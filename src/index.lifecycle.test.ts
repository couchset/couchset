import 'mocha';

import {expect} from 'chai';

import CouchbaseConnection from './connection';
import couchset, {health, ping, ready, shutdown} from './index';

describe('root lifecycle helpers', () => {
    const connection = CouchbaseConnection.Instance;

    const fakeConnected = (): void => {
        connection.bucketName = 'test';
        connection.bucket = {defaultCollection: () => ({})} as any;
        connection.cluster = {
            close: async () => undefined,
            ping: async () => ({ok: true}),
        } as any;
        (connection as any).autoReconnectEnabled = true;
        (connection as any).connectionState = 'connected';
        (connection as any).reconnectDelayMs = 25;
    };

    afterEach(async () => {
        await shutdown();
    });

    it('exports named lifecycle helpers and attaches them to couchset()', async () => {
        fakeConnected();

        expect((couchset as any).ready).to.equal(ready);
        expect((couchset as any).health).to.equal(health);
        expect((couchset as any).ping).to.equal(ping);
        expect((couchset as any).shutdown).to.equal(shutdown);

        expect(await ready()).to.equal(connection);
        expect(await ping()).to.deep.equal({ok: true});
        expect(health()).to.include({
            autoReconnect: true,
            bucketName: 'test',
            reconnectIntervalMs: 25,
            state: 'connected',
        });
    });
});
