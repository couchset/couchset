/* eslint-disable @typescript-eslint/ban-ts-comment */
import * as couchbase from 'couchbase';
import {Collection, Cluster, Bucket} from 'couchbase';

export interface CouchsetArgs {
    connectionString: string;
    bucketName: string;
    username: string;
    password: string;
}

/**
 * CouchbaseConnection class
 * Only one CouchbaseConnection can exist that's why it's a singleton
 */
export class CouchbaseConnection implements CouchsetArgs {
    private static _instance: CouchbaseConnection;

    bucket: Bucket = null;
    cluster: Cluster = null;

    // Args
    connectionString: string;
    bucketName: string;
    username: string;
    password: string;

    public static get Instance(): CouchbaseConnection {
        return this._instance || (this._instance = new this());
    }

    private constructor() {}

    /**
     * start
     */
    public init = async (args: CouchsetArgs): Promise<CouchbaseConnection> => {
        const {connectionString, password, username, bucketName = 'default'} = args;

        this.connectionString = connectionString;
        this.bucketName = bucketName;
        this.username = username;
        this.password = password;

        const cluster = await couchbase.connect(connectionString, {
            username,
            password,
        });

        this.cluster = cluster as any;
        this.bucket = this.cluster.bucket(bucketName);

        return this;
    };

    /**
     * getCollection
     */
    public getCollection = (): Collection => {
        return this.bucket.defaultCollection();
    };

    public getCluster = (): Cluster => {
        return this.cluster;
    };

    /**
     * shutdown cluster
     */
    public shutdown = async (): Promise<void> => {
        return this.cluster.close();
    };
}

export default CouchbaseConnection;
