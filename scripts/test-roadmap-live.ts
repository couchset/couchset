import 'dotenv/config';
import {strict as assert} from 'assert';

import {
    connect,
    QueryScanConsistency,
    SearchFacet,
    SearchSort,
    MutationState,
    TransactionOperationFailedError,
} from 'couchbase';

import {
    createCouchsetClient,
    defineModel,
    defineModelPlugin,
    withModelValidator,
    withModelScopes,
    withModelMethods,
    withDocumentMethods,
    withModelBulk,
    bulkMap,
    ModelAfterHookError,
    ModelValidationError,
} from '../src/next';

// No shared resources are deleted: each run owns one uniquely named scope.
async function main() {
    const url = process.env.COUCHBASE_URL || '';
    assert(/^couchbases?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(url), 'Local server required');
    assert.equal(process.env.COUCHBASE_BUCKET, 'test');
    const cluster = await connect(url, {
        username: process.env.COUCHBASE_USERNAME,
        password: process.env.COUCHBASE_PASSWORD,
    });
    console.log('Connected to local test server');
    const bucket = cluster.bucket('test');
    await bucket.waitUntilReady(30000);
    console.log('Test bucket ready');
    const scope = `cs_live_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const events: any[] = [];
    const retries: any[] = [];
    const db = createCouchsetClient({
        bucketName: 'test',
        dependencies: {cluster, bucket},
        instrumentation: {
            onOperation: (e) => {
                events.push({kind: 'operation', ...e});
            },
            onQuery: (e) => {
                events.push({kind: 'query', ...e});
            },
            onMutation: (e) => {
                events.push({kind: 'mutation', ...e});
            },
            onSlowOperation: (e) => {
                events.push({kind: 'slow', ...e});
            },
            slowOperationMs: 0,
            onRetry: (e) => {
                retries.push(e);
            },
        },
    });
    const collection = bucket.scope(scope).collection('docs');
    const consistency = {scanConsistency: QueryScanConsistency.RequestPlus};
    let failures = 0;
    async function check(name: string, run: () => Promise<void>) {
        try {
            await run();
            console.log(`PASS ${name}`);
        } catch (error) {
            failures++;
            console.error(`FAIL ${name}: ${error.name}: ${error.message}`);
            if (error.cause) console.error(`Cause: ${error.cause.name}: ${error.cause.message}`);
        }
    }
    const indexes: Array<{name: string; scoped: boolean}> = [];
    let scopeCreated = false;
    try {
        console.log('Creating isolated feature scope');
        await bucket.collections().createScope(scope);
        scopeCreated = true;
        console.log('Creating isolated feature collection');
        await bucket.collections().createCollection({scopeName: scope, name: 'docs'});
        // Query-service manifests can lag successful collection creation.
        const fixtureDeadline = Date.now() + 30000;
        for (;;) {
            try {
                await cluster.query(
                    `CREATE PRIMARY INDEX IF NOT EXISTS ON \`test\`.\`${scope}\`.\`docs\``
                );
                break;
            } catch (error) {
                if (
                    Date.now() >= fixtureDeadline ||
                    !/bucket.*not.*found|keyspace.*not.*found/i.test(error.message)
                )
                    throw error;
                await new Promise((resolve) => setTimeout(resolve, 200));
            }
        }
        const base = (name: string, extra: any = {}) =>
            defineModel<any>({name, scope, collection: 'docs', ...extra});
        await check(
            'plugins: composition, immutable contributions, conflict guards, persisted transforms',
            async () => {
                let calls = 0;
                const plugin = defineModelPlugin<any>((options) => {
                    calls++;
                    assert(Object.isFrozen(options));
                    return {
                        validateCreate: (doc: any) => ({...doc, value: doc.value.toUpperCase()}),
                    };
                });
                const definition = base('Plugin', {plugins: [plugin]});
                const model = db.model(definition);
                db.model(definition);
                assert.equal(calls, 1);
                await model.insert({id: 'plugin', value: 'hello'});
                assert.equal((await collection.get('plugin')).content.value, 'HELLO');
                assert.throws(() => base('Conflict', {plugins: [() => ({scope: 'other'})]}));
                assert.throws(() =>
                    base('Conflict2', {
                        plugins: [() => ({softDelete: true}), () => ({softDelete: false})],
                    })
                );
            }
        );
        await check(
            'keys: default, generated insert/upsert, explicit allow/validate/reject',
            async () => {
                const ordinary = db.model(base('Ordinary'));
                const doc = await ordinary.insert({value: 'default'});
                assert(doc.id);
                assert((await collection.exists(doc.id)).exists);
                let keyCount = 0;
                const keyed = db.model(
                    base('Keyed', {key: {create: () => `generated-${++keyCount}`}})
                );
                assert.equal((await keyed.insert({value: 1})).id, 'generated-1');
                assert.equal((await keyed.upsert({value: 2})).id, 'generated-2');
                await keyed.insert({id: 'explicit', value: 3});
                assert.equal(keyCount, 2);
                const validated = db.model(
                    base('ValidatedKey', {
                        key: {
                            create: () => 'valid-generated',
                            parse: (id: string) => id.startsWith('valid-') || null,
                            explicitId: 'validate',
                        },
                    })
                );
                await validated.insert({id: 'valid-explicit', value: 4});
                await assert.rejects(() => validated.insert({id: 'invalid', value: 4}));
                assert.equal((await collection.exists('invalid')).exists, false);
                const rejected = db.model(
                    base('RejectedKey', {
                        key: {create: () => 'reject-generated', explicitId: 'reject'},
                    })
                );
                await rejected.insert({value: 5});
                await assert.rejects(() => rejected.upsert({id: 'rejected', value: 5}));
            }
        );
        await check(
            'validation: sync/async transforms, metadata, rejection, replace/upsert and patch bypass',
            async () => {
                for (const asyncMode of [false, true]) {
                    const validate = (input: any) =>
                        input.value === 'bad'
                            ? {issues: [{message: 'bad value', path: ['value']}]}
                            : {value: {value: String(input.value).toUpperCase()}};
                    const model = db.model(
                        base(`Schema${asyncMode}`, {
                            plugins: [
                                withModelValidator({
                                    '~standard': {
                                        version: 1,
                                        vendor: 'live',
                                        validate: asyncMode ? async (v) => validate(v) : validate,
                                    },
                                }),
                            ],
                        })
                    );
                    const id = `schema-${asyncMode}`;
                    await model.insert({id, value: 'first', stripped: true});
                    let content = (await collection.get(id)).content;
                    assert.equal(content.value, 'FIRST');
                    assert.equal(content.id, id);
                    assert.equal(content._type, `Schema${asyncMode}`);
                    assert(!('stripped' in content));
                    await assert.rejects(
                        () => model.replaceById(id, {value: 'bad'}),
                        ModelValidationError
                    );
                    assert.equal((await collection.get(id)).content.value, 'FIRST');
                    await model.upsert({id, value: 'second'});
                    await model.replaceById(id, {value: 'third'});
                    assert.equal((await collection.get(id)).content.value, 'THIRD');
                    await model.patchById(id, {$set: {value: 'bad'}});
                    content = (await collection.get(id)).content;
                    assert.equal(content.value, 'bad');
                }
            }
        );
        await check(
            'hooks: every mutation phase, read projections, soft-delete and restore',
            async () => {
                const seen: string[] = [];
                const hooks: any = {};
                for (const phase of ['Insert', 'Upsert', 'Replace', 'Patch', 'Delete']) {
                    hooks[`before${phase}`] = (v: any, c: any) => {
                        assert.equal(c.transaction, false);
                        seen.push(`before${phase}`);
                        return v;
                    };
                    hooks[`after${phase}`] = () => {
                        seen.push(`after${phase}`);
                    };
                }
                hooks.afterRead = (v: any) => {
                    assert(v);
                    seen.push('read');
                };
                const model = db.model(base('Hooks', {hooks, softDelete: true}));
                await model.insert({id: 'hooks', value: 'one'});
                await model.upsert({id: 'hooks', value: 'two'});
                await model.replaceById('hooks', {value: 'three'});
                await model.patchById('hooks', {$set: {value: 'four'}});
                for (const phase of ['Insert', 'Upsert', 'Replace', 'Patch'])
                    assert(seen.indexOf(`before${phase}`) < seen.indexOf(`after${phase}`));
                for (const run of [
                    () => model.getById('hooks'),
                    () => model.findByIdWithMeta('hooks'),
                    () => model.findMany({select: ['value'], queryOptions: consistency}),
                    () => model.findOne({queryOptions: consistency}),
                    () => model.page({queryOptions: consistency}),
                ]) {
                    seen.length = 0;
                    await run();
                    assert(seen.includes('read'));
                }
                seen.length = 0;
                await model.deleteById('hooks');
                assert.deepEqual(
                    seen.filter((s) => s !== 'read'),
                    ['beforeDelete', 'beforePatch', 'afterPatch', 'afterDelete']
                );
                assert.equal((await model.findMany({queryOptions: consistency})).length, 0);
                assert.equal(
                    (await model.onlyDeleted().findMany({queryOptions: consistency})).length,
                    1
                );
                await model.restoreById('hooks');
                assert.equal((await model.findMany({queryOptions: consistency})).length, 1);
                await model.softDeleteById('hooks');
                await model.deleteById('hooks', {hard: true});
                assert.equal((await collection.exists('hooks')).exists, false);
            }
        );
        await check(
            'hook failures: before prevents write; after reports persisted mutation',
            async () => {
                const before = db.model(
                    base('BeforeFailure', {
                        hooks: {
                            beforeInsert: () => {
                                throw new Error('before');
                            },
                        },
                    })
                );
                await assert.rejects(() => before.insert({id: 'before-fail'}));
                assert.equal((await collection.exists('before-fail')).exists, false);
                const after = db.model(
                    base('AfterFailure', {
                        hooks: {
                            afterInsert: () => {
                                throw new Error('after');
                            },
                        },
                    })
                );
                await assert.rejects(() => after.insert({id: 'after-fail'}), ModelAfterHookError);
                assert.equal((await collection.exists('after-fail')).exists, true);
            }
        );
        await check(
            'scopes: AND, undefined filters, all read methods, projections and local methods',
            async () => {
                const model = db.model(base('Scopes', {defaultWhere: {tenant: 'a'}}));
                await model.insert({id: 'scope-a', tenant: 'a', value: 'match'});
                await model.insert({id: 'scope-b', tenant: 'b', value: 'match'});
                await model.insert({id: 'scope-c', tenant: 'a', value: 'other'});
                const scoped = withModelScopes(model, {
                    named: () => ({where: {value: 'match'}, queryOptions: consistency}),
                    optional: () => ({where: undefined}),
                })
                    .scopes.named()
                    .scopes.optional();
                assert.equal((await scoped.findMany({where: undefined})).length, 1);
                assert.equal((await scoped.findOne()).id, 'scope-a');
                assert.equal(await scoped.count(), 1);
                assert.equal(await scoped.exists(), true);
                assert.equal((await scoped.page()).items.length, 1);
                assert.equal((await scoped.withoutDefaultWhere().findMany()).length, 2);
                const projected = await scoped.findMany({select: ['value']});
                assert.equal(projected[0].value, 'match');
                const view = withModelMethods(model, {
                    read(id: string) {
                        return this.getById(id);
                    },
                });
                assert.equal((await view.read('scope-a')).value, 'match');
                assert(!('read' in model));
                const original = model.hydrate(await model.getById('scope-a'));
                const document = withDocumentMethods(original, {
                    rename(value: string) {
                        this.value = value;
                        return this.save();
                    },
                });
                await document.rename('renamed');
                assert.equal((await collection.get('scope-a')).content.value, 'renamed');
                assert.equal(original.value, 'match');
                assert(!('rename' in document.toJSON()));
            }
        );
        await check(
            'bulk: insert/get/delete, partial failures, fail-fast, bounded concurrency and SDK metadata',
            async () => {
                const bulk = withModelBulk(db.model(base('Bulk')));
                const inserted = await bulk.insertMany([
                    {id: 'bulk-a'},
                    {id: 'bulk-a'},
                    {id: 'bulk-skipped'},
                ]);
                assert.deepEqual(
                    inserted.map((r) => r.status),
                    ['fulfilled', 'rejected', 'skipped']
                );
                assert.equal((await collection.exists('bulk-skipped')).exists, false);
                const all = await bulk.insertMany(
                    [{id: 'bulk-a'}, {id: 'bulk-b'}, {id: 'bulk-c'}],
                    {ordered: false, concurrency: 2}
                );
                assert.deepEqual(
                    all.map((r) => r.status),
                    ['rejected', 'fulfilled', 'fulfilled']
                );
                const reads = await bulk.getMany(['bulk-a', 'bulk-b']);
                assert(reads.every((r) => r.status === 'fulfilled' && r.value.cas));
                let active = 0;
                let peak = 0;
                const raw = await bulkMap(
                    ['raw-a', 'raw-b', 'raw-c'],
                    async (id) => {
                        active++;
                        peak = Math.max(active, peak);
                        try {
                            return await collection.insert(id, {value: 'sdk'});
                        } finally {
                            active--;
                        }
                    },
                    {ordered: false, concurrency: 2}
                );
                assert(peak <= 2);
                assert(raw.every((r) => r.status === 'fulfilled' && r.value.cas && r.value.token));
                assert(
                    (await bulk.deleteMany(['bulk-a', 'bulk-b', 'bulk-c'])).every(
                        (r) => r.status === 'fulfilled'
                    )
                );
                assert.equal((await collection.exists('bulk-a')).exists, false);
            }
        );
        await check('transactions: hooks, validation, keys, commit and rollback', async () => {
            const seen: string[] = [];
            const hooks: any = {};
            for (const phase of ['Insert', 'Replace', 'Delete']) {
                hooks[`before${phase}`] = (v: any, c: any) => {
                    assert(c.transaction);
                    seen.push(`before${phase}`);
                    return v;
                };
                hooks[`after${phase}`] = (_v: any, c: any) => {
                    assert(c.transaction);
                    seen.push(`after${phase}`);
                };
            }
            hooks.afterRead = (_v: any, c: any) => {
                assert(c.transaction);
                seen.push('read');
            };
            const definition = base('Transaction', {
                hooks,
                key: {
                    create: () => 'tx-generated',
                    explicitId: 'validate',
                    parse: (id: string) => id.startsWith('tx-') || null,
                },
                plugins: [
                    withModelValidator({
                        '~standard': {
                            version: 1,
                            vendor: 'live',
                            validate: (v: any) => ({value: {value: String(v.value).toUpperCase()}}),
                        },
                    }),
                ],
            });
            await db.transaction(async (tx) => {
                await tx.model(definition).insert('tx-one', {value: 'first'});
            });
            assert.equal((await collection.get('tx-one')).content.value, 'FIRST');
            await db.transaction(async (tx) => {
                const m = tx.model(definition);
                const d = await m.get('tx-one');
                assert(d);
                await m.replace(d, {value: 'second'});
            });
            assert.equal((await collection.get('tx-one')).content.value, 'SECOND');
            await db.transaction(async (tx) => {
                const m = tx.model(definition);
                const d = await m.get('tx-one');
                assert(d);
                await m.remove(d);
            });
            assert.equal((await collection.exists('tx-one')).exists, false);
            assert.deepEqual(seen, [
                'beforeInsert',
                'afterInsert',
                'read',
                'beforeReplace',
                'afterReplace',
                'read',
                'beforeDelete',
                'afterDelete',
            ]);
            await assert.rejects(() =>
                db.transaction(async (tx) => {
                    await tx.model(definition).insert('tx-rollback', {value: 'no'});
                    throw new Error('rollback');
                })
            );
            assert.equal((await collection.exists('tx-rollback')).exists, false);
            await assert.rejects(() =>
                db.transaction(async (tx) => {
                    await tx.model(definition).insert('invalid-tx', {value: 'no'});
                })
            );
            assert.equal((await collection.exists('invalid-tx')).exists, false);
        });
        await check('transaction retry notifications and after-hook rollback', async () => {
            let hookCalls = 0;
            const definition = base('Retry', {
                hooks: {
                    afterRead: (_v: any, context: any) => {
                        assert(context.transaction);
                        hookCalls++;
                    },
                },
            });
            const model = db.model(definition);
            await model.insert({id: 'tx-conflict', value: 0});
            await assert.rejects(() =>
                db.transaction(async (tx) => {
                    const m = tx.model(definition);
                    const doc = await m.get('tx-conflict');
                    assert(doc);
                    await collection.replace('tx-conflict', {...doc.content, value: 10});
                    await m.replace(doc, {...doc.content, value: doc.content.value + 1});
                })
            );
            assert.equal((await collection.get('tx-conflict')).content.value, 10);
            let staged: () => void;
            const stagedPromise = new Promise<void>((resolve) => {
                staged = resolve;
            });
            const holder = db.transaction(async (tx) => {
                const m = tx.model(definition);
                const doc = await m.get('tx-conflict');
                assert(doc);
                await m.replace(doc, {...doc.content, value: doc.content.value + 1});
                staged();
                await new Promise((resolve) => setTimeout(resolve, 1500));
            });
            await Promise.race([stagedPromise, holder]);
            const contender = db.transaction(async (tx) => {
                const m = tx.model(definition);
                try {
                    const doc = await m.get('tx-conflict');
                    assert(doc);
                    await m.replace(doc, {...doc.content, value: doc.content.value + 1});
                } catch (error) {
                    // SDK 4.7's run() rethrows escaped operation failures. Let its
                    // native finalize step observe this failed attempt and retry.
                    if (!(error instanceof TransactionOperationFailedError)) throw error;
                }
            });
            await Promise.all([holder, contender]);
            assert.equal((await collection.get('tx-conflict')).content.value, 12);
            assert(hookCalls >= 2);
            assert(retries.some((e) => e.attempt >= 2));
            const failing = base('TxAfterFailure', {
                hooks: {
                    afterInsert: () => {
                        throw new Error('abort after');
                    },
                },
            });
            await assert.rejects(() =>
                db.transaction(async (tx) => {
                    await tx.model(failing).insert('tx-after-fail', {value: 'never committed'});
                })
            );
            assert.equal((await collection.exists('tx-after-fail')).exists, false);
        });
        await check(
            'instrumentation: query/mutation/slow/failure events, payload exclusion and observer isolation',
            async () => {
                for (const kind of ['operation', 'query', 'mutation', 'slow'])
                    assert(events.some((e) => e.kind === kind));
                assert(events.some((e) => e.outcome === 'failure'));
                assert(
                    events.every(
                        (e) =>
                            Object.keys(e).sort().join() ===
                            'durationMs,kind,model,operation,outcome'
                    )
                );
                const isolated = createCouchsetClient({
                    bucketName: 'test',
                    dependencies: {cluster, bucket},
                    instrumentation: {
                        onOperation: () => {
                            throw new Error('observer');
                        },
                        onMutation: async () => {
                            throw new Error('observer');
                        },
                    },
                });
                await isolated
                    .model(base('Observer'))
                    .insert({id: 'observer', secret: 'never emitted'});
                assert.equal((await collection.get('observer')).content.secret, 'never emitted');
            }
        );
        for (const scoped of [false, true])
            await check(
                `Search ${
                    scoped ? 'scoped' : 'global'
                }: all mappings, text, raw options, vector/hybrid and every geo helper`,
                async () => {
                    const name = `search_${scope}_${scoped}`;
                    indexes.push({name, scoped});
                    const definition = base(`Search${scoped}`, {
                        searchIndexes: [
                            {
                                name,
                                scoped,
                                fields: {
                                    title: {type: 'text', store: true},
                                    category: {type: 'text', analyzer: 'keyword', store: true},
                                    rating: {type: 'number', store: true},
                                    active: {type: 'boolean'},
                                    date: {type: 'datetime'},
                                    location: {type: 'geopoint'},
                                    shape: {type: 'geoshape'},
                                    embedding: {type: 'vector', dims: 3, similarity: 'dot_product'},
                                },
                            },
                        ],
                    });
                    const model = db.model(definition);
                    const id = `search-${scoped}`;
                    await model.insert({
                        id,
                        title: 'coffee shop',
                        category: 'cafe',
                        rating: 5,
                        active: true,
                        date: '2026-01-01T00:00:00Z',
                        location: {lat: 43.65, lon: -79.44},
                        shape: {type: 'Point', coordinates: [-79.44, 43.65]},
                        embedding: [1, 0, 0],
                    });
                    await model.insert({
                        id: `${id}-far`,
                        title: 'distant tea',
                        category: 'tea',
                        rating: 1,
                        active: false,
                        date: '2025-01-01T00:00:00Z',
                        location: {lat: 0, lon: 0},
                        shape: {type: 'Point', coordinates: [0, 0]},
                        embedding: [0, 1, 0],
                    });
                    const plan = await db.planSearchIndexes();
                    await db.applySearchIndexPlan(
                        {items: plan.items.filter((i) => i.index.name === name)},
                        {timeoutMs: 60000}
                    );
                    const search = db.search(definition, name);
                    const deadline = Date.now() + 60000;
                    while (!(await search.match('title', 'coffee')).rows.some((r) => r.id === id)) {
                        assert(Date.now() < deadline, 'Search ingestion timeout');
                        await new Promise((r) => setTimeout(r, 200));
                    }
                    const hasOnly = (result: any) => {
                        assert.deepEqual(
                            result.rows.map((r: any) => r.id),
                            [id]
                        );
                    };
                    hasOnly(await search.match('title', 'coffee'));
                    const highlighted = await search.match('title', 'coffee', {
                        highlight: {fields: ['title']},
                    });
                    assert(
                        highlighted.rows[0].fragments?.title?.some((fragment: string) =>
                            fragment.includes('coffee')
                        ),
                        'Expected highlighted title fragments'
                    );
                    hasOnly(
                        await search.query({
                            conjuncts: [
                                {field: 'rating', min: 4, max: 6},
                                {field: 'active', bool: true},
                                {
                                    field: 'date',
                                    start: '2026-01-01T00:00:00Z',
                                    end: '2027-01-01T00:00:00Z',
                                },
                            ],
                        })
                    );
                    const raw = await search.query(
                        {match_all: {}},
                        {
                            fields: ['title'],
                            sort: [SearchSort.field('rating').descending(true)],
                            limit: 1,
                            facets: {category: SearchFacet.term('category', 10)},
                            highlight: {fields: ['title']},
                        }
                    );
                    hasOnly(raw);
                    assert((raw.meta as any).facets.category);
                    assert.equal(raw.rows[0].fields.title, 'coffee shop');
                    assert.equal(
                        (
                            await search.query(
                                {match_all: {}},
                                {
                                    sort: [SearchSort.field('rating').descending(true)],
                                    skip: 1,
                                    limit: 1,
                                }
                            )
                        ).rows[0].id,
                        `${id}-far`
                    );
                    // A real mutation token verifies the SDK consistency option passthrough.
                    const updated = await collection.upsert(id, (await collection.get(id)).content);
                    hasOnly(
                        await search.match('title', 'coffee', {
                            consistentWith: new MutationState(updated.token),
                        })
                    );
                    hasOnly(await search.vector('embedding', [1, 0, 0], {numCandidates: 1}));
                    hasOnly(
                        await search.vector('embedding', [1, 0, 0], {
                            numCandidates: 2,
                            filter: {term: 'cafe', field: 'category'},
                        })
                    );
                    hasOnly(
                        await search.vector('embedding', [1, 0, 0], {
                            numCandidates: 1,
                            searchQuery: {match: 'coffee', field: 'title'},
                        })
                    );
                    hasOnly(
                        await search.withinRadius({
                            strategy: 'search',
                            field: 'location',
                            center: {lat: 43.65, lon: -79.44},
                            radius: '5km',
                        })
                    );
                    hasOnly(
                        await search.withinBox({
                            strategy: 'search',
                            field: 'location',
                            bounds: {south: 43, north: 44, west: -80, east: -79},
                        })
                    );
                    hasOnly(
                        await search.withinPolygon({
                            strategy: 'search',
                            field: 'location',
                            points: [
                                {lat: 43, lon: -80},
                                {lat: 43, lon: -79},
                                {lat: 44, lon: -79},
                                {lat: 44, lon: -80},
                            ],
                        })
                    );
                    for (const relation of ['intersects', 'within'] as const)
                        hasOnly(
                            await search.shape({
                                strategy: 'search',
                                field: 'shape',
                                relation,
                                geometry: {
                                    type: 'Polygon',
                                    coordinates: [
                                        [
                                            [-80, 43],
                                            [-79, 43],
                                            [-79, 44],
                                            [-80, 44],
                                            [-80, 43],
                                        ],
                                    ],
                                },
                            })
                        );
                    hasOnly(
                        await search.shape({
                            strategy: 'search',
                            field: 'shape',
                            relation: 'contains',
                            geometry: {type: 'Point', coordinates: [-79.44, 43.65]},
                        })
                    );
                    await assert.rejects(() => search.vector('embedding', [1]), /dimensions/);
                    const unsafe = base(`Unsafe${scoped}`, {
                        defaultWhere: {tenant: 'a'},
                        searchIndexes: definition.searchIndexes,
                    });
                    const guarded = createCouchsetClient({
                        bucketName: 'test',
                        dependencies: {cluster, bucket},
                    });
                    await assert.rejects(
                        () => guarded.search(unsafe, name).match('title', 'coffee'),
                        /explicit Search filters/
                    );
                    assert.equal(
                        (await db.planSearchIndexes()).items.find((i) => i.index.name === name)
                            .status,
                        'matching'
                    );
                    await db.applySearchIndexPlan(await db.planSearchIndexes());
                    await assert.rejects(
                        () =>
                            db.applySearchIndexPlan({
                                items: plan.items.filter((i) => i.index.name === name),
                            }),
                        /stale/
                    );
                }
            );
        await check(
            'GSI geo: box/radius, pagination, codecs, defaults, soft-delete, antimeridian and poles',
            async () => {
                const definition = base('Geo', {
                    softDelete: true,
                    codecs: {
                        tag: {
                            toDatabase: (v: string) => v.toUpperCase(),
                            fromDatabase: (v: string) => v.toLowerCase(),
                        },
                    },
                });
                const model = db.model(definition);
                for (const [id, lat, lon] of [
                    ['geo-near', 0, 179.9],
                    ['geo-across', 0, -179.9],
                    ['geo-far', 0, 0],
                    ['geo-pole', 89.9, 90],
                ] as const)
                    await model.insert({id, location: {lat, lon}, tag: 'Codec'});
                const geo = db.geo(definition);
                const args = {
                    strategy: 'gsi' as const,
                    field: 'location',
                    center: {lat: 0, lon: 179.9},
                    radius: '50km',
                    queryOptions: consistency,
                };
                const rows = await geo.withinRadius(args);
                assert.equal(rows.length, 2);
                assert(rows[0].distanceKm < rows[1].distanceKm);
                assert.equal(rows[0].document.tag, 'codec');
                assert.equal(
                    (await geo.withinRadius({...args, limit: 1, offset: 1}))[0].document.id,
                    'geo-across'
                );
                assert.equal(
                    (
                        await geo.withinBox({
                            strategy: 'gsi',
                            field: 'location',
                            bounds: {south: -1, north: 1, west: 179, east: -179},
                            queryOptions: consistency,
                        })
                    ).length,
                    2
                );
                assert.equal(
                    (await geo.withinRadius({...args, center: {lat: 90, lon: 0}, radius: '50km'}))
                        .length,
                    1
                );
                await model.softDeleteById('geo-across');
                assert.equal((await geo.withinRadius(args)).length, 1);
                assert.equal((await geo.withinRadius({...args, where: {id: 'geo-far'}})).length, 0);
                const defaults = base('GeoDefaults', {defaultWhere: {tag: 'keep'}});
                const defaultModel = db.model(defaults);
                await defaultModel.insert({
                    id: 'geo-keep',
                    tag: 'keep',
                    location: {lat: 0, lon: 0},
                });
                await defaultModel.insert({
                    id: 'geo-hide',
                    tag: 'hide',
                    location: {lat: 0, lon: 0},
                });
                assert.equal(
                    (await db.geo(defaults).withinRadius({...args, center: {lat: 0, lon: 0}}))
                        .length,
                    1
                );
                assert.equal(
                    (
                        await db.geo(defaults).withinBox({
                            strategy: 'gsi',
                            field: 'location',
                            bounds: {south: -1, north: 1, west: -1, east: 1},
                            queryOptions: consistency,
                        })
                    ).length,
                    1
                );
            }
        );
    } finally {
        for (const index of indexes) {
            try {
                await (index.scoped
                    ? bucket.scope(scope).searchIndexes()
                    : cluster.searchIndexes()
                ).dropIndex(index.name);
            } catch (error) {
                if (!/not.*found/i.test(error.message)) {
                    failures++;
                    console.error(`Cleanup Search: ${error.name}`);
                }
            }
        }
        try {
            if (scopeCreated) await bucket.collections().dropScope(scope);
        } catch (error) {
            failures++;
            console.error(`Cleanup scope: ${error.name}`);
        }
        try {
            await db.shutdown();
        } catch (error) {
            failures++;
            console.error(`Cleanup connection: ${error.name}: ${error.message}`);
        }
    }
    assert.equal(failures, 0, `${failures} live feature groups failed`);
}
main().catch((error) => {
    console.error(error.name, error.message);
    process.exitCode = 1;
});
