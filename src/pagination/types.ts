import type {SafeQueryOptions} from '../model/safe-query';

export interface PaginationArgs {
    bucketName: string;
    resultKey?: string;
    select?: any[] | string;
    where: any;
    page?: number;
    limit?: number;
    offset?: number;
    orderBy?: any;
    throwOnError?: boolean;
    queryOptions?: SafeQueryOptions;
}
