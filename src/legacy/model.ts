import type {Collection, GetOptions, RemoveOptions, ReplaceOptions, UpsertOptions} from 'couchbase';

import {SchemaTypes, parseSchema} from '../utils';
import {generateUUID} from '../uuid';

import CouchbaseConnection from './connection';
import {Pagination} from './pagination';
import {CustomQuery, CustomQueryPagination} from './search';

export interface AutoModelFields {
    id: string;
    createdAt: Date;
    updatedAt?: Date;
    deleted?: Date;
    _type: string;
    _scope: string;
}

export interface UpdateOptions extends ReplaceOptions {
    silent?: boolean;
}

export interface ModalOptions {
    scope?: string;
    schema?: Record<string, SchemaTypes>;
    graphqlType?: unknown;
}

export class Model {
    collection: Collection;
    collectionName: string;
    scope = '_default';
    schema: Record<string, SchemaTypes> = {
        createdAt: 'date',
        updatedAt: 'date',
    };
    graphqlType: unknown = null;

    constructor(name: string, options?: ModalOptions) {
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

    public setGraphqlType(gqlType: unknown): Model {
        this.graphqlType = gqlType;
        return this;
    }

    public fresh(): void {
        if (CouchbaseConnection.Instance.bucketName) {
            this.collection = CouchbaseConnection.Instance.getCollection();
        }
    }

    public getBucketName(): string {
        return CouchbaseConnection.Instance?.getBucket();
    }

    public couchbaseConnection(): CouchbaseConnection {
        return CouchbaseConnection.Instance;
    }

    public getCollection(): Collection {
        this.fresh();
        return this.collection;
    }

    public async create<T>(data: T, options?: UpsertOptions): Promise<T & AutoModelFields> {
        this.fresh();
        const id = generateUUID();
        const createdData = {
            id,
            ...data,
            createdAt: new Date(),
            updatedAt: new Date(),
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

    public async findById(id: string, options?: GetOptions): Promise<any & AutoModelFields> {
        this.fresh();
        try {
            const data = await this.collection.get(id, options);
            return parseSchema(this.schema, data.content);
        } catch (error) {
            throw error;
        }
    }

    public async updateById<T>(id: string, data: T, opt?: UpdateOptions): Promise<T> {
        this.fresh();

        const {silent = false, ...options} = opt || {};

        const updatedDocument: any = {
            ...data,
            id,
            _type: this.collectionName,
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

    public async save<T>(data: T & {id: string}, opt?: UpdateOptions): Promise<T> {
        this.fresh();

        const id = data && data.id;
        const {silent = false, ...options} = opt || {};

        const updatedDocument: any = {
            ...data,
            id,
            _type: this.collectionName,
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
        customQuery?: any;
    }): Promise<any[]> {
        this.fresh();

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

    public async customQuery<T>({
        params,
        limit,
        query,
    }: {
        params: any;
        limit: number;
        query: string;
    }): Promise<[T[], CustomQueryPagination]> {
        this.fresh();

        return CustomQuery<T>({
            limit,
            params,
            query,
        });
    }

    public parse<T>(data: T): T {
        this.fresh();
        return parseSchema(this.schema, data);
    }
}

export default Model;
