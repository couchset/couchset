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
    validateCreate?: ValidationHook;
    validateUpdate?: ValidationHook;
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

const modelDocument = <T>(
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

const replacementDocument = <T>(
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

export const insert = async <T>(
    context: ModelWriteContext,
    data: T,
    options?: InsertWriteOptions
): Promise<T & AutoModelFields> => {
    const document = modelDocument<T>(context, data);
    const validated = await applyValidation(document, context.validateCreate);

    await context.collection.insert(validated.id, validated, applyTtlOptions(options));

    return context.parse<T & AutoModelFields>(validated);
};

export const upsert = async <T>(
    context: ModelWriteContext,
    data: T,
    options?: UpsertWriteOptions
): Promise<T & AutoModelFields> => {
    const document = modelDocument<T>(context, data);
    const validated = await applyValidation(document, context.validateCreate);

    await context.collection.upsert(validated.id, validated, applyTtlOptions(options));

    return context.parse<T & AutoModelFields>(validated);
};

export const replaceById = async <T>(
    context: ModelWriteContext,
    id: string,
    data: T,
    options?: UpdateOptions
): Promise<T & AutoModelFields> => {
    const {silent, ...replaceOptions} = options || {};
    const document = replacementDocument<T>(context, id, data, {silent});
    const validated = await applyValidation(document, context.validateReplace);

    await context.collection.replace(id, validated, replaceOptions as ReplaceOptions);

    return context.parse<T & AutoModelFields>(validated);
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
            couchbase.MutateInSpec.upsert(path, patch.$set[path])
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
