import 'mocha';

import {expect} from 'chai';

import {Model as NewModel} from '../model';

import CouchbaseConnection from './connection';
import {Model as LegacyModel} from './model';

describe('legacy entrypoint', () => {
    let calls: Array<{query: string; options?: any}>;

    beforeEach(() => {
        calls = [];
        CouchbaseConnection.Instance.bucketName = 'test';
        CouchbaseConnection.Instance.bucket = {
            defaultCollection: () => ({
                get: async () => ({
                    content: {
                        createdAt: '2026-05-17T10:00:00.000Z',
                        id: 'user-1',
                    },
                }),
                remove: async () => undefined,
                replace: async () => undefined,
                upsert: async () => undefined,
            }),
        } as any;
        CouchbaseConnection.Instance.cluster = {
            query: async (query: string, options?: any) => {
                calls.push({options, query});
                return {
                    rows: [
                        {
                            test: {
                                createdAt: '2026-05-17T10:00:00.000Z',
                                id: 'user-1',
                                userId: 'ceddy',
                            },
                        },
                    ],
                };
            },
        } as any;
    });

    it('exports a legacy Model class that is separate from the new Model', () => {
        const legacy = new LegacyModel('User');
        const modern = new NewModel('User');

        expect(LegacyModel).to.not.equal(NewModel);
        expect((legacy as any).findMany).to.equal(undefined);
        expect((legacy as any).queryRows).to.equal(undefined);
        expect((legacy as any).ensureIndexes).to.equal(undefined);
        expect((modern as any).findMany).to.be.a('function');
    });

    it('preserves legacy pagination without SDK parameters', async () => {
        const model = new LegacyModel('User', {schema: {createdAt: 'date'}});
        const rows = await model.pagination({
            limit: 10,
            page: 0,
            select: '*',
            where: {userId: {$eq: 'ceddy'}},
        });

        expect(calls[0].options).to.equal(undefined);
        expect(calls[0].query).to.not.contain('$cs_param');
        expect(rows[0].id).to.equal('user-1');
        expect(rows[0].createdAt).to.be.instanceOf(Date);
    });

    it('preserves legacy customQuery tuple and raw cluster.query call', async () => {
        const model = new LegacyModel('User');
        const [rows, page] = await model.customQuery<{test: {id: string}}>({
            limit: 1,
            params: {id: 'user-1'},
            query: 'SELECT * FROM `test` WHERE id=$id',
        });

        expect(calls[0]).to.deep.equal({
            options: undefined,
            query: 'SELECT * FROM `test` WHERE id=$id',
        });
        expect(rows).to.have.length(1);
        expect(page).to.deep.equal({hasNext: true, params: {id: 'user-1'}});
    });
});
