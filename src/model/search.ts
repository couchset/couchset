import {SearchQuery, SearchRequest, VectorQuery, VectorSearch} from 'couchbase';
import type {ISearchIndex, SearchQueryOptions, SearchResult} from 'couchbase';

import type {ModelDefinition} from '../next';

import {geoPoint, geoRadiusKm, geoBounds, GeoPoint, GeoBounds} from './geo';

export interface ModelSearchField {
    type: 'text' | 'number' | 'boolean' | 'datetime' | 'geopoint' | 'geoshape' | 'vector';
    store?: boolean;
    analyzer?: string;
    dims?: number;
    similarity?: 'dot_product' | 'l2_norm' | 'cosine';
}
export interface ModelSearchIndex {
    name: string;
    fields: Record<string, ModelSearchField>;
    /** Scoped indexes require Couchbase Server 7.6+. */
    scoped?: boolean;
}
export interface SearchPlanItem {
    status: 'create' | 'matching' | 'replace';
    index: ISearchIndex;
    scope?: string;
    previousUuid?: string;
}
export interface SearchIndexPlan {
    items: SearchPlanItem[];
}
export interface SearchRuntime {
    ready(): Promise<unknown>;
    cluster: any;
    bucket: any;
    bucketName: string;
}

const stable = (value: any): string => {
    if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
    if (value && typeof value === 'object')
        return `{${Object.keys(value)
            .sort()
            .map((key) => `${JSON.stringify(key)}:${stable(value[key])}`)
            .join(',')}}`;
    return JSON.stringify(value);
};
const comparable = (index: ISearchIndex): unknown => {
    const mapping = JSON.parse(JSON.stringify(index.params.mapping || {}));
    if (mapping.analysis && !Object.keys(mapping.analysis).length) delete mapping.analysis;
    const normalizeFields = (node: any): void => {
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node.fields))
            for (const field of node.fields) {
                // Couchbase omits false field flags when returning its catalog.
                if (field.store === false) delete field.store;
                if (field.include_in_all === false) delete field.include_in_all;
            }
        Object.keys(node).forEach((key) => normalizeFields(node[key]));
    };
    normalizeFields(mapping);
    return {
        name: index.name,
        sourceName: index.sourceName,
        type: index.type,
        params: {mapping, doc_config: index.params.doc_config},
        indexPartitions: index.planParams.indexPartitions,
        sourceType: index.sourceType,
    };
};

export const buildModelSearchIndex = (
    bucket: string,
    definition: ModelDefinition<any>,
    index: ModelSearchIndex
): ISearchIndex => {
    if (!/^[a-zA-Z][\w-]*$/.test(index.name)) throw new Error('Invalid Search index name');
    const properties: any = {};
    const fields = {
        ...index.fields,
        _type: {type: 'text', analyzer: 'keyword'} as ModelSearchField,
    };
    for (const path of Object.keys(fields)) {
        const config = fields[path];
        if (
            !['text', 'number', 'boolean', 'datetime', 'geopoint', 'geoshape', 'vector'].includes(
                config.type
            )
        )
            throw new Error('Invalid Search field type');
        if (config.type === 'vector' && (!Number.isSafeInteger(config.dims) || config.dims < 1))
            throw new Error('Vector field requires positive dims');
        let target = properties;
        const parts = path.split('.');
        if (parts.some((part) => !/^[a-zA-Z_][\w]*$/.test(part)))
            throw new Error('Search fields require simple dotted paths');
        parts.forEach((part, position) => {
            if (!Object.prototype.hasOwnProperty.call(target, part))
                Object.defineProperty(target, part, {
                    value: {enabled: true, dynamic: false},
                    enumerable: true,
                });
            if (position < parts.length - 1) {
                target[part].properties = target[part].properties || {};
                target = target[part].properties;
            } else
                target[part].fields = [
                    {
                        name: part,
                        type: config.type,
                        index: true,
                        store: config.store || false,
                        docvalues: true,
                        include_in_all: false,
                        ...(config.analyzer ? {analyzer: config.analyzer} : {}),
                        ...(config.type === 'vector'
                            ? {dims: config.dims, similarity: config.similarity || 'dot_product'}
                            : {}),
                    },
                ];
        });
    }
    return {
        name: index.name,
        type: 'fulltext-index',
        sourceType: 'gocbcore',
        sourceName: bucket,
        sourceUuid: '',
        sourceParams: {},
        planParams: {indexPartitions: 1},
        params: {
            doc_config: {
                mode: 'scope.collection.type_field',
                type_field: '_type',
                docid_prefix_delim: '',
                docid_regexp: '',
            },
            mapping: {
                default_mapping: {enabled: false, dynamic: false},
                default_analyzer: 'standard',
                default_datetime_parser: 'dateTimeOptional',
                default_field: '_all',
                default_type: '_default',
                type_field: '_type',
                docvalues_dynamic: false,
                index_dynamic: false,
                store_dynamic: false,
                types: {
                    [`${definition.scope || '_default'}.${definition.collection || '_default'}`]: {
                        enabled: true,
                        dynamic: false,
                        properties,
                    },
                },
            },
        },
    };
};

const manager = (runtime: SearchRuntime, scope?: string): any =>
    scope ? runtime.bucket.scope(scope).searchIndexes() : runtime.cluster.searchIndexes();

export const planModelSearchIndexes = async (
    runtime: SearchRuntime,
    definitions: ModelDefinition<any>[]
): Promise<SearchIndexPlan> => {
    await runtime.ready();
    const items: SearchPlanItem[] = [];
    const identities = new Set<string>();
    for (const definition of definitions)
        for (const declared of definition.searchIndexes || []) {
            const scope = declared.scoped ? definition.scope || '_default' : undefined;
            const identity = `${scope || ''}/${declared.name}`;
            if (identities.has(identity))
                throw new Error(`Duplicate Search index target ${identity}`);
            identities.add(identity);
            const index = buildModelSearchIndex(runtime.bucketName, definition, declared);
            const existing = (await manager(runtime, scope).getAllIndexes()).find(
                (entry: ISearchIndex) => entry.name === index.name
            );
            items.push({
                index,
                scope,
                previousUuid: existing?.uuid,
                status: !existing
                    ? 'create'
                    : stable(comparable(existing)) === stable(comparable(index))
                    ? 'matching'
                    : 'replace',
            });
        }
    return {items};
};

export const applyModelSearchPlan = async (
    runtime: SearchRuntime,
    plan: SearchIndexPlan,
    options: {allowReplace?: boolean; timeoutMs?: number} = {}
): Promise<void> => {
    await runtime.ready();
    const timeout = options.timeoutMs === undefined ? 30000 : options.timeoutMs;
    if (!Number.isFinite(timeout) || timeout <= 0)
        throw new Error('Positive Search readiness timeout required');
    // Validate the entire plan before the first administrative mutation.
    for (const item of plan.items) {
        if (item.index.sourceName !== runtime.bucketName)
            throw new Error('Search plan targets another bucket');
        if (item.status === 'replace' && !options.allowReplace)
            throw new Error('Search index replacement requires allowReplace');
        const existing = (await manager(runtime, item.scope).getAllIndexes()).find(
            (index: ISearchIndex) => index.name === item.index.name
        );
        if ((existing?.uuid || undefined) !== item.previousUuid)
            throw new Error('Search plan is stale; re-plan');
    }
    for (const item of plan.items) {
        if (item.status === 'matching') continue;
        await manager(runtime, item.scope).upsertIndex({
            ...item.index,
            ...(item.previousUuid ? {uuid: item.previousUuid} : {}),
        });
        const end = Date.now() + timeout;
        for (;;) {
            try {
                const target = item.scope ? runtime.bucket.scope(item.scope) : runtime.cluster;
                await target.search(
                    item.index.name,
                    SearchRequest.create(SearchQuery.matchNone()),
                    {timeout: Math.max(1, end - Date.now())}
                );
                break;
            } catch (error) {
                if (Date.now() >= end) throw error;
                await new Promise((resolve) =>
                    setTimeout(resolve, Math.min(100, end - Date.now()))
                );
            }
        }
    }
};

/** Search returns SDK hits/metadata, not hydrated documents; raw fields stay unknown. */
export class ModelSearch<T> {
    constructor(
        private readonly runtime: SearchRuntime,
        private readonly definition: ModelDefinition<T>,
        private readonly index: ModelSearchIndex
    ) {}
    private filter(query: unknown): SearchQuery {
        if (this.definition.defaultWhere || this.definition.softDelete)
            throw new Error(
                'Search requires explicit Search filters; SQL++ defaultWhere/softDelete cannot be translated implicitly'
            );
        return new SearchQuery({conjuncts: [{term: this.definition.name, field: '_type'}, query]});
    }
    async query(query: unknown, options?: SearchQueryOptions): Promise<SearchResult> {
        const request = SearchRequest.create(this.filter(query));
        await this.runtime.ready();
        return (
            this.index.scoped
                ? this.runtime.bucket.scope(this.definition.scope || '_default')
                : this.runtime.cluster
        ).search(this.index.name, request, options);
    }
    match(
        field: keyof T & string,
        text: string,
        options?: SearchQueryOptions
    ): Promise<SearchResult> {
        if (this.index.fields[field]?.type !== 'text')
            throw new Error('Match requires a text field mapping');
        return this.query({match: text, field}, options);
    }
    async vector(
        field: keyof T & string,
        vector: number[],
        options: SearchQueryOptions & {
            numCandidates?: number;
            filter?: unknown;
            searchQuery?: unknown;
        } = {}
    ): Promise<SearchResult> {
        const mapping = this.index.fields[field];
        if (
            mapping?.type !== 'vector' ||
            vector.length !== mapping.dims ||
            vector.some((value) => !Number.isFinite(value))
        )
            throw new Error('Vector dimensions or values do not match index');
        const {
            numCandidates = 10,
            filter = {match_all: {}},
            searchQuery,
            ...searchOptions
        } = options;
        if (!Number.isSafeInteger(numCandidates) || numCandidates < 1)
            throw new Error('Invalid vector candidate count');
        const request = SearchRequest.create(
            VectorSearch.fromVectorQuery(
                VectorQuery.create(field, vector)
                    .numCandidates(numCandidates)
                    .prefilter(this.filter(filter))
            )
        );
        if (searchQuery) request.withSearchQuery(this.filter(searchQuery));
        await this.runtime.ready();
        return (
            this.index.scoped
                ? this.runtime.bucket.scope(this.definition.scope || '_default')
                : this.runtime.cluster
        ).search(this.index.name, request, searchOptions);
    }
    withinRadius(
        args: {field: string; center: GeoPoint; radius: string; strategy: 'search'},
        options?: SearchQueryOptions
    ) {
        this.requireGeo(args.field, 'geopoint', args.strategy);
        geoRadiusKm(args.radius);
        return this.query(
            {field: args.field, location: geoPoint(args.center), distance: args.radius},
            options
        );
    }
    withinBox(
        args: {field: string; bounds: GeoBounds; strategy: 'search'},
        options?: SearchQueryOptions
    ) {
        this.requireGeo(args.field, 'geopoint', args.strategy);
        const box = geoBounds(args.bounds);
        return this.query(
            {
                field: args.field,
                top_left: {lat: box.north, lon: box.west},
                bottom_right: {lat: box.south, lon: box.east},
            },
            options
        );
    }
    withinPolygon(
        args: {field: string; points: GeoPoint[]; strategy: 'search'},
        options?: SearchQueryOptions
    ) {
        this.requireGeo(args.field, 'geopoint', args.strategy);
        if (args.points.length < 3) throw new Error('Polygon requires at least three points');
        return this.query({field: args.field, polygon_points: args.points.map(geoPoint)}, options);
    }
    shape(
        args: {
            field: string;
            geometry: {type: string; coordinates?: unknown; geometries?: unknown[]};
            relation: 'intersects' | 'within' | 'contains';
            strategy: 'search';
        },
        options?: SearchQueryOptions
    ) {
        this.requireGeo(args.field, 'geoshape', args.strategy);
        return this.query(
            {field: args.field, geometry: {shape: args.geometry, relation: args.relation}},
            options
        );
    }
    private requireGeo(field: string, type: string, strategy: string): void {
        if (strategy !== 'search' || this.index.fields[field]?.type !== type)
            throw new Error(`Geo query requires search strategy and ${type} mapping`);
    }
}
