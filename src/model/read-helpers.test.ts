import 'mocha';

import {expect} from 'chai';

import CouchbaseConnection from '../connection';

import {Model} from './index';

describe('Model read helpers', () => {
    const model = new Model('User', {schema: {createdAt: 'date'}});
    let calls: Array<{query: string; options?: any}>;

    beforeEach(() => {
        calls = [];
        CouchbaseConnection.Instance.bucketName = 'test';
        CouchbaseConnection.Instance.bucket = {defaultCollection: () => ({})} as any;
        CouchbaseConnection.Instance.cluster = {
            query: async (query: string, options?: any) => {
                calls.push({query, options});
                return {
                    rows: [
                        {
                            test: {
                                id: 'one',
                                userId: 'ceddy',
                                createdAt: '2026-05-17T22:00:00.000Z',
                            },
                        },
                        {
                            test: {
                                id: 'two',
                                userId: 'ceddy',
                                createdAt: '2026-05-17T22:01:00.000Z',
                            },
                        },
                        {
                            test: {
                                id: 'three',
                                userId: 'ceddy',
                                createdAt: '2026-05-17T22:02:00.000Z',
                            },
                        },
                    ],
                };
            },
        } as any;
    });

    it('findMany injects _type and passes values as parameters', async () => {
        const rows = await model.findMany<{id: string; createdAt: Date}>({
            where: {userId: 'ceddy'},
            limit: 2,
            page: 1,
        });

        expect(calls[0].query).to.equal(
            'SELECT * FROM `test` WHERE (_type=$cs_param_0 AND userId=$cs_param_1) LIMIT $cs_limit OFFSET $cs_offset'
        );
        expect(calls[0].options).to.deep.equal({
            parameters: {
                cs_param_0: 'User',
                cs_param_1: 'ceddy',
                cs_limit: 2,
                cs_offset: 2,
            },
        });
        expect(rows[0].id).to.equal('one');
        expect(rows[0].createdAt).to.be.instanceOf(Date);
    });

    it('findOne returns the first matching row or null', async () => {
        const row = await model.findOne<{id: string}>({where: {userId: 'ceddy'}});

        expect(row).to.deep.include({id: 'one', userId: 'ceddy'});
        expect(calls[0].options.parameters.cs_limit).to.equal(1);

        CouchbaseConnection.Instance.cluster = {
            query: async () => ({rows: []}),
        } as any;

        expect(await model.findOne({where: {userId: 'missing'}})).to.equal(null);
    });

    it('exists uses a cheap raw 1 query', async () => {
        const found = await model.exists({where: {userId: 'ceddy'}});

        expect(found).to.equal(true);
        expect(calls[0].query).to.equal(
            'SELECT RAW 1 FROM `test` WHERE (_type=$cs_param_0 AND userId=$cs_param_1) LIMIT $cs_limit OFFSET $cs_offset'
        );
    });

    it('count returns the raw count value', async () => {
        CouchbaseConnection.Instance.cluster = {
            query: async (query: string, options?: any) => {
                calls.push({query, options});
                return {rows: [3]};
            },
        } as any;

        const total = await model.count({where: {userId: 'ceddy'}});

        expect(total).to.equal(3);
        expect(calls[0].query).to.equal(
            'SELECT RAW COUNT(1) FROM `test` WHERE (_type=$cs_param_0 AND userId=$cs_param_1)'
        );
        expect(calls[0].options.parameters).to.deep.equal({
            cs_param_0: 'User',
            cs_param_1: 'ceddy',
        });
    });

    it('page fetches limit + 1 rows and trims the extra row', async () => {
        const page = await model.page<{id: string}>({where: {userId: 'ceddy'}, limit: 2});

        expect(calls[0].options.parameters.cs_limit).to.equal(3);
        expect(page.items.map((row) => row.id)).to.deep.equal(['one', 'two']);
        expect(page.hasNext).to.equal(true);
        expect(page.pageInfo).to.deep.equal({
            limit: 2,
            page: 0,
            offset: 0,
            nextPage: 1,
            nextOffset: 2,
        });
    });

    it('throws by default and can return empty fallbacks with throwOnError false', async () => {
        const error = new Error('read failed');
        CouchbaseConnection.Instance.cluster = {
            query: async () => {
                throw error;
            },
        } as any;

        try {
            await model.findMany({where: {userId: 'ceddy'}});
            throw new Error('expected findMany to reject');
        } catch (caught) {
            expect(caught).to.equal(error);
        }

        expect(await model.findMany({where: {userId: 'ceddy'}, throwOnError: false})).to.deep.equal(
            []
        );
        expect(await model.findOne({where: {userId: 'ceddy'}, throwOnError: false})).to.equal(null);
        expect(await model.exists({where: {userId: 'ceddy'}, throwOnError: false})).to.equal(false);
        expect(await model.count({where: {userId: 'ceddy'}, throwOnError: false})).to.equal(0);
    });
});
