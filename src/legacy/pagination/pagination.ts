import {QueryBuilder} from '../../query';
import CouchbaseConnection from '../connection';

export interface PaginationArgs {
    bucketName: string;
    select?: any[] | string;
    where: any;
    page: number;
    limit: number;
    orderBy?: any;
}

/**
 * Legacy pagination preserves the old string-built query and error-swallowing behavior.
 */
export const Pagination = async (args: PaginationArgs): Promise<any[]> => {
    const {
        bucketName = '_default',
        where = {},
        page = 0,
        limit = 10,
        orderBy = {createdAt: 'DESC'},
    } = args;

    const cluster = CouchbaseConnection.Instance.cluster;

    let select = args.select || '*';
    if (Array.isArray(select)) {
        select = select.map((i) => ({$field: i}));
    }

    const offset = page * limit;

    try {
        const query = new QueryBuilder(where, bucketName)
            .select(select)
            .limit(limit)
            .offset(offset)
            .orderBy(orderBy)
            .build();

        console.log('query', query);

        const {rows} = await cluster.query(query);

        return rows.map((r: any) => {
            return select === '*' ? r[bucketName] : r;
        });
    } catch (error) {
        console.error('error running pagination', error);
        return [];
    }
};
