import type {IncludeDefinition} from './include';
import type {ModelReadArgs} from './read-helpers';

import type {AutoModelFields} from './index';

/** Compile-time marker carried by client-bound models; no runtime value is required. */
export declare const modelDocument: unique symbol;
export interface ModelDocument<T> {
    readonly [modelDocument]?: T;
}

type DocumentOf<M> = M extends ModelDocument<infer T> ? T : Record<string, unknown>;
/** Optional keys can take their declared value or the runtime default. */
type Option<I, K extends PropertyKey, Default> = K extends keyof I
    ? {} extends Pick<I, K>
        ? I[K] | Default
        : I[K]
    : Default;
type IsUnion<T, Whole = T> = T extends Whole ? ([Whole] extends [T] ? false : true) : never;
type HasUnionEntries<S extends readonly unknown[]> = S extends readonly [infer Head, ...infer Tail]
    ? true extends IsUnion<Head>
        ? true
        : HasUnionEntries<Tail>
    : false;
type Project<T, S> = S extends undefined | '*'
    ? T
    : S extends readonly (keyof T)[]
    ? number extends S['length']
        ? Partial<Pick<T, S[number]>>
        : S extends Required<S>
        ? HasUnionEntries<S> extends true
            ? Partial<Pick<T, S[number]>>
            : Pick<T, S[number]>
        : Partial<Pick<T, S[number]>>
    : Record<string, unknown>;
type Relation<I extends IncludeDefinition> = Project<
    I extends {model: infer M} ? DocumentOf<M> : Record<string, unknown>,
    Option<I, 'select', '*'>
>;
type DefaultNest<I> = 'keys' extends keyof I ? (I extends {keys: string} ? true : boolean) : false;
type NestKind<I, K> = K extends 'nest' | 'leftNest'
    ? true
    : K extends 'join' | 'leftJoin'
    ? false
    : DefaultNest<I>;
type IsNest<I> = NestKind<I, Option<I, 'type', 'default'>>;
type IsLeft<I> = Extract<Option<I, 'type', 'default'>, 'leftJoin' | 'leftNest'> extends never
    ? true extends Option<I, 'optional', false>
        ? true
        : false
    : true;
type Included<I extends IncludeDefinition> = IncludeDefinition extends I
    ? unknown
    : true extends IsNest<I>
    ? false extends IsNest<I>
        ? unknown
        : Relation<I>[]
    : IsLeft<I> extends true
    ? Relation<I> | null | undefined
    : Relation<I>;
type UncertainAlias<I extends IncludeDefinition> = string extends I['as'] ? true : IsUnion<I['as']>;
type OptionalAlias<I extends IncludeDefinition> = true extends UncertainAlias<I>
    ? true
    : IsLeft<I> extends true
    ? IsNest<I> extends true
        ? false
        : true
    : false;
// Distribute each tuple slot separately: a union-valued include describes one
// runtime alternative, not all its alternative aliases at once.
type IncludeOne<I extends IncludeDefinition> = I extends unknown
    ? {[Alias in I['as'] as OptionalAlias<I> extends true ? never : Alias]: Included<I>} & {
          [Alias in I['as'] as OptionalAlias<I> extends true ? Alias : never]?: Included<I>;
      }
    : never;
type Includes<I> = [I] extends [undefined]
    ? {}
    : I extends readonly IncludeDefinition[]
    ? number extends I['length']
        ? Record<string, unknown>
        : I extends readonly [
              infer Head extends IncludeDefinition,
              ...infer Tail extends readonly IncludeDefinition[]
          ]
        ? IncludeOne<Head> & Includes<Tail>
        : {}
    : {};

type ReadIncludes<A> = A extends {include: infer I} ? Includes<I> : {};
export type ModelReadResult<T, A> = 'select' extends keyof A
    ? A extends {select?: infer S}
        ? S extends undefined | '*' | readonly (keyof (T & AutoModelFields))[]
            ? Project<T & AutoModelFields, S> & ReadIncludes<A>
            : unknown
        : unknown
    : (T & AutoModelFields) & ReadIncludes<A>;

/** Reject known collisions; runtime checks also cover schemaless documents. */
type AliasCollision<T, A> = A extends {include: readonly (infer I)[]}
    ? I extends {as: infer Alias}
        ? Extract<Alias, keyof T | keyof AutoModelFields | 'doc' | '__cs_root'>
        : never
    : never;
export type CheckedReadArgs<T, A extends ModelReadArgs> = A &
    ([AliasCollision<T, A>] extends [never]
        ? unknown
        : {readonly __includeAliasConflictsWithRoot: never});
