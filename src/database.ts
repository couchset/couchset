import CouchbaseConnection, {CouchsetArgs} from './connection';

export type CouchbaseStarterLogger = ((...args: any[]) => void) | false;

export interface StartCouchbaseOptions extends Partial<CouchsetArgs> {
    logger?: CouchbaseStarterLogger;
}

const envValue = (key: string, fallback = ''): string => {
    const value = typeof process !== 'undefined' && process.env ? process.env[key] : undefined;

    return value === undefined ? fallback : value;
};

const maskPassword = (password: string): string => {
    return password ? 'xxxxxx' : 'empty';
};

const splitStartOptions = (options: StartCouchbaseOptions = {}) => {
    const {logger, ...connectionOverrides} = options;

    return {connectionOverrides, logger};
};

export const getConnectionOptions = (overrides: Partial<CouchsetArgs> = {}): CouchsetArgs => {
    const proxy = envValue('COUCHBASE_PROXY');
    const options: CouchsetArgs = {
        bucketName: envValue('COUCHBASE_BUCKET', 'dev'),
        connectionString: envValue('COUCHBASE_URL', 'couchbase://localhost'),
        password: envValue('COUCHBASE_PASSWORD', '1234'),
        username: envValue('COUCHBASE_USERNAME', 'admin'),
    };

    if (proxy) {
        options.proxy = proxy;
    }

    return {
        ...options,
        ...overrides,
    };
};

export const connectionOptions: CouchsetArgs = getConnectionOptions();

const refreshConnectionOptions = (overrides: Partial<CouchsetArgs> = {}): CouchsetArgs => {
    const nextOptions = getConnectionOptions(overrides);

    Object.keys(connectionOptions).forEach((key) => {
        delete (connectionOptions as any)[key];
    });
    Object.assign(connectionOptions, nextOptions);

    return connectionOptions;
};

const logConnectionStart = (
    options: CouchsetArgs,
    logger: CouchbaseStarterLogger | undefined,
    mode: string
): void => {
    if (logger === false) {
        return;
    }

    const log = logger || console.log;

    log(
        'Couchbase',
        'starting',
        mode,
        JSON.stringify({
            bucket: options.bucketName,
            host: options.connectionString,
            password: maskPassword(options.password),
            username: options.username,
        })
    );
};

const logConnectionStarted = (
    options: CouchsetArgs,
    logger: CouchbaseStarterLogger | undefined,
    mode: string
): void => {
    if (logger === false) {
        return;
    }

    const log = logger || console.log;

    log(
        'Couchbase',
        'started',
        mode,
        JSON.stringify({bucket: options.bucketName, host: options.connectionString})
    );
};

export const startCouchbase = async (options: StartCouchbaseOptions = {}): Promise<boolean> => {
    const {connectionOverrides, logger} = splitStartOptions(options);
    const resolvedOptions = refreshConnectionOptions(connectionOverrides);

    logConnectionStart(resolvedOptions, logger, 'standard');
    await CouchbaseConnection.Instance.init(resolvedOptions);
    logConnectionStarted(resolvedOptions, logger, 'standard');

    return true;
};

export const startCouchbaseServerless = async (
    options: StartCouchbaseOptions = {}
): Promise<boolean> => {
    const {connectionOverrides, logger} = splitStartOptions(options);
    const resolvedOptions = refreshConnectionOptions(connectionOverrides);

    logConnectionStart(resolvedOptions, logger, 'serverless');
    await CouchbaseConnection.Instance.initServerless(resolvedOptions);
    logConnectionStarted(resolvedOptions, logger, 'serverless');

    return true;
};
