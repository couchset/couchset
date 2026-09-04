import type {
    Collection,
    GetOptions,
    InsertOptions,
    MutateInOptions,
    ReplaceOptions,
    UpsertOptions,
} from 'couchbase';

import couchbase from '../couchbase';
import {generateUUID} from '../uuid';

import {applyTtlOptions, TtlOptions} from './ttl';
import {applyValidation, ValidationHook} from './validation';

import type {AutoModelFields, UpdateOptions} from './index';

export interface ModelWriteContext {
    collection: Collection;
    collectionName: string;
    scope: string;
    parse: <T>(data: T) => T;
    serialize?: <T>(data: T) => T;
    serializeField?: (path: string, value: any) => any;
    validateCreate?: ValidationHook;
    validateReplace?: ValidationHook;
}

export interface PatchByIdArgs {
    $set?: Record<string, any>;
    $unset?: string[] | Record<string, any>;
    $inc?: Record<string, number>;
}

export interface FindByIdWithMetaResult<T> {
    content: T & AutoModelFields;
    cas: any;
    expiryTime?: any;
}

export type InsertWriteOptions = InsertOptions & TtlOptions;
export type UpsertWriteOptions = UpsertOptions & TtlOptions;

const now = (): Date => new Date();

export const modelDocument = <T>(
    context: ModelWriteContext,
    data: T,
    createdAt?: Date
): T & AutoModelFields => {
    const id = generateUUID();
    const timestamp = now();

    return {
        id,
        ...data,
        createdAt: createdAt || timestamp,
        updatedAt: timestamp,
        _type: context.collectionName,
        _scope: context.scope,
    } as T & AutoModelFields;
};

export const replacementDocument = <T>(
    context: ModelWriteContext,
    id: string,
    data: T,
    options?: UpdateOptions
): T & AutoModelFields => {
    const document: any = {
        ...data,
        id,
        _type: context.collectionName,
        _scope: context.scope,
    };

    if (!options || !options.silent) {
        document.updatedAt = now();
    }

    return document;
};

const unsetPaths = (value?: string[] | Record<string, any>): string[] => {
    if (!value) {
        return [];
    }

    return Array.isArray(value) ? value : Object.keys(value);
};

/** Prepare an insert using the same metadata, validation, and codec pipeline as Model.insert. */
export const prepareInsertDocument = async <T>(
    context: ModelWriteContext,
    data: T
): Promise<T & AutoModelFields> => {
    const validated = await applyValidation(
        modelDocument<T>(context, data),
        context.validateCreate
    );
    return context.serialize ? context.serialize(validated) : validated;
};

/** Prepare a replace using the same metadata, validation, and codec pipeline as Model.replaceById. */
export const prepareReplacementDocument = async <T>(
    context: ModelWriteContext,
    id: string,
    data: T,
    options?: UpdateOptions
): Promise<T & AutoModelFields> => {
    const validated = await applyValidation(
        replacementDocument<T>(context, id, data, options),
        context.validateReplace
    );
    return context.serialize ? context.serialize(validated) : validated;
};

export const insert = async <T>(
    context: ModelWriteContext,
    data: T,
    options?: InsertWriteOptions
): Promise<T & AutoModelFields> => {
    const stored = await prepareInsertDocument<T>(context, data);
    await context.collection.insert(stored.id, stored, applyTtlOptions(options));

    return context.parse<T & AutoModelFields>(stored);
};

export const upsert = async <T>(
    context: ModelWriteContext,
    data: T,
    options?: UpsertWriteOptions
): Promise<T & AutoModelFields> => {
    const stored = await prepareInsertDocument<T>(context, data);
    await context.collection.upsert(stored.id, stored, applyTtlOptions(options));

    return context.parse<T & AutoModelFields>(stored);
};

export const replaceById = async <T>(
    context: ModelWriteContext,
    id: string,
    data: T,
    options?: UpdateOptions
): Promise<T & AutoModelFields> => {
    const {silent, ...replaceOptions} = options || {};
    const stored = await prepareReplacementDocument<T>(context, id, data, {silent});
    await context.collection.replace(id, stored, replaceOptions as ReplaceOptions);

    return context.parse<T & AutoModelFields>(stored);
};

export const mutateById = async (
    context: ModelWriteContext,
    id: string,
    specs: any[],
    options?: MutateInOptions
): Promise<any> => {
    if (!Array.isArray(specs) || !specs.length) {
        throw new Error('mutateById requires at least one mutation spec');
    }

    return context.collection.mutateIn(id, specs, options);
};

export const patchById = async <T>(
    context: ModelWriteContext,
    id: string,
    patch: PatchByIdArgs,
    options?: MutateInOptions
): Promise<T & AutoModelFields> => {
    const specs = [
        ...Object.keys(patch.$set || {}).map((path) =>
            couchbase.MutateInSpec.upsert(
                path,
                context.serializeField
                    ? context.serializeField(path, patch.$set[path])
                    : patch.$set[path]
            )
        ),
        ...unsetPaths(patch.$unset).map((path) => couchbase.MutateInSpec.remove(path)),
        ...Object.keys(patch.$inc || {}).map((path) =>
            couchbase.MutateInSpec.increment(path, patch.$inc[path])
        ),
        couchbase.MutateInSpec.upsert('updatedAt', now()),
    ];

    await mutateById(context, id, specs, options);
    const data = await context.collection.get(id);

    return context.parse<T & AutoModelFields>(data.content);
};

export const incrementById = async <T>(
    context: ModelWriteContext,
    id: string,
    field: string,
    delta: number,
    options?: MutateInOptions
): Promise<T & AutoModelFields> => {
    return patchById<T>(context, id, {$inc: {[field]: delta}}, options);
};

export const findByIdWithMeta = async <T>(
    context: ModelWriteContext,
    id: string,
    options?: GetOptions
): Promise<FindByIdWithMetaResult<T>> => {
    const data = await context.collection.get(id, options);

    return {
        content: context.parse<T & AutoModelFields>(data.content),
        cas: data.cas,
        expiryTime: data.expiryTime,
    };
};
