import 'mocha';

import {expect} from 'chai';

import CouchbaseConnection from '../connection';

import {Model} from './index';

describe('Model safe query APIs', () => {
    const model = new Model('User');
    let calls: Array<{query: string; options?: any}>;

    beforeEach(() => {
        calls = [];
        CouchbaseConnection.Instance.bucketName = 'test-bucket';
        CouchbaseConnection.Instance.bucket = {defaultCollection: () => ({})} as any;
        CouchbaseConnection.Instance.cluster = {
            query: async (query: string, options?: any) => {
                calls.push({query, options});
                return {rows: [{id: 1}, {id: 2}, {id: 3}]};
            },
        } as any;
    });

    it('passes named parameters to the Couchbase SDK query options', async () => {
        await model.queryRows('SELECT * FROM bucket WHERE type = $type', {type: 'User'});

        expect(calls[0].options).to.deep.equal({parameters: {type: 'User'}});
    });

    it('passes positional parameters to the Couchbase SDK query options', async () => {
        await model.queryRows('SELECT * FROM bucket WHERE type = ?', ['User']);

        expect(calls[0].options).to.deep.equal({parameters: ['User']});
    });

    it('returns rows directly from queryRows()', async () => {
        const rows = await model.queryRows<{id: number}>('SELECT * FROM bucket');

        expect(rows).to.deep.equal([{id: 1}, {id: 2}, {id: 3}]);
    });

    it('returns the first row from queryOne()', async () => {
        const row = await model.queryOne<{id: number}>('SELECT * FROM bucket');

        expect(row).to.deep.equal({id: 1});
    });

    it('returns null from queryOne() when there are no rows', async () => {
        CouchbaseConnection.Instance.cluster = {
            query: async (query: string, options?: any) => {
                calls.push({query, options});
                return {rows: []};
            },
        } as any;

        const row = await model.queryOne<{id: number}>('SELECT * FROM bucket');

        expect(row).to.equal(null);
    });

    it('fetches limit + 1 rows in queryPage(), trims the extra row, and sets hasNext', async () => {
        const page = await model.queryPage<{id: number}>(
            'SELECT * FROM bucket LIMIT $limit',
            {limit: 2}
        );

        expect(calls[0].options).to.deep.equal({parameters: {limit: 3}});
        expect(page.items).to.deep.equal([{id: 1}, {id: 2}]);
        expect(page.hasNext).to.equal(true);
        expect(page.params).to.deep.equal({limit: 3});
    });

    it('rejects query failures in the new APIs', async () => {
        const error = new Error('query failed');
        CouchbaseConnection.Instance.cluster = {
            query: async () => {
                throw error;
            },
        } as any;

        try {
            await model.queryRows('SELECT * FROM bucket');
            throw new Error('expected queryRows to reject');
        } catch (caught) {
            expect(caught).to.equal(error);
        }
    });

    it('builds a bucket FROM helper with an alias', () => {
        expect(model.from('user')).to.equal('`test-bucket` AS user');
    });
});
