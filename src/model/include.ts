import {buildSelectArrayExpr} from '../query/helpers';
import {LogicalWhereExpr, SortType} from '../query/interface/query.types';
import {escapeReservedWords} from '../query/utils';

import {escapeIdentifier} from './keyspace';

export type IncludeType = 'join' | 'leftJoin' | 'nest' | 'leftNest';

export interface IncludeDefinition {
    as: string;
    key?: string;
    keys?: string;
    keyspace?: string;
    model?: string | {keyspace: () => string};
    type?: IncludeType;
    optional?: boolean;
}

export interface IncludedSelectionQueryArgs {
    keyspace: string;
    collectionName: string;
    select?: any[] | string;
    where?: LogicalWhereExpr;
    orderBy?: Record<string, SortType>;
    include?: IncludeDefinition[];
    limit?: number;
    page?: number;
    offset?: number;
    sourceAlias?: string;
}

export interface IncludedSelectionQuery {
    query: string;
    parameters: Record<string, any>;
    selectAll: boolean;
    resultKey?: string;
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

class IncludeParameterStore {
    public parameters: Record<string, any> = {};
    private index = 0;

    public add(value: any): string {
        const key = `cs_param_${this.index}`;
        this.index += 1;
        this.parameters[key] = value;

        return `$${key}`;
    }

    public set(key: string, value: any): string {
        this.parameters[key] = value;

        return `$${key}`;
    }
}

const safeAlias = (alias: string): string => {
    return /^[A-Za-z_][A-Za-z0-9_]*$/.test(alias) ? alias : escapeIdentifier(alias);
};

const keyspaceFromInclude = (include: IncludeDefinition, defaultKeyspace: string): string => {
    if (include.keyspace) {
        return include.keyspace;
    }

    if (typeof include.model === 'string') {
        return include.model;
    }

    if (include.model) {
        return include.model.keyspace();
    }

    return defaultKeyspace;
};

const sourceField = (field: string, sourceAlias: string): string => {
    if (field.indexOf(`${sourceAlias}.`) === 0) {
        return field;
    }

    return `${sourceAlias}.${escapeReservedWords(field)}`;
};

const includeOperator = (include: IncludeDefinition): string => {
    if (include.type === 'leftNest') {
        return 'LEFT NEST';
    }

    if (include.type === 'nest') {
        return include.optional ? 'LEFT NEST' : 'NEST';
    }

    if (include.type === 'leftJoin') {
        return 'LEFT JOIN';
    }

    if (include.keys) {
        return include.optional ? 'LEFT NEST' : 'NEST';
    }

    return include.optional ? 'LEFT JOIN' : 'JOIN';
};

export const buildIncludeClauses = (
    keyspace: string,
    include: IncludeDefinition[] = [],
    sourceAlias = 'doc'
): string => {
    return include
        .map((item) => {
            const key = item.key || item.keys;

            if (!key) {
                throw new Error(`include ${item.as} requires key or keys`);
            }

            const alias = safeAlias(item.as);

            return `${includeOperator(item)} ${keyspaceFromInclude(
                item,
                keyspace
            )} AS ${alias} ON KEYS ${sourceField(key, sourceAlias)}`;
        })
        .join(' ');
};

const hasLogicalOperator = (clause: Record<string, any>): boolean => {
    return Object.keys(clause).some((key) => ['$and', '$or', '$not'].includes(key));
};

const buildComparisonExpr = (
    fieldName: string,
    comparison: Record<string, any>,
    store: IncludeParameterStore,
    sourceAlias: string
): string => {
    const field = sourceField(fieldName, sourceAlias);
    const expr = Object.keys(comparison)
        .map((operator) => {
            if (Object.prototype.hasOwnProperty.call(emptyComparisonOperators, operator)) {
                return `${field} ${emptyComparisonOperators[operator]}`;
            }

            if (Object.prototype.hasOwnProperty.call(comparisonOperators, operator)) {
                return `${field}${comparisonOperators[operator]}${store.add(comparison[operator])}`;
            }

            if (Object.prototype.hasOwnProperty.call(stringComparisonOperators, operator)) {
                return `${field} ${stringComparisonOperators[operator]} ${store.add(
                    comparison[operator]
                )}`;
            }

            if (
                Object.prototype.hasOwnProperty.call(multipleComparisonOperators, operator) &&
                Array.isArray(comparison[operator])
            ) {
                const [from, to] = comparison[operator];

                return `${field} ${multipleComparisonOperators[operator]} ${store.add(
                    from
                )} AND ${store.add(to)}`;
            }

            throw new Error(`Unsupported include where operator: ${operator}`);
        })
        .join(' AND ');

    return Object.keys(comparison).length > 1 ? `(${expr})` : expr;
};

const buildFieldExpr = (
    field: Record<string, any>,
    store: IncludeParameterStore,
    sourceAlias: string
): string => {
    return Object.keys(field)
        .map((fieldName) => {
            const value = field[fieldName];

            if (
                value &&
                typeof value === 'object' &&
                !Array.isArray(value) &&
                Object.keys(value).some((operator) => operator.indexOf('$') === 0)
            ) {
                return buildComparisonExpr(fieldName, value, store, sourceAlias);
            }

            if (fieldName.indexOf('$') === -1) {
                return `${sourceField(fieldName, sourceAlias)}=${store.add(value)}`;
            }

            throw new Error(`Unsupported include where field: ${fieldName}`);
        })
        .join(' AND ');
};

const buildWhereClauseExpr = (
    clause: LogicalWhereExpr,
    store: IncludeParameterStore,
    sourceAlias: string
): string => {
    if (!hasLogicalOperator(clause as Record<string, any>)) {
        return buildFieldExpr(clause as Record<string, any>, store, sourceAlias);
    }

    return Object.keys(clause)
        .map((key) => {
            const value = clause[key];

            if (
                Array.isArray(value) &&
                Object.prototype.hasOwnProperty.call(logicalOperators, key)
            ) {
                return `(${value
                    .map((item) =>
                        buildWhereClauseExpr(item as LogicalWhereExpr, store, sourceAlias)
                    )
                    .join(` ${logicalOperators[key]} `)})`;
            }

            if (key === '$not' && Array.isArray(value)) {
                return `NOT (${value
                    .map((item) =>
                        buildWhereClauseExpr(item as LogicalWhereExpr, store, sourceAlias)
                    )
                    .join(' AND ')})`;
            }

            return buildWhereClauseExpr({[key]: value} as LogicalWhereExpr, store, sourceAlias);
        })
        .join(' AND ');
};

const buildWhereExpr = (
    expr: LogicalWhereExpr | undefined,
    store: IncludeParameterStore,
    sourceAlias: string
): string => {
    return expr ? ` WHERE ${buildWhereClauseExpr(expr, store, sourceAlias)}` : '';
};

const buildOrderByExpr = (
    orderBy: Record<string, SortType> | undefined,
    sourceAlias: string
): string => {
    return orderBy
        ? ` ORDER BY ${Object.keys(orderBy)
              .map((field) => `${sourceField(field, sourceAlias)} ${orderBy[field]}`)
              .join(',')}`
        : '';
};

const buildSelectExpr = (
    select: any[] | string | undefined,
    include: IncludeDefinition[],
    sourceAlias: string
): {expr: string; selectAll: boolean; resultKey?: string} => {
    if (!select || select === '*') {
        const aliases = include.map((item) => safeAlias(item.as));
        const mergeObject = aliases.map((alias) => `${JSON.stringify(alias)}: ${alias}`).join(',');

        return {
            expr: `OBJECT_CONCAT(${sourceAlias}, {${mergeObject}}) AS ${sourceAlias}`,
            selectAll: true,
            resultKey: sourceAlias,
        };
    }

    const includeSelect = include.map((item) => {
        const alias = safeAlias(item.as);

        return `${alias} AS ${alias}`;
    });

    if (typeof select === 'string') {
        return {expr: [select, ...includeSelect].join(','), selectAll: false};
    }

    const modelSelect = select.map((item) => {
        return typeof item === 'string'
            ? sourceField(item, sourceAlias)
            : buildSelectArrayExpr([item]);
    });

    return {expr: [...modelSelect, ...includeSelect].join(','), selectAll: false};
};

export const buildIncludedSelectionQuery = (
    args: IncludedSelectionQueryArgs
): IncludedSelectionQuery => {
    const sourceAlias = safeAlias(args.sourceAlias || 'doc');
    const include = args.include || [];
    const store = new IncludeParameterStore();
    const limit = typeof args.limit === 'number' ? args.limit : 10;
    const page = typeof args.page === 'number' ? args.page : 0;
    const offset = typeof args.offset === 'number' ? args.offset : page * limit;
    const {expr, selectAll, resultKey} = buildSelectExpr(args.select, include, sourceAlias);
    const joins = buildIncludeClauses(args.keyspace, include, sourceAlias);
    const limitExpr = ` LIMIT ${store.set('cs_limit', limit)} OFFSET ${store.set(
        'cs_offset',
        offset
    )}`;

    return {
        query: `SELECT ${expr} FROM ${args.keyspace} AS ${sourceAlias} ${joins}${buildWhereExpr(
            args.where,
            store,
            sourceAlias
        )}${buildOrderByExpr(args.orderBy, sourceAlias)}${limitExpr}`,
        parameters: store.parameters,
        resultKey,
        selectAll,
    };
};
