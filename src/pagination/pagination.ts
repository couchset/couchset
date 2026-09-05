import CouchbaseConnection from '../connection';
import {queryOptionsWithParameters, validateReadConsistency} from '../model/safe-query';

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
    const {bucketName = '_default', resultKey = bucketName} = args;

    const cluster = CouchbaseConnection.Instance.cluster;

    validateReadConsistency(args.queryOptions);
    try {
        const {query, parameters, selectAll} = buildPaginationQuery(args);

        const {rows} = await cluster.query(
            query,
            queryOptionsWithParameters(parameters, args.queryOptions)
        );

        const completedRows = rows.map((r: any) => {
            return selectAll ? r[resultKey] : r;
        });

        return completedRows;
    } catch (error) {
        if (args.throwOnError === false) {
            return [];
        }

        throw error;
    }
};
