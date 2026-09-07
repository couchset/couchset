import type {TypedModel} from '../next';

import type {CheckedReadArgs, ModelReadResult} from './read-types';
import type {ModelPageResult, ModelReadArgs} from './read-helpers';

export type ModelScopes = Record<string, (...args: any[]) => ModelReadArgs>;
type Merge<A, B> = Omit<A, keyof B> & B;
type ReadMerge<A extends ModelReadArgs, B extends ModelReadArgs> = Merge<A, B>;

/** A query-only capability: mutations and raw SQL++ stay on the original model. */
export class ScopedModel<T, S extends ModelScopes, A extends ModelReadArgs = {}> {
    readonly scopes: {
        [K in keyof S]: (
            ...args: Parameters<S[K]>
        ) => ScopedModel<T, S, ReadMerge<A, ReturnType<S[K]>>>;
    };

    constructor(
        private readonly model: TypedModel<T>,
        private readonly definitions: S,
        private readonly args: A = {} as A
    ) {
        this.scopes = Object.create(null);
        for (const name of Object.keys(definitions)) {
            if (typeof definitions[name] !== 'function')
                throw new Error(`Scope ${name} must be a function`);
            Object.defineProperty(this.scopes, name, {
                enumerable: true,
                value: (...parameters: any[]) => {
                    const contribution = definitions[name](...parameters);
                    if (
                        !contribution ||
                        typeof contribution !== 'object' ||
                        typeof (contribution as any).then === 'function'
                    ) {
                        throw new Error(`Scope ${name} must return synchronous read arguments`);
                    }
                    return new ScopedModel(model, definitions, mergeReadArgs(args, contribution));
                },
            });
        }
        Object.freeze(this.scopes);
    }

    /** Inspect the accumulated query options without executing a query. */
    inspect(): A {
        return snapshot(this.args);
    }

    findMany<const B extends ModelReadArgs = {}>(
        args?: CheckedReadArgs<T, B>
    ): Promise<ModelReadResult<T, ReadMerge<A, B>>[]> {
        return this.model.findMany(mergeReadArgs(this.args, args || {}) as any) as any;
    }
    findOne<const B extends ModelReadArgs = {}>(
        args?: CheckedReadArgs<T, B>
    ): Promise<ModelReadResult<T, ReadMerge<A, B>> | null> {
        return this.model.findOne(mergeReadArgs(this.args, args || {}) as any) as any;
    }
    page<const B extends ModelReadArgs = {}>(
        args?: CheckedReadArgs<T, B>
    ): Promise<ModelPageResult<ModelReadResult<T, ReadMerge<A, B>>>> {
        return this.model.page(mergeReadArgs(this.args, args || {}) as any) as any;
    }
    count(args: ModelReadArgs = {}): Promise<number> {
        return this.model.count(mergeReadArgs(this.args, args));
    }
    exists(args: ModelReadArgs = {}): Promise<boolean> {
        return this.model.exists(mergeReadArgs(this.args, args));
    }
    withDeleted(): ScopedModel<T, S, A> {
        return new ScopedModel(this.model.withDeleted(), this.definitions, this.args);
    }
    onlyDeleted(): ScopedModel<T, S, A> {
        return new ScopedModel(this.model.onlyDeleted(), this.definitions, this.args);
    }
    withoutDefaultWhere(): ScopedModel<T, S, A> {
        return new ScopedModel(this.model.withoutDefaultWhere(), this.definitions, this.args);
    }
}

// SDK option objects (e.g. MutationState) remain opaque; copy declarative data.
const snapshot = <T>(value: T): T => {
    if (Array.isArray(value)) return value.map((item) => snapshot(item)) as any;
    if (value && Object.getPrototypeOf(value) === Object.prototype) {
        const result: any = {};
        Object.keys(value).forEach((key) =>
            Object.defineProperty(result, key, {
                value: snapshot(value[key]),
                enumerable: true,
                writable: true,
                configurable: true,
            })
        );
        return result;
    }
    return value;
};

const mergeReadArgs = (left: ModelReadArgs, right: ModelReadArgs): ModelReadArgs => ({
    ...snapshot(left),
    ...snapshot(right),
    ...(left.where && right.where
        ? {where: {$and: [snapshot(left.where), snapshot(right.where)]}}
        : {}),
});

export const withModelScopes = <T, S extends ModelScopes>(
    model: TypedModel<T>,
    scopes: S
): ScopedModel<T, S> => new ScopedModel(model, {...scopes});

/** Extend this model view only. Existing model members cannot be replaced. */
export const withModelMethods = <M extends object, E extends object>(
    model: M,
    methods: E & ThisType<M>
): M & E => {
    const view = Object.create(model);
    for (const name of Object.keys(methods)) {
        if (name in model) throw new Error(`Model method ${name} already exists`);
        if (typeof methods[name] !== 'function')
            throw new Error(`Model method ${name} must be a function`);
        Object.defineProperty(view, name, {value: methods[name], enumerable: false});
    }
    return view;
};

/** A hydrated copy retains its own enumerable data for toJSON/save. */
export const withDocumentMethods = <M extends object, E extends object>(
    document: M,
    methods: E & ThisType<M>
): M & E => {
    const view = Object.create(Object.getPrototypeOf(document));
    for (const key of Object.getOwnPropertyNames(document))
        Object.defineProperty(view, key, Object.getOwnPropertyDescriptor(document, key)!);
    for (const key of Object.keys(methods)) {
        if (key in view || typeof methods[key] !== 'function')
            throw new Error(`Invalid or conflicting document method ${key}`);
        Object.defineProperty(view, key, {value: methods[key], enumerable: false});
    }
    return view;
};
