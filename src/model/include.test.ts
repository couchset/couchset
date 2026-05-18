import 'mocha';

import {expect} from 'chai';

import CouchbaseConnection from '../connection';

import {buildIncludeClauses, buildIncludedSelectionQuery} from './include';
import {Model} from './index';

describe('Model include helpers', () => {
    beforeEach(() => {
        CouchbaseConnection.Instance.bucketName = 'test';
        CouchbaseConnection.Instance.bucket = {defaultCollection: () => ({})} as any;
    });

    it('builds JOIN, LEFT JOIN, and NEST clauses', () => {
        const clauses = buildIncludeClauses('`test`', [
            {as: 'owner', key: 'owner'},
            {as: 'members', keys: 'members', type: 'nest'},
            {as: 'lastMessage', key: 'lastMessage', optional: true},
        ]);

        expect(clauses).to.equal(
            'JOIN `test` AS owner ON KEYS doc.owner NEST `test` AS members ON KEYS doc.members LEFT JOIN `test` AS lastMessage ON KEYS doc.lastMessage'
        );
    });

    it('can target another model keyspace', () => {
        const ownerModel = new Model('User', {scope: 'app', collection: 'users'});
        const clauses = buildIncludeClauses('`test`', [
            {as: 'owner', key: 'owner', model: ownerModel},
        ]);

        expect(clauses).to.equal(
            'JOIN default:`test`.`app`.`users` AS owner ON KEYS doc.owner'
        );
    });

    it('builds a populated select query with parameterized source filters', () => {
        const query = buildIncludedSelectionQuery({
            keyspace: '`test`',
            collectionName: 'ChatConvo',
            where: {
                $and: [
                    {_type: {$eq: 'ChatConvo'}},
                    {owner: {$eq: 'owner-1'}},
                    {updatedAt: {$lte: '2026-05-17T20:00:00.000Z'}},
                ],
            },
            include: [{as: 'owner', key: 'owner'}],
            orderBy: {updatedAt: 'DESC'},
            limit: 1,
            page: 0,
        });

        expect(query.query).to.equal(
            'SELECT OBJECT_CONCAT(doc, {"owner": owner}) AS doc FROM `test` AS doc JOIN `test` AS owner ON KEYS doc.owner WHERE (doc._type=$cs_param_0 AND doc.owner=$cs_param_1 AND doc.updatedAt<=$cs_param_2) ORDER BY doc.updatedAt DESC LIMIT $cs_limit OFFSET $cs_offset'
        );
        expect(query.parameters).to.deep.equal({
            cs_param_0: 'ChatConvo',
            cs_param_1: 'owner-1',
            cs_param_2: '2026-05-17T20:00:00.000Z',
            cs_limit: 1,
            cs_offset: 0,
        });
        expect(query.resultKey).to.equal('doc');
    });

    it('findOne executes include queries and unwraps the populated document', async () => {
        const calls: Array<{query: string; options?: any}> = [];
        CouchbaseConnection.Instance.cluster = {
            query: async (query: string, options?: any) => {
                calls.push({query, options});
                return {
                    rows: [
                        {
                            doc: {
                                id: 'convo-1',
                                owner: {id: 'owner-1', username: 'ceddy'},
                                _type: 'ChatConvo',
                            },
                        },
                    ],
                };
            },
        } as any;

        const model = new Model('ChatConvo');
        const row = await model.findOne<{id: string; owner: {id: string}}>({
            where: {owner: 'owner-1'},
            include: [{as: 'owner', key: 'owner'}],
        });

        expect(calls[0].query).to.equal(
            'SELECT OBJECT_CONCAT(doc, {"owner": owner}) AS doc FROM `test` AS doc JOIN `test` AS owner ON KEYS doc.owner WHERE (doc._type=$cs_param_0 AND doc.owner=$cs_param_1) LIMIT $cs_limit OFFSET $cs_offset'
        );
        expect(calls[0].options.parameters).to.deep.equal({
            cs_param_0: 'ChatConvo',
            cs_param_1: 'owner-1',
            cs_limit: 1,
            cs_offset: 0,
        });
        expect(row).to.deep.include({id: 'convo-1', _type: 'ChatConvo'});
        expect(row.owner).to.deep.equal({id: 'owner-1', username: 'ceddy'});
    });
});
