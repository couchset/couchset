import type {
    Collection,
    GetOptions,
    MutateInOptions,
    RemoveOptions,
    ReplaceOptions,
} from 'couchbase';

// import {AutomaticMethodOptions, AutomaticOutput, automateImplementation} from '../automate';
import {CustomQuery, CustomQueryPagination} from '../search';
import {SchemaTypes, parseSchema} from '../utils';
import CouchbaseConnection from '../connection';
import {Pagination} from '../pagination';
import {generateUUID} from '../uuid';

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
    QueryLogger,
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
import {applyTtlOptions} from './ttl';
import type {ParseHook, ValidationHook} from './validation';
import {applyValidation, parseDateFields, schemaFromDateFields} from './validation';

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
    graphqlType?: any;
    softDelete?: boolean;
    defaultWhere?: any;
    validateCreate?: ValidationHook;
    validateUpdate?: ValidationHook;
    validateReplace?: ValidationHook;
    parse?: ParseHook;
    dateFields?: string[];
    indexes?: ModelIndexDefinition[];
}

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
    private validateUpdateHook?: ValidationHook;
    private validateReplaceHook?: ValidationHook;
    private parseHook?: ParseHook;
    private dateFields?: string[];
    private indexes: ModelIndexDefinition[] = [];
    schema: Record<string, SchemaTypes> = {
        createdAt: 'date',
        updatedAt: 'date',
    };
    graphqlType = null;

    constructor(name: string, options?: ModalOptions) {
        // this.collection = CouchbaseConnection.Instance.getCollection();
        this.collectionName = name;
        if (options) {
            const hasScope = Object.prototype.hasOwnProperty.call(options, 'scope');
            const hasCollection = Object.prototype.hasOwnProperty.call(options, 'collection');
            this.graphqlType = (options && options.graphqlType) || null;
            this.scope = (options && options.scope) || '_default';
            this.scopeName = hasScope ? this.scope : undefined;
            this.collectionTargetName = hasCollection
                ? options.collection || '_default'
                : undefined;
            this.softDelete = !!options.softDelete;
            this.defaultWhere = options.defaultWhere;
            this.validateCreateHook = options.validateCreate;
            this.validateUpdateHook = options.validateUpdate;
            this.validateReplaceHook = options.validateReplace;
            this.parseHook = options.parse;
            this.dateFields = options.dateFields;
            this.indexes = options.indexes || [];
            this.schema = {
                ...((options && options.schema) || {}),
                ...schemaFromDateFields(options.dateFields),
                createdAt: 'date',
                updatedAt: 'date',
            };
        }

        if (this.indexes.length) {
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
     * Set setGraphqlType
     * setGraphqlType
     */
    public setGraphqlType(gqlType: any): Model {
        this.graphqlType = gqlType;
        return this;
    }

    /**
     * Refresh and get default collection from CouchbaseConnection
     * Because CouchbaseConnection is a singleton, sometimes it might be undefined depending when model was created
     * So we have to call it from all model methods
     * to avoid error `Cannot read property 'defaultCollection' of null`
     */
    public fresh(): void {
        // if couchbase connection has been init
        if (CouchbaseConnection.Instance.bucketName) {
            const target = this.collectionTarget();
            this.collection = CouchbaseConnection.Instance.getCollection(
                target.scopeName,
                target.collectionName
            );
        }
    }

    /** Get this collection
     * getCollection
     */
    public getBucketName(): string {
        return CouchbaseConnection.Instance?.getBucket();
    }

    /** Get this collection
     * getCollection
     */
    public couchbaseConnection(): CouchbaseConnection {
        return CouchbaseConnection.Instance;
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
            validateCreate: this.validateCreateHook,
            validateReplace: this.validateReplaceHook,
            validateUpdate: this.validateUpdateHook,
        };
    }

    private cloneWithDefaultWhereMode(mode: DefaultWhereMode): Model {
        const options: ModalOptions = {
            dateFields: this.dateFields,
            defaultWhere: this.defaultWhere,
            graphqlType: this.graphqlType,
            parse: this.parseHook,
            schema: this.schema,
            softDelete: this.softDelete,
            validateCreate: this.validateCreateHook,
            validateReplace: this.validateReplaceHook,
            validateUpdate: this.validateUpdateHook,
        };

        if (this.scopeName) {
            options.scope = this.scopeName;
        }

        if (this.collectionTargetName) {
            options.collection = this.collectionTargetName;
        }

        const model = new Model(this.collectionName, options);
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
        this.fresh();

        return ensureModelIndexes(
            this.couchbaseConnection().cluster,
            this.keyspace(),
            this.indexes,
            options
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
        return runQueryRows<T>(this.couchbaseConnection().cluster, query, params, options);
    }

    /**
     * Run a SQL++ query and return the first row or null.
     */
    public async queryOne<T>(
        query: string,
        params?: QueryParameters,
        options?: SafeQueryOptions
    ): Promise<T | null> {
        return runQueryOne<T>(this.couchbaseConnection().cluster, query, params, options);
    }

    /**
     * Run a SQL++ query using limit + 1 pagination.
     */
    public async queryPage<T>(
        query: string,
        params?: QueryParameters,
        options?: QueryPageOptions
    ): Promise<QueryPageResult<T>> {
        return runQueryPage<T>(this.couchbaseConnection().cluster, query, params, options);
    }

    /**
     * Find many model-scoped documents.
     */
    public async findMany<T>(args: ModelReadArgs = {}): Promise<T[]> {
        this.fresh();
        return findManyRows<T>(this.readContext(), this.readArgs(args));
    }

    /**
     * Find the first matching model-scoped document.
     */
    public async findOne<T>(args: ModelReadArgs = {}): Promise<T | null> {
        this.fresh();
        return findOneRow<T>(this.readContext(), this.readArgs(args));
    }

    /**
     * Check whether at least one model-scoped document matches.
     */
    public async exists(args: ModelReadArgs = {}): Promise<boolean> {
        this.fresh();
        return rowsExist(this.readContext(), this.readArgs(args));
    }

    /**
     * Count model-scoped documents.
     */
    public async count(args: ModelReadArgs = {}): Promise<number> {
        this.fresh();
        return countRows(this.readContext(), this.readArgs(args));
    }

    /**
     * Fetch a limit + 1 page of model-scoped documents.
     */
    public async page<T>(args: ModelReadArgs = {}): Promise<ModelPageResult<T>> {
        this.fresh();
        return pageRows<T>(this.readContext(), this.readArgs(args));
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
     * create
     */
    public async create<T>(data: T, options?: UpsertWriteOptions): Promise<T & AutoModelFields> {
        this.fresh();
        const id = generateUUID();
        const createdData = {
            id, // let id be override
            ...data,
            createdAt: new Date(),
            updatedAt: new Date(), // same as created at
            _type: this.collectionName,
            _scope: this.scope,
        };

        try {
            const validated = await applyValidation(createdData, this.validateCreateHook);
            await this.collection.upsert(validated.id, validated, applyTtlOptions(options));
            return this.parse(validated);
        } catch (error) {
            throw error;
        }
    }

    /**
     * Insert a new document and fail if the id already exists.
     */
    public async insert<T>(data: T, options?: InsertWriteOptions): Promise<T & AutoModelFields> {
        this.fresh();
        return insertDocument<T>(this.writeContext(), data, options);
    }

    /**
     * Explicit insert-or-replace write.
     */
    public async upsert<T>(data: T, options?: UpsertWriteOptions): Promise<T & AutoModelFields> {
        this.fresh();
        return upsertDocument<T>(this.writeContext(), data, options);
    }

    /**
     * findById
     */
    public async findById(id: string, options?: GetOptions): Promise<any & AutoModelFields> {
        this.fresh();
        try {
            const data = await this.collection.get(id, options);
            return this.parse(data.content);
        } catch (error) {
            throw error;
        }
    }

    public async findDocById<T extends {id: string}>(
        id: string,
        options?: GetOptions
    ): Promise<Hydrated<T>> {
        const data = await this.findById(id, options);

        return this.hydrate<T>(data);
    }

    /**
     * Find a document with SDK metadata.
     */
    public async findByIdWithMeta<T>(
        id: string,
        options?: GetOptions
    ): Promise<FindByIdWithMetaResult<T>> {
        this.fresh();
        return findByIdWithMetaDoc<T>(this.writeContext(), id, options);
    }

    /**
     * update
     */
    public async updateById<T>(id: string, data: T, opt?: UpdateOptions): Promise<T> {
        this.fresh();

        const {silent = false, ...options} = opt || {};

        const updatedDocument: any = {
            ...data,
            id,
            _type: this.collectionName, // type and scope must be defined
            _scope: this.scope,
        };

        if (!silent) {
            updatedDocument.updatedAt = new Date();
        }

        try {
            const validated = await applyValidation(updatedDocument, this.validateUpdateHook);
            await this.collection.replace(id, validated, options);
            return this.parse(validated);
        } catch (error) {
            throw error;
        }
    }

    /**
     * Explicit full-document replace.
     */
    public async replaceById<T>(
        id: string,
        data: T,
        options?: UpdateOptions
    ): Promise<T & AutoModelFields> {
        this.fresh();
        return replaceDocumentById<T>(this.writeContext(), id, data, options);
    }

    /**
     * Partial document mutation using common patch operators.
     */
    public async patchById<T>(
        id: string,
        patch: PatchByIdArgs,
        options?: MutateInOptions
    ): Promise<T & AutoModelFields> {
        this.fresh();
        return patchDocumentById<T>(this.writeContext(), id, patch, options);
    }

    /**
     * Couchbase subdocument mutation escape hatch.
     */
    public async mutateById(id: string, specs: any[], options?: MutateInOptions): Promise<any> {
        this.fresh();
        return mutateDocumentById(this.writeContext(), id, specs, options);
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
        this.fresh();
        return incrementDocumentById<T>(this.writeContext(), id, field, delta, options);
    }

    public async softDeleteById<T>(
        id: string,
        options?: MutateInOptions
    ): Promise<T & AutoModelFields> {
        this.fresh();
        return this.patchById<T>(id, {$set: {deleted: true, deletedAt: new Date()}}, options);
    }

    public async restoreById<T>(
        id: string,
        options?: MutateInOptions
    ): Promise<T & AutoModelFields> {
        this.fresh();
        return this.patchById<T>(id, {$unset: ['deleted', 'deletedAt']}, options);
    }

    public async deleteById<T>(
        id: string,
        options?: DeleteByIdOptions
    ): Promise<boolean | (T & AutoModelFields)> {
        const {hard = false, ...removeOptions} = options || {};

        if (hard || !this.softDelete) {
            return this.delete(id, removeOptions);
        }

        return this.softDeleteById<T>(id);
    }

    /**
     * save
     */
    public async save<T>(data: T & {id: string}, opt?: UpdateOptions): Promise<T> {
        this.fresh();

        const id = data && data.id;

        const {silent = false, ...options} = opt || {};

        const updatedDocument: any = {
            ...data,
            id,
            _type: this.collectionName, // type and scope must be defined
            _scope: this.scope,
        };

        if (!silent) {
            updatedDocument.updatedAt = new Date();
        }

        try {
            if (!id) {
                throw new Error('document must have id');
            }
            const validated = await applyValidation(updatedDocument, this.validateUpdateHook);
            await this.collection.replace(id, validated, options);
            return this.parse(validated);
        } catch (error) {
            console.error(error);
            throw error;
        }
    }

    public async delete(id: string, options?: RemoveOptions): Promise<boolean> {
        this.fresh();
        try {
            await this.collection.remove(id, options);
            return true;
        } catch (error) {
            throw error;
        }
    }

    /**
     * Pagination
     *  
        select = ['id', 'createdAt']
        where = {
         where: { owner: { $eq: "stoqey" }, _type: { $eq: "Trade" } },
        },
        page = 0,
        limit = 10,
        orderBy = { createdAt: "DESC" },
    * @param args PaginationArgs
    */
    public async pagination({
        select,
        where,
        orderBy,
        limit,
        page,
        customQuery = {},
    }: {
        select?: any[] | string;
        where?: any;
        orderBy?: any;
        limit?: number;
        page?: number;
        customQuery?: any; // can be $and or any other valid quries
    }): Promise<any[]> {
        this.fresh(); // refresh
        // Where begins here
        let whereEx = {_type: {$eq: this.collectionName}};

        if (where) {
            whereEx = {
                ...whereEx,
                ...where,
            };
        }

        const rows = await Pagination({
            bucketName: this.keyspace(),
            resultKey: this.queryResultKey(),
            select,
            where: {where: whereEx, ...customQuery},
            limit,
            page,
            orderBy,
        });

        return rows.map((r) => this.parse(r));
    }

    /**
     * Run a custom query with model parsing
     * @param { select, query }
     * @returns
     */
    public async customQuery<T>({
        debug,
        logger,
        params,
        limit,
        query,
    }: {
        debug?: boolean;
        logger?: QueryLogger;
        params: any;
        limit: number;
        query: string;
    }): Promise<[T[], CustomQueryPagination]> {
        this.fresh(); // refresh
        // Where begins here

        const response = await CustomQuery<T>({
            debug,
            limit,
            logger,
            params,
            query,
        });

        return response;
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
        this.fresh(); // refresh
        const parsed = parseSchema(this.schema, data);
        const parsedDates = parseDateFields(parsed, this.dateFields);

        return this.parseHook ? this.parseHook(parsedDates) : parsedDates;
    }

    // /**
    //  *
    //  * @param args AutomaticModelOptions
    //  * @returns
    //  */
    // public automate(args?: Partial<AutomaticMethodOptions>): AutomaticOutput {
    //     this.fresh(); // refresh
    //     return automateImplementation(this.graphqlType, {model: this, ...args});
    // }
}

export default Model;
