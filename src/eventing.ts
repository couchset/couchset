import type {
    EventingFunction,
    EventingFunctionManager,
    EventingFunctionSettings,
    EventingFunctionState,
} from 'couchbase';

/** A Couchbase bucket/scope/collection used by an Eventing function. */
export interface EventingKeyspace {
    bucket: string;
    scope?: string;
    collection?: string;
}

/**
 * A declarative Eventing handler. `name` is logical: CouchSet derives the
 * physical Couchbase name from the Eventing namespace.
 */
export interface EventingDefinition {
    name: string;
    code: string;
    sourceKeyspace: EventingKeyspace;
    enforceSchema?: boolean;
    bucketBindings?: EventingFunction['bucketBindings'];
    urlBindings?: EventingFunction['urlBindings'];
    constantBindings?: EventingFunction['constantBindings'];
    settings?: Partial<EventingFunctionSettings>;
}

export type EventingFunctionDefinition = EventingDefinition;

/**
 * The metadata collection is used only by Couchbase Eventing for checkpoints
 * and timers. CouchSet never opens it as an application collection or writes
 * documents to it.
 */
export interface EventingOptions {
    /** Required ownership boundary for physical Couchbase function names. */
    namespace: string;
    /** A dedicated collection reserved for Couchbase Eventing metadata. */
    metadataKeyspace: EventingKeyspace;
    /** Definitions registered when the control plane is constructed. */
    definitions?: EventingDefinition[];
    /** Alias for definitions, useful for manifest-shaped configuration. */
    functions?: EventingDefinition[];
    /** Explicit SDK manager injection, primarily for tests or owned clusters. */
    manager?: EventingFunctionManagerLike;
    /** Maximum time to wait for Couchbase Eventing lifecycle convergence. */
    lifecycleTimeoutMs?: number;
    /** Delay between lifecycle status checks. Defaults to 250ms. */
    lifecyclePollIntervalMs?: number;
}

export interface EventingApplyOptions {
    /**
     * Permit source or metadata keyspace changes. Couchbase must undeploy first,
     * which erases the function's timers and checkpoints.
     */
    allowRecreate?: boolean;
}

export type EventingOutcomeAction =
    | 'created'
    | 'updated'
    | 'resumed'
    | 'unchanged'
    | 'pruned'
    | 'paused'
    | 'removed'
    | 'requires-recreate';

export interface EventingOutcome {
    action: EventingOutcomeAction;
    /** Lifecycle operations performed for this function, in order. */
    actions: EventingOutcomeAction[];
    name: string;
    physicalName: string;
    /** Present whenever undeploying can erase Eventing timers/checkpoints. */
    timerStateLost?: boolean;
    message?: string;
}

/**
 * Each status array contains the matching outcome, so callers can inspect a
 * report directly without parsing text. An update can also be in `paused` and
 * `resumed`, because that is the safe lifecycle used to perform the update.
 */
export interface EventingReport {
    outcomes: EventingOutcome[];
    created: EventingOutcome[];
    updated: EventingOutcome[];
    resumed: EventingOutcome[];
    unchanged: EventingOutcome[];
    pruned: EventingOutcome[];
    paused: EventingOutcome[];
    removed: EventingOutcome[];
    requiresRecreate: EventingOutcome[];
}

/** The portion of SDK 4.7's EventingFunctionManager used by CouchSet. */
export interface EventingFunctionManagerLike {
    upsertFunction(functionDefinition: EventingFunction): Promise<void>;
    dropFunction(name: string): Promise<void>;
    getAllFunctions(): Promise<EventingFunction[]>;
    deployFunction(name: string): Promise<void>;
    undeployFunction(name: string): Promise<void>;
    pauseFunction(name: string): Promise<void>;
    resumeFunction(name: string): Promise<void>;
    functionsStatus(): Promise<{functions: EventingFunctionState[]}>;
}

/** A minimal client shape that lets Eventing acquire the connected SDK cluster. */
export interface EventingClient {
    ready(): Promise<any>;
    getConnection(): {cluster: {eventingFunctions?: () => EventingFunctionManager}};
}

interface FunctionLifecycle {
    deployed: boolean;
    paused: boolean;
    transitional: boolean;
}

const timerStateWarning =
    'Undeploying an Eventing function erases its Eventing timers and checkpoints.';

const emptyReport = (): EventingReport => ({
    created: [],
    outcomes: [],
    paused: [],
    pruned: [],
    removed: [],
    requiresRecreate: [],
    resumed: [],
    unchanged: [],
    updated: [],
});

const normalizeKeyspace = (keyspace: EventingKeyspace): Required<EventingKeyspace> => ({
    bucket: keyspace.bucket,
    collection: keyspace.collection || '_default',
    scope: keyspace.scope || '_default',
});

const keyspaceEquals = (left: EventingKeyspace, right: EventingKeyspace): boolean => {
    const normalizedLeft = normalizeKeyspace(left);
    const normalizedRight = normalizeKeyspace(right);

    return (
        normalizedLeft.bucket === normalizedRight.bucket &&
        normalizedLeft.scope === normalizedRight.scope &&
        normalizedLeft.collection === normalizedRight.collection
    );
};

const requiredKeyspace = (keyspace: EventingKeyspace, label: string): void => {
    if (!keyspace || !keyspace.bucket) {
        throw new Error(`${label} requires a non-empty bucket`);
    }
};

const stableValue = (value: any): any => {
    if (value === undefined) {
        return undefined;
    }
    if (value === null || typeof value !== 'object') {
        return value;
    }
    if (Array.isArray(value)) {
        return value.map(stableValue);
    }

    const normalized: any = {};
    Object.keys(value)
        .sort()
        .forEach((key) => {
            const item = stableValue(value[key]);
            if (item !== undefined) {
                normalized[key] = item;
            }
        });
    return normalized;
};

const equal = (left: any, right: any): boolean =>
    JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right));

const settingsMatch = (
    live: EventingFunction['settings'] | undefined,
    desired: Partial<EventingFunctionSettings> | undefined
): boolean => {
    const requested = desired || {};
    const comparableLive: any = {};

    Object.keys(requested).forEach((key) => {
        if (key !== 'deploymentStatus' && key !== 'processingStatus') {
            comparableLive[key] = (live as any)?.[key];
        }
    });

    const comparableDesired: any = {};
    Object.keys(requested).forEach((key) => {
        if (key !== 'deploymentStatus' && key !== 'processingStatus') {
            comparableDesired[key] = (requested as any)[key];
        }
    });

    return equal(comparableLive, comparableDesired);
};

const lifecycleFor = (
    state: EventingFunctionState | undefined,
    functionDefinition: EventingFunction
): FunctionLifecycle => {
    const status = (state as any)?.status || '';
    const deploymentStatus =
        (state as any)?.deploymentStatus ||
        (functionDefinition.settings as any)?.deploymentStatus ||
        '';
    const processingStatus =
        (state as any)?.processingStatus ||
        (functionDefinition.settings as any)?.processingStatus ||
        '';

    return {
        deployed: status === 'deployed' || status === 'paused' || deploymentStatus === 'deployed',
        paused: status === 'paused' || processingStatus === 'paused',
        transitional:
            status === 'deploying' ||
            status === 'undeploying' ||
            status === 'pausing' ||
            deploymentStatus === 'deploying' ||
            deploymentStatus === 'undeploying',
    };
};

const own = (object: any, key: string): boolean =>
    Object.prototype.hasOwnProperty.call(object, key);

/**
 * Declarative Eventing reconciler backed by the SDK 4.7 EventingFunctionManager.
 * It only manages names starting with its namespace prefix.
 */
export class Eventing {
    private readonly definitionsByName = new Map<string, EventingDefinition>();
    private readonly eventingMetadataKeyspace: EventingKeyspace;
    private readonly lifecyclePollIntervalMs: number;
    private readonly lifecycleTimeoutMs: number;
    private readonly prefix: string;
    private readonly client?: EventingClient;
    private readonly explicitManager?: EventingFunctionManagerLike;

    constructor(client: EventingClient | undefined, options: EventingOptions) {
        if (!options || !options.namespace || !options.namespace.trim()) {
            throw new Error('Eventing requires an explicit, non-empty namespace');
        }
        requiredKeyspace(options.metadataKeyspace, 'Eventing metadataKeyspace');
        if (
            !options.metadataKeyspace.collection ||
            options.metadataKeyspace.collection === '_default'
        ) {
            throw new Error(
                'Eventing metadataKeyspace requires a dedicated non-default collection; CouchSet never uses it as application data'
            );
        }

        this.client = client;
        this.explicitManager = options.manager;
        this.eventingMetadataKeyspace = {...options.metadataKeyspace};
        this.lifecycleTimeoutMs = this.positiveNumber(options.lifecycleTimeoutMs, 30000);
        this.lifecyclePollIntervalMs = this.nonNegativeNumber(options.lifecyclePollIntervalMs, 250);
        this.prefix = `${options.namespace.trim()}__`;

        (options.definitions || options.functions || []).forEach((definition) =>
            this.register(definition)
        );
    }

    /** Logical namespace that owns this controller's physical functions. */
    public get namespace(): string {
        return this.prefix.slice(0, -2);
    }

    /** A copy of registered, code-only declarations. This performs no I/O. */
    public definitions(): EventingDefinition[] {
        return Array.from(this.definitionsByName.values()).map((definition) => ({...definition}));
    }

    /** Converts a logical declaration name into its Couchbase function name. */
    public physicalName(name: string): string {
        this.assertLogicalName(name);
        return `${this.prefix}${name}`;
    }

    /** Registers or replaces an in-memory manifest declaration without I/O. */
    public register(definition: EventingDefinition): EventingDefinition {
        this.assertDefinition(definition);
        this.definitionsByName.set(definition.name, {...definition});
        return definition;
    }

    /** Alias for register(), matching the declaration-oriented API vocabulary. */
    public define(definition: EventingDefinition): EventingDefinition {
        return this.register(definition);
    }

    public async apply(options?: EventingApplyOptions): Promise<EventingReport>;
    public async apply(
        definition: EventingDefinition,
        options?: EventingApplyOptions
    ): Promise<EventingReport>;
    public async apply(
        definitionOrOptions?: EventingDefinition | EventingApplyOptions,
        possibleOptions: EventingApplyOptions = {}
    ): Promise<EventingReport> {
        const dynamic = this.isDefinition(definitionOrOptions) ? definitionOrOptions : undefined;
        const options = dynamic
            ? possibleOptions
            : (definitionOrOptions as EventingApplyOptions) || {};
        const report = emptyReport();
        const manager = await this.manager();

        if (dynamic) {
            this.register(dynamic);
        }

        const live = await manager.getAllFunctions();
        const states = await this.states(manager);
        const statesByName = new Map<string, EventingFunctionState>();
        states.forEach((state) => statesByName.set(state.name, state));
        const liveByName = new Map<string, EventingFunction>();
        live.forEach((functionDefinition) =>
            liveByName.set(functionDefinition.name, functionDefinition)
        );

        const targets = dynamic ? [dynamic] : this.definitions();
        for (const definition of targets) {
            await this.reconcile(
                manager,
                definition,
                liveByName.get(this.physicalName(definition.name)),
                statesByName.get(this.physicalName(definition.name)),
                options,
                report
            );
        }

        // A dynamic apply is intentionally surgical: it never prunes anything.
        if (!dynamic) {
            const declared = new Set<string>();
            targets.forEach((definition) => declared.add(this.physicalName(definition.name)));
            for (const functionDefinition of live) {
                if (this.owns(functionDefinition.name) && !declared.has(functionDefinition.name)) {
                    await this.prune(
                        manager,
                        functionDefinition,
                        statesByName.get(functionDefinition.name),
                        report
                    );
                }
            }
        }

        return report;
    }

    /** Temporarily disables one namespace-owned Eventing function. */
    public async pause(name: string): Promise<EventingReport> {
        const report = emptyReport();
        const physicalName = this.physicalName(name);
        const manager = await this.manager();
        const live = await manager.getAllFunctions();
        const current = live.filter(
            (functionDefinition) => functionDefinition.name === physicalName
        )[0];

        if (!current) {
            this.record(
                report,
                this.outcome(
                    'unchanged',
                    name,
                    ['unchanged'],
                    'No namespace-owned Eventing function exists with this name.'
                )
            );
            return report;
        }

        const states = await this.states(manager);
        const state = states.filter((item) => item.name === physicalName)[0];
        const lifecycle = await this.stableLifecycle(manager, physicalName, current, state);

        if (!lifecycle.deployed || lifecycle.paused) {
            this.record(report, this.outcome('unchanged', name, ['unchanged']));
            return report;
        }

        await manager.pauseFunction(physicalName);
        await this.waitForLifecycle(manager, physicalName, 'paused');
        this.record(report, this.outcome('paused', name, ['paused']));
        return report;
    }

    /**
     * Intentionally undeploys then deletes one namespace-owned function.
     * Undeployment erases Couchbase Eventing timers and checkpoints.
     */
    public async remove(name: string): Promise<EventingReport> {
        const report = emptyReport();
        const physicalName = this.physicalName(name);
        const manager = await this.manager();
        const live = await manager.getAllFunctions();
        const current = live.filter(
            (functionDefinition) => functionDefinition.name === physicalName
        )[0];

        if (!current) {
            this.record(
                report,
                this.outcome(
                    'unchanged',
                    name,
                    ['unchanged'],
                    'No namespace-owned Eventing function exists with this name.'
                )
            );
            return report;
        }

        const states = await this.states(manager);
        const state = states.filter((item) => item.name === physicalName)[0];
        const lifecycle = await this.stableLifecycle(manager, physicalName, current, state);

        if (lifecycle.deployed) {
            await manager.undeployFunction(physicalName);
            await this.waitForLifecycle(manager, physicalName, 'undeployed');
        }
        await manager.dropFunction(physicalName);
        this.definitionsByName.delete(name);
        this.record(
            report,
            this.outcome('removed', name, ['removed'], timerStateWarning, lifecycle.deployed)
        );
        return report;
    }

    private async reconcile(
        manager: EventingFunctionManagerLike,
        definition: EventingDefinition,
        current: EventingFunction | undefined,
        state: EventingFunctionState | undefined,
        options: EventingApplyOptions,
        report: EventingReport
    ): Promise<void> {
        const physicalName = this.physicalName(definition.name);
        const desired = this.sdkDefinition(definition);

        if (!current) {
            await manager.upsertFunction(desired);
            await manager.deployFunction(physicalName);
            await this.waitForLifecycle(manager, physicalName, 'deployed');
            this.record(report, this.outcome('created', definition.name, ['created']));
            return;
        }

        const lifecycle = await this.stableLifecycle(manager, physicalName, current, state);
        const keyspaceChanged =
            !keyspaceEquals(current.sourceKeyspace, desired.sourceKeyspace) ||
            !keyspaceEquals(current.metadataKeyspace, desired.metadataKeyspace);

        if (keyspaceChanged) {
            if (!options.allowRecreate) {
                this.record(
                    report,
                    this.outcome(
                        'requires-recreate',
                        definition.name,
                        ['requires-recreate'],
                        `${timerStateWarning} Re-run apply with {allowRecreate: true} to permit this keyspace change.`
                    )
                );
                return;
            }

            if (lifecycle.deployed) {
                await manager.undeployFunction(physicalName);
                await this.waitForLifecycle(manager, physicalName, 'undeployed');
            }
            await manager.upsertFunction(desired);
            await manager.deployFunction(physicalName);
            await this.waitForLifecycle(manager, physicalName, 'deployed');
            this.record(
                report,
                this.outcome(
                    'updated',
                    definition.name,
                    ['updated'],
                    timerStateWarning,
                    lifecycle.deployed
                )
            );
            return;
        }

        if (this.matches(current, desired, definition)) {
            if (lifecycle.paused) {
                await manager.resumeFunction(physicalName);
                await this.waitForLifecycle(manager, physicalName, 'deployed');
                this.record(report, this.outcome('resumed', definition.name, ['resumed']));
            } else if (!lifecycle.deployed) {
                await manager.deployFunction(physicalName);
                await this.waitForLifecycle(manager, physicalName, 'deployed');
                this.record(report, this.outcome('resumed', definition.name, ['resumed']));
            } else {
                this.record(report, this.outcome('unchanged', definition.name, ['unchanged']));
            }
            return;
        }

        const actions: EventingOutcomeAction[] = [];
        if (lifecycle.deployed && !lifecycle.paused) {
            await manager.pauseFunction(physicalName);
            await this.waitForLifecycle(manager, physicalName, 'paused');
            actions.push('paused');
        }
        await manager.upsertFunction(desired);
        actions.push('updated');
        await this.activateAfterUpsert(manager, physicalName, desired, actions);
        this.record(report, this.outcome('updated', definition.name, actions));
    }

    private async prune(
        manager: EventingFunctionManagerLike,
        functionDefinition: EventingFunction,
        state: EventingFunctionState | undefined,
        report: EventingReport
    ): Promise<void> {
        const lifecycle = await this.stableLifecycle(
            manager,
            functionDefinition.name,
            functionDefinition,
            state
        );
        if (lifecycle.deployed) {
            await manager.undeployFunction(functionDefinition.name);
            await this.waitForLifecycle(manager, functionDefinition.name, 'undeployed');
        }
        await manager.dropFunction(functionDefinition.name);
        this.record(
            report,
            this.outcome(
                'pruned',
                this.logicalName(functionDefinition.name),
                ['pruned'],
                timerStateWarning,
                lifecycle.deployed
            )
        );
    }

    private matches(
        current: EventingFunction,
        desired: EventingFunction,
        definition: EventingDefinition
    ): boolean {
        return (
            current.code === desired.code &&
            (definition.enforceSchema === undefined ||
                current.enforceSchema === desired.enforceSchema) &&
            equal(current.bucketBindings || [], desired.bucketBindings || []) &&
            equal(current.urlBindings || [], desired.urlBindings || []) &&
            equal(current.constantBindings || [], desired.constantBindings || []) &&
            settingsMatch(current.settings, definition.settings)
        );
    }

    private sdkDefinition(definition: EventingDefinition): EventingFunction {
        const metadataKeyspace = normalizeKeyspace(this.metadataKeyspace());
        const sourceKeyspace = normalizeKeyspace(definition.sourceKeyspace);
        const settings: any = {...(definition.settings || {})};

        // Lifecycle is controlled through manager methods, never through an upsert payload.
        delete settings.deploymentStatus;
        delete settings.processingStatus;

        return {
            bucketBindings: definition.bucketBindings || [],
            code: definition.code,
            constantBindings: definition.constantBindings || [],
            enforceSchema: definition.enforceSchema,
            metadataKeyspace,
            name: this.physicalName(definition.name),
            settings,
            sourceKeyspace,
            urlBindings: definition.urlBindings || [],
        } as EventingFunction;
    }

    private metadataKeyspace(): EventingKeyspace {
        // The keyspace has already been validated in the constructor. Keeping it
        // behind this helper prevents accidental exposure as a CouchSet collection.
        return this.eventingMetadataKeyspace;
    }

    private async manager(): Promise<EventingFunctionManagerLike> {
        if (this.explicitManager) {
            return this.explicitManager;
        }
        if (!this.client) {
            throw new Error(
                'Eventing requires a CouchSet client or an explicit EventingFunctionManager'
            );
        }

        await this.client.ready();
        const cluster = this.client.getConnection().cluster;
        if (!cluster || typeof cluster.eventingFunctions !== 'function') {
            throw new Error('The connected Couchbase SDK does not expose EventingFunctionManager');
        }
        return cluster.eventingFunctions() as EventingFunctionManagerLike;
    }

    private async states(manager: EventingFunctionManagerLike): Promise<EventingFunctionState[]> {
        const result = await manager.functionsStatus();
        return result.functions || [];
    }

    /**
     * Management requests acknowledge receipt, not necessarily completion. Do
     * not issue the next incompatible Eventing operation until status confirms
     * that Couchbase has converged.
     */
    private async waitForLifecycle(
        manager: EventingFunctionManagerLike,
        physicalName: string,
        expected: 'deployed' | 'paused' | 'undeployed'
    ): Promise<void> {
        const deadline = Date.now() + this.lifecycleTimeoutMs;

        while (true) {
            const state = (await this.states(manager)).filter(
                (item) => item.name === physicalName
            )[0];
            const lifecycle = lifecycleFor(state, {settings: {}} as EventingFunction);
            const reached =
                !!state &&
                !lifecycle.transitional &&
                ((expected === 'deployed' && lifecycle.deployed && !lifecycle.paused) ||
                    (expected === 'paused' && lifecycle.deployed && lifecycle.paused) ||
                    (expected === 'undeployed' && !lifecycle.deployed));

            if (reached) {
                return;
            }
            if (Date.now() >= deadline) {
                throw new Error(
                    `Timed out waiting for Eventing function ${physicalName} to become ${expected}`
                );
            }
            await new Promise<void>((resolve) => setTimeout(resolve, this.lifecyclePollIntervalMs));
        }
    }

    /**
     * Couchbase Server may turn a paused function into an undeployed function
     * when upsert persists new code/settings/bindings. Inspect that post-upsert
     * state rather than assuming resume is legal; deploy is the compatible
     * activation operation in that case.
     */
    private async activateAfterUpsert(
        manager: EventingFunctionManagerLike,
        physicalName: string,
        functionDefinition: EventingFunction,
        actions: EventingOutcomeAction[]
    ): Promise<void> {
        const lifecycle = await this.waitForStableLifecycle(
            manager,
            physicalName,
            functionDefinition
        );

        if (lifecycle.deployed && lifecycle.paused) {
            await manager.resumeFunction(physicalName);
            await this.waitForLifecycle(manager, physicalName, 'deployed');
            actions.push('resumed');
        } else if (!lifecycle.deployed) {
            await manager.deployFunction(physicalName);
            await this.waitForLifecycle(manager, physicalName, 'deployed');
            actions.push('resumed');
        }
    }

    /**
     * A live function with no status row is unknown, not safely undeployed.
     * Poll for a positive row; a known transitional row remains an immediate
     * blocker so callers do not race an operator's in-progress lifecycle call.
     */
    private async stableLifecycle(
        manager: EventingFunctionManagerLike,
        physicalName: string,
        functionDefinition: EventingFunction,
        initialState: EventingFunctionState | undefined
    ): Promise<FunctionLifecycle> {
        if (initialState) {
            const lifecycle = lifecycleFor(initialState, functionDefinition);
            this.assertStable(physicalName, lifecycle);
            return lifecycle;
        }

        const deadline = Date.now() + this.lifecycleTimeoutMs;
        while (true) {
            const state = (await this.states(manager)).filter(
                (item) => item.name === physicalName
            )[0];
            if (state) {
                const lifecycle = lifecycleFor(state, functionDefinition);
                this.assertStable(physicalName, lifecycle);
                return lifecycle;
            }
            if (Date.now() >= deadline) {
                throw new Error(
                    `Timed out waiting for Eventing status for function ${physicalName}`
                );
            }
            await new Promise<void>((resolve) => setTimeout(resolve, this.lifecyclePollIntervalMs));
        }
    }

    /** Waits for a stable state caused by this controller's own upsert call. */
    private async waitForStableLifecycle(
        manager: EventingFunctionManagerLike,
        physicalName: string,
        functionDefinition: EventingFunction
    ): Promise<FunctionLifecycle> {
        const deadline = Date.now() + this.lifecycleTimeoutMs;

        while (true) {
            const state = (await this.states(manager)).filter(
                (item) => item.name === physicalName
            )[0];
            if (state) {
                const lifecycle = lifecycleFor(state, functionDefinition);
                if (!lifecycle.transitional) {
                    return lifecycle;
                }
            }
            if (Date.now() >= deadline) {
                throw new Error(
                    `Timed out waiting for Eventing function ${physicalName} to settle after upsert`
                );
            }
            await new Promise<void>((resolve) => setTimeout(resolve, this.lifecyclePollIntervalMs));
        }
    }

    private record(report: EventingReport, outcome: EventingOutcome): void {
        report.outcomes.push(outcome);
        const actions = outcome.actions.length ? outcome.actions : [outcome.action];
        actions.forEach((action) => {
            const list =
                action === 'requires-recreate' ? report.requiresRecreate : (report as any)[action];
            if (list && list.indexOf(outcome) === -1) {
                list.push(outcome);
            }
        });
    }

    private outcome(
        action: EventingOutcomeAction,
        name: string,
        actions: EventingOutcomeAction[],
        message?: string,
        timerStateLost?: boolean
    ): EventingOutcome {
        return {
            action,
            actions,
            message,
            name,
            physicalName: this.physicalName(name),
            timerStateLost,
        };
    }

    private owns(name: string): boolean {
        return typeof name === 'string' && name.indexOf(this.prefix) === 0;
    }

    private logicalName(physicalName: string): string {
        if (!this.owns(physicalName)) {
            throw new Error(
                `Refusing to manage Eventing function outside namespace ${this.namespace}`
            );
        }
        return physicalName.slice(this.prefix.length);
    }

    private assertDefinition(definition: EventingDefinition): void {
        if (!definition || !definition.name || !definition.name.trim()) {
            throw new Error('Eventing definitions require a non-empty logical name');
        }
        if (!definition.code || typeof definition.code !== 'string') {
            throw new Error(`Eventing definition ${definition.name} requires handler code`);
        }
        requiredKeyspace(
            definition.sourceKeyspace,
            `Eventing definition ${definition.name} sourceKeyspace`
        );
        if (keyspaceEquals(definition.sourceKeyspace, this.metadataKeyspace())) {
            throw new Error(
                `Eventing definition ${definition.name} must use a dedicated metadata keyspace distinct from its source keyspace`
            );
        }
    }

    private assertLogicalName(name: string): void {
        if (!name || !name.trim()) {
            throw new Error('Eventing requires a non-empty logical function name');
        }
        if (name.indexOf(this.prefix) === 0) {
            throw new Error('Pass Eventing logical names, not physical namespace-prefixed names');
        }
    }

    private assertStable(physicalName: string, lifecycle: FunctionLifecycle): void {
        if (lifecycle.transitional) {
            throw new Error(
                `Eventing function ${physicalName} is transitioning; wait for Couchbase to settle before reconciling it`
            );
        }
    }

    private isDefinition(value: any): value is EventingDefinition {
        return !!value && own(value, 'name') && own(value, 'code') && own(value, 'sourceKeyspace');
    }

    private positiveNumber(value: number | undefined, fallback: number): number {
        return typeof value === 'number' && value > 0 ? value : fallback;
    }

    private nonNegativeNumber(value: number | undefined, fallback: number): number {
        return typeof value === 'number' && value >= 0 ? value : fallback;
    }
}

/**
 * Construct an Eventing control plane from a CouchSet client. The client is
 * used only to obtain the SDK EventingFunctionManager after `ready()`.
 */
export const createEventing = (client: EventingClient, options: EventingOptions): Eventing =>
    new Eventing(client, options);

/** Construct an Eventing control plane around an application-owned SDK manager. */
export const createEventingWithManager = (options: EventingOptions): Eventing => {
    if (!options.manager) {
        throw new Error('createEventingWithManager requires EventingOptions.manager');
    }
    return new Eventing(undefined, options);
};

/** A small helper that makes Eventing definitions read as manifest declarations. */
export const defineEventingFunction = (definition: EventingDefinition): EventingDefinition => ({
    ...definition,
});
