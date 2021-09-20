import CouchbaseConnection, {CouchsetArgs} from './connection';

export * from './model';
export * from './connection';
export * from './query';
export * from './search';
export * from './pagination';

/**
 * Main function to start CouchSet
 * @param @interface CouchsetArgs
 */
export const couchset = async (args: CouchsetArgs): Promise<boolean> => {
    const couch = CouchbaseConnection.Instance;
    await couch.init(args);
    return Promise.resolve(true);
};

export default couchset;
