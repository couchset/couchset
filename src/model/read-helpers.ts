import type {Cluster} from 'couchbase';

import {buildSelectionQuery} from '../pagination/safe-pagination';

import {buildIncludedSelectionQuery, IncludeDefinition, includeOperator} from './include';
import {queryOptionsWithParameters, SafeQueryOptions} from './safe-query';

export interface ModelReadArgs {
    select?: readonly any[] | string;
    where?: any;
    orderBy?: any;
    limit?: number;
    page?: number;
    offset?: number;
    throwOnError?: boolean;
    include?: readonly IncludeDefinition[];
    sourceAlias?: string;
    queryOptions?: SafeQueryOptions;
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
    resultKey?: string;
    parseProjection?: <T>(data: T) => T;
}

const scopedWhere = (collectionName: string, where?: any): any => {
    const typeWhere = {_type: {$eq: collectionName}};

    if (!where || !Object.keys(where).length) {
        return typeWhere;
    }

    return {$and: [typeWhere, where]};
};

const shouldThrow = (args: ModelReadArgs): boolean => args.throwOnError !== false;

const decodeRows = <T>(
    rows: any[],
    context: ModelReadContext,
    args: ModelReadArgs,
    selectAll: boolean,
    resultKey?: string
): T[] => {
    const includes = args.include || [];
    const structured =
        Array.isArray(args.select) &&
        args.select.every((field) => typeof field === 'string' && !field.includes('.'));
    return rows.map((row) => {
        let root: any;
        if (resultKey === '__cs_root') root = row.__cs_root;
        else root = selectAll ? row[context.resultKey || context.bucketName] : row;
        // Raw/computed projections have unknown shape and must not run document codecs.
        const parse = selectAll ? context.parse : structured ? context.parseProjection : undefined;
        if (!includes.length && !parse) return root as T;
        const result: any = parse ? parse(root) : {...root};
        for (const item of includes) {
            if (
                resultKey === '__cs_root' &&
                (Object.prototype.hasOwnProperty.call(root, item.as) ||
                    Object.prototype.hasOwnProperty.call(result, item.as))
            ) {
                throw new Error(
                    `Include alias ${item.as} would overwrite a root field; choose another alias`
                );
            }
            if (!Object.prototype.hasOwnProperty.call(row, item.as)) {
                if (includeOperator(item).includes('NEST')) result[item.as] = [];
                continue;
            }
            const value = row[item.as];
            if (includeOperator(item).includes('NEST') && (value === null || value === undefined)) {
                result[item.as] = [];
                continue;
            }
            const model = typeof item.model === 'object' ? item.model : undefined;
            const decode = item.select ? model?.parseProjection : model?.parse;
            result[item.as] =
                value === null || value === undefined || !decode
                    ? value
                    : Array.isArray(value)
                    ? value.map((document) => decode.call(model, document))
                    : decode.call(model, value);
        }
        return result as T;
    });
};

const runReadQuery = async <T>(
    context: ModelReadContext,
    args: ModelReadArgs,
    queryArgs: ModelReadArgs
): Promise<T[]> => {
    const hasIncludes = Array.isArray(queryArgs.include) && queryArgs.include.length > 0;
    const builtQuery = hasIncludes
        ? buildIncludedSelectionQuery({
              keyspace: context.bucketName,
              collectionName: context.collectionName,
              select: queryArgs.select || '*',
              where: scopedWhere(context.collectionName, queryArgs.where),
              limit: queryArgs.limit,
              page: queryArgs.page,
              offset: queryArgs.offset,
              orderBy: queryArgs.orderBy,
              include: queryArgs.include,
              sourceAlias: queryArgs.sourceAlias,
          })
        : {
              ...buildSelectionQuery(
                  {
                      bucketName: context.bucketName,
                      select: (queryArgs.select || '*') as any,
                      where: {where: scopedWhere(context.collectionName, queryArgs.where)},
                      limit: queryArgs.limit,
                      page: queryArgs.page,
                      offset: queryArgs.offset,
                      orderBy: queryArgs.orderBy,
                  },
                  {includeLimitOffset: true}
              ),
              resultKey: undefined,
          };
    const {query, parameters, selectAll, resultKey} = builtQuery;

    const options = queryOptionsWithParameters(parameters, args.queryOptions);
    try {
        const {rows = []} = await context.cluster.query(query, options);

        return decodeRows<T>(rows, context, queryArgs, selectAll, resultKey);
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
    if (args.include?.length)
        throw new Error('count/exists do not support includes; use findMany/page for joined rows');
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

    const options = queryOptionsWithParameters(parameters, args.queryOptions);
    try {
        const {rows = []} = await context.cluster.query(query, options);

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
    if (args.include?.length)
        throw new Error('count/exists do not support includes; use findMany/page for joined rows');
    const {query, parameters} = buildSelectionQuery({
        bucketName: context.bucketName,
        select: 'RAW COUNT(1)',
        where: {where: scopedWhere(context.collectionName, args.where)},
    });

    const options = queryOptionsWithParameters(parameters, args.queryOptions);
    try {
        const {rows = []} = await context.cluster.query(query, options);

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
