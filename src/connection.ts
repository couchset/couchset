import type {Collection, Cluster, Bucket} from 'couchbase';
import * as couchbase from 'couchbase';

export interface CouchsetArgs {
    connectionString: string;
    bucketName: string;
    username: string;
    password: string;
    proxy?: string;
    force?: boolean;
}

interface ConnectionSettings {
    connectionString: string;
    bucketName: string;
    username: string;
    password: string;
    proxy?: string;
}

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

    // Args
    connectionString: string = null;
    bucketName: string = null;
    username: string = null;
    password: string = null;

    public static get Instance(): CouchbaseConnection {
        return this._instance || (this._instance = new this());
    }

    private constructor() {}

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

    /**
     * start
     */
    public init = async (args: CouchsetArgs): Promise<CouchbaseConnection> => {
        const settings = this.normalizeArgs(args);

        if (this.connectionPromise && this.sameSettings(settings)) {
            return this.connectionPromise;
        }

        if (this.isConnected() && this.sameSettings(settings)) {
            return this;
        }

        if ((this.isConnected() || this.connectionPromise) && !args.force) {
            throw this.settingsError();
        }

        if (args.force && this.connectionPromise) {
            await this.connectionPromise.catch(() => undefined);
        }

        if (args.force) {
            await this.shutdown();
        }

        const connectionOpt: any = {
            password: settings.password,
            username: settings.username,
        };

        if (settings.proxy) {
            connectionOpt.proxy = settings.proxy;
        }

        this.assignSettings(settings);
        this.connectionPromise = couchbase
            .connect(settings.connectionString, connectionOpt)
            .then((cluster) => {
                this.cluster = cluster as any;
                this.bucket = this.cluster.bucket(settings.bucketName);

                return this;
            })
            .catch((error) => {
                this.connectionPromise = undefined;
                this.connectionSettings = undefined;
                throw error;
            });

        return this.connectionPromise;
    };

    /**
     * start serverless start
     */
    public initServerless = (args: CouchsetArgs): CouchbaseConnection => {
        const settings = this.normalizeArgs(args);

        if (this.isConnected() && this.sameSettings(settings)) {
            return this;
        }

        if (this.isConnected() && !args.force) {
            throw this.settingsError();
        }

        if (args.force) {
            this.shutdown().catch(() => undefined);
        }

        this.assignSettings(settings);

        const connectionOpt = {
            password: settings.password,
            username: settings.username,
        };

        if (settings.proxy) {
            connectionOpt['proxy'] = settings.proxy;
        }

        const cluster = new couchbase.Cluster(settings.connectionString, connectionOpt);

        this.cluster = cluster as any;
        this.bucket = this.cluster.bucket(settings.bucketName);

        return this;
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
        if (this.connectionPromise) {
            return this.connectionPromise;
        }

        if (this.isConnected()) {
            return this;
        }

        throw new Error('couchset is not connected; call couchset(args) first');
    };

    public ping = async (): Promise<any> => {
        await this.ready();

        if (this.cluster && typeof (this.cluster as any).ping === 'function') {
            return (this.cluster as any).ping();
        }

        return this.cluster.query('SELECT 1');
    };

    /**
     * shutdown cluster
     */
    public shutdown = async (): Promise<void> => {
        const cluster = this.cluster;

        this.connectionPromise = undefined;
        this.connectionSettings = undefined;
        this.cluster = null;
        this.bucket = null;
        this.connectionString = null;
        this.bucketName = null;
        this.username = null;
        this.password = null;

        if (cluster && typeof (cluster as any).close === 'function') {
            await (cluster as any).close();
        }
    };
}

export default CouchbaseConnection;
