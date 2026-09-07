import 'dotenv/config';
import {strict as assert} from 'assert';

import {QueryScanConsistency} from 'couchbase';

import {
    createCouchsetClient,
    defineModel,
    defineModelPlugin,
    withModelScopes,
    withModelMethods,
    withModelValidator,
    withModelBulk,
} from '../src/next';

async function main() {
    const connectionString = process.env.COUCHBASE_URL || '';
    assert(
        /^couchbases?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(connectionString),
        'Local Couchbase required'
    );
    assert.equal(process.env.COUCHBASE_BUCKET, 'test', 'Test bucket required');
    const events: unknown[] = [];
    const db = createCouchsetClient({
        connectionString,
        bucketName: 'test',
        instrumentation: {
            onOperation: (event) => {
                events.push(event);
            },
        },
        username: process.env.COUCHBASE_USERNAME,
        password: process.env.COUCHBASE_PASSWORD,
    });
    const id = `couchset-plugin-test::${Date.now()}::${Math.random()}`;
    const indexName = `idx_couchset_plugin_${Date.now()}_${Math.floor(Math.random() * 1e9)}`;
    const definition = defineModel<{value: string}>({
        name: 'CouchsetPluginTest',
        indexes: [{name: indexName, fields: ['value']}],
        plugins: [
            defineModelPlugin(() => ({
                validateCreate: (doc: any) => ({...doc, value: doc.value.toUpperCase()}),
            })),
        ],
    });
    const model = db.model(definition);
    let inserted = false;
    let indexed = false;
    const secondId = `${id}::key`;
    let secondInserted = false;
    let afterCalled = false;
    const keyed = db.model(
        defineModel<{value: string}>({
            name: 'KeyedPluginTest',
            key: {create: () => secondId},
            hooks: {
                afterInsert: () => {
                    afterCalled = true;
                },
            },
            plugins: [
                withModelValidator({
                    '~standard': {
                        version: 1,
                        vendor: 'live',
                        validate: (input: any) => ({value: {value: input.value.toUpperCase()}}),
                    },
                }),
            ],
        })
    );
    try {
        await db.ready();
        const keyedDocument = await keyed.insert({value: 'validated'});
        secondInserted = true;
        assert.equal(keyedDocument.id, secondId);
        assert.equal((await keyed.getById(secondId)).value, 'VALIDATED');
        assert.equal(afterCalled, true);
        const batch = await withModelBulk(keyed).getMany([secondId]);
        assert.equal(batch[0].status, 'fulfilled');
        assert.ok((batch[0] as any).value.cas);
        assert.ok(events.length > 0);
        await model.insert({id, value: 'hello'} as any);
        inserted = true;
        assert.equal((await model.getById(id)).value, 'HELLO');
        await model.ensureIndexes();
        indexed = true;
        const scoped = withModelScopes(model, {named: (value: string) => ({where: {value}})});
        const rows = await scoped.scopes.named('HELLO').findMany({
            where: {id},
            queryOptions: {scanConsistency: QueryScanConsistency.RequestPlus},
        });
        assert.equal(rows.length, 1);
        const extended = withModelMethods(model, {
            read(id: string) {
                return this.getById(id);
            },
        });
        assert.equal((await extended.read(id)).value, 'HELLO');
        console.log('Plugin, scope and domain-method live tests passed against local test bucket');
    } finally {
        try {
            if (secondInserted) await keyed.deleteById(secondId, {hard: true});
            if (inserted) await model.deleteById(id, {hard: true});
        } finally {
            try {
                if (indexed)
                    await model.queryRows(`DROP INDEX ${model.keyspace()}.\`${indexName}\``);
            } finally {
                await db.shutdown();
            }
        }
    }
}
main().catch((error) => {
    console.error(error.name, error.message);
    process.exitCode = 1;
});
