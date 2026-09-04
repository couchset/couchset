import CouchbaseConnection, {CouchsetArgs} from './connection';

export type CouchbaseStarterLogger = ((...args: any[]) => void) | false;

export interface StartCouchbaseOptions extends Partial<CouchsetArgs> {
    logger?: CouchbaseStarterLogger;
}

const envValue = (key: string, fallback = ''): string => {
    const value = typeof process !== 'undefined' && process.env ? process.env[key] : undefined;

    return value === undefined ? fallback : value;
};

const databaseUrlError = (reason: string): Error =>
    new Error(`DB_URL must use couchbase:// or couchbases://user:password@host/bucket: ${reason}`);

const decodeDatabaseUrlComponent = (value: string, label: string): string => {
    try {
        return decodeURIComponent(value);
    } catch (_error) {
        throw databaseUrlError(`${label} contains invalid percent-encoding`);
    }
};

/**
 * Convert a PostgreSQL-style DB_URL into Couchbase SDK connection settings.
 * The bucket lives in the URL path; it is not part of Couchbase's connection
 * string, which contains only the scheme, host, optional port, and options.
 */
export const parseDatabaseUrl = (
    value: string
): Pick<CouchsetArgs, 'bucketName' | 'connectionString' | 'password' | 'username'> => {
    let url: URL;

    try {
        url = new URL(value);
    } catch (_error) {
        throw databaseUrlError('the value is not a valid URL');
    }

    if (url.protocol !== 'couchbase:' && url.protocol !== 'couchbases:') {
        throw databaseUrlError(`unsupported protocol ${url.protocol || '(missing)'}`);
    }
    if (!url.hostname) {
        throw databaseUrlError('a host is required');
    }
    if (!url.username || !url.password) {
        throw databaseUrlError('a username and password are required');
    }
    if (url.hash) {
        throw databaseUrlError('fragments are not supported');
    }

    const bucketName = decodeDatabaseUrlComponent(
        url.pathname.replace(/^\//, ''),
        'the bucket name'
    );
    if (!bucketName || bucketName.indexOf('/') !== -1) {
        throw databaseUrlError('the path must contain exactly one bucket name');
    }

    return {
        bucketName,
        connectionString: `${url.protocol}//${url.host}${url.search}`,
        password: decodeDatabaseUrlComponent(url.password, 'the password'),
        username: decodeDatabaseUrlComponent(url.username, 'the username'),
    };
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
    const databaseUrl = envValue('DB_URL');
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
        ...(databaseUrl ? parseDatabaseUrl(databaseUrl) : {}),
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
