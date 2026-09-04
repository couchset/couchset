import type {Bucket, Cluster} from 'couchbase';

import couchbase from './couchbase';
import type {CouchsetArgs} from './connection';
import {Eventing} from './eventing';
import type {EventingOptions} from './eventing';
import {AutoModelFields, FieldCodec, Model, ModelConnection, ModalOptions} from './model';
import type {ModelIndexDefinition} from './model';
import {buildIndexQuery} from './model/indexes';
import {escapeIdentifier, keyspaceIdentifier} from './model/keyspace';
import type {SortType} from './query/interface/query.types';
import {buildWhereExpr} from './query/helpers/builders';
import {generateUUID} from './uuid';

export type {FieldCodec} from './model';
export * from './eventing';

/** A JSON-friendly Date codec for models declared with defineModel. */
export const dateCodec: FieldCodec<Date, string> = {
    fromDatabase: (value: string): Date => new Date(value),
    toDatabase: (value: Date): string => value.toISOString(),
};

export interface ModelCollectionSettings {
    maxExpiry?: number;
    history?: boolean;
}

/**
 * A model definition has no connection and performs no I/O. Definitions may be
 * reused safely across clients and are the unit the client registers.
 */
export type ModelField<T> = Extract<keyof T, string>;
export type TypedIndexField<T> = ModelField<T> | Partial<Record<ModelField<T>, SortType>>;
export type ModelCodecs<T> = Partial<{
    [Field in ModelField<T>]: FieldCodec<T[Field], any>;
}> &
    Partial<Record<`${string}.${string}`, FieldCodec<any, any>>>;

export interface TypedModelIndexDefinition<T> extends Omit<ModelIndexDefinition, 'fields'> {
    fields?: TypedIndexField<T>[];
}

export interface ModelDefinition<T = any> extends Omit<ModalOptions, 'codecs' | 'indexes'> {
    name: string;
    collectionSettings?: ModelCollectionSettings;
    codecs?: ModelCodecs<T>;
    indexes?: TypedModelIndexDefinition<T>[];
}

/** User fields are distinct from CouchSet's generated persistence metadata. */
export type ModelCreateInput<T> = Omit<T, keyof AutoModelFields> &
    Partial<Pick<T, Extract<keyof T, keyof AutoModelFields>>>;

export interface TypedModel<T>
    extends Omit<Model, 'getById' | 'getWithCas' | 'insert' | 'replaceById' | 'replaceIfCas'> {
    getById(id: string, options?: any): Promise<T & AutoModelFields>;
    getWithCas(
        id: string,
        options?: any
    ): Promise<{content: T & AutoModelFields; cas: any; expiryTime?: any}>;
    insert(data: ModelCreateInput<T>, options?: any): Promise<T & AutoModelFields>;
    replaceById(id: string, data: T, options?: any): Promise<T & AutoModelFields>;
    replaceIfCas(id: string, data: T, cas: any, options?: any): Promise<T & AutoModelFields>;
}

export const defineModel = <T = any>(definition: ModelDefinition<T>): ModelDefinition<T> => {
    if (!definition || !definition.name) {
        throw new Error('defineModel requires a non-empty name');
    }

    return {...definition};
};

export interface CouchsetClientDependencies {
    /** Supply a fully controlled runtime for tests or an application-owned connection. */
    connection?: ModelConnection;
    /** Supply an already connected SDK cluster/bucket without using couchbase.connect. */
    cluster?: Cluster;
    bucket?: Bucket;
    /** Override connection construction; useful for dependency injection and test doubles. */
    connect?: (settings: CouchsetArgs) => Promise<Cluster>;
}

export interface CouchsetClientOptions extends Partial<CouchsetArgs> {
    models?: Array<ModelDefinition<any>>;
    dependencies?: CouchsetClientDependencies;
}

export interface EnsureCollectionsOptions {
    models?: Array<ModelDefinition<any>>;
    timeoutMs?: number;
    pollIntervalMs?: number;
}

export interface ProvisionOptions extends EnsureCollectionsOptions {
    collections?: boolean;
    indexes?: boolean;
    waitForIndexes?: boolean;
}

export interface RegisterModelOptions extends ProvisionOptions {
    /** Explicitly provision this dynamic model. Constructors and CRUD never do this. */
    provision?: boolean | {collections?: boolean; indexes?: boolean; waitForIndexes?: boolean};
}

export interface ProvisionedTarget {
    scope: string;
    collection: string;
    createdScope: boolean;
    createdCollection: boolean;
}

export interface IndexPlanItem {
    status: 'create' | 'matching' | 'replace';
    definition: ModelIndexDefinition;
    keyspace: string;
    target: CollectionTarget;
    /** The physical index CouchSet will create. Replacement names are versioned. */
    createAs: string;
    /** Only populated for an explicit or detected safe replacement. */
    replaces?: string;
    reason?: string;
}

export interface IndexPlan {
    items: IndexPlanItem[];
}

export interface ApplyIndexPlanOptions {
    /** Opt-in only: drop old indexes after the replacement is online. */
    dropReplaced?: boolean;
    timeoutMs?: number;
}

interface RegisteredModel<T = any> {
    definition: ModelDefinition<T>;
    model: Model;
}

interface CollectionTarget {
    scope: string;
    collection: string;
    settings?: ModelCollectionSettings;
}

const defaultSettings = (options: CouchsetClientOptions): CouchsetArgs => ({
    bucketName: options.bucketName || 'default',
    connectionString: options.connectionString || 'couchbase://localhost',
    password: options.password || '',
    username: options.username || '',
    proxy: options.proxy,
});

const errorText = (error: any): string => `${error?.name || ''} ${error?.message || error || ''}`;
const isAlreadyExists = (error: any): boolean =>
    /already exists|exists|ScopeExists|CollectionExists/i.test(errorText(error));
const isNotFound = (error: any): boolean => /not found|not exist/i.test(errorText(error));

const provisionError = (operation: string, target: string, error: any): Error => {
    const message = errorText(error);
    const privilege = /access|permission|authoriz|privilege|forbidden/i.test(message)
        ? ' This operation requires Couchbase Manage Scopes privileges on the bucket.'
        : '';
    const wrapped: any = new Error(
        `CouchSet could not ${operation} ${target}.${privilege} ${message}`.trim()
    );
    wrapped.cause = error;
    return wrapped;
};

const delay = (milliseconds: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, milliseconds));

class DirectConnection implements ModelConnection {
    public cluster: Cluster;
    public bucket: Bucket;
    private connectPromise?: Promise<Cluster>;

    constructor(
        private readonly settings: CouchsetArgs,
        private readonly dependencies: CouchsetClientDependencies
    ) {
        this.cluster = dependencies.cluster as Cluster;
        this.bucket = dependencies.bucket as Bucket;

        if (this.cluster && !this.bucket) {
            this.bucket = this.cluster.bucket(settings.bucketName);
        }
    }

    public getBucket(): string {
        return this.settings.bucketName;
    }

    public getCollection(scopeName?: string, collectionName?: string): any {
        if (!this.bucket) {
            throw new Error('CouchSet client is not connected; call client.ready() first');
        }

        if (!scopeName && !collectionName) {
            return this.bucket.defaultCollection();
        }

        return this.bucket.scope(scopeName || '_default').collection(collectionName || '_default');
    }

    public isConnected(): boolean {
        return !!this.cluster && !!this.bucket;
    }

    public async ready(): Promise<DirectConnection> {
        if (this.isConnected()) {
            return this;
        }

        if (!this.connectPromise) {
            const connect =
                this.dependencies.connect ||
                ((settings: CouchsetArgs) =>
                    couchbase.connect(settings.connectionString, {
                        password: settings.password,
                        proxy: settings.proxy,
                        username: settings.username,
                    }));
            this.connectPromise = connect(this.settings);
        }

        this.cluster = await this.connectPromise;
        this.bucket = this.cluster.bucket(this.settings.bucketName);
        return this;
    }

    public shouldReconnect(): boolean {
        return false;
    }

    public markDisconnected(): void {
        // A client-owned connection never retries an arbitrary write operation.
    }

    public async shutdown(): Promise<void> {
        if (this.cluster && typeof (this.cluster as any).close === 'function') {
            await (this.cluster as any).close();
        }
        this.cluster = undefined as any;
        this.bucket = undefined as any;
    }
}

/**
 * A client owns its model-definition registry and connection. It intentionally
 * does not alter the legacy singleton or register models globally.
 */
export class CouchsetClient {
    private readonly connection: ModelConnection;
    private readonly registered = new Map<string, RegisteredModel<any>>();
    private readonly settings: CouchsetArgs;

    constructor(options: CouchsetClientOptions = {}) {
        this.settings = defaultSettings(options);
        const dependencies = options.dependencies || {};

        if (dependencies.connection) {
            const bucketName = dependencies.connection.getBucket();
            if (!bucketName) {
                throw new Error('Injected CouchSet connections must expose a bucket name');
            }
            if (options.bucketName && options.bucketName !== bucketName) {
                throw new Error(
                    `Injected CouchSet connection targets ${bucketName}, not requested bucket ${options.bucketName}`
                );
            }
            this.settings.bucketName = bucketName;
        } else if (dependencies.bucket) {
            const bucketName = dependencies.bucket.name;
            if (options.bucketName && options.bucketName !== bucketName) {
                throw new Error(
                    `Injected Couchbase bucket targets ${bucketName}, not requested bucket ${options.bucketName}`
                );
            }
            this.settings.bucketName = bucketName;
        } else if (dependencies.cluster && !options.bucketName) {
            throw new Error('bucketName is required when injecting a Couchbase cluster');
        }

        this.connection =
            dependencies.connection || new DirectConnection(this.settings, dependencies);

        (options.models || []).forEach((definition) => this.model(definition));
    }

    public async ready(): Promise<this> {
        await this.connection.ready();
        return this;
    }

    public async shutdown(): Promise<void> {
        const shutdown = (this.connection as any).shutdown;
        if (typeof shutdown === 'function') {
            await shutdown.call(this.connection);
        }
    }

    public definitions(): ModelDefinition<any>[] {
        return Array.from(this.registered.values()).map(({definition}) => definition);
    }

    /**
     * Creates a namespace-owned Eventing control plane. Definitions remain
     * declarative until eventing.apply() is called.
     */
    public eventing(options: EventingOptions): Eventing {
        return new Eventing(this, options);
    }

    /** Bind and register a definition without provisioning or index DDL. */
    public model<T>(definition: ModelDefinition<T>): TypedModel<T> {
        const identity = modelIdentity(definition);
        const existing = this.registered.get(identity);

        if (existing) {
            assertSameDefinition(existing.definition, definition);
            return existing.model as TypedModel<T>;
        }

        const model = new Model(definition.name, definition as ModalOptions, this.connection);
        this.registered.set(identity, {definition, model});
        return model as TypedModel<T>;
    }

    /**
     * Async registration for dynamic models. DDL is performed only when the
     * caller explicitly opts into provision; ordinary model() is side-effect-free.
     */
    public async registerModel<T>(
        definition: ModelDefinition<T>,
        options: RegisterModelOptions = {}
    ): Promise<TypedModel<T>> {
        const model = this.model(definition);
        const requested = options.provision;

        if (requested) {
            const config =
                typeof requested === 'boolean' ? {collections: true, indexes: true} : requested;
            await this.provision({
                collections: config.collections !== false,
                indexes: config.indexes !== false,
                models: [definition],
                timeoutMs: options.timeoutMs,
                waitForIndexes: config.waitForIndexes,
            });
        }

        return model;
    }

    /** Create only missing scopes/collections. Existing resources are never altered. */
    public async ensureCollections(
        options: EnsureCollectionsOptions = {}
    ): Promise<ProvisionedTarget[]> {
        await this.ready();
        const targets = this.targets(options.models);
        const manager: any = (this.connection as any).bucket.collections();
        let manifest: any[];

        try {
            manifest = await manager.getAllScopes();
        } catch (error) {
            throw provisionError('read the scope manifest for', this.settings.bucketName, error);
        }

        const result: ProvisionedTarget[] = [];
        for (const target of targets) {
            const defaultTarget = target.scope === '_default' && target.collection === '_default';
            if (defaultTarget) {
                result.push({...target, createdScope: false, createdCollection: false});
                continue;
            }

            let scope = findScope(manifest, target.scope);
            let createdScope = false;
            if (!scope && target.scope !== '_default') {
                try {
                    await manager.createScope(target.scope);
                    createdScope = true;
                } catch (error) {
                    if (!isAlreadyExists(error)) {
                        throw provisionError('create scope', target.scope, error);
                    }
                }
                manifest = await this.waitForCollectionManifest(target.scope, undefined, options);
                scope = findScope(manifest, target.scope);
            }

            if (!scope) {
                throw new Error(`CouchSet could not find scope ${target.scope} after provisioning`);
            }

            const exists = (scope.collections || []).some(
                (item: any) => item.name === target.collection
            );
            let createdCollection = false;
            if (!exists) {
                try {
                    await manager.createCollection(
                        target.collection,
                        target.scope,
                        target.settings || {}
                    );
                    createdCollection = true;
                } catch (error) {
                    if (!isAlreadyExists(error)) {
                        throw provisionError(
                            'create collection',
                            `${target.scope}.${target.collection}`,
                            error
                        );
                    }
                }
            }

            await this.waitForCollectionManifest(target.scope, target.collection, options);
            result.push({...target, createdScope, createdCollection});
        }

        return result;
    }

    /** Explicit bootstrap: provisioning occurs before index creation. */
    public async provision(options: ProvisionOptions = {}): Promise<{
        collections: ProvisionedTarget[];
        indexes: string[];
    }> {
        const definitions = options.models || this.definitions();
        const collections =
            options.collections === false
                ? []
                : await this.ensureCollections({...options, models: definitions});
        const indexes = options.indexes
            ? await this.ensureIndexes({
                  models: definitions,
                  waitForIndexes: options.waitForIndexes,
                  timeoutMs: options.timeoutMs,
              })
            : [];

        return {collections, indexes};
    }

    /** Normal ensureIndexes stays create-only. It never checks, drops, or changes an existing index. */
    public async ensureIndexes(
        options: {
            models?: Array<ModelDefinition<any>>;
            deferred?: boolean;
            waitForIndexes?: boolean;
            timeoutMs?: number;
        } = {}
    ): Promise<string[]> {
        await this.ready();
        const definitions = options.models || this.definitions();
        const queries: string[] = [];
        const indexes: Array<{name: string; target: CollectionTarget}> = [];

        for (const definition of definitions) {
            const model = this.model(definition);
            const statements = await model.ensureIndexes({deferred: options.deferred});
            queries.push(...statements);
            indexes.push(
                ...(definition.indexes || []).map((index) => ({
                    name: index.name,
                    target: definitionTarget(definition),
                }))
            );
        }

        if (options.waitForIndexes && indexes.length) {
            await this.waitForIndexes(indexes, options.timeoutMs);
        }

        return queries;
    }

    /** Report missing, matching, and drifted indexes; this method has no DDL side effects. */
    public async planIndexes(
        options: {models?: Array<ModelDefinition<any>>} = {}
    ): Promise<IndexPlan> {
        await this.ready();
        const rows = await this.indexCatalog();
        const items: IndexPlanItem[] = [];

        for (const definition of options.models || this.definitions()) {
            const keyspace = this.keyspace(definition);
            const target = definitionTarget(definition);
            for (const index of definition.indexes || []) {
                const matchingRows = rows.filter((row) => indexRowMatchesTarget(row, definition));
                const desired = matchingRows.find((row) => row.name === index.name);
                const replacementName = versionedIndexName(index.name, index);
                const replacement = matchingRows.find((row) => row.name === replacementName);

                // A previous safe rollout may have dropped the old logical name
                // while retaining this deterministic replacement physical name.
                if (replacement && indexMatches(replacement, index)) {
                    items.push({
                        createAs: replacementName,
                        definition: index,
                        keyspace,
                        status: 'matching',
                        target,
                    });
                    continue;
                }

                if (desired && indexMatches(desired, index)) {
                    items.push({
                        createAs: index.name,
                        definition: index,
                        keyspace,
                        status: 'matching',
                        target,
                    });
                    continue;
                }

                // `replaces` explicitly asks for a new physical index, even if
                // the predecessor happens to have equivalent keys.
                const predecessorName = index.replaces || index.name;
                const predecessor = matchingRows.find((row) => row.name === predecessorName);

                if (!predecessor) {
                    items.push({
                        createAs: index.name,
                        definition: index,
                        keyspace,
                        status: 'create',
                        target,
                    });
                    continue;
                }

                const createAs = index.replaces ? index.name : replacementName;
                items.push({
                    createAs,
                    definition: index,
                    keyspace,
                    reason: 'Declared keys, predicate, or primary mode differs from the live index.',
                    replaces: predecessor.name,
                    status: 'replace',
                    target,
                });
            }
        }

        return {items};
    }

    /**
     * Apply a reviewed plan by creating versioned replacements and waiting for
     * them. Dropping old indexes is deliberately an explicit second opt-in.
     */
    public async applyIndexPlan(
        plan: IndexPlan,
        options: ApplyIndexPlanOptions = {}
    ): Promise<string[]> {
        await this.ready();
        const applied: string[] = [];
        const replacements: Array<{name: string; target: CollectionTarget}> = [];

        for (const item of plan.items) {
            if (item.status === 'matching') {
                continue;
            }

            const definition = {...item.definition, name: item.createAs};
            const query = buildIndexQuery(item.keyspace, definition);
            await this.connection.cluster.query(query);
            applied.push(query);
            replacements.push({name: item.createAs, target: item.target});
        }

        if (replacements.length) {
            await this.waitForIndexes(replacements, options.timeoutMs);
        }

        if (options.dropReplaced) {
            for (const item of plan.items) {
                if (item.status === 'replace' && item.replaces) {
                    await this.connection.cluster.query(
                        `DROP INDEX ${item.keyspace}.${escapeIdentifier(item.replaces)}`
                    );
                }
            }
        }

        return applied;
    }

    /**
     * Run the callback through Couchbase's transaction retry loop. The callback
     * may execute more than once; do not perform external side effects inside it.
     * A commit-ambiguous error is rethrown and must be resolved by the caller via
     * an idempotency key/outbox, never by blindly retrying a side effect.
     */
    public async transaction<T>(
        callback: (transaction: CouchsetTransaction) => Promise<T>
    ): Promise<T> {
        await this.ready();
        let result: T;
        await (this.connection.cluster as any).transactions().run(async (attempt: any) => {
            result = await callback(new CouchsetTransaction(this, attempt));
        });
        return result as T;
    }

    public keyspace(definition: ModelDefinition<any>): string {
        const target = definitionTarget(definition);
        return keyspaceIdentifier({
            bucketName: this.settings.bucketName,
            collectionName: target.collection,
            scopeName: target.scope,
        });
    }

    public getConnection(): ModelConnection {
        return this.connection;
    }

    private targets(definitions?: Array<ModelDefinition<any>>): CollectionTarget[] {
        const targets = new Map<string, CollectionTarget>();
        for (const definition of definitions || this.definitions()) {
            const target = definitionTarget(definition);
            const identity = `${target.scope}.${target.collection}`;
            const existing = targets.get(identity);
            const settings = definition.collectionSettings;

            if (
                existing &&
                JSON.stringify(existing.settings || {}) !== JSON.stringify(settings || {})
            ) {
                throw new Error(
                    `Conflicting collection settings declared for ${identity}; CouchSet will not alter an existing collection`
                );
            }
            targets.set(identity, {...target, settings});
        }
        return Array.from(targets.values());
    }

    private async waitForCollectionManifest(
        scopeName: string,
        collectionName: string | undefined,
        options: EnsureCollectionsOptions
    ): Promise<any[]> {
        const manager: any = (this.connection as any).bucket.collections();
        const timeout = options.timeoutMs || 30000;
        const poll = options.pollIntervalMs || 100;
        const deadline = Date.now() + timeout;

        while (Date.now() <= deadline) {
            try {
                const manifest = await manager.getAllScopes();
                const scope = findScope(manifest, scopeName);
                if (
                    scope &&
                    (!collectionName ||
                        (scope.collections || []).some((item: any) => item.name === collectionName))
                ) {
                    return manifest;
                }
            } catch (error) {
                if (!isNotFound(error)) {
                    throw provisionError(
                        'wait for collection metadata',
                        `${scopeName}.${collectionName || ''}`,
                        error
                    );
                }
            }
            await delay(poll);
        }

        throw new Error(
            `Timed out waiting for Couchbase collection ${scopeName}.${
                collectionName || ''
            } to appear in the manifest`
        );
    }

    private async waitForIndexes(
        indexes: Array<{name: string; target: CollectionTarget}>,
        timeoutMs = 30000
    ): Promise<void> {
        const deadline = Date.now() + timeoutMs;

        while (Date.now() <= deadline) {
            const rows = await this.indexCatalog();
            if (
                indexes.every((index) =>
                    rows.some(
                        (row) =>
                            row.name === index.name &&
                            String(row.state).toLowerCase() === 'online' &&
                            indexRowMatchesCollection(row, index.target)
                    )
                )
            ) {
                return;
            }
            await delay(100);
        }

        throw new Error(
            `Timed out waiting for Couchbase indexes to become online: ${indexes
                .map((index) => index.name)
                .join(', ')}`
        );
    }

    private async indexCatalog(): Promise<any[]> {
        const result = await this.connection.cluster.query(
            'SELECT name, bucket_id, keyspace_id, scope_id, collection_id, index_key, condition, is_primary, state FROM system:indexes WHERE bucket_id = $bucket OR keyspace_id = $bucket',
            {parameters: {bucket: this.settings.bucketName}}
        );
        return (result as any).rows || [];
    }
}

/** A model bound strictly to a Couchbase transaction attempt. */
export class TransactionModel<T = any> {
    constructor(private readonly model: TypedModel<T>, private readonly attempt: any) {}

    public async get(id: string): Promise<TransactionDocument<T> | null> {
        try {
            const document = await this.attempt.get(this.model.getCollection(), id);
            return {content: this.model.parse<T & AutoModelFields>(document.content), document};
        } catch (error) {
            if (isNotFound(error)) {
                return null;
            }
            throw error;
        }
    }

    public getById(id: string): Promise<TransactionDocument<T> | null> {
        return this.get(id);
    }

    public async insert(id: string, data: ModelCreateInput<T>): Promise<TransactionDocument<T>> {
        const stored = await this.model.prepareInsert({...data, id} as T);
        const document = await this.attempt.insert(this.model.getCollection(), id, stored);
        return {
            content: this.model.parse<T & AutoModelFields>(document.content || stored),
            document,
        };
    }

    /** Replace requires the prior transactional read, as required by the SDK. */
    public async replace(
        document: TransactionDocument<T>,
        data: T
    ): Promise<TransactionDocument<T>> {
        const stored = await this.model.prepareReplace(document.content.id, data);
        const replacement = await this.attempt.replace(document.document, stored);
        return {
            content: this.model.parse<T & AutoModelFields>(replacement.content || stored),
            document: replacement,
        };
    }

    public async replaceById(id: string, data: T): Promise<TransactionDocument<T>> {
        const current = await this.get(id);
        if (!current) {
            throw new Error(`Cannot replace missing transaction document ${id}`);
        }
        return this.replace(current, data);
    }

    public async remove(document: TransactionDocument<T>): Promise<void> {
        await this.attempt.remove(document.document);
    }

    public query<TRow = any>(statement: string, options?: any): Promise<{rows: TRow[]}> {
        return this.attempt.query(statement, options);
    }
}

export interface TransactionDocument<T> {
    content: T & AutoModelFields;
    /** Opaque transaction SDK result; only pass it back to replace/remove. */
    document: any;
}

export class CouchsetTransaction {
    constructor(private readonly client: CouchsetClient, private readonly attempt: any) {}

    public model<T>(definition: ModelDefinition<T>): TransactionModel<T> {
        return new TransactionModel<T>(this.client.model(definition), this.attempt);
    }

    public query<TRow = any>(statement: string, options?: any): Promise<{rows: TRow[]}> {
        return this.attempt.query(statement, options);
    }
}

/**
 * Creates a short-lived scoped fixture and a cleanup function. The caller must
 * invoke cleanup in after/afterEach; no normal client operation ever drops data.
 */
export const createCouchsetTestFixture = async <T = any>(
    client: CouchsetClient,
    definition: Omit<ModelDefinition<T>, 'scope' | 'collection'> & {
        scope?: string;
        collection?: string;
    }
): Promise<{
    definition: ModelDefinition<T>;
    model: TypedModel<T>;
    cleanup: () => Promise<void>;
}> => {
    const suffix = generateUUID().replace(/-/g, '').slice(0, 12);
    const fixtureScope = definition.scope || `couchset_test_${suffix}`;
    const generatedScope = fixtureScope !== definition.scope;
    const scoped = defineModel<T>({
        ...definition,
        collection: definition.collection || `fixture_${suffix}`,
        scope: fixtureScope,
    });
    const model = await client.registerModel(scoped, {provision: {collections: true}});

    return {
        definition: scoped,
        model,
        cleanup: async () => {
            const target = definitionTarget(scoped);
            const manager: any = (client.getConnection() as any).bucket.collections();
            try {
                await manager.dropCollection(target.collection, target.scope);
            } catch (error) {
                if (!isNotFound(error)) {
                    throw provisionError(
                        'drop fixture collection',
                        `${target.scope}.${target.collection}`,
                        error
                    );
                }
            }
            if (generatedScope) {
                try {
                    await manager.dropScope(target.scope);
                } catch (error) {
                    if (!isNotFound(error)) {
                        throw provisionError('drop fixture scope', target.scope, error);
                    }
                }
            }
        },
    };
};

export const createCouchsetClient = (options: CouchsetClientOptions = {}): CouchsetClient =>
    new CouchsetClient(options);

const definitionTarget = (definition: ModelDefinition<any>): CollectionTarget => ({
    collection: Object.prototype.hasOwnProperty.call(definition, 'collection')
        ? definition.collection || '_default'
        : '_default',
    scope: Object.prototype.hasOwnProperty.call(definition, 'scope')
        ? definition.scope || '_default'
        : '_default',
});

const modelIdentity = (definition: ModelDefinition<any>): string => {
    const target = definitionTarget(definition);
    return `${target.scope}.${target.collection}.${definition.name}`;
};

const assertSameDefinition = (left: ModelDefinition<any>, right: ModelDefinition<any>): void => {
    if (!sameValue(left, right)) {
        throw new Error(
            `Model ${modelIdentity(
                left
            )} is already registered with a different definition; create a separate client or use a new model name`
        );
    }
};

const sameValue = (left: any, right: any): boolean => {
    if (left === right) {
        return true;
    }
    if (!left || !right || typeof left !== 'object' || typeof right !== 'object') {
        return false;
    }
    if (left instanceof Date || right instanceof Date) {
        return left instanceof Date && right instanceof Date && left.getTime() === right.getTime();
    }
    if (Array.isArray(left) || Array.isArray(right)) {
        return (
            Array.isArray(left) &&
            Array.isArray(right) &&
            left.length === right.length &&
            left.every((item, index) => sameValue(item, right[index]))
        );
    }
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return (
        leftKeys.length === rightKeys.length &&
        leftKeys.every((key, index) => key === rightKeys[index] && sameValue(left[key], right[key]))
    );
};

const findScope = (scopes: any[], name: string): any => scopes.find((scope) => scope.name === name);

const normalize = (value: any): string =>
    JSON.stringify(value || '')
        .replace(/[\s`()"']/g, '')
        .toLowerCase();

const indexMatches = (row: any, definition: ModelIndexDefinition): boolean => {
    if (!!row.is_primary !== !!definition.primary) {
        return false;
    }
    if (definition.primary) {
        return true;
    }

    const expectedKeys = (definition.fields || []).map((field) => {
        if (typeof field === 'string') {
            return field;
        }
        const key = Object.keys(field)[0];
        return `${key} ${field[key]}`;
    });
    return (
        normalize(row.index_key) === normalize(expectedKeys) &&
        normalize(row.condition) === normalize(indexCondition(definition))
    );
};

/** Match Couchbase's catalogued SQL++ condition against the same SQL++ we declare. */
const indexCondition = (definition: ModelIndexDefinition): string =>
    buildWhereExpr(definition.where).replace(/^\s*WHERE\s+/i, '');

const indexRowMatchesTarget = (row: any, definition: ModelDefinition<any>): boolean => {
    return indexRowMatchesCollection(row, definitionTarget(definition));
};

const indexRowMatchesCollection = (row: any, target: CollectionTarget): boolean => {
    // On current Couchbase Server, scoped collection indexes expose the
    // collection in keyspace_id and omit collection_id. Older/default targets
    // may use keyspace_id for the bucket, so prefer collection_id when present.
    const collection = row.collection_id || (row.scope_id ? row.keyspace_id : undefined);
    return (
        (!row.scope_id || row.scope_id === target.scope) &&
        (!collection || collection === target.collection)
    );
};

const versionedIndexName = (name: string, definition: ModelIndexDefinition): string => {
    const fingerprint = JSON.stringify({
        fields: definition.fields,
        primary: definition.primary,
        where: definition.where,
    })
        .split('')
        .reduce((hash, character) => (hash * 31 + character.charCodeAt(0)) >>> 0, 7)
        .toString(36);
    return `${name}_v${fingerprint}`;
};
