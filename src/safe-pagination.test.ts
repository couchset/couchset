import 'mocha';

import {expect} from 'chai';

import CouchbaseConnection from './connection';
import {Pagination} from './pagination';
import {buildPaginationQuery} from './pagination/safe-pagination';

describe('Safe pagination', () => {
    it('builds pagination queries with SDK parameters', () => {
        const {query, parameters, selectAll} = buildPaginationQuery({
            bucketName: 'test',
            select: ['id', 'password'],
            where: {
                where: {
                    _type: {$eq: 'User'},
                    userId: {$eq: 'ceddy'},
                    $or: [{userId: {$eq: 'ceddy'}}, {phone: 10}],
                },
            },
            limit: 10,
            page: 2,
            orderBy: {createdAt: 'DESC'},
        });

        expect(query).to.equal(
            'SELECT id,`password` FROM `test` WHERE _type=$cs_param_0 AND userId=$cs_param_1 AND (userId=$cs_param_2 OR phone=$cs_param_3) ORDER BY createdAt DESC LIMIT $cs_limit OFFSET $cs_offset'
        );
        expect(parameters).to.deep.equal({
            cs_param_0: 'User',
            cs_param_1: 'ceddy',
            cs_param_2: 'ceddy',
            cs_param_3: 10,
            cs_limit: 10,
            cs_offset: 20,
        });
        expect(selectAll).to.equal(false);
    });

    it('keeps unsafe string values out of the generated query text', () => {
        const unsafeValue = 'ceddy" OR 1=1 --';
        const {query, parameters} = buildPaginationQuery({
            bucketName: 'test',
            select: '*',
            where: {
                where: {
                    userId: {$eq: unsafeValue},
                },
            },
            limit: 1,
            page: 0,
        });

        expect(query).not.to.contain(unsafeValue);
        expect(query).to.contain('userId=$cs_param_0');
        expect(parameters.cs_param_0).to.equal(unsafeValue);
    });

    it('passes parameters to Couchbase and unwraps SELECT * rows', async () => {
        const calls: Array<{query: string; options?: any}> = [];
        CouchbaseConnection.Instance.cluster = {
            query: async (query: string, options?: any) => {
                calls.push({query, options});
                return {rows: [{test: {id: 'one', userId: 'ceddy'}}]};
            },
        } as any;

        const rows = await Pagination({
            bucketName: 'test',
            select: '*',
            where: {
                where: {
                    _type: {$eq: 'User'},
                    userId: {$eq: 'ceddy'},
                },
            },
            limit: 5,
            page: 1,
        });

        expect(rows).to.deep.equal([{id: 'one', userId: 'ceddy'}]);
        expect(calls[0].options).to.deep.equal({
            parameters: {
                cs_param_0: 'User',
                cs_param_1: 'ceddy',
                cs_limit: 5,
                cs_offset: 5,
            },
        });
    });
});
