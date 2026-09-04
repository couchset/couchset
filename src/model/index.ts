import type {
    Collection,
    Cluster,
    GetOptions,
    MutateInOptions,
    RemoveOptions,
    ReplaceOptions,
} from 'couchbase';

import {SchemaTypes, parseSchema} from '../utils';
import CouchbaseConnection from '../connection';

import {applyDefaultWhere, DefaultWhereMode} from './default-scope';
import {
    count as countRows,
    exists as rowsExist,
    findMany as findManyRows,
    findOne as findOneRow,
    page as pageRows,
} from './read-helpers';
import type {ModelPageResult, ModelReadArgs, ModelReadContext} from './read-helpers';
import {bucketIdentifier, fromTarget, keyspaceIdentifier} from './keyspace';
import {runQueryOne, runQueryPage, runQueryRows} from './safe-query';
import type {
    QueryPageOptions,
    QueryPageResult,
    QueryParameters,
    SafeQueryOptions,
} from './safe-query';
import {
    findByIdWithMeta as findByIdWithMetaDoc,
    incrementById as incrementDocumentById,
    insert as insertDocument,
    mutateById as mutateDocumentById,
    patchById as patchDocumentById,
    prepareInsertDocument,
    prepareReplacementDocument,
    replaceById as replaceDocumentById,
    upsert as upsertDocument,
} from './write-helpers';
import type {
    FindByIdWithMetaResult,
    InsertWriteOptions,
    ModelWriteContext,
    PatchByIdArgs,
    UpsertWriteOptions,
} from './write-helpers';
import {hydrate as hydrateDocument, Hydrated} from './hydrated-document';
import {
    buildIndexQuery,
    ensureModelIndexes,
    EnsureIndexOptions,
    ModelIndexDefinition,
} from './indexes';
import type {ParseHook, ValidationHook} from './validation';
import {parseDateFields, schemaFromDateFields} from './validation';

/** A small connection surface used by client-bound models. */
export interface ModelConnection {
    bucket?: any;
    bucketName?: string;
    cluster: Cluster;
    getBucket(): string;
    getCollection(scopeName?: string, collectionName?: string): Collection;
    isConnected(): boolean;
    ready(): Promise<any>;
    shouldReconnect(error: any): boolean;
    markDisconnected(error: any): void;
}

/** Converts a field between the application's value and Couchbase JSON. */
export interface FieldCodec<T = any, TDatabase = any> {
    toDatabase(value: T): TDatabase;
    fromDatabase(value: TDatabase): T;
}

export type {ModelPageResult, ModelReadArgs} from './read-helpers';
export type {
    QueryLogger,
    QueryPageOptions,
    QueryPageResult,
    QueryParameters,
    SafeQueryOptions,
} from './safe-query';
export type {FindByIdWithMetaResult, PatchByIdArgs} from './write-helpers';
export type {Hydrated} from './hydrated-document';
export type {IncludeDefinition, IncludeType} from './include';
export type {EnsureIndexOptions, ModelIndexDefinition} from './indexes';
export type {TtlOptions} from './ttl';
export type {ParseHook, ValidationHook} from './validation';

export interface AutoModelFields {
    id: string;
    createdAt: Date;
    updatedAt?: Date;
    deleted?: Date;
    _type: string; // type for models/collections
    _scope: string; // scope for collections
}

export interface UpdateOptions extends ReplaceOptions {
    silent?: boolean; // whether to updatedAt;
}

export interface DeleteByIdOptions extends RemoveOptions {
    hard?: boolean;
}

export interface ModalOptions {
    scope?: string;
    collection?: string;
    schema?: Record<string, SchemaTypes>;
    softDelete?: boolean;
    defaultWhere?: any;
    validateCreate?: ValidationHook;
    validateReplace?: ValidationHook;
    parse?: ParseHook;
    dateFields?: string[];
    /**
     * Explicit field transforms. A field cannot also be a dateFields/schema date
     * transform, since that makes the parse order ambiguous.
     */
    codecs?: Record<string, FieldCodec<any, any>>;
    indexes?: ModelIndexDefinition[];
}

export type ConsumeOnceResult = {status: 'consumed'} | {status: 'missing'} | {status: 'conflict'};

interface CollectionTarget {
    scopeName?: string;
    collectionName?: string;
}

export class Model {
    private static registeredModels: Model[] = [];

    collection: Collection;
    collectionName: string;
    scope = '_default';
    private scopeName?: string;
    private collectionTargetName?: string;
    private defaultWhere?: any;
    private defaultWhereMode: DefaultWhereMode = 'default';
    private softDelete = false;
    private validateCreateHook?: ValidationHook;
    private validateReplaceHook?: ValidationHook;
    private parseHook?: ParseHook;
    private dateFields?: string[];
    private codecs: Record<string, FieldCodec<any, any>> = {};
    private readonly connection?: ModelConnection;
    private indexes: ModelIndexDefinition[] = [];
    schema: Record<string, SchemaTypes> = {
        createdAt: 'date',
        updatedAt: 'date',
    };

    constructor(name: string, options?: ModalOptions, connection?: ModelConnection) {
        // this.collection = CouchbaseConnection.Instance.getCollection();
        this.collectionName = name;
        this.connection = connection;
        if (options) {
            const hasScope = Object.prototype.hasOwnProperty.call(options, 'scope');
            const hasCollection = Object.prototype.hasOwnProperty.call(options, 'collection');
            this.scope = (options && options.scope) || '_default';
            this.scopeName = hasScope ? this.scope : undefined;
            this.collectionTargetName = hasCollection
                ? options.collection || '_default'
                : undefined;
            this.softDelete = !!options.softDelete;
            this.defaultWhere = options.defaultWhere;
            this.validateCreateHook = options.validateCreate;
            this.validateReplaceHook = options.validateReplace;
            this.parseHook = options.parse;
            this.dateFields = options.dateFields;
            this.codecs = options.codecs || {};
            const dateFields = new Set(options.dateFields || []);
            Object.keys(this.codecs).forEach((field) => {
                if (dateFields.has(field) || options.schema?.[field] === 'date') {
                    throw new Error(
                        `codec for ${field} conflicts with dateFields or schema date; use one transform`
                    );
                }
            });
            this.indexes = options.indexes || [];
            this.schema = {
                ...((options && options.schema) || {}),
                ...schemaFromDateFields(options.dateFields),
                createdAt: 'date',
                updatedAt: 'date',
            };
        }

        // Legacy models participate in the singleton registry. Client-bound
        // models are registered only by their owning CouchsetClient.
        if (this.indexes.length && !this.connection) {
            Model.registeredModels.push(this);
        }
    }

    /**
     * Ensure indexes for every constructed model with index declarations.
     */
    public static async ensureIndexes(options?: EnsureIndexOptions): Promise<string[]> {
        const queries: string[] = [];
        const seenQueries = new Set<string>();

        for (const model of Model.registeredModels) {
            await model.prepare();
            const statements = model.indexStatements(options);
            const pending = statements.filter((query) => !seenQueries.has(query));

            pending.forEach((query) => seenQueries.add(query));
            await ensureModelIndexes(
                model.couchbaseConnection().cluster,
                model.keyspace(),
                model.indexes.filter((index, indexPosition) =>
                    pending.includes(statements[indexPosition])
                ),
                options
            );
            queries.push(...pending);
        }

        return queries;
    }

    /**
     * Refresh and get default collection from CouchbaseConnection
     * Because CouchbaseConnection is a singleton, sometimes it might be undefined depending when model was created
     * So we have to call it from all model methods
     * to avoid error `Cannot read property 'defaultCollection' of null`
     */
    private fresh(): void {
        // if couchbase connection has been init
        if (this.couchbaseConnection().isConnected()) {
            const target = this.collectionTarget();
            this.collection = this.couchbaseConnection().getCollection(
                target.scopeName,
                target.collectionName
            );
        }
    }

    private async prepare(): Promise<void> {
        const connection = this.couchbaseConnection();

        if (!connection.bucket) {
            await connection.ready();
        }

        const target = this.collectionTarget();
        this.collection = connection.getCollection(target.scopeName, target.collectionName);
    }

    private async withConnection<T>(operation: () => Promise<T>): Promise<T> {
        await this.prepare();

        try {
            return await operation();
        } catch (error) {
            const connection = this.couchbaseConnection();

            if (!connection.shouldReconnect(error)) {
                throw error;
            }

            connection.markDisconnected(error);
            await this.prepare();

            return operation();
        }
    }

    /** Get this collection
     * getCollection
     */
    private getBucketName(): string {
        const bucketName = this.couchbaseConnection().getBucket();

        if (!bucketName) {
            throw new Error('couchset is not connected; call couchset(args) first');
        }

        return bucketName;
    }

    /** Get this collection
     * getCollection
     */
    private couchbaseConnection(): ModelConnection {
        return this.connection || CouchbaseConnection.Instance;
    }

    /** Get this collection
     * getCollection
     */
    public getCollection(): Collection {
        this.fresh();
        return this.collection;
    }

    private collectionTarget(): CollectionTarget {
        if (!this.scopeName && !this.collectionTargetName) {
            return {};
        }

        return {
            scopeName: this.scopeName || '_default',
            collectionName: this.collectionTargetName || '_default',
        };
    }

    private queryResultKey(): string {
        const target = this.collectionTarget();

        return target.collectionName || this.getBucketName();
    }

    private readContext(): ModelReadContext {
        return {
            bucketName: this.keyspace(),
            collectionName: this.collectionName,
            cluster: this.couchbaseConnection().cluster,
            parse: <T>(data: T) => this.parse(data),
            resultKey: this.queryResultKey(),
        };
    }

    private readArgs(args: ModelReadArgs = {}): ModelReadArgs {
        return applyDefaultWhere(args, {
            defaultWhere: this.defaultWhere,
            mode: this.defaultWhereMode,
            softDelete: this.softDelete,
        });
    }

    private writeContext(): ModelWriteContext {
        return {
            collection: this.getCollection(),
            collectionName: this.collectionName,
            scope: this.scope,
            parse: <T>(data: T) => this.parse(data),
            serialize: <T>(data: T) => this.serialize(data),
            serializeField: (path: string, value: any) => this.serializeField(path, value),
            validateCreate: this.validateCreateHook,
            validateReplace: this.validateReplaceHook,
        };
    }

    private cloneWithDefaultWhereMode(mode: DefaultWhereMode): Model {
        const options: ModalOptions = {
            codecs: this.codecs,
            dateFields: this.dateFields,
            defaultWhere: this.defaultWhere,
            parse: this.parseHook,
            schema: this.schema,
            softDelete: this.softDelete,
            validateCreate: this.validateCreateHook,
            validateReplace: this.validateReplaceHook,
        };

        if (this.scopeName) {
            options.scope = this.scopeName;
        }

        if (this.collectionTargetName) {
            options.collection = this.collectionTargetName;
        }

        const model = new Model(this.collectionName, options, this.connection);
        model.defaultWhereMode = mode;

        return model;
    }

    /**
     * Return the active bucket as a SQL++ keyspace identifier.
     */
    public bucket(): string {
        return bucketIdentifier(this.getBucketName());
    }

    /**
     * Return this model's SQL++ keyspace target.
     */
    public keyspace(): string {
        const target = this.collectionTarget();

        return keyspaceIdentifier({
            bucketName: this.getBucketName(),
            scopeName: target.scopeName,
            collectionName: target.collectionName,
        });
    }

    /**
     * Return a SQL++ FROM target for this model's current bucket.
     */
    public from(alias?: string): string {
        return fromTarget(this.keyspace(), alias);
    }

    /**
     * Return CREATE INDEX statements for this model without executing them.
     */
    public indexStatements(options?: EnsureIndexOptions): string[] {
        return this.indexes.map((index) => buildIndexQuery(this.keyspace(), index, options));
    }

    /**
     * Create this model's declared indexes if Couchbase does not already have them.
     */
    public async ensureIndexes(options?: EnsureIndexOptions): Promise<string[]> {
        return this.withConnection(() =>
            ensureModelIndexes(
                this.couchbaseConnection().cluster,
                this.keyspace(),
                this.indexes,
                options
            )
        );
    }

    /**
     * Run a SQL++ query and return rows directly.
     */
    public async queryRows<T>(
        query: string,
        params?: QueryParameters,
        options?: SafeQueryOptions
    ): Promise<T[]> {
        return this.withConnection(() =>
            runQueryRows<T>(this.couchbaseConnection().cluster, query, params, options)
        );
    }

    /**
     * Run a SQL++ query and return the first row or null.
     */
    public async queryOne<T>(
        query: string,
        params?: QueryParameters,
        options?: SafeQueryOptions
    ): Promise<T | null> {
        return this.withConnection(() =>
            runQueryOne<T>(this.couchbaseConnection().cluster, query, params, options)
        );
    }

    /**
     * Run a SQL++ query using limit + 1 pagination.
     */
    public async queryPage<T>(
        query: string,
        params?: QueryParameters,
        options?: QueryPageOptions
    ): Promise<QueryPageResult<T>> {
        return this.withConnection(() =>
            runQueryPage<T>(this.couchbaseConnection().cluster, query, params, options)
        );
    }

    /**
     * Find many model-scoped documents.
     */
    public async findMany<T>(args: ModelReadArgs = {}): Promise<T[]> {
        return this.withConnection(() => findManyRows<T>(this.readContext(), this.readArgs(args)));
    }

    /**
     * Find the first matching model-scoped document.
     */
    public async findOne<T>(args: ModelReadArgs = {}): Promise<T | null> {
        return this.withConnection(() => findOneRow<T>(this.readContext(), this.readArgs(args)));
    }

    /**
     * Check whether at least one model-scoped document matches.
     */
    public async exists(args: ModelReadArgs = {}): Promise<boolean> {
        return this.withConnection(() => rowsExist(this.readContext(), this.readArgs(args)));
    }

    /**
     * Count model-scoped documents.
     */
    public async count(args: ModelReadArgs = {}): Promise<number> {
        return this.withConnection(() => countRows(this.readContext(), this.readArgs(args)));
    }

    /**
     * Fetch a limit + 1 page of model-scoped documents.
     */
    public async page<T>(args: ModelReadArgs = {}): Promise<ModelPageResult<T>> {
        return this.withConnection(() => pageRows<T>(this.readContext(), this.readArgs(args)));
    }

    public withDeleted(): Model {
        return this.cloneWithDefaultWhereMode('withDeleted');
    }

    public onlyDeleted(): Model {
        return this.cloneWithDefaultWhereMode('onlyDeleted');
    }

    public withoutDefaultWhere(): Model {
        return this.cloneWithDefaultWhereMode('none');
    }

    /**
     * Insert a new document and fail if the id already exists.
     */
    public async insert<T>(data: T, options?: InsertWriteOptions): Promise<T & AutoModelFields> {
        return this.withConnection(() => insertDocument<T>(this.writeContext(), data, options));
    }

    /** @internal Prepare a transaction insert without issuing a normal SDK write. */
    public prepareInsert<T>(data: T): Promise<T & AutoModelFields> {
        return prepareInsertDocument<T>(this.writeContext(), data);
    }

    /**
     * Explicit insert-or-replace write.
     */
    public async upsert<T>(data: T, options?: UpsertWriteOptions): Promise<T & AutoModelFields> {
        return this.withConnection(() => upsertDocument<T>(this.writeContext(), data, options));
    }

    public async getById<T>(id: string, options?: GetOptions): Promise<T & AutoModelFields> {
        return this.withConnection(async () => {
            const data = await this.collection.get(id, options);
            return this.parse<T & AutoModelFields>(data.content);
        });
    }

    public async findDocById<T extends {id: string}>(
        id: string,
        options?: GetOptions
    ): Promise<Hydrated<T>> {
        const data = await this.getById<T>(id, options);

        return this.hydrate<T>(data);
    }

    /**
     * Find a document with SDK metadata.
     */
    public async findByIdWithMeta<T>(
        id: string,
        options?: GetOptions
    ): Promise<FindByIdWithMetaResult<T>> {
        return this.withConnection(() => findByIdWithMetaDoc<T>(this.writeContext(), id, options));
    }

    /** Ergonomic alias for findByIdWithMeta, intended for CAS workflows. */
    public async getWithCas<T>(
        id: string,
        options?: GetOptions
    ): Promise<FindByIdWithMetaResult<T>> {
        return this.findByIdWithMeta<T>(id, options);
    }

    /**
     * Explicit full-document replace.
     */
    public async replaceById<T>(
        id: string,
        data: T,
        options?: UpdateOptions
    ): Promise<T & AutoModelFields> {
        return this.withConnection(() =>
            replaceDocumentById<T>(this.writeContext(), id, data, options)
        );
    }

    /** @internal Prepare a transaction replace without issuing a normal SDK write. */
    public prepareReplace<T>(
        id: string,
        data: T,
        options?: UpdateOptions
    ): Promise<T & AutoModelFields> {
        return prepareReplacementDocument<T>(this.writeContext(), id, data, options);
    }

    /**
     * Replace only when the supplied CAS still describes the current document.
     * CouchSet deliberately performs one SDK operation and never re-reads/retries
     * with a new CAS, because doing so would defeat the caller's concurrency check.
     */
    public async replaceIfCas<T>(
        id: string,
        data: T,
        cas: any,
        options?: UpdateOptions
    ): Promise<T & AutoModelFields> {
        return this.replaceById<T>(id, data, {...(options || {}), cas});
    }

    /**
     * Remove a one-time document with exactly the CAS supplied by the caller.
     * Missing and CAS-mismatch cases are normal outcomes; transport and ambiguous
     * failures are rethrown so callers never mistake an unknown commit for success.
     */
    public async consumeOnce(id: string, cas: any): Promise<ConsumeOnceResult> {
        await this.prepare();

        try {
            await this.collection.remove(id, {cas});
            return {status: 'consumed'};
        } catch (error) {
            const name = (error as any)?.name || '';
            const message = (error as any)?.message || '';

            if (/DocumentNotFound|not found/i.test(`${name} ${message}`)) {
                return {status: 'missing'};
            }

            if (/CasMismatch|cas mismatch/i.test(`${name} ${message}`)) {
                return {status: 'conflict'};
            }

            throw error;
        }
    }

    /**
     * Partial document mutation using common patch operators.
     */
    public async patchById<T>(
        id: string,
        patch: PatchByIdArgs,
        options?: MutateInOptions
    ): Promise<T & AutoModelFields> {
        return this.withConnection(() =>
            patchDocumentById<T>(this.writeContext(), id, patch, options)
        );
    }

    /**
     * Couchbase subdocument mutation escape hatch.
     */
    public async mutateById(id: string, specs: any[], options?: MutateInOptions): Promise<any> {
        return this.withConnection(() =>
            mutateDocumentById(this.writeContext(), id, specs, options)
        );
    }

    /**
     * Atomic numeric field increment.
     */
    public async incrementById<T>(
        id: string,
        field: string,
        delta: number,
        options?: MutateInOptions
    ): Promise<T & AutoModelFields> {
        return this.withConnection(() =>
            incrementDocumentById<T>(this.writeContext(), id, field, delta, options)
        );
    }

    public async softDeleteById<T>(
        id: string,
        options?: MutateInOptions
    ): Promise<T & AutoModelFields> {
        return this.patchById<T>(id, {$set: {deleted: true, deletedAt: new Date()}}, options);
    }

    public async restoreById<T>(
        id: string,
        options?: MutateInOptions
    ): Promise<T & AutoModelFields> {
        return this.patchById<T>(id, {$unset: ['deleted', 'deletedAt']}, options);
    }

    public async deleteById<T>(
        id: string,
        options?: DeleteByIdOptions
    ): Promise<boolean | (T & AutoModelFields)> {
        const {hard = false, ...removeOptions} = options || {};

        if (hard || !this.softDelete) {
            return this.withConnection(async () => {
                await this.collection.remove(id, removeOptions);
                return true;
            });
        }

        return this.softDeleteById<T>(id);
    }

    public async findDocOne<T extends {id: string}>(
        args: ModelReadArgs = {}
    ): Promise<Hydrated<T> | null> {
        const data = await this.findOne<T>(args);

        return data ? this.hydrate<T>(data as T & AutoModelFields) : null;
    }

    public hydrate<T extends {id: string}>(data: T & AutoModelFields): Hydrated<T> {
        return hydrateDocument<T>(this as any, this.parse(data));
    }

    public parse<T>(data: T): T {
        const decoded = this.deserialize(data);
        const parsed = parseSchema(this.schema, decoded);
        const parsedDates = parseDateFields(parsed, this.dateFields);

        return this.parseHook ? this.parseHook(parsedDates) : parsedDates;
    }

    /** @internal Used by the typed client before a document reaches the SDK. */
    public serialize<T>(data: T): T {
        const result: any = {...(data as any)};

        Object.keys(this.codecs).forEach((path) => {
            const current = getPath(result, path);
            if (current !== undefined) {
                setPath(result, path, this.codecs[path].toDatabase(current));
            }
        });

        return result;
    }

    /** @internal Used by patch helpers and transaction-bound models. */
    public serializeField(path: string, value: any): any {
        return this.codecs[path] ? this.codecs[path].toDatabase(value) : value;
    }

    private deserialize<T>(data: T): T {
        const result: any = {...(data as any)};

        Object.keys(this.codecs).forEach((path) => {
            const current = getPath(result, path);
            if (current !== undefined) {
                setPath(result, path, this.codecs[path].fromDatabase(current));
            }
        });

        return result;
    }
}

const getPath = (data: any, path: string): any =>
    path.split('.').reduce((value, key) => (value == null ? undefined : value[key]), data);

const setPath = (data: any, path: string, value: any): void => {
    const parts = path.split('.');
    const key = parts.pop() as string;
    const target = parts.reduce((current, part) => {
        const existing = current[part];
        if (Array.isArray(existing)) {
            current[part] = existing.slice();
        } else if (existing && typeof existing === 'object') {
            // serialize/parse start with a shallow root copy. Clone every branch
            // we traverse so dotted codecs never mutate caller or SDK content.
            current[part] = {...existing};
        } else {
            current[part] = {};
        }
        return current[part];
    }, data);
    target[key] = value;
};

export default Model;
