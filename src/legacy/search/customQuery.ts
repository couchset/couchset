import CouchbaseConnection from '../connection';

export interface CustomQueryArgs {
    query: any;
    limit: number;
    params: any;
}

export interface CustomQueryPagination {
    hasNext: boolean;
    params: any;
}

/**
 * Legacy custom query preserves the old raw cluster.query(query) behavior.
 */
export const CustomQuery = async <T>(
    args: CustomQueryArgs
): Promise<[T[], CustomQueryPagination]> => {
    const {query, limit, params} = args;

    const cluster = CouchbaseConnection.Instance.cluster;

    try {
        console.log('-> ', query);

        const {rows = []} = await cluster.query(query);

        const totalItems = rows.length;
        const hasNext = totalItems >= limit;

        return [rows as unknown as T[], {params, hasNext}];
    } catch (error) {
        console.error('error running CustomQuery', error);
        return [[], {params, hasNext: false}];
    }
};
