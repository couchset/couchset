import 'dotenv/config';
import {strict as assert} from 'assert';
import {execFile} from 'child_process';
import {mkdtempSync, writeFileSync, unlinkSync, rmdirSync} from 'fs';
import {tmpdir} from 'os';
import {join, resolve} from 'path';
import {promisify} from 'util';

import {connect} from 'couchbase';

async function main() {
    assert.equal(process.env.COUCHBASE_BUCKET, 'test');
    const url = process.env.COUCHBASE_URL || '';
    assert(/^couchbases?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(url));
    const cluster = await connect(url, {
        username: process.env.COUCHBASE_USERNAME,
        password: process.env.COUCHBASE_PASSWORD,
    });
    const scope = `cs_cli_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const directory = mkdtempSync(join(tmpdir(), 'couchset-cli-live-'));
    const planPath = join(directory, 'plan.json');
    const bucket = cluster.bucket('test');
    await bucket.waitUntilReady(30000);
    const searchName = `${scope}_search`;
    const functionName = `${scope}__probe`;
    const staleName = `${scope}__stale`;
    let scopeCreated = false;
    let searchCreated = false;
    const functionsCreated: string[] = [];
    const run = async (args: string[], drift = false) => {
        const {stdout} = await promisify(execFile)(
            process.execPath,
            [resolve('bin/couchset.js'), ...args, '--config', resolve('test/cli/live-config.cjs')],
            {
                env: {
                    ...process.env,
                    COUCHSET_LIVE_SCOPE: scope,
                    COUCHSET_LIVE_DRIFT: drift ? '1' : '0',
                },
                timeout: 90000,
            }
        );
        return JSON.parse(stdout);
    };
    try {
        const help = await promisify(execFile)(process.execPath, ['bin/couchset.js', '--help']);
        assert(help.stdout.includes('collections'));
        const scaffold = await promisify(execFile)(process.execPath, [
            'bin/couchset.js',
            'model',
            'Example',
        ]);
        assert(scaffold.stdout.includes("name: 'Example'"));
        const inspect = await run(['inspect']);
        assert.equal(inspect[0].name, 'CliLive');
        assert.equal((await run(['collections', 'plan']))[0].status, 'create');
        assert(!(await bucket.collections().getAllScopes()).some((s) => s.name === scope));
        // Cleanup is armed before apply, including partial provisioning failures.
        scopeCreated = true;
        await run(['collections', 'apply']);
        assert.equal((await run(['collections', 'plan']))[0].status, 'matching');
        await run(['collections', 'apply']);
        console.log('PASS CLI help/scaffold/inspect and collection plan/apply/idempotence');
        const plan = await run(['indexes', 'plan']);
        writeFileSync(planPath, JSON.stringify(plan));
        await assert.rejects(() => run(['indexes', 'apply']));
        await run(['indexes', 'apply', '--plan', planPath]);
        const matching = await run(['indexes', 'plan']);
        assert(JSON.stringify(matching).includes('matching'));
        console.log('PASS CLI GSI reviewed plan/apply/convergence and missing-plan guard');
        const search = await run(['search-indexes', 'plan']);
        assert.equal(search.items[0].status, 'create');
        writeFileSync(planPath, JSON.stringify(search));
        searchCreated = true;
        await run(['search-indexes', 'apply', '--plan', planPath]);
        assert.equal((await run(['search-indexes', 'plan'])).items[0].status, 'matching');
        await assert.rejects(() => run(['search-indexes', 'apply', '--plan', planPath]));
        const drift = await run(['search-indexes', 'plan'], true);
        assert.equal(drift.items[0].status, 'replace');
        writeFileSync(planPath, JSON.stringify(drift));
        await assert.rejects(() => run(['search-indexes', 'apply', '--plan', planPath], true));
        await run(['search-indexes', 'apply', '--plan', planPath, '--allow-replace'], true);
        assert.equal((await run(['search-indexes', 'plan'], true)).items[0].status, 'matching');
        console.log('PASS CLI Search create/replacement/convergence, stale-plan and opt-in guards');
        await bucket.collections().createCollection({scopeName: scope, name: 'metadata'});
        const manager = cluster.eventingFunctions();
        const before = await manager.getAllFunctions();
        const missing = await run(['eventing', 'plan']);
        assert.equal(missing.functions[0].action, 'create');
        assert.deepEqual(
            (await manager.getAllFunctions()).map((f) => f.name).sort(),
            before.map((f) => f.name).sort()
        );
        const desired: any = {
            name: functionName,
            code: 'function OnUpdate(doc, meta) {}',
            sourceKeyspace: {bucket: 'test', scope, collection: 'docs'},
            metadataKeyspace: {bucket: 'test', scope, collection: 'metadata'},
            bucketBindings: [],
            urlBindings: [],
            constantBindings: [],
            settings: {},
        };
        functionsCreated.push(functionName);
        await manager.upsertFunction(desired);
        assert.equal((await run(['eventing', 'plan'])).functions[0].action, 'matching');
        await manager.upsertFunction({
            ...desired,
            code: 'function OnUpdate(doc, meta) { log(meta.id); }',
        });
        assert.equal((await run(['eventing', 'plan'])).functions[0].action, 'update');
        functionsCreated.push(staleName);
        await manager.upsertFunction({...desired, name: staleName});
        assert((await run(['eventing', 'plan'])).staleOwnedFunctions.includes(staleName));
        assert.equal(
            (await manager.getFunction(functionName)).code,
            'function OnUpdate(doc, meta) { log(meta.id); }'
        );
        console.log('PASS CLI Eventing read-only create/matching/drift/stale-owned reports');
    } finally {
        for (const name of functionsCreated) await cluster.eventingFunctions().dropFunction(name);
        if (searchCreated) await bucket.scope(scope).searchIndexes().dropIndex(searchName);
        if (scopeCreated) await bucket.collections().dropScope(scope);
        try {
            unlinkSync(planPath);
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
        }
        rmdirSync(directory);
        await cluster.close();
    }
}
main().catch((error) => {
    console.error(error.name, error.message);
    process.exitCode = 1;
});
