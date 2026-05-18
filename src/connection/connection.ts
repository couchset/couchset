import type {Bucket, Cluster, Collection} from 'couchbase';
import * as couchbase from 'couchbase';

import {envFlag, envNumber} from './env';
import {ConnectionHealth, ConnectionSettings, ConnectionState, CouchsetArgs} from './types';

/**
 * CouchbaseConnection class
 * Only one CouchbaseConnection can exist that's why it's a singleton
 */
export class CouchbaseConnection implements CouchsetArgs {
    private static _instance: CouchbaseConnection;

    bucket: Bucket = null;
    cluster: Cluster = null;
    private connectionPromise?: Promise<CouchbaseConnection>;
    private connectionSettings?: ConnectionSettings;
    private reconnectPromise?: Promise<CouchbaseConnection>;
    private reconnectReject?: (error: Error) => void;
    private reconnectTimer?: ReturnType<typeof setTimeout>;
    private healthTimer?: ReturnType<typeof setTimeout>;
    private connectionState: ConnectionState = 'idle';
    private autoReconnectEnabled = true;
    private reconnectDelayMs = 5000;
    private manuallyClosed = false;
    private lastConnectionError?: any;

    // Args
    connectionString: string = null;
    bucketName: string = null;
    username: string = null;
    password: string = null;

    public static get Instance(): CouchbaseConnection {
        return this._instance || (this._instance = new this());
    }

    private constructor() {}

    private configureReconnect(args: CouchsetArgs): void {
        this.autoReconnectEnabled =
            typeof args.autoReconnect === 'boolean'
                ? args.autoReconnect
                : envFlag(process.env.COUCHSET_RECONNECT, true);
        this.reconnectDelayMs =
            typeof args.reconnectIntervalMs === 'number' && args.reconnectIntervalMs > 0
                ? args.reconnectIntervalMs
                : envNumber(process.env.COUCHSET_RECONNECT_INTERVAL_MS, 5000);
    }

    private normalizeArgs(args: CouchsetArgs): ConnectionSettings {
        const {connectionString, password, username, bucketName = 'default', proxy} = args;

        return {
            bucketName,
            connectionString,
            password,
            proxy,
            username,
        };
    }

    private sameSettings(next: ConnectionSettings): boolean {
        const current = this.connectionSettings;

        return (
            !!current &&
            current.connectionString === next.connectionString &&
            current.bucketName === next.bucketName &&
            current.username === next.username &&
            current.password === next.password &&
            current.proxy === next.proxy
        );
    }

    private assignSettings(settings: ConnectionSettings): void {
        this.connectionString = settings.connectionString;
        this.bucketName = settings.bucketName;
        this.username = settings.username;
        this.password = settings.password;
        this.connectionSettings = settings;
    }

    private settingsError(): Error {
        return new Error(
            'couchset is already connected with different settings; call couchset({...args, force: true}) to reconnect'
        );
    }

    private connectionOptions(settings: ConnectionSettings): any {
        const options: any = {
            password: settings.password,
            username: settings.username,
        };

        if (settings.proxy) {
            options.proxy = settings.proxy;
        }

        return options;
    }

    private clearReconnectTimer(): void {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = undefined;
        }
    }

    private clearHealthTimer(): void {
        if (this.healthTimer) {
            clearTimeout(this.healthTimer);
            this.healthTimer = undefined;
        }
    }

    private scheduleTimer(callback: () => void, unref = true): ReturnType<typeof setTimeout> {
        const timer = setTimeout(callback, this.reconnectDelayMs);

        if (unref && typeof (timer as any).unref === 'function') {
            (timer as any).unref();
        }

        return timer;
    }

    private rawPing = async (): Promise<any> => {
        if (!this.cluster) {
            throw new Error('couchset is not connected; call couchset(args) first');
        }

        if (typeof (this.cluster as any).ping === 'function') {
            return (this.cluster as any).ping();
        }

        return this.cluster.query('SELECT 1');
    };

    private openCluster = (settings: ConnectionSettings): Promise<Cluster> => {
        return couchbase.connect(settings.connectionString, this.connectionOptions(settings));
    };

    private scheduleHealthCheck(): void {
        this.clearHealthTimer();

        if (!this.autoReconnectEnabled || this.manuallyClosed) {
            return;
        }

        this.healthTimer = this.scheduleTimer(async () => {
            try {
                await this.rawPing();
                this.scheduleHealthCheck();
            } catch (error) {
                this.markDisconnected(error);
            }
        });
    }

    private connectWithSettings = async (
        settings: ConnectionSettings
    ): Promise<CouchbaseConnection> => {
        const cluster = await this.openCluster(settings);

        if (this.manuallyClosed) {
            if (cluster && typeof (cluster as any).close === 'function') {
                await (cluster as any).close();
            }
            throw new Error('couchset reconnect stopped');
        }

        this.cluster = cluster as any;
        this.bucket = this.cluster.bucket(settings.bucketName);
        this.connectionState = 'connected';
        this.lastConnectionError = undefined;
        this.scheduleHealthCheck();

        return this;
    };

    private startReconnect = (): Promise<CouchbaseConnection> => {
        if (this.reconnectPromise) {
            return this.reconnectPromise;
        }

        if (!this.autoReconnectEnabled || !this.connectionSettings || this.manuallyClosed) {
            return Promise.reject(
                new Error('couchset reconnect is disabled or no connection settings are available')
            );
        }

        this.connectionState = 'reconnecting';

        this.reconnectPromise = new Promise<CouchbaseConnection>((resolve, reject) => {
            this.reconnectReject = reject;

            const attempt = async () => {
                if (this.manuallyClosed || !this.connectionSettings) {
                    reject(new Error('couchset reconnect stopped'));
                    return;
                }

                try {
                    const connection = await this.connectWithSettings(this.connectionSettings);
                    this.reconnectPromise = undefined;
                    this.reconnectReject = undefined;
                    this.clearReconnectTimer();
                    resolve(connection);
                } catch (error) {
                    this.lastConnectionError = error;
                    this.connectionState = 'reconnecting';
                    this.reconnectTimer = this.scheduleTimer(attempt, false);
                }
            };

            attempt();
        });

        return this.reconnectPromise;
    };

    /**
     * start
     */
    public init = async (args: CouchsetArgs): Promise<CouchbaseConnection> => {
        const settings = this.normalizeArgs(args);
        this.configureReconnect(args);

        if (this.connectionPromise && this.sameSettings(settings)) {
            return this.connectionPromise;
        }

        if (this.reconnectPromise && this.sameSettings(settings)) {
            return this.reconnectPromise;
        }

        if (this.isConnected() && this.sameSettings(settings)) {
            return this;
        }

        if (
            (this.isConnected() || this.connectionPromise || this.reconnectPromise) &&
            !args.force
        ) {
            throw this.settingsError();
        }

        if (args.force && this.connectionPromise) {
            await this.connectionPromise.catch(() => undefined);
        }

        if (args.force) {
            await this.shutdown();
            this.configureReconnect(args);
        }

        this.manuallyClosed = false;
        this.clearReconnectTimer();
        this.clearHealthTimer();
        this.assignSettings(settings);
        this.connectionState = 'connecting';
        this.connectionPromise = this.connectWithSettings(settings)
            .then((connection) => {
                this.connectionPromise = undefined;

                return connection;
            })
            .catch((error) => {
                this.connectionPromise = undefined;
                this.connectionSettings = undefined;
                this.connectionState = 'idle';
                this.lastConnectionError = error;
                throw error;
            });

        return this.connectionPromise;
    };

    /**
     * start serverless start
     */
    public initServerless = async (args: CouchsetArgs): Promise<CouchbaseConnection> => {
        return this.init(args);
    };

    /**
     * getCollection
     */
    public getCollection = (scopeName?: string, collectionName?: string): Collection => {
        if (scopeName || collectionName) {
            return this.bucket
                .scope(scopeName || '_default')
                .collection(collectionName || '_default');
        }

        return this.bucket.defaultCollection();
    };

    public getCluster = (): Cluster => {
        return this.cluster;
    };

    public getBucket = (): string => {
        return this.bucketName;
    };

    public isConnected = (): boolean => {
        return !!this.cluster && !!this.bucket;
    };

    public ready = async (): Promise<CouchbaseConnection> => {
        if (this.isConnected()) {
            return this;
        }

        if (this.connectionPromise) {
            return this.connectionPromise;
        }

        if (this.reconnectPromise) {
            return this.reconnectPromise;
        }

        if (this.autoReconnectEnabled && this.connectionSettings && !this.manuallyClosed) {
            return this.startReconnect();
        }

        throw new Error('couchset is not connected; call couchset(args) first');
    };

    public ping = async (): Promise<any> => {
        await this.ready();

        try {
            return await this.rawPing();
        } catch (error) {
            this.markDisconnected(error);
            throw error;
        }
    };

    public state = (): ConnectionState => {
        return this.connectionState;
    };

    public health = (): ConnectionHealth => {
        return {
            autoReconnect: this.autoReconnectEnabled,
            bucketName: this.bucketName,
            lastError: this.lastConnectionError,
            reconnectIntervalMs: this.reconnectDelayMs,
            state: this.connectionState,
        };
    };

    public shouldReconnect = (error: unknown): boolean => {
        if (!this.autoReconnectEnabled || this.manuallyClosed) {
            return false;
        }

        const caught = error as any;
        const name = String(caught?.name || caught?.constructor?.name || '');
        const message = String(caught?.message || '');
        const text = `${name} ${message}`.toLowerCase();

        return [
            'timeout',
            'network',
            'connect',
            'closed',
            'disconnect',
            'unavailable',
            'socket',
            'econnrefused',
            'etimedout',
            'temporary failure',
        ].some((value) => text.includes(value));
    };

    public markDisconnected = (error?: unknown): void => {
        if (!this.connectionSettings || this.manuallyClosed) {
            return;
        }

        const cluster = this.cluster;

        this.lastConnectionError = error;
        this.connectionPromise = undefined;
        this.cluster = null;
        this.bucket = null;
        this.clearHealthTimer();

        if (cluster && typeof (cluster as any).close === 'function') {
            (cluster as any).close().catch(() => undefined);
        }

        if (this.autoReconnectEnabled) {
            this.connectionState = 'reconnecting';
            this.startReconnect().catch(() => undefined);
            return;
        }

        this.connectionState = 'idle';
    };

    /**
     * shutdown cluster
     */
    public shutdown = async (): Promise<void> => {
        const cluster = this.cluster;

        this.manuallyClosed = true;
        this.clearReconnectTimer();
        this.clearHealthTimer();
        if (this.reconnectReject) {
            this.reconnectReject(new Error('couchset reconnect stopped'));
        }
        this.reconnectPromise = undefined;
        this.reconnectReject = undefined;
        this.connectionPromise = undefined;
        this.connectionSettings = undefined;
        this.cluster = null;
        this.bucket = null;
        this.connectionString = null;
        this.bucketName = null;
        this.username = null;
        this.password = null;
        this.connectionState = 'closed';
        this.lastConnectionError = undefined;

        if (cluster && typeof (cluster as any).close === 'function') {
            await (cluster as any).close();
        }
    };
}

export default CouchbaseConnection;
