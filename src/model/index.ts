import type {
    Collection,
    GetOptions,
    InsertOptions,
    MutateInOptions,
    RemoveOptions,
    ReplaceOptions,
    UpsertOptions,
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
import type {FindByIdWithMetaResult, ModelWriteContext, PatchByIdArgs} from './write-helpers';

export type {ModelPageResult, ModelReadArgs} from './read-helpers';
export type {
    QueryLogger,
    QueryPageOptions,
    QueryPageResult,
    QueryParameters,
    SafeQueryOptions,
} from './safe-query';
export type {FindByIdWithMetaResult, PatchByIdArgs} from './write-helpers';

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
}

interface CollectionTarget {
    scopeName?: string;
    collectionName?: string;
}

export class Model {
    collection: Collection;
    collectionName: string;
    scope = '_default';
    private scopeName?: string;
    private collectionTargetName?: string;
    private defaultWhere?: any;
    private defaultWhereMode: DefaultWhereMode = 'default';
    private softDelete = false;
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
            this.schema = {
                ...((options && options.schema) || {}),
                createdAt: 'date',
                updatedAt: 'date',
            };
        }
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
            parse: <T>(data: T) => parseSchema(this.schema, data),
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
            parse: <T>(data: T) => parseSchema(this.schema, data),
        };
    }

    private cloneWithDefaultWhereMode(mode: DefaultWhereMode): Model {
        const options: ModalOptions = {
            defaultWhere: this.defaultWhere,
            graphqlType: this.graphqlType,
            schema: this.schema,
            softDelete: this.softDelete,
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
    public async create<T>(data: T, options?: UpsertOptions): Promise<T & AutoModelFields> {
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
            await this.collection.upsert(createdData.id, createdData, options);
            return parseSchema(this.schema, createdData);
        } catch (error) {
            throw error;
        }
    }

    /**
     * Insert a new document and fail if the id already exists.
     */
    public async insert<T>(data: T, options?: InsertOptions): Promise<T & AutoModelFields> {
        this.fresh();
        return insertDocument<T>(this.writeContext(), data, options);
    }

    /**
     * Explicit insert-or-replace write.
     */
    public async upsert<T>(data: T, options?: UpsertOptions): Promise<T & AutoModelFields> {
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
            return parseSchema(this.schema, data.content);
        } catch (error) {
            throw error;
        }
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
            await this.collection.replace(id, updatedDocument, options);
            return parseSchema(this.schema, updatedDocument);
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
            await this.collection.replace(id, updatedDocument, options);
            return parseSchema(this.schema, updatedDocument);
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

        return rows.map((r) => parseSchema(this.schema, r));
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

    public parse<T>(data: T): T {
        this.fresh(); // refresh
        return parseSchema(this.schema, data);
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
