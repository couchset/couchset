import 'mocha';

import {expect} from 'chai';

import CouchbaseConnection from './connection';

const args = {
    bucketName: 'test',
    connectionString: 'couchbase://localhost',
    password: 'password',
    username: 'admin',
};

describe('CouchbaseConnection lifecycle', () => {
    beforeEach(() => {
        const connection = CouchbaseConnection.Instance as any;

        connection.connectionPromise = undefined;
        connection.connectionSettings = undefined;
        connection.cluster = null;
        connection.bucket = null;
        connection.connectionString = null;
        connection.bucketName = null;
        connection.username = null;
        connection.password = null;
    });

    it('reports connection state and ready rejects before init', async () => {
        const connection = CouchbaseConnection.Instance;

        expect(connection.isConnected()).to.equal(false);

        try {
            await connection.ready();
            throw new Error('expected ready to reject');
        } catch (error) {
            expect(error.message).to.equal('couchset is not connected; call couchset(args) first');
        }
    });

    it('returns the active connection when settings match', async () => {
        const connection = CouchbaseConnection.Instance as any;

        connection.cluster = {close: async () => undefined};
        connection.bucket = {};
        connection.connectionSettings = args;

        const started = await CouchbaseConnection.Instance.init(args);

        expect(started).to.equal(CouchbaseConnection.Instance);
    });

    it('throws clearly when settings change without force', async () => {
        const connection = CouchbaseConnection.Instance as any;

        connection.cluster = {close: async () => undefined};
        connection.bucket = {};
        connection.connectionSettings = args;

        try {
            await CouchbaseConnection.Instance.init({...args, bucketName: 'other'});
            throw new Error('expected init to reject');
        } catch (error) {
            expect(error.message).to.equal(
                'couchset is already connected with different settings; call couchset({...args, force: true}) to reconnect'
            );
        }
    });

    it('ping uses cluster ping when available', async () => {
        const connection = CouchbaseConnection.Instance as any;
        const pingResult = {version: 'mock'};

        connection.cluster = {
            close: async () => undefined,
            ping: async () => pingResult,
        };
        connection.bucket = {};

        expect(await CouchbaseConnection.Instance.ping()).to.equal(pingResult);
    });

    it('shutdown closes and clears the active connection', async () => {
        const connection = CouchbaseConnection.Instance as any;
        let closed = false;

        connection.cluster = {
            close: async () => {
                closed = true;
            },
        };
        connection.bucket = {};
        connection.connectionSettings = args;
        connection.bucketName = 'test';

        await CouchbaseConnection.Instance.shutdown();

        expect(closed).to.equal(true);
        expect(CouchbaseConnection.Instance.isConnected()).to.equal(false);
        expect(CouchbaseConnection.Instance.bucketName).to.equal(null);
    });
});
