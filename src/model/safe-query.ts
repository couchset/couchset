import type {Cluster, QueryOptions} from 'couchbase';

export type QueryParameters = {[key: string]: any} | any[];

export type QueryLogger = (message: string, details?: any) => void;

export interface SafeQueryOptions extends Omit<QueryOptions, 'parameters'> {
    debug?: boolean;
    logger?: QueryLogger;
}

export interface QueryPageOptions extends SafeQueryOptions {
    limit?: number;
    limitParamIndex?: number;
}

export interface QueryPageResult<T> {
    items: T[];
    hasNext: boolean;
    params?: any;
}

const escapeIdentifier = (identifier: string): string => `\`${identifier.replace(/`/g, '``')}\``;

const safeAlias = (alias: string): string => {
    return /^[A-Za-z_][A-Za-z0-9_]*$/.test(alias) ? alias : escapeIdentifier(alias);
};

const queryOptionsWithParameters = (
    params?: QueryParameters,
    options?: SafeQueryOptions
): QueryOptions => {
    const queryOptions: any = {...(options || {})};
    delete queryOptions.debug;
    delete queryOptions.logger;

    return {
        ...queryOptions,
        ...(params === undefined ? {} : {parameters: params}),
    };
};

const resolvePageLimit = (params?: QueryParameters, options?: QueryPageOptions): number => {
    const limit =
        options && typeof options.limit === 'number'
            ? options.limit
            : !Array.isArray(params) && params && typeof params.limit === 'number'
            ? params.limit
            : null;

    if (!limit || limit < 1) {
        throw new Error('queryPage requires a positive limit option or named params.limit');
    }

    return limit;
};

const pageParameters = (
    params: QueryParameters | undefined,
    limit: number,
    options?: QueryPageOptions
): QueryParameters | undefined => {
    const nextLimit = limit + 1;

    if (Array.isArray(params)) {
        if (options && typeof options.limitParamIndex === 'number') {
            const updatedParams = params.slice();
            updatedParams[options.limitParamIndex] = nextLimit;
            return updatedParams;
        }

        return params;
    }

    return {...(params || {}), limit: nextLimit};
};

const queryPageOptions = (options?: QueryPageOptions): SafeQueryOptions => {
    const queryOptions: any = {...(options || {})};
    delete queryOptions.limit;
    delete queryOptions.limitParamIndex;

    return queryOptions;
};

export const bucketIdentifier = (bucketName: string): string => escapeIdentifier(bucketName);

export const fromTarget = (bucketName: string, alias?: string): string => {
    const keyspace = bucketIdentifier(bucketName);

    if (!alias) {
        return keyspace;
    }

    return `${keyspace} AS ${safeAlias(alias)}`;
};

export const runQueryRows = async <T>(
    cluster: Cluster,
    query: string,
    params?: QueryParameters,
    options?: SafeQueryOptions
): Promise<T[]> => {
    const queryOptions = queryOptionsWithParameters(params, options);

    if (options && options.debug && options.logger) {
        options.logger('couchset queryRows', {query, options: queryOptions});
    }

    const {rows = []} = await cluster.query<T>(query, queryOptions);

    return rows;
};

export const runQueryOne = async <T>(
    cluster: Cluster,
    query: string,
    params?: QueryParameters,
    options?: SafeQueryOptions
): Promise<T | null> => {
    const rows = await runQueryRows<T>(cluster, query, params, options);

    return rows.length ? rows[0] : null;
};

export const runQueryPage = async <T>(
    cluster: Cluster,
    query: string,
    params?: QueryParameters,
    options?: QueryPageOptions
): Promise<QueryPageResult<T>> => {
    const limit = resolvePageLimit(params, options);
    const pagedParams = pageParameters(params, limit, options);
    const rows = await runQueryRows<T>(cluster, query, pagedParams, queryPageOptions(options));
    const hasNext = rows.length > limit;

    return {
        items: hasNext ? rows.slice(0, limit) : rows,
        hasNext,
        params: pagedParams,
    };
};
