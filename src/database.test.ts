import 'mocha';

import {expect} from 'chai';

import CouchbaseConnection from './connection';
import {
    connectionOptions,
    getConnectionOptions,
    startCouchbase,
    startCouchbaseServerless,
} from './index';

const envKeys = [
    'COUCHBASE_URL',
    'COUCHBASE_BUCKET',
    'COUCHBASE_USERNAME',
    'COUCHBASE_PASSWORD',
    'COUCHBASE_PROXY',
];

const fakeCluster = () => ({
    bucket: () => ({defaultCollection: () => ({})}),
    close: async () => undefined,
    ping: async () => ({}),
});

describe('database starters', () => {
    let originalEnv: Record<string, string | undefined> = {};
    let originalOpenCluster: any;

    beforeEach(() => {
        const connection = CouchbaseConnection.Instance as any;

        originalEnv = envKeys.reduce((env, key) => {
            env[key] = process.env[key];
            delete process.env[key];
            return env;
        }, {});
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
    });

    afterEach(async () => {
        const connection = CouchbaseConnection.Instance as any;

        await CouchbaseConnection.Instance.shutdown();
        connection.openCluster = originalOpenCluster;

        envKeys.forEach((key) => {
            if (originalEnv[key] === undefined) {
                delete process.env[key];
                return;
            }

            process.env[key] = originalEnv[key];
        });
    });

    it('builds connection options from Couchbase environment variables', () => {
        process.env.COUCHBASE_URL = 'couchbase://env';
        process.env.COUCHBASE_BUCKET = 'env-bucket';
        process.env.COUCHBASE_USERNAME = 'env-user';
        process.env.COUCHBASE_PASSWORD = 'env-password';
        process.env.COUCHBASE_PROXY = 'http://proxy';

        expect(getConnectionOptions({bucketName: 'override-bucket'})).to.deep.equal({
            bucketName: 'override-bucket',
            connectionString: 'couchbase://env',
            password: 'env-password',
            proxy: 'http://proxy',
            username: 'env-user',
        });
    });

    it('uses local development defaults when env is missing', () => {
        expect(getConnectionOptions()).to.deep.equal({
            bucketName: 'dev',
            connectionString: 'couchbase://localhost',
            password: '1234',
            username: 'admin',
        });
    });

    it('starts Couchbase from env and refreshes exported connectionOptions', async () => {
        const connection = CouchbaseConnection.Instance as any;
        let settings: any;

        process.env.COUCHBASE_URL = 'couchbase://starter';
        process.env.COUCHBASE_BUCKET = 'starter-bucket';
        process.env.COUCHBASE_USERNAME = 'starter-user';
        process.env.COUCHBASE_PASSWORD = 'starter-password';
        process.env.COUCHBASE_PROXY = 'http://starter-proxy';
        connection.openCluster = async (nextSettings: any) => {
            settings = nextSettings;
            return fakeCluster();
        };

        const started = await startCouchbase({
            autoReconnect: false,
            logger: false,
            reconnectIntervalMs: 25,
        });

        expect(started).to.equal(true);
        expect(settings).to.deep.equal({
            bucketName: 'starter-bucket',
            connectionString: 'couchbase://starter',
            password: 'starter-password',
            proxy: 'http://starter-proxy',
            username: 'starter-user',
        });
        expect(connectionOptions).to.deep.include({
            autoReconnect: false,
            bucketName: 'starter-bucket',
            connectionString: 'couchbase://starter',
            password: 'starter-password',
            proxy: 'http://starter-proxy',
            reconnectIntervalMs: 25,
            username: 'starter-user',
        });
        expect(CouchbaseConnection.Instance.health()).to.deep.include({
            autoReconnect: false,
            bucketName: 'starter-bucket',
            reconnectIntervalMs: 25,
            state: 'connected',
        });
    });

    it('starts serverless Couchbase from env', async () => {
        const connection = CouchbaseConnection.Instance as any;
        let settings: any;

        process.env.COUCHBASE_URL = 'couchbase://serverless';
        process.env.COUCHBASE_BUCKET = 'serverless-bucket';
        process.env.COUCHBASE_USERNAME = 'serverless-user';
        process.env.COUCHBASE_PASSWORD = 'serverless-password';
        connection.openCluster = async (nextSettings: any) => {
            settings = nextSettings;
            return fakeCluster();
        };

        const started = await startCouchbaseServerless({
            autoReconnect: false,
            logger: false,
        });

        expect(started).to.equal(true);
        expect(settings).to.deep.include({
            bucketName: 'serverless-bucket',
            connectionString: 'couchbase://serverless',
            password: 'serverless-password',
            username: 'serverless-user',
        });
    });
});
