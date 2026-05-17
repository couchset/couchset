import CouchbaseConnection, {CouchsetArgs} from './connection';
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

(couchset as any).ensureIndexes = ensureIndexes;

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
