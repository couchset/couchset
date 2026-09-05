import 'mocha';
import {expect} from 'chai';
import {QueryScanConsistency, MutationState} from 'couchbase';
import CouchbaseConnection from '../connection';
import {Model} from './index';
import {joinField} from './include';
import {Pagination} from '../pagination/pagination';
import {CustomQuery} from '../search/customQuery';

describe('Read consistency forwarding', () => {
    let calls: any[];
    const model = new Model('Battle');
    beforeEach(() => {
        calls = [];
        CouchbaseConnection.Instance.bucketName = 'test';
        CouchbaseConnection.Instance.bucket = {defaultCollection: () => ({})} as any;
        CouchbaseConnection.Instance.cluster = {
            query: async (query: string, options: any) => {
                calls.push({query, options});
                return {rows: []};
            },
        } as any;
    });
    const includes = [
        {
            as: 'creator',
            type: 'leftJoin' as const,
            on: {
                left: joinField('creator.ownerUserId'),
                op: '$eq' as const,
                right: joinField('doc.createdByUserId'),
            },
        },
    ];
    it('forwards request_plus and mutation state unchanged across supported SQL++ reads', async () => {
        const state = new MutationState();
        for (const queryOptions of [
            {scanConsistency: QueryScanConsistency.RequestPlus},
            {consistentWith: state},
        ]) {
            for (const include of [undefined, includes]) {
                await model.findMany({include, queryOptions});
                await model.findOne({include, queryOptions});
                await model.page({include, queryOptions});
            }
            await model.exists({queryOptions});
            await model.count({queryOptions});
            await model.queryRows('SELECT 1', {x: 1}, queryOptions);
            await model.queryOne('SELECT 1', {x: 1}, queryOptions);
            await model.queryPage('SELECT 1 LIMIT $limit', {limit: 1}, queryOptions);
            await Pagination({bucketName: 'test', where: {}, queryOptions});
            await CustomQuery({query: 'SELECT 1', limit: 1, queryOptions});
            const round = calls.splice(0);
            expect(round).to.have.length(13);
            for (const call of round) {
                if ('consistentWith' in queryOptions)
                    expect(call.options.consistentWith).to.equal(state);
                else expect(call.options.scanConsistency).to.equal('request_plus');
            }
        }
    });
    it('preserves SDK defaults, binds paging parameters, and strips helper options', async () => {
        await model.findMany();
        expect(calls[0].options).to.have.keys('parameters');
        await model.page({
            include: includes,
            limit: 2,
            queryOptions: {
                scanConsistency: QueryScanConsistency.NotBounded,
                timeout: 1234,
                debug: true,
                logger: () => undefined,
            },
        });
        expect(calls[1].options).to.include({scanConsistency: 'not_bounded', timeout: 1234});
        expect(calls[1].options).not.to.have.property('debug');
        expect(calls[1].options).not.to.have.property('logger');
        expect(calls[1].options.parameters.cs_limit).to.equal(3);
    });
    it('rejects incompatible or unsupported consistency before query execution, even with fallback enabled', async () => {
        for (const queryOptions of [
            {
                scanConsistency: QueryScanConsistency.RequestPlus,
                consistentWith: new MutationState(),
            },
            {scanConsistency: QueryScanConsistency.NotBounded, consistentWith: new MutationState()},
            {scanConsistency: 'at_plus' as any},
            {raw: {scan_consistency: 'request_plus'}},
        ]) {
            const operations = [
                () => model.findMany({include: includes, queryOptions, throwOnError: false}),
                () => model.findOne({queryOptions, throwOnError: false}),
                () => model.page({queryOptions, throwOnError: false}),
                () => model.exists({queryOptions, throwOnError: false}),
                () => model.count({queryOptions, throwOnError: false}),
                () => model.queryRows('SELECT 1', {}, queryOptions),
                () =>
                    Pagination({bucketName: 'test', where: {}, queryOptions, throwOnError: false}),
                () => CustomQuery({query: 'SELECT 1', limit: 1, queryOptions, throwOnError: false}),
            ];
            for (const operation of operations) {
                let error: unknown;
                try {
                    await operation();
                } catch (caught) {
                    error = caught;
                }
                expect(error).to.be.instanceOf(Error);
            }
        }
        expect(calls).to.have.length(0);
    });
    it('rejects includes on aggregate helpers instead of silently ignoring them', async () => {
        for (const operation of [
            () => model.count({include: includes}),
            () => model.exists({include: includes}),
        ]) {
            let error: any;
            try {
                await operation();
            } catch (caught) {
                error = caught;
            }
            expect(error?.message).to.contain('do not support includes');
        }
        expect(calls).to.have.length(0);
    });
});
