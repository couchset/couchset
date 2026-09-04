import 'mocha';

import {expect} from 'chai';

import type {ModelConnection} from './model';
import {
    createCouchsetClient,
    createCouchsetTestFixture,
    dateCodec,
    defineModel,
    ModelDefinition,
} from './next';

interface FakeRuntime {
    connection: ModelConnection;
    collections: Array<{scope: string; collection: string}>;
    operations: string[];
    queries: string[];
    documents: Record<string, any>;
}

const fakeRuntime = (): FakeRuntime => {
    const collections: Array<{scope: string; collection: string}> = [
        {scope: '_default', collection: '_default'},
    ];
    const scopes = ['_default'];
    const operations: string[] = [];
    const queries: string[] = [];
    const documents: Record<string, any> = {};
    const manager = {
        createCollection: async (collection: string, scope: string) => {
            operations.push(`collection:${scope}.${collection}`);
            collections.push({collection, scope});
        },
        createScope: async (scope: string) => {
            operations.push(`scope:${scope}`);
            scopes.push(scope);
        },
        dropCollection: async (collection: string, scope: string) => {
            operations.push(`drop:${scope}.${collection}`);
        },
        dropScope: async (scope: string) => {
            operations.push(`drop-scope:${scope}`);
        },
        getAllScopes: async () => {
            const names = Array.from(new Set(scopes.concat(collections.map((item) => item.scope))));
            return names.map((name) => ({
                collections: collections.filter((item) => item.scope === name).map((item) => ({name: item.collection})),
                name,
            }));
        },
    };
    const collection = {
        get: async (id: string) => {
            if (!documents[id]) {
                const error: any = new Error('document not found');
                error.name = 'DocumentNotFoundError';
                throw error;
            }
            return {cas: documents[id].cas || 'cas-1', content: documents[id]};
        },
        insert: async (id: string, data: any) => {
            documents[id] = data;
        },
        remove: async (id: string, options: any) => {
            if (!documents[id]) {
                const error: any = new Error('document not found');
                error.name = 'DocumentNotFoundError';
                throw error;
            }
            if (options?.cas !== documents[id].cas) {
                const error: any = new Error('cas mismatch');
                error.name = 'CasMismatchError';
                throw error;
            }
            delete documents[id];
        },
        replace: async (id: string, data: any, options: any) => {
            if (options?.cas && options.cas !== documents[id]?.cas) {
                const error: any = new Error('cas mismatch');
                error.name = 'CasMismatchError';
                throw error;
            }
            documents[id] = {...data, cas: documents[id]?.cas || 'cas-1'};
        },
    };
    const cluster: any = {
        query: async (query: string) => {
            queries.push(query);
            if (query.indexOf('system:indexes') >= 0) {
                return {rows: []};
            }
            return {rows: []};
        },
        transactions: () => ({
            run: async (callback: any) => callback({
                get: async (_collection: any, id: string) => ({content: documents[id], id}),
                insert: async (_collection: any, id: string, data: any) => {
                    documents[id] = data;
                    return {content: data, id};
                },
                query: async () => ({rows: []}),
                remove: async (document: any) => delete documents[document.id],
                replace: async (document: any, data: any) => {
                    documents[document.id] = data;
                    return {content: data, id: document.id};
                },
            }),
        }),
    };
    const bucket: any = {
        collections: () => manager,
        defaultCollection: () => collection,
        scope: () => ({collection: () => collection}),
    };
    const connection: ModelConnection = {
        bucket,
        cluster,
        getBucket: () => 'test',
        getCollection: () => collection as any,
        isConnected: () => true,
        markDisconnected: () => undefined,
        ready: async () => connection,
        shouldReconnect: () => false,
    };

    return {collections, connection, documents, operations, queries};
};

describe('CouchSet next client primitives', () => {
    const sessions = defineModel<{id: string; expiresAt: Date; userId: string}>({
        codecs: {expiresAt: dateCodec},
        collection: 'sessions',
        indexes: [{fields: ['userId'], name: 'idx_session_user'}],
        name: 'Session',
        scope: 'auth',
    });

    it('owns a registry per injected client and codecs values at the SDK boundary', async () => {
        const runtime = fakeRuntime();
        const client = createCouchsetClient({
            bucketName: 'test',
            dependencies: {connection: runtime.connection},
        });
        const model = client.model(sessions);
        const expiresAt = new Date('2026-09-04T12:00:00.000Z');

        await model.insert({id: 'session-1', expiresAt, userId: 'user-1'});

        expect(client.definitions()).to.deep.equal([sessions]);
        expect(runtime.documents['session-1'].expiresAt).to.equal(expiresAt.toISOString());
        expect((await model.getById<any>('session-1')).expiresAt).to.be.instanceOf(Date);
    });

    it('keeps dotted-codec serialization and parsing immutable', async () => {
        const runtime = fakeRuntime();
        const client = createCouchsetClient({dependencies: {connection: runtime.connection}});
        const nested = defineModel<{id: string; payload: {expiresAt: Date}}>({
            codecs: {'payload.expiresAt': dateCodec},
            name: 'NestedSession',
        });
        const model = client.model(nested);
        const input = {id: 'nested-1', payload: {expiresAt: new Date('2026-09-04T12:00:00.000Z')}};

        await model.insert(input);
        expect(input.payload.expiresAt).to.be.instanceOf(Date);
        expect(runtime.documents['nested-1'].payload.expiresAt).to.equal(
            '2026-09-04T12:00:00.000Z'
        );

        const parsed = await model.getById('nested-1');
        expect(parsed.payload.expiresAt).to.be.instanceOf(Date);
        expect(runtime.documents['nested-1'].payload.expiresAt).to.equal(
            '2026-09-04T12:00:00.000Z'
        );
    });

    it('provisions named scopes then collections, without touching the default target', async () => {
        const runtime = fakeRuntime();
        const client = createCouchsetClient({
            bucketName: 'test',
            dependencies: {connection: runtime.connection},
            models: [sessions, defineModel({name: 'Default'})],
        });

        const created = await client.ensureCollections();

        expect(runtime.operations).to.deep.equal(['scope:auth', 'collection:auth.sessions']);
        expect(created.find((item) => item.scope === 'auth' && item.collection === 'sessions')).to.deep.include({
            collection: 'sessions',
            createdCollection: true,
            createdScope: true,
            scope: 'auth',
        });
    });

    it('keeps normal ensureIndexes create-only', async () => {
        const runtime = fakeRuntime();
        const client = createCouchsetClient({
            bucketName: 'test',
            dependencies: {connection: runtime.connection},
            models: [sessions],
        });

        await client.ensureIndexes();

        expect(runtime.queries).to.deep.equal([
            'CREATE INDEX IF NOT EXISTS `idx_session_user` ON default:`test`.`auth`.`sessions`(userId)',
        ]);
    });

    it('returns clear consumeOnce outcomes without refreshing a CAS', async () => {
        const runtime = fakeRuntime();
        const client = createCouchsetClient({
            bucketName: 'test',
            dependencies: {connection: runtime.connection},
        });
        const model = client.model(sessions);
        runtime.documents.link = {cas: 'correct', id: 'link'};

        expect(await model.consumeOnce('link', 'wrong')).to.deep.equal({status: 'conflict'});
        expect(await model.consumeOnce('missing', 'anything')).to.deep.equal({status: 'missing'});
        expect(await model.consumeOnce('link', 'correct')).to.deep.equal({status: 'consumed'});
    });

    it('binds transaction models to the attempt context instead of normal collection writes', async () => {
        const runtime = fakeRuntime();
        const client = createCouchsetClient({
            bucketName: 'test',
            dependencies: {connection: runtime.connection},
        });
        const transactionSessions = defineModel({
            ...sessions,
            validateCreate: (document: any) => ({...document, createValidated: true}),
            validateReplace: (document: any) => ({...document, replaceValidated: true}),
        });

        const value = await client.transaction(async (transaction) => {
            const model = transaction.model(transactionSessions);
            const inserted = await model.insert('tx-1', {
                expiresAt: new Date('2026-09-04T12:00:00.000Z'),
                id: 'tx-1',
                userId: 'u1',
            });
            const replaced = await model.replace(inserted, {...inserted.content, userId: 'u2'});
            return replaced.content.userId;
        });

        expect(value).to.equal('u2');
        expect(runtime.documents['tx-1'].userId).to.equal('u2');
        expect(runtime.documents['tx-1']).to.include({_scope: 'auth', _type: 'Session'});
        expect(runtime.documents['tx-1'].createdAt).to.be.instanceOf(Date);
        expect(runtime.documents['tx-1'].expiresAt).to.equal('2026-09-04T12:00:00.000Z');
        expect(runtime.documents['tx-1']).to.include({createValidated: true, replaceValidated: true});
    });

    it('reports index drift as a versioned replacement plan without executing DDL', async () => {
        const runtime = fakeRuntime();
        (runtime.connection.cluster as any).query = async (query: string) => {
            runtime.queries.push(query);
            return {
                rows: query.indexOf('system:indexes') >= 0
                    ? [{
                        collection_id: 'sessions',
                        index_key: ['userId'],
                        is_primary: false,
                        keyspace_id: 'test',
                        name: 'idx_session_user',
                        scope_id: 'auth',
                        state: 'online',
                    }]
                    : [],
            };
        };
        const changed: ModelDefinition<any> = {
            ...sessions,
            indexes: [{fields: ['userId', 'expiresAt'], name: 'idx_session_user'}],
        };
        const client = createCouchsetClient({
            bucketName: 'test',
            dependencies: {connection: runtime.connection},
            models: [changed],
        });

        const plan = await client.planIndexes();

        expect(plan.items[0].status).to.equal('replace');
        expect(plan.items[0].createAs).to.match(/^idx_session_user_v/);
        expect(runtime.queries).to.have.length(1);
    });

    it('matches an unchanged partial index using its SQL++ condition', async () => {
        const runtime = fakeRuntime();
        (runtime.connection.cluster as any).query = async (query: string) => ({
            rows: query.indexOf('system:indexes') >= 0
                ? [{
                    collection_id: 'sessions',
                    condition: '(`deleted` IS MISSING)',
                    index_key: ['`userId`'],
                    is_primary: false,
                    name: 'idx_active_session',
                    scope_id: 'auth',
                    state: 'online',
                }]
                : [],
        });
        const partial: ModelDefinition<any> = {
            ...sessions,
            indexes: [{
                fields: ['userId'],
                name: 'idx_active_session',
                where: {deleted: {$isMissing: true}},
            }],
        };
        const client = createCouchsetClient({dependencies: {connection: runtime.connection}});

        const plan = await client.planIndexes({models: [partial]});

        expect(plan.items[0].status).to.equal('matching');
    });

    it('applies a reviewed replacement by waiting before the opt-in old-index drop', async () => {
        const runtime = fakeRuntime();
        let replacementCreated = false;
        let catalogReads = 0;
        (runtime.connection.cluster as any).query = async (query: string) => {
            runtime.queries.push(query);
            if (query.indexOf('CREATE INDEX') === 0) {
                replacementCreated = true;
                return {rows: []};
            }
            if (query.indexOf('system:indexes') >= 0) {
                catalogReads += 1;
                if (!replacementCreated) {
                    return {rows: []};
                }
                return {rows: [catalogReads === 1
                    ? {collection_id: 'other', name: 'idx_session_user_v2', scope_id: 'other', state: 'online'}
                    : {collection_id: 'sessions', name: 'idx_session_user_v2', scope_id: 'auth', state: 'online'}]};
            }
            return {rows: []};
        };
        const client = createCouchsetClient({
            bucketName: 'test',
            dependencies: {connection: runtime.connection},
        });

        await client.applyIndexPlan({
            items: [{
                createAs: 'idx_session_user_v2',
                definition: {fields: ['userId', 'expiresAt'], name: 'idx_session_user'},
                keyspace: 'default:`test`.`auth`.`sessions`',
                replaces: 'idx_session_user',
                status: 'replace',
                target: {collection: 'sessions', scope: 'auth'},
            }],
        }, {dropReplaced: true});

        expect(runtime.queries[0]).to.contain('CREATE INDEX IF NOT EXISTS `idx_session_user_v2`');
        expect(runtime.queries[1]).to.contain('system:indexes');
        expect(catalogReads).to.equal(2);
        expect(runtime.queries[3]).to.equal(
            'DROP INDEX default:`test`.`auth`.`sessions`.`idx_session_user`'
        );
    });

    it('converges after a replacement has dropped its predecessor', async () => {
        const runtime = fakeRuntime();
        const changed: ModelDefinition<any> = {
            ...sessions,
            indexes: [{fields: ['userId', 'expiresAt'], name: 'idx_session_user'}],
        };
        const rows: any[] = [{
            collection_id: 'sessions',
            index_key: ['userId'],
            is_primary: false,
            name: 'idx_session_user',
            scope_id: 'auth',
            state: 'online',
        }];
        (runtime.connection.cluster as any).query = async (query: string) => {
            runtime.queries.push(query);
            if (query.indexOf('system:indexes') >= 0) {
                return {rows};
            }
            if (query.indexOf('CREATE INDEX') === 0) {
                const name = /`([^`]+)`/.exec(query)?.[1];
                rows.push({
                    collection_id: 'sessions',
                    index_key: ['userId', 'expiresAt'],
                    is_primary: false,
                    name,
                    scope_id: 'auth',
                    state: 'online',
                });
            }
            if (query.indexOf('DROP INDEX') === 0) {
                const old = 'idx_session_user';
                const position = rows.findIndex((row) => row.name === old);
                rows.splice(position, 1);
            }
            return {rows: []};
        };
        const client = createCouchsetClient({
            dependencies: {connection: runtime.connection},
            models: [changed],
        });

        const first = await client.planIndexes();
        await client.applyIndexPlan(first, {dropReplaced: true});
        const second = await client.planIndexes();

        expect(first.items[0].status).to.equal('replace');
        expect(second.items[0]).to.include({createAs: first.items[0].createAs, status: 'matching'});
    });

    it('rejects duplicate registry identities with changed definitions', () => {
        const runtime = fakeRuntime();
        const client = createCouchsetClient({dependencies: {connection: runtime.connection}});
        client.model(sessions);

        expect(() => client.model({...sessions, indexes: [{fields: ['expiresAt'], name: 'idx_session_user'}]}))
            .to.throw('already registered with a different definition');
    });

    it('derives the bucket from an injected connection and cleans up generated fixture scopes', async () => {
        const runtime = fakeRuntime();
        const client = createCouchsetClient({dependencies: {connection: runtime.connection}});
        const definition = defineModel({name: 'Fixture'});
        const fixture = await createCouchsetTestFixture(client, definition);

        expect(client.keyspace(fixture.definition)).to.contain('`test`');
        await fixture.cleanup();
        expect(runtime.operations.some((operation) => operation.indexOf('drop-scope:couchset_test_') === 0))
            .to.equal(true);

        const undefinedScopeFixture = await createCouchsetTestFixture(client, defineModel({
            name: 'UndefinedScopeFixture',
            scope: undefined,
        }));
        await undefinedScopeFixture.cleanup();
        expect(runtime.operations.filter((operation) => operation.indexOf('drop-scope:couchset_test_') === 0))
            .to.have.length(2);
    });
});
