import {readFileSync} from 'fs';
import {resolve} from 'path';

/** Explicit administrative CLI. The config is trusted application code. */
export const runCouchsetCli = async (
    args: string[],
    write: (text: string) => void = console.log
): Promise<void> => {
    const [resource, action] = args;
    if (!resource || resource === '--help') {
        write(
            'couchset model NAME | inspect | indexes plan/apply | search-indexes plan/apply | collections plan/apply | eventing plan\nUse --config ./couchset.config.cjs; apply requires --plan ./plan.json except create-only collections apply.'
        );
        return;
    }
    if (resource === 'model') {
        if (!action || !/^[A-Za-z][A-Za-z0-9_]*$/.test(action))
            throw new Error('Model name must be an identifier');
        write(
            `import {defineModel} from 'couchset/next';\nexport const ${action} = defineModel({name: '${action}'});`
        );
        return;
    }
    const option = (name: string): string | undefined => {
        const index = args.indexOf(name);
        return index < 0 ? undefined : args[index + 1];
    };
    const configPath = option('--config');
    if (!configPath) throw new Error('--config is required');
    // Loading application config is explicit, never discovery at import time.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const config = require(resolve(configPath));
    const db = config.db || config.default;
    if (!db || typeof db.definitions !== 'function')
        throw new Error('Config must export db (a CouchsetClient)');
    try {
        let result: unknown;
        if (resource === 'inspect')
            result = db.definitions().map((definition: any) => ({
                name: definition.name,
                scope: definition.scope || '_default',
                collection: definition.collection || '_default',
                indexes: (definition.indexes || []).map((index: any) => index.name),
                searchIndexes: (definition.searchIndexes || []).map((index: any) => index.name),
            }));
        else if (resource === 'collections' && action === 'apply')
            result = await db.ensureCollections();
        else if (resource === 'collections' && action === 'plan')
            result = await db.planCollections();
        else if (resource === 'eventing' && action === 'plan') {
            if (!config.eventing || typeof config.eventing.plan !== 'function')
                throw new Error('Config must export an Eventing controller as eventing');
            result = await config.eventing.plan();
        } else if ((resource === 'indexes' || resource === 'search-indexes') && action === 'plan') {
            result = resource === 'indexes' ? await db.planIndexes() : await db.planSearchIndexes();
        } else if (
            (resource === 'indexes' || resource === 'search-indexes') &&
            action === 'apply'
        ) {
            const planPath = option('--plan');
            if (!planPath) throw new Error('Apply requires --plan with a reviewed JSON plan');
            const plan = JSON.parse(readFileSync(resolve(planPath), 'utf8'));
            result =
                resource === 'indexes'
                    ? await db.applyIndexPlan(plan)
                    : await db.applySearchIndexPlan(plan, {
                          allowReplace: args.includes('--allow-replace'),
                      });
            result = result || {applied: true};
        } else throw new Error('Unsupported command; run couchset --help');
        write(JSON.stringify(result, null, 2));
    } finally {
        await db.shutdown();
    }
};
