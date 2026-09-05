import {LogicalWhereExpr, SortType} from '../query/interface/query.types';

import {escapeIdentifier} from './keyspace';
import {parseFieldPath, renderFieldPath} from './field-path';

export type IncludeType = 'join' | 'leftJoin' | 'nest' | 'leftNest';

export interface IncludeDefinition {
    as: string;
    /** ANSI predicate; mutually exclusive with key/keys. */
    on?: JoinPredicate;
    /** Explicit trusted SQL++ escape hatch. Values still use positional placeholders. */
    onRaw?: {sql: string; values?: readonly unknown[]};
    /** Top-level fields retained from the related document. */
    select?: readonly string[];
    key?: string;
    keys?: string;
    keyspace?: string;
    model?:
        | string
        | {keyspace: () => string; parse?: <T>(data: T) => T; parseProjection?: <T>(data: T) => T};
    type?: IncludeType;
    optional?: boolean;
}

/** A field operand is explicit; bare strings are always parameter values. */
export interface JoinField {
    readonly $field: string;
}
export type JoinPredicate =
    | {$and: readonly JoinPredicate[]}
    | {$or: readonly JoinPredicate[]}
    | {left: JoinField; op: '$eq' | '$neq' | '$gt' | '$gte' | '$lt' | '$lte'; right: unknown};
export const joinField = (path: string): JoinField => ({$field: path});

const identifier = (name: string): string => {
    if (!name || name.indexOf('\0') !== -1) throw new Error('Empty or invalid identifier');
    return escapeIdentifier(name);
};

export interface IncludedSelectionQueryArgs {
    keyspace: string;
    collectionName: string;
    select?: readonly any[] | string;
    where?: LogicalWhereExpr;
    orderBy?: Record<string, SortType>;
    include?: readonly IncludeDefinition[];
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

const safeAlias = identifier;

const safeKeyspace = (target: string): string => {
    // Accept existing model.keyspace() output and simple dotted identifiers, never expressions.
    const token = '(?:`(?:[^`]|``)+`|[A-Za-z_][A-Za-z0-9_-]*)';
    if (!new RegExp(`^(?:default:)?${token}(?:\\.${token}){0,2}$`).test(target))
        throw new Error('Invalid include keyspace; use a model or identifier path');
    return target.replace(/[A-Za-z_][A-Za-z0-9_-]*|`(?:[^`]|``)+`/g, (part, offset) =>
        target.slice(offset + part.length, offset + part.length + 1) === ':' || part.startsWith('`')
            ? part
            : identifier(part)
    );
};
const keyspaceFromInclude = (include: IncludeDefinition, defaultKeyspace: string): string => {
    const target =
        include.keyspace ||
        (typeof include.model === 'string' ? include.model : include.model?.keyspace()) ||
        defaultKeyspace;
    return safeKeyspace(target);
};

const sourceField = (field: string, sourceAlias: string): string => {
    const segments = parseFieldPath(field);
    const qualified =
        segments.length > 1 && segments[0].name === sourceAlias && !segments[0].selectors.length;
    return qualified
        ? renderFieldPath(segments)
        : `${identifier(sourceAlias)}.${renderFieldPath(segments)}`;
};

export const includeOperator = (include: IncludeDefinition): string => {
    if (include.type === 'leftNest') {
        return 'LEFT NEST';
    }

    if (include.type === 'nest') {
        return include.optional ? 'LEFT NEST' : 'NEST';
    }

    if (include.type === 'leftJoin') {
        return 'LEFT JOIN';
    }

    if (include.type === 'join') {
        return include.optional ? 'LEFT JOIN' : 'JOIN';
    }

    if (include.keys) {
        return include.optional ? 'LEFT NEST' : 'NEST';
    }

    return include.optional ? 'LEFT JOIN' : 'JOIN';
};

const predicateExpr = (
    predicate: JoinPredicate,
    store: IncludeParameterStore,
    aliases: Set<string>
): string => {
    if (!predicate || typeof predicate !== 'object') throw new Error('Invalid ON predicate');
    const keys = Object.keys(predicate);
    if (keys.length === 1 && (keys[0] === '$and' || keys[0] === '$or')) {
        const children = (predicate as any)[keys[0]];
        if (!Array.isArray(children) || !children.length)
            throw new Error('ON logical groups must be nonempty');
        return `(${children
            .map((child) => predicateExpr(child, store, aliases))
            .join(keys[0] === '$and' ? ' AND ' : ' OR ')})`;
    }
    const comparison = predicate as any;
    if (
        keys.length !== 3 ||
        !keys.includes('left') ||
        !keys.includes('right') ||
        !keys.includes('op') ||
        !Object.prototype.hasOwnProperty.call(comparisonOperators, comparison.op)
    )
        throw new Error('Unsupported ON comparison');
    const reference = (value: any): string => {
        if (!value || typeof value.$field !== 'string' || Object.keys(value).length !== 1)
            throw new Error('Expected explicit joinField reference');
        const segments = parseFieldPath(value.$field);
        if (segments.length < 2 || segments[0].selectors.length || !aliases.has(segments[0].name))
            throw new Error(`Unknown ON alias: ${segments[0].name}`);
        return renderFieldPath(segments);
    };
    const right = comparison.right;
    return `${reference(comparison.left)} ${comparisonOperators[comparison.op]} ${
        right && typeof right === 'object' && Object.prototype.hasOwnProperty.call(right, '$field')
            ? reference(right)
            : store.add(right)
    }`;
};

export const buildIncludeClauses = (
    keyspace: string,
    include: readonly IncludeDefinition[] = [],
    sourceAlias = 'doc',
    store = new IncludeParameterStore()
): string => {
    const aliases = new Set([sourceAlias]);
    const reservedAliases = new Set(['__cs_root', '__proto__', 'constructor', 'prototype']);
    const modes = new Set(include.map((item) => (item.on || item.onRaw ? 'ansi' : 'keys')));
    // Couchbase does not permit mixing lookup and ANSI joins in the same FROM clause.
    if (modes.size > 1) throw new Error('Cannot mix ANSI ON and ON KEYS includes');
    return include
        .map((item) => {
            if (aliases.has(item.as) || reservedAliases.has(item.as))
                throw new Error(`Duplicate or reserved include alias: ${item.as}`);
            aliases.add(item.as);
            if (item.type && !['join', 'leftJoin', 'nest', 'leftNest'].includes(item.type))
                throw new Error('Unsupported include type');
            if (
                [
                    item.key !== undefined,
                    item.keys !== undefined,
                    item.on !== undefined,
                    item.onRaw !== undefined,
                ].filter(Boolean).length !== 1
            ) {
                throw new Error(`include ${item.as} requires exactly one of key, keys, on, onRaw`);
            }
            let condition: string;
            if (item.on) condition = `ON ${predicateExpr(item.on, store, aliases)}`;
            else if (item.onRaw) {
                const values = item.onRaw.values || [];
                let index = 0;
                if (!item.onRaw.sql.trim()) throw new Error('onRaw requires SQL');
                const sql = item.onRaw.sql.replace(/\?/g, () => {
                    if (index >= values.length) throw new Error('onRaw placeholder/value mismatch');
                    return store.add(values[index++]);
                });
                if (index !== values.length) throw new Error('onRaw placeholder/value mismatch');
                condition = `ON (${sql})`;
            } else
                condition = `ON KEYS ${sourceField(
                    (item.key || item.keys) as string,
                    sourceAlias
                )}`;
            return `${includeOperator(item)} ${keyspaceFromInclude(item, keyspace)} AS ${safeAlias(
                item.as
            )} ${condition}`;
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
              .map((field) => {
                  if (!['ASC', 'DESC'].includes(orderBy[field]))
                      throw new Error('Unsupported order direction');
                  return `${sourceField(field, sourceAlias)} ${orderBy[field]}`;
              })
              .join(',')}`
        : '';
};

const selectedObject = (alias: string, fields?: readonly string[]): string => {
    if (!fields) return identifier(alias);
    if (!fields.length || new Set(fields).size !== fields.length)
        throw new Error('Projection must contain distinct fields');
    return `{${fields
        .map((field) => {
            if (field.includes('.'))
                throw new Error('Include projections support top-level fields only');
            return `${JSON.stringify(field)}: ${identifier(alias)}.${identifier(field)}`;
        })
        .join(', ')}}`;
};

const buildSelectExpr = (
    select: readonly any[] | string | undefined,
    include: readonly IncludeDefinition[],
    sourceAlias: string
): {expr: string; selectAll: boolean; resultKey?: string} => {
    const all = !select || select === '*';
    const structured =
        Array.isArray(select) &&
        select.every((field) => typeof field === 'string' && !field.includes('.'));
    const root = all
        ? identifier(sourceAlias)
        : structured
        ? selectedObject(sourceAlias, select as string[])
        : undefined;
    const relations = include.map((item) => {
        const alias = identifier(item.as);
        if (!item.select) return `${alias} AS ${alias}`;
        const object = selectedObject('__cs_item', item.select);
        const expression = includeOperator(item).includes('NEST')
            ? `ARRAY ${object} FOR ${identifier('__cs_item')} IN ${alias} END`
            : `CASE WHEN ${alias} IS MISSING THEN MISSING WHEN ${alias} IS NULL THEN NULL ELSE ${selectedObject(
                  item.as,
                  item.select
              )} END`;
        return `${expression} AS ${alias}`;
    });
    if (
        structured &&
        (select as string[]).some((field) => include.some((item) => item.as === field))
    )
        throw new Error('Include alias conflicts with projected root field');
    if (root)
        return {
            expr: [`${root} AS __cs_root`, ...relations].join(', '),
            selectAll: all,
            resultKey: '__cs_root',
        };
    throw new Error(
        'Includes support only * or top-level field-array projections; use queryRows for arbitrary SQL++ projections'
    );
};

export const buildIncludedSelectionQuery = (
    args: IncludedSelectionQueryArgs
): IncludedSelectionQuery => {
    const sourceAlias = args.sourceAlias || 'doc';
    if (sourceAlias === '__cs_root') throw new Error('Reserved source alias');
    const include = args.include || [];
    const store = new IncludeParameterStore();
    const limit = typeof args.limit === 'number' ? args.limit : 10;
    const page = typeof args.page === 'number' ? args.page : 0;
    const offset = typeof args.offset === 'number' ? args.offset : page * limit;
    const {expr, selectAll, resultKey} = buildSelectExpr(args.select, include, sourceAlias);
    const joins = buildIncludeClauses(args.keyspace, include, sourceAlias, store);
    const limitExpr = ` LIMIT ${store.set('cs_limit', limit)} OFFSET ${store.set(
        'cs_offset',
        offset
    )}`;

    return {
        query: `SELECT ${expr} FROM ${args.keyspace} AS ${identifier(
            sourceAlias
        )} ${joins}${buildWhereExpr(args.where, store, sourceAlias)}${buildOrderByExpr(
            args.orderBy,
            sourceAlias
        )}${limitExpr}`,
        parameters: store.parameters,
        resultKey,
        selectAll,
    };
};
