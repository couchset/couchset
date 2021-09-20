import {Query} from '../query';
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
 * Common pagination
 *  where = {
      where: { owner: { $eq: "stoqey" }, _type: { $eq: "Trade" } },
    },
    page = 0,
    limit = 10,
    orderBy = { createdAt: "DESC" },
 * @param args PaginationArgs
 */
export const Pagination = async (args: PaginationArgs): Promise<any[]> => {
    const {
        bucketName = '_default',
        // select: ogSelected = '*',
        where = {
            // where: {owner: {$eq: 'stoqey'}, _type: {$eq: 'Trade'}},
        },
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
        const query = new Query(where, bucketName)
            .select(select)
            .limit(limit)
            .offset(offset)
            .orderBy(orderBy)
            .build();

        console.log('query', query);

        const {rows} = await cluster.query(query);

        const completedRows = rows.map((r: any) => {
            return select === '*' ? r[bucketName] : r;
        });

        return completedRows;
    } catch (error) {
        console.error('error running pagination', error);
        return [];
    }
};
