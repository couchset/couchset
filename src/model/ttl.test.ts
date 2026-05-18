import 'mocha';

import {expect} from 'chai';

import CouchbaseConnection from '../connection';

import {Model} from './index';
import {applyTtlOptions, ttlToSeconds} from './ttl';

describe('Model TTL helpers', () => {
    let calls: Array<{method: string; options?: any}>;

    beforeEach(() => {
        calls = [];
        CouchbaseConnection.Instance.bucketName = 'test';
        CouchbaseConnection.Instance.bucket = {
            defaultCollection: () => ({
                upsert: async (_key: string, _value: any, options?: any) => {
                    calls.push({method: 'upsert', options});
                },
                insert: async (_key: string, _value: any, options?: any) => {
                    calls.push({method: 'insert', options});
                },
            }),
        } as any;
    });

    it('converts unit ttl strings to Couchbase expiry seconds', () => {
        expect(ttlToSeconds('30s')).to.equal(30);
        expect(ttlToSeconds('2m')).to.equal(120);
        expect(ttlToSeconds('3h')).to.equal(10800);
        expect(ttlToSeconds('10d')).to.equal(864000);
        expect(ttlToSeconds('1w')).to.equal(604800);
    });

    it('passes raw expiry through when no ttl helper is used', () => {
        expect(applyTtlOptions({expiry: 123, timeout: 1000})).to.deep.equal({
            expiry: 123,
            timeout: 1000,
        });
    });

    it('normalizes ttlSeconds and ttl on model writes', async () => {
        const model = new Model('User');

        await model.insert({id: 'user-1'}, {ttl: '2m'});
        await model.upsert({id: 'user-2'}, {ttlSeconds: 300});
        await model.upsert({id: 'user-3'}, {ttl: '1d'});

        expect(calls.map((call) => call.options.expiry)).to.deep.equal([120, 300, 86400]);
        expect(calls.map((call) => call.method)).to.deep.equal(['insert', 'upsert', 'upsert']);
    });

    it('rejects ambiguous ttl values in strict mode', () => {
        expect(() => ttlToSeconds(10, true)).to.throw(
            'numeric ttl is ambiguous; use ttlSeconds or a unit string'
        );
        expect(() => ttlToSeconds('10', true)).to.throw(
            'ttl must include a supported unit: s, m, h, d, or w'
        );
    });
});
