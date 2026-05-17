import CouchbaseConnection from '../connection';

import {buildPaginationQuery} from './safe-pagination';
import {PaginationArgs} from './types';

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
    const {bucketName = '_default'} = args;

    const cluster = CouchbaseConnection.Instance.cluster;

    try {
        const {query, parameters, selectAll} = buildPaginationQuery(args);

        console.log('query', query);

        const {rows} = await cluster.query(query, {parameters});

        const completedRows = rows.map((r: any) => {
            return selectAll ? r[bucketName] : r;
        });

        return completedRows;
    } catch (error) {
        console.error('error running pagination', error);
        return [];
    }
};
