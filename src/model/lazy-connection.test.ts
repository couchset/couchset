import 'mocha';

import {expect} from 'chai';

import CouchbaseConnection from '../connection';

import {Model} from './index';

describe('Model lazy connection binding', () => {
    let originalMarkDisconnected: any;

    beforeEach(() => {
        const connection = CouchbaseConnection.Instance as any;

        originalMarkDisconnected = connection.markDisconnected;
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

    afterEach(() => {
        const connection = CouchbaseConnection.Instance as any;

        connection.markDisconnected = originalMarkDisconnected;
    });

    it('allows models to be defined before the connection is ready', async () => {
        const model = new Model('User');
        const connection = CouchbaseConnection.Instance as any;
        const writes: any[] = [];

        connection.connectionPromise = Promise.resolve().then(() => {
            connection.bucketName = 'test';
            connection.cluster = {query: async () => ({rows: []})};
            connection.bucket = {
                defaultCollection: () => ({
                    upsert: async (key: string, value: any) => writes.push({key, value}),
                }),
            };

            return CouchbaseConnection.Instance;
        });

        const created = await model.create({userId: 'ceddy'});

        expect(writes).to.have.length(1);
        expect(writes[0].key).to.equal(created.id);
        expect(created).to.deep.include({_type: 'User', _scope: '_default', userId: 'ceddy'});
    });

    it('rebinds the collection and retries once after a reconnectable write error', async () => {
        const model = new Model('User');
        const connection = CouchbaseConnection.Instance as any;
        let defaultCollectionCalls = 0;
        let upsertCalls = 0;

        connection.bucketName = 'test';
        connection.cluster = {query: async () => ({rows: []})};
        connection.connectionSettings = {
            bucketName: 'test',
            connectionString: 'couchbase://localhost',
            password: 'password',
            username: 'admin',
        };
        connection.bucket = {
            defaultCollection: () => {
                defaultCollectionCalls += 1;

                return {
                    upsert: async () => {
                        upsertCalls += 1;

                        if (upsertCalls === 1) {
                            const error = new Error('network socket closed');
                            error.name = 'UnambiguousTimeoutError';
                            throw error;
                        }
                    },
                };
            },
        };
        connection.markDisconnected = () => undefined;

        await model.create({userId: 'ceddy'});

        expect(defaultCollectionCalls).to.equal(2);
        expect(upsertCalls).to.equal(2);
    });
});
