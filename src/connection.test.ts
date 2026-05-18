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
    let originalReconnectEnv: string;
    let originalReconnectIntervalEnv: string;
    let originalOpenCluster: any;

    beforeEach(() => {
        const connection = CouchbaseConnection.Instance as any;

        originalReconnectEnv = process.env.COUCHSET_RECONNECT;
        originalReconnectIntervalEnv = process.env.COUCHSET_RECONNECT_INTERVAL_MS;
        originalOpenCluster = connection.openCluster;

        if (connection.reconnectTimer) {
            clearTimeout(connection.reconnectTimer);
        }
        if (connection.healthTimer) {
            clearTimeout(connection.healthTimer);
        }
        connection.connectionPromise = undefined;
        connection.connectionSettings = undefined;
        connection.reconnectPromise = undefined;
        connection.reconnectReject = undefined;
        connection.reconnectTimer = undefined;
        connection.healthTimer = undefined;
        connection.cluster = null;
        connection.bucket = null;
        connection.connectionString = null;
        connection.bucketName = null;
        connection.username = null;
        connection.password = null;
        connection.connectionState = 'idle';
        connection.autoReconnectEnabled = true;
        connection.reconnectDelayMs = 5000;
        connection.manuallyClosed = false;
        connection.lastConnectionError = undefined;
        connection.openCluster = async () => ({
            bucket: () => ({defaultCollection: () => ({})}),
            close: async () => undefined,
            ping: async () => ({}),
        });
    });

    afterEach(() => {
        const connection = CouchbaseConnection.Instance as any;

        if (originalReconnectEnv === undefined) {
            delete process.env.COUCHSET_RECONNECT;
        } else {
            process.env.COUCHSET_RECONNECT = originalReconnectEnv;
        }
        if (originalReconnectIntervalEnv === undefined) {
            delete process.env.COUCHSET_RECONNECT_INTERVAL_MS;
        } else {
            process.env.COUCHSET_RECONNECT_INTERVAL_MS = originalReconnectIntervalEnv;
        }
        if (connection.reconnectTimer) {
            clearTimeout(connection.reconnectTimer);
        }
        if (connection.healthTimer) {
            clearTimeout(connection.healthTimer);
        }
        connection.openCluster = originalOpenCluster;
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

    it('uses reconnect env defaults and explicit args', async () => {
        process.env.COUCHSET_RECONNECT = 'false';
        process.env.COUCHSET_RECONNECT_INTERVAL_MS = '123';

        await CouchbaseConnection.Instance.init(args);

        expect(CouchbaseConnection.Instance.health()).to.deep.include({
            autoReconnect: false,
            reconnectIntervalMs: 123,
            state: 'connected',
        });

        await CouchbaseConnection.Instance.shutdown();
        await CouchbaseConnection.Instance.init({
            ...args,
            autoReconnect: true,
            reconnectIntervalMs: 50,
        });

        expect(CouchbaseConnection.Instance.health()).to.deep.include({
            autoReconnect: true,
            reconnectIntervalMs: 50,
            state: 'connected',
        });
    });

    it('keeps retrying reconnect until the cluster is available again', async () => {
        const connection = CouchbaseConnection.Instance as any;
        let attempts = 0;
        const clusters = [
            {
                bucket: () => ({defaultCollection: () => ({})}),
                close: async () => undefined,
                ping: async () => ({}),
            },
            null,
            {
                bucket: () => ({defaultCollection: () => ({})}),
                close: async () => undefined,
                ping: async () => ({}),
            },
        ];

        connection.openCluster = async () => {
            const cluster = clusters[attempts];
            attempts += 1;

            if (!cluster) {
                const error = new Error('ECONNREFUSED');
                error.name = 'NetworkError';
                throw error;
            }

            return cluster;
        };

        await CouchbaseConnection.Instance.init({...args, reconnectIntervalMs: 1});
        CouchbaseConnection.Instance.markDisconnected(new Error('socket closed'));

        const reconnected = await CouchbaseConnection.Instance.ready();

        expect(reconnected).to.equal(CouchbaseConnection.Instance);
        expect(attempts).to.equal(3);
        expect(CouchbaseConnection.Instance.state()).to.equal('connected');
        expect(CouchbaseConnection.Instance.isConnected()).to.equal(true);

        connection.manuallyClosed = true;
    });
});
