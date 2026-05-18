import CouchbaseConnection, {CouchsetArgs} from './connection';

export * from './model';
export * from './connection';
export * from '../query';
export * from './search';
export * from './pagination';
export * from '../shared';

export const couchset = async (args: CouchsetArgs): Promise<boolean> => {
    const couch = CouchbaseConnection.Instance;
    await couch.init(args);
    return Promise.resolve(true);
};

export const couchsetServerless = async (args: CouchsetArgs): Promise<boolean> => {
    const couch = CouchbaseConnection.Instance;
    await couch.initServerless(args);
    return Promise.resolve(true);
};

export default couchset;
