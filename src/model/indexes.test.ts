import 'mocha';

import {expect} from 'chai';

import CouchbaseConnection from '../connection';
import {couchset} from '../index';

import {Model} from './index';
import {buildIndexQuery} from './indexes';

describe('Model index declarations', () => {
    let queries: string[];

    beforeEach(() => {
        queries = [];
        CouchbaseConnection.Instance.bucketName = 'test';
        CouchbaseConnection.Instance.bucket = {defaultCollection: () => ({})} as any;
        CouchbaseConnection.Instance.cluster = {
            query: async (query: string) => {
                queries.push(query);
                return {rows: []};
            },
        } as any;
    });

    it('builds secondary index statements with fields and sort order', () => {
        const query = buildIndexQuery('`test`', {
            name: 'idx_trade_conid_date',
            fields: ['instrument.conId', '_type', 'date', {createdAt: 'DESC'}],
        });

        expect(query).to.equal(
            'CREATE INDEX IF NOT EXISTS `idx_trade_conid_date` ON `test`(instrument.conId,_type,date,createdAt DESC)'
        );
    });

    it('supports partial indexes and deferred builds', () => {
        const query = buildIndexQuery(
            '`test`',
            {
                name: 'idx_trade_active',
                fields: ['_type', 'workspaceId', 'deleted'],
                where: {deleted: {$isMissing: true}},
            },
            {deferred: true}
        );

        expect(query).to.equal(
            'CREATE INDEX IF NOT EXISTS `idx_trade_active` ON `test`(_type,workspaceId,deleted) WHERE deleted IS MISSING WITH {"defer_build": true}'
        );
    });

    it('supports named primary indexes', () => {
        const query = buildIndexQuery('`test`', {
            name: 'primary_test',
            primary: true,
        });

        expect(query).to.equal('CREATE PRIMARY INDEX IF NOT EXISTS `primary_test` ON `test`');
    });

    it('executes declared model indexes against the current keyspace', async () => {
        const model = new Model('User', {
            indexes: [{name: 'idx_user_email', fields: ['_type', 'email']}],
        });

        const created = await model.ensureIndexes();

        expect(created).to.deep.equal([
            'CREATE INDEX IF NOT EXISTS `idx_user_email` ON `test`(_type,email)',
        ]);
        expect(queries).to.deep.equal(created);
    });

    it('exposes root couchset ensureIndexes helper', async () => {
        new Model('RootIndexUser', {
            indexes: [{name: 'idx_root_user_email', fields: ['_type', 'email']}],
        });

        const created = await (couchset as any).ensureIndexes();

        expect(created).to.include(
            'CREATE INDEX IF NOT EXISTS `idx_root_user_email` ON `test`(_type,email)'
        );
        expect(queries).to.include(
            'CREATE INDEX IF NOT EXISTS `idx_root_user_email` ON `test`(_type,email)'
        );
    });
});
