import 'mocha';

import {expect} from 'chai';

import CouchbaseConnection from '../connection';

import {CustomQuery} from './customQuery';

describe('CustomQuery', () => {
    let calls: Array<{query: string; options?: any}>;

    beforeEach(() => {
        calls = [];
        CouchbaseConnection.Instance.cluster = {
            query: async (query: string, options?: any) => {
                calls.push({query, options});
                return {rows: [{id: 1}, {id: 2}, {id: 3}]};
            },
        } as any;
    });

    it('runs with SDK parameters and tuple pagination metadata', async () => {
        const [rows, pagination] = await CustomQuery<{id: number}>({
            query: 'SELECT * FROM bucket',
            params: {limit: 2},
            limit: 2,
        });

        expect(rows).to.deep.equal([{id: 1}, {id: 2}, {id: 3}]);
        expect(pagination).to.deep.equal({params: {limit: 2}, hasNext: true});
        expect(calls[0].options).to.deep.equal({parameters: {limit: 2}});
    });

    it('rejects failures by default', async () => {
        const error = new Error('query failed');
        CouchbaseConnection.Instance.cluster = {
            query: async () => {
                throw error;
            },
        } as any;

        try {
            await CustomQuery<{id: number}>({
                query: 'SELECT * FROM bucket',
                params: {limit: 2},
                limit: 2,
            });
            throw new Error('expected CustomQuery to reject');
        } catch (caught) {
            expect(caught).to.equal(error);
        }
    });

    it('can return fallbacks with throwOnError false', async () => {
        CouchbaseConnection.Instance.cluster = {
            query: async () => {
                throw new Error('fallback failure');
            },
        } as any;

        const [rows, pagination] = await CustomQuery<{id: number}>({
            query: 'SELECT * FROM bucket',
            params: {limit: 2},
            limit: 2,
            throwOnError: false,
        });

        expect(rows).to.deep.equal([]);
        expect(pagination).to.deep.equal({params: {limit: 2}, hasNext: false});
    });
});
