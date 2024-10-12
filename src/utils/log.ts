import debug from 'debug';

const appName = process.env.APP_NAME || 'couchset';

const libraryPrefix = appName;

/**
 * Use to log in general case
 */
export const log = debug(`${libraryPrefix}:info`);

/**
 * Use for verbose log
 */
export const verbose = debug(`${libraryPrefix}:verbose`);
