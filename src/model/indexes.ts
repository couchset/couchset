import type {Cluster} from 'couchbase';

import {buildWhereExpr} from '../query/helpers/builders';
import {LogicalWhereExpr, SortType} from '../query/interface/query.types';
import {escapeReservedWords} from '../query/utils';

export type IndexField = string | Record<string, SortType>;

export interface ModelIndexDefinition {
    name: string;
    fields?: IndexField[];
    where?: LogicalWhereExpr;
    deferred?: boolean;
    numReplica?: number;
    primary?: boolean;
}

export interface EnsureIndexOptions {
    deferred?: boolean;
}

const indexName = (name: string): string => `\`${name.replace(/`/g, '``')}\``;

const buildIndexField = (field: IndexField): string => {
    if (typeof field === 'string') {
        return escapeReservedWords(field);
    }

    const key = Object.keys(field)[0];

    return `${escapeReservedWords(key)} ${field[key]}`;
};

const buildWithExpr = (index: ModelIndexDefinition, options?: EnsureIndexOptions): string => {
    const deferred = options?.deferred ?? index.deferred;
    const withOptions: string[] = [];

    if (deferred) {
        withOptions.push('"defer_build": true');
    }

    if (typeof index.numReplica === 'number') {
        withOptions.push(`"num_replica": ${index.numReplica}`);
    }

    return withOptions.length ? ` WITH {${withOptions.join(',')}}` : '';
};

export const buildIndexQuery = (
    keyspace: string,
    index: ModelIndexDefinition,
    options?: EnsureIndexOptions
): string => {
    if (index.primary) {
        return `CREATE PRIMARY INDEX IF NOT EXISTS ${indexName(
            index.name
        )} ON ${keyspace}${buildWithExpr(index, options)}`;
    }

    if (!index.fields || !index.fields.length) {
        throw new Error(`index ${index.name} requires at least one field`);
    }

    return `CREATE INDEX IF NOT EXISTS ${indexName(index.name)} ON ${keyspace}(${index.fields
        .map(buildIndexField)
        .join(',')})${buildWhereExpr(index.where)}${buildWithExpr(index, options)}`;
};

export const ensureModelIndexes = async (
    cluster: Cluster,
    keyspace: string,
    indexes: ModelIndexDefinition[] = [],
    options?: EnsureIndexOptions
): Promise<string[]> => {
    const queries = indexes.map((index) => buildIndexQuery(keyspace, index, options));

    for (const query of queries) {
        await cluster.query(query);
    }

    return queries;
};
