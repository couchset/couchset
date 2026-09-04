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
    'DB_URL',
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

    it('maps DB_URL into Couchbase credentials, host, optional port, and bucket', () => {
        process.env.COUCHBASE_URL = 'couchbase://ignored';
        process.env.COUCHBASE_BUCKET = 'ignored-bucket';
        process.env.COUCHBASE_USERNAME = 'ignored-user';
        process.env.COUCHBASE_PASSWORD = 'ignored-password';
        process.env.DB_URL = 'couchbase://env-user:env-password@localhost:11210/env-bucket';

        expect(getConnectionOptions()).to.deep.equal({
            bucketName: 'env-bucket',
            connectionString: 'couchbase://localhost:11210',
            password: 'env-password',
            username: 'env-user',
        });
    });

    it('supports TLS DB_URL values and URL-encoded credentials', () => {
        process.env.DB_URL =
            'couchbases://team%40example.com:p%40ss%3Aword@cb.example.com/cloud-bucket';

        expect(getConnectionOptions()).to.deep.equal({
            bucketName: 'cloud-bucket',
            connectionString: 'couchbases://cb.example.com',
            password: 'p@ss:word',
            username: 'team@example.com',
        });
    });

    it('keeps explicit starter options above DB_URL', () => {
        process.env.DB_URL = 'couchbase://env-user:env-password@localhost/env-bucket';

        expect(getConnectionOptions({bucketName: 'override-bucket', username: 'override-user'})).to.deep.include({
            bucketName: 'override-bucket',
            connectionString: 'couchbase://localhost',
            password: 'env-password',
            username: 'override-user',
        });
    });

    it('rejects malformed DB_URL values with a clear error', () => {
        process.env.DB_URL = 'https://user:password@example.com/bucket';

        expect(() => getConnectionOptions()).to.throw('DB_URL must use couchbase:// or couchbases://');

        process.env.DB_URL = 'couchbase://user:password@example.com/%ZZ';
        expect(() => getConnectionOptions()).to.throw('the bucket name contains invalid percent-encoding');
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
