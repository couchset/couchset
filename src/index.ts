import CouchbaseConnection, {ConnectionHealth, CouchsetArgs} from './connection';
import {EnsureIndexOptions, Model} from './model';

export * from './model';
export * from './connection';
export * from './query';
export * from './search';
export * from './pagination';
export * from './shared';
export * from './timeseries';

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

export interface CouchsetStarter {
    (args: CouchsetArgs): Promise<boolean>;
    ensureIndexes: typeof ensureIndexes;
    health: typeof health;
    ping: typeof ping;
    ready: typeof ready;
    shutdown: typeof shutdown;
}

/**
 * Main function to start CouchSet
 * @param @interface CouchsetArgs
 */
const startCouchset = async (args: CouchsetArgs): Promise<boolean> => {
    const couch = CouchbaseConnection.Instance;
    await couch.init(args);
    return Promise.resolve(true);
};

export const couchset = Object.assign(startCouchset, {
    ensureIndexes,
    health,
    ping,
    ready,
    shutdown,
}) as CouchsetStarter;

/**
 * Main function to start CouchSet
 * @param @interface CouchsetArgs
 */
export const couchsetServerless = async (args: CouchsetArgs): Promise<boolean> => {
    const couch = CouchbaseConnection.Instance;
    await couch.initServerless(args);
    return Promise.resolve(true);
};

export default couchset;
