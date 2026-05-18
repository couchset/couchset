import CouchbaseConnection, {ConnectionHealth, CouchsetArgs} from './connection';
import {EnsureIndexOptions, Model} from './model';

export * from './model';
export * from './connection';
export * from './query';
export * from './search';
export * from './pagination';
export * from './shared';
export * from './timeseries';

/**
 * Main function to start CouchSet
 * @param @interface CouchsetArgs
 */
export const couchset = async (args: CouchsetArgs): Promise<boolean> => {
    const couch = CouchbaseConnection.Instance;
    await couch.init(args);
    return Promise.resolve(true);
};

export const ensureIndexes = async (options?: EnsureIndexOptions): Promise<string[]> => {
    return Model.ensureIndexes(options);
};

export const ready = async (): Promise<CouchbaseConnection> => {
    return CouchbaseConnection.Instance.ready();
};

export const ping = async (): Promise<any> => {
    return CouchbaseConnection.Instance.ping();
};

export const health = (): ConnectionHealth => {
    return CouchbaseConnection.Instance.health();
};

export const shutdown = async (): Promise<void> => {
    return CouchbaseConnection.Instance.shutdown();
};

Object.assign(couchset as any, {
    ensureIndexes,
    health,
    ping,
    ready,
    shutdown,
});

/**
 * Main function to start CouchSet
 * @param @interface CouchsetArgs
 */
export const couchsetServerless = (args: CouchsetArgs): Promise<boolean> => {
    const couch = CouchbaseConnection.Instance;
    couch.initServerless(args);
    return Promise.resolve(true);
};

export default couchset;
