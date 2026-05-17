import 'mocha';

import {expect} from 'chai';

import CouchbaseConnection from '../connection';

import {Model} from './index';

describe('Model keyspace targets', () => {
    beforeEach(() => {
        CouchbaseConnection.Instance.bucketName = 'test-bucket';
    });

    it('keeps default models on the bucket default collection', async () => {
        let usedDefaultCollection = false;
        CouchbaseConnection.Instance.bucket = {
            defaultCollection: () => {
                usedDefaultCollection = true;
                return {
                    upsert: async () => undefined,
                };
            },
        } as any;

        const model = new Model('User');
        await model.create({userId: 'ceddy'});

        expect(usedDefaultCollection).to.equal(true);
        expect(model.bucket()).to.equal('`test-bucket`');
        expect(model.keyspace()).to.equal('`test-bucket`');
        expect(model.from('user')).to.equal('`test-bucket` AS user');
    });

    it('uses configured Couchbase scope and collection for writes', async () => {
        const calls: Array<{scopeName: string; collectionName: string; key: string; value: any}> =
            [];
        CouchbaseConnection.Instance.bucket = {
            scope: (scopeName: string) => ({
                collection: (collectionName: string) => ({
                    upsert: async (key: string, value: any) => {
                        calls.push({scopeName, collectionName, key, value});
                    },
                }),
            }),
        } as any;

        const model = new Model('User', {scope: 'app', collection: 'users'});
        const created = await model.create({userId: 'ceddy'});

        expect(calls).to.have.length(1);
        expect(calls[0].scopeName).to.equal('app');
        expect(calls[0].collectionName).to.equal('users');
        expect(calls[0].key).to.equal(created.id);
        expect(calls[0].value._type).to.equal('User');
        expect(calls[0].value._scope).to.equal('app');
    });

    it('builds fully qualified keyspaces for scoped model queries', async () => {
        const calls: Array<{query: string; options?: any}> = [];
        CouchbaseConnection.Instance.bucket = {
            scope: () => ({
                collection: () => ({}),
            }),
        } as any;
        CouchbaseConnection.Instance.cluster = {
            query: async (query: string, options?: any) => {
                calls.push({query, options});
                return {rows: [{users: {id: 'one', userId: 'ceddy'}}]};
            },
        } as any;

        const model = new Model('User', {scope: 'app', collection: 'users'});
        const rows = await model.findMany<{id: string}>({
            where: {userId: 'ceddy'},
            limit: 1,
        });

        expect(model.keyspace()).to.equal('default:`test-bucket`.`app`.`users`');
        expect(model.from('user')).to.equal('default:`test-bucket`.`app`.`users` AS user');
        expect(calls[0].query).to.equal(
            'SELECT * FROM default:`test-bucket`.`app`.`users` WHERE (_type=$cs_param_0 AND userId=$cs_param_1) LIMIT $cs_limit OFFSET $cs_offset'
        );
        expect(rows).to.deep.equal([{id: 'one', userId: 'ceddy'}]);
    });
});
