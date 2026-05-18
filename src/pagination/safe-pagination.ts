import {buildSelectArrayExpr} from '../query/helpers';
import {IGroupBy, ILetExpr, LogicalWhereExpr, SortType} from '../query/interface/query.types';
import {escapeReservedWords} from '../query/utils';

import {PaginationArgs} from './types';

export interface PaginationQuery {
    query: string;
    parameters: Record<string, any>;
    selectAll: boolean;
    limit?: number;
    offset?: number;
}

export interface SelectionQueryOptions {
    includeLimitOffset?: boolean;
    defaultOrderBy?: Record<string, SortType>;
}

const comparisonOperators: Record<string, string> = {
    $eq: '=',
    $neq: '!=',
    $gt: '>',
    $gte: '>=',
    $lt: '<',
    $lte: '<=',
};

const stringComparisonOperators: Record<string, string> = {
    $like: 'LIKE',
    $notLike: 'NOT LIKE',
};

const emptyComparisonOperators: Record<string, string> = {
    $isNull: 'IS NULL',
    $isNotNull: 'IS NOT NULL',
    $isMissing: 'IS MISSING',
    $isNotMissing: 'IS NOT MISSING',
    $isValued: 'IS VALUED',
    $isNotValued: 'IS NOT VALUED',
};

const multipleComparisonOperators: Record<string, string> = {
    $btw: 'BETWEEN',
    $notBtw: 'NOT BETWEEN',
};

const logicalOperators: Record<string, string> = {
    $and: 'AND',
    $or: 'OR',
};

class PaginationParameterStore {
    public parameters: Record<string, any> = {};
    private index = 0;

    public add(value: any): string {
        const key = `cs_param_${this.index}`;
        this.index += 1;
        this.parameters[key] = value;

        return `$${key}`;
    }
}

const collectionIdentifier = (collection: string): string => {
    if (collection.indexOf(' ') !== -1) {
        return `\`${collection}`.replace(' ', '` ');
    }

    if (collection.indexOf('`') !== -1) {
        return collection;
    }

    return `\`${collection}\``;
};

const hasLogicalOperator = (clause: Record<string, any>): boolean => {
    return Object.keys(clause).some((key) => ['$and', '$or', '$not'].includes(key));
};

const parameterizeValue = (value: any, store: PaginationParameterStore): string => {
    return store.add(value);
};

const buildComparisonExpr = (
    fieldName: string,
    comparison: Record<string, any>,
    store: PaginationParameterStore
): string => {
    const field = escapeReservedWords(fieldName);
    const expr = Object.keys(comparison)
        .map((operator) => {
            if (Object.prototype.hasOwnProperty.call(emptyComparisonOperators, operator)) {
                return `${field} ${emptyComparisonOperators[operator]}`;
            }

            if (Object.prototype.hasOwnProperty.call(comparisonOperators, operator)) {
                return `${field}${comparisonOperators[operator]}${parameterizeValue(
                    comparison[operator],
                    store
                )}`;
            }

            if (Object.prototype.hasOwnProperty.call(stringComparisonOperators, operator)) {
                return `${field} ${stringComparisonOperators[operator]} ${parameterizeValue(
                    comparison[operator],
                    store
                )}`;
            }

            if (
                Object.prototype.hasOwnProperty.call(multipleComparisonOperators, operator) &&
                Array.isArray(comparison[operator])
            ) {
                const [from, to] = comparison[operator];

                return `${field} ${multipleComparisonOperators[operator]} ${parameterizeValue(
                    from,
                    store
                )} AND ${parameterizeValue(to, store)}`;
            }

            throw new Error(`Unsupported pagination where operator: ${operator}`);
        })
        .join(' AND ');

    return Object.keys(comparison).length > 1 ? `(${expr})` : expr;
};

const buildFieldExpr = (field: Record<string, any>, store: PaginationParameterStore): string => {
    return Object.keys(field)
        .map((fieldName) => {
            const value = field[fieldName];

            if (
                value &&
                typeof value === 'object' &&
                !Array.isArray(value) &&
                Object.keys(value).some((operator) => operator.indexOf('$') === 0)
            ) {
                return buildComparisonExpr(fieldName, value, store);
            }

            if (fieldName.indexOf('$') === -1) {
                return `${escapeReservedWords(fieldName)}=${parameterizeValue(value, store)}`;
            }

            throw new Error(`Unsupported pagination where field: ${fieldName}`);
        })
        .join(' AND ');
};

const buildWhereClauseExpr = (
    clause: LogicalWhereExpr,
    store: PaginationParameterStore
): string => {
    if (!hasLogicalOperator(clause as Record<string, any>)) {
        return buildFieldExpr(clause as Record<string, any>, store);
    }

    return Object.keys(clause)
        .map((key) => {
            const value = clause[key];

            if (
                Array.isArray(value) &&
                Object.prototype.hasOwnProperty.call(logicalOperators, key)
            ) {
                return `(${value
                    .map((item) => buildWhereClauseExpr(item as LogicalWhereExpr, store))
                    .join(` ${logicalOperators[key]} `)})`;
            }

            if (key === '$not' && Array.isArray(value)) {
                return `NOT (${value
                    .map((item) => buildWhereClauseExpr(item as LogicalWhereExpr, store))
                    .join(' AND ')})`;
            }

            return buildWhereClauseExpr({[key]: value} as LogicalWhereExpr, store);
        })
        .join(' AND ');
};

const buildWhereExpr = (
    expr: LogicalWhereExpr | undefined,
    store: PaginationParameterStore,
    clause = 'WHERE'
): string => {
    return expr ? ` ${clause} ${buildWhereClauseExpr(expr, store)}` : '';
};

const buildUseKeysExpr = (
    useKeys: string[] | undefined,
    store: PaginationParameterStore
): string => {
    return Array.isArray(useKeys) ? ` USE KEYS ${parameterizeValue(useKeys, store)}` : '';
};

const buildLetExpr = (
    letExpr: ILetExpr[] | undefined,
    store: PaginationParameterStore,
    clause = 'LET'
): string => {
    return Array.isArray(letExpr)
        ? ` ${clause} ${letExpr
              .map(
                  (value: ILetExpr) =>
                      `${escapeReservedWords(value.key)}=${parameterizeValue(value.value, store)}`
              )
              .join(',')}`
        : '';
};

const buildGroupByExpr = (
    groupByExpr: IGroupBy[] | undefined,
    lettingExpr: ILetExpr[] | undefined,
    havingExpr: LogicalWhereExpr | undefined,
    store: PaginationParameterStore
): string => {
    if (!groupByExpr) {
        return '';
    }

    return ` GROUP BY ${groupByExpr
        .map((value: IGroupBy) => {
            return `${escapeReservedWords(value.expr)}${value.as ? ` AS ${value.as}` : ''}`;
        })
        .join(',')}${buildLetExpr(lettingExpr, store, 'LETTING')}${buildWhereExpr(
        havingExpr,
        store,
        'HAVING'
    )}`;
};

const buildSelectExpr = (select?: any[] | string): {expr: string; selectAll: boolean} => {
    if (!select || select === '*') {
        return {expr: '*', selectAll: true};
    }

    if (typeof select === 'string') {
        return {expr: select, selectAll: false};
    }

    const selectExpr = select.map((item) => {
        return typeof item === 'string' ? {$field: item} : item;
    });

    return {expr: buildSelectArrayExpr(selectExpr), selectAll: false};
};

const buildOrderByExpr = (orderExpr: Record<string, SortType> | undefined): string => {
    return orderExpr
        ? ` ORDER BY ${Object.keys(orderExpr)
              .map((value: string) => `${escapeReservedWords(value)} ${orderExpr[value]}`)
              .join(',')}`
        : '';
};

const addNamedParameter = (parameters: Record<string, any>, key: string, value: any): string => {
    parameters[key] = value;

    return `$${key}`;
};

export const buildSelectionQuery = (
    args: PaginationArgs,
    options: SelectionQueryOptions = {}
): PaginationQuery => {
    const {
        bucketName = '_default',
        where = {},
        page = 0,
        limit = 10,
        offset,
        orderBy = options.defaultOrderBy,
    } = args;
    const {includeLimitOffset = false} = options;
    const store = new PaginationParameterStore();
    const parameters = store.parameters;
    const {expr: selectExpr, selectAll} = buildSelectExpr(args.select || '*');
    const queryOffset = typeof offset === 'number' ? offset : page * limit;
    const conditions = where || {};
    const plainJoin = conditions.plainJoin ? ` ${conditions.plainJoin} ` : '';
    const limitOffsetExpr = includeLimitOffset
        ? ` LIMIT ${addNamedParameter(parameters, 'cs_limit', limit)} OFFSET ${addNamedParameter(
              parameters,
              'cs_offset',
              queryOffset
          )}`
        : '';

    const query = `SELECT ${selectExpr} FROM ${collectionIdentifier(
        bucketName
    )}${plainJoin}${buildUseKeysExpr(conditions.use, store)}${buildLetExpr(
        conditions.let,
        store
    )}${buildWhereExpr(conditions.where, store)}${buildGroupByExpr(
        conditions.groupBy,
        conditions.letting,
        conditions.having,
        store
    )}${buildOrderByExpr(orderBy)}${limitOffsetExpr}`;

    return {
        query,
        parameters,
        selectAll,
        limit,
        offset: queryOffset,
    };
};

export const buildPaginationQuery = (args: PaginationArgs): PaginationQuery => {
    return buildSelectionQuery(args, {
        includeLimitOffset: true,
        defaultOrderBy: {createdAt: 'DESC'},
    });
};
