import {Collection, GetOptions, RemoveOptions, ReplaceOptions, UpsertOptions} from 'couchbase';

import {AutomaticMethodOptions, AutomaticOutput, automateImplementation} from '../automate';
import {CustomQuery, CustomQueryPagination} from '../search';
import {SchemaTypes, parseSchema} from '../utils';
import CouchbaseConnection from '../connection';
import {Pagination} from '../pagination';
import {generateUUID} from '../uuid';

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

export interface ModalOptions {
    scope?: string;
    schema?: Record<string, SchemaTypes>;
    graphqlType?: any;
}

export class Model {
    collection: Collection;
    collectionName: string;
    scope = '_default';
    schema: Record<string, SchemaTypes> = {
        createdAt: 'date',
        updatedAt: 'date',
    };
    graphqlType = null;

    constructor(name: string, options?: ModalOptions) {
        // this.collection = CouchbaseConnection.Instance.getCollection();
        this.collectionName = name;
        if (options) {
            this.graphqlType = (options && options.graphqlType) || null;
            this.scope = (options && options.scope) || '_default';
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
            this.collection = CouchbaseConnection.Instance.getCollection();
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

        const bucketName = CouchbaseConnection.Instance.bucketName;

        const rows = await Pagination({
            bucketName,
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
        params,
        limit,
        query,
    }: {
        params: any;
        limit: number;
        query: string;
    }): Promise<[T[], CustomQueryPagination]> {
        this.fresh(); // refresh
        // Where begins here

        const response = await CustomQuery<T>({
            limit,
            params,
            query,
        });

        return response;
    }

    public parse<T>(data: T): T {
        this.fresh(); // refresh
        return parseSchema(this.schema, data);
    }

    /**
     *
     * @param args AutomaticModelOptions
     * @returns
     */
    public automate(args?: Partial<AutomaticMethodOptions>): AutomaticOutput {
        this.fresh(); // refresh
        return automateImplementation(this.graphqlType, {model: this, ...args});
    }
}

export default Model;
