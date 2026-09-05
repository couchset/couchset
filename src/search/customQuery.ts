import CouchbaseConnection from '../connection';
import {queryOptionsWithParameters, SafeQueryOptions} from '../model/safe-query';

export type CustomQueryParameters = {[key: string]: any} | any[];
export type CustomQueryLogger = (message: string, details?: any) => void;

export interface CustomQueryArgs {
    query: string;
    limit: number;
    params?: CustomQueryParameters;
    debug?: boolean;
    logger?: CustomQueryLogger;
    throwOnError?: boolean;
    queryOptions?: SafeQueryOptions;
}

export interface CustomQueryPagination {
    hasNext: boolean;
    params?: CustomQueryParameters;
}

/**
 * Common pagination
 *  query,
    bucketName = "",
    select = ["id", "owner"] || "*"
 * @param args PaginationArgs
 */
export const CustomQuery = async <T>(
    args: CustomQueryArgs
): Promise<[T[], CustomQueryPagination]> => {
    const {query, limit, params, debug = false, logger, throwOnError = true} = args;

    const cluster = CouchbaseConnection.Instance.cluster;
    const queryOptions =
        args.queryOptions || params !== undefined
            ? queryOptionsWithParameters(params, args.queryOptions)
            : undefined;

    try {
        if (debug && logger) {
            logger('couchset customQuery', {query, options: queryOptions});
        }

        const {rows = []} = await cluster.query<T>(query, queryOptions);

        const totalItems = rows.length;

        const hasNext = totalItems >= limit;

        return [rows, {params, hasNext}];
    } catch (error) {
        if (throwOnError) {
            throw error;
        }

        return [[], {params, hasNext: false}];
    }
};
