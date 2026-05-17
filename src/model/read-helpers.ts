import type {Cluster} from 'couchbase';

import {buildSelectionQuery} from '../pagination/safe-pagination';

export interface ModelReadArgs {
    select?: any[] | string;
    where?: any;
    orderBy?: any;
    limit?: number;
    page?: number;
    offset?: number;
    throwOnError?: boolean;
}

export interface ModelPageInfo {
    limit: number;
    page: number;
    offset: number;
    nextPage: number | null;
    nextOffset: number | null;
}

export interface ModelPageResult<T> {
    items: T[];
    hasNext: boolean;
    pageInfo: ModelPageInfo;
}

export interface ModelReadContext {
    bucketName: string;
    collectionName: string;
    cluster: Cluster;
    parse: <T>(data: T) => T;
}

const scopedWhere = (collectionName: string, where?: any): any => {
    const typeWhere = {_type: {$eq: collectionName}};

    if (!where || !Object.keys(where).length) {
        return typeWhere;
    }

    return {$and: [typeWhere, where]};
};

const shouldThrow = (args: ModelReadArgs): boolean => args.throwOnError !== false;

const unwrapRows = <T>(
    rows: any[],
    bucketName: string,
    selectAll: boolean,
    parse: <TItem>(data: TItem) => TItem
): T[] => {
    return rows.map((row) => {
        const data = selectAll ? row[bucketName] : row;

        return parse<T>(data);
    });
};

const runReadQuery = async <T>(
    context: ModelReadContext,
    args: ModelReadArgs,
    queryArgs: ModelReadArgs
): Promise<T[]> => {
    const {query, parameters, selectAll} = buildSelectionQuery(
        {
            bucketName: context.bucketName,
            select: queryArgs.select || '*',
            where: {where: scopedWhere(context.collectionName, queryArgs.where)},
            limit: queryArgs.limit,
            page: queryArgs.page,
            offset: queryArgs.offset,
            orderBy: queryArgs.orderBy,
        },
        {includeLimitOffset: true}
    );

    try {
        const {rows = []} = await context.cluster.query(query, {parameters});

        return unwrapRows<T>(rows, context.bucketName, selectAll, context.parse);
    } catch (error) {
        if (shouldThrow(args)) {
            throw error;
        }

        return [];
    }
};

export const findMany = async <T>(
    context: ModelReadContext,
    args: ModelReadArgs = {}
): Promise<T[]> => {
    return runReadQuery<T>(context, args, {
        ...args,
        limit: typeof args.limit === 'number' ? args.limit : 10,
        page: typeof args.page === 'number' ? args.page : 0,
    });
};

export const findOne = async <T>(
    context: ModelReadContext,
    args: ModelReadArgs = {}
): Promise<T | null> => {
    const rows = await runReadQuery<T>(context, args, {
        ...args,
        limit: 1,
        page: 0,
        offset: args.offset,
    });

    return rows.length ? rows[0] : null;
};

export const exists = async (
    context: ModelReadContext,
    args: ModelReadArgs = {}
): Promise<boolean> => {
    const {query, parameters} = buildSelectionQuery(
        {
            bucketName: context.bucketName,
            select: 'RAW 1',
            where: {where: scopedWhere(context.collectionName, args.where)},
            limit: 1,
            page: 0,
        },
        {includeLimitOffset: true}
    );

    try {
        const {rows = []} = await context.cluster.query(query, {parameters});

        return rows.length > 0;
    } catch (error) {
        if (shouldThrow(args)) {
            throw error;
        }

        return false;
    }
};

export const count = async (
    context: ModelReadContext,
    args: ModelReadArgs = {}
): Promise<number> => {
    const {query, parameters} = buildSelectionQuery({
        bucketName: context.bucketName,
        select: 'RAW COUNT(1)',
        where: {where: scopedWhere(context.collectionName, args.where)},
    });

    try {
        const {rows = []} = await context.cluster.query(query, {parameters});

        return Number(rows[0] || 0);
    } catch (error) {
        if (shouldThrow(args)) {
            throw error;
        }

        return 0;
    }
};

export const page = async <T>(
    context: ModelReadContext,
    args: ModelReadArgs = {}
): Promise<ModelPageResult<T>> => {
    const limit = typeof args.limit === 'number' ? args.limit : 10;
    const pageNumber = typeof args.page === 'number' ? args.page : 0;
    const offset = typeof args.offset === 'number' ? args.offset : pageNumber * limit;
    const rows = await runReadQuery<T>(context, args, {
        ...args,
        limit: limit + 1,
        page: pageNumber,
        offset,
    });
    const hasNext = rows.length > limit;

    return {
        items: hasNext ? rows.slice(0, limit) : rows,
        hasNext,
        pageInfo: {
            limit,
            page: pageNumber,
            offset,
            nextPage: hasNext ? pageNumber + 1 : null,
            nextOffset: hasNext ? offset + limit : null,
        },
    };
};
