import type {Bucket, Cluster, Collection} from 'couchbase';
import * as couchbase from 'couchbase';

export interface CouchsetArgs {
    connectionString: string;
    bucketName: string;
    username: string;
    password: string;
    proxy?: string;
}

/**
 * Legacy Couchbase singleton kept for the pre-new-Model API surface.
 */
export class CouchbaseConnection implements CouchsetArgs {
    private static _instance: CouchbaseConnection;

    bucket: Bucket = null;
    cluster: Cluster = null;

    connectionString: string = null;
    bucketName: string = null;
    username: string = null;
    password: string = null;

    public static get Instance(): CouchbaseConnection {
        return this._instance || (this._instance = new this());
    }

    private constructor() {}

    public init = async (args: CouchsetArgs): Promise<CouchbaseConnection> => {
        const {connectionString, password, username, bucketName = 'default'} = args;

        this.connectionString = connectionString;
        this.bucketName = bucketName;
        this.username = username;
        this.password = password;

        const cluster = await couchbase.connect(connectionString, {
            password,
            username,
        });

        this.cluster = cluster as any;
        this.bucket = this.cluster.bucket(bucketName);

        return this;
    };

    public initServerless = (args: CouchsetArgs): CouchbaseConnection => {
        const {connectionString, password, username, bucketName = 'default'} = args;

        this.connectionString = connectionString;
        this.bucketName = bucketName;
        this.username = username;
        this.password = password;

        const connectionOpt = {
            password,
            username,
        };

        if (args.proxy) {
            connectionOpt['proxy'] = args.proxy;
        }

        const cluster = new couchbase.Cluster(connectionString, connectionOpt);

        this.cluster = cluster as any;
        this.bucket = this.cluster.bucket(bucketName);

        return this;
    };

    public getCollection = (): Collection => {
        return this.bucket.defaultCollection();
    };

    public getCluster = (): Cluster => {
        return this.cluster;
    };

    public getBucket = (): string => {
        return this.bucketName;
    };

    public shutdown = async (): Promise<void> => {
        return this.cluster.close();
    };
}

export default CouchbaseConnection;
