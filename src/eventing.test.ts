import 'mocha';

import {expect} from 'chai';

import {
    createEventingWithManager,
    EventingDefinition,
    EventingFunctionManagerLike,
    EventingKeyspace,
} from './eventing';

const source: EventingKeyspace = {bucket: 'app', collection: 'orders', scope: 'sales'};
const metadata: EventingKeyspace = {
    bucket: 'app',
    collection: 'eventing_metadata',
    scope: 'eventing',
};

const handler = (changes: Partial<EventingDefinition> = {}): EventingDefinition => ({
    code: 'function OnUpdate(doc, meta) { log(meta.id); }',
    name: 'audit_orders',
    sourceKeyspace: source,
    ...changes,
});

class FakeEventingManager implements EventingFunctionManagerLike {
    public functions: any[] = [];
    public operations: string[] = [];
    public requirePausedBeforeUpdate = false;
    public requireUndeployedBeforeUpdate = false;
    public requireUndeployedBeforeDrop = false;
    public statusReads = 0;
    public upsertUndeploysExisting = false;
    private delayTransitions = false;
    private omittedStatusRows = new Map<string, number>();
    private pendingStates: Array<{name: string; status: string; remainingReads: number}> = [];
    private statesByName = new Map<string, any>();

    public delayReportedTransitions(): void {
        this.delayTransitions = true;
    }

    public omitStatusRows(name: string, count: number): void {
        this.omittedStatusRows.set(name, count);
    }

    public seed(functionDefinition: any, status = 'deployed'): void {
        this.functions.push(functionDefinition);
        this.statesByName.set(functionDefinition.name, this.state(functionDefinition.name, status));
    }

    public async upsertFunction(functionDefinition: any): Promise<void> {
        this.operations.push(`upsert:${functionDefinition.name}`);
        const index = this.functions.findIndex((item) => item.name === functionDefinition.name);
        if (index === -1) {
            this.functions.push(functionDefinition);
            this.statesByName.set(functionDefinition.name, this.state(functionDefinition.name, 'undeployed'));
        } else {
            if (
                this.requirePausedBeforeUpdate &&
                this.statesByName.get(functionDefinition.name)?.status !== 'paused'
            ) {
                throw new Error('upsert was issued before Couchbase reported the handler paused');
            }
            if (
                this.requireUndeployedBeforeUpdate &&
                this.statesByName.get(functionDefinition.name)?.status !== 'undeployed'
            ) {
                throw new Error('upsert was issued before Couchbase reported the handler undeployed');
            }
            this.functions[index] = functionDefinition;
            if (this.upsertUndeploysExisting) {
                this.statesByName.set(functionDefinition.name, this.state(functionDefinition.name, 'undeployed'));
            }
        }
    }

    public async dropFunction(name: string): Promise<void> {
        this.operations.push(`drop:${name}`);
        if (this.requireUndeployedBeforeDrop && this.statesByName.get(name)?.status !== 'undeployed') {
            throw new Error('drop was issued before Couchbase reported the handler undeployed');
        }
        this.functions = this.functions.filter((item) => item.name !== name);
        this.statesByName.delete(name);
    }

    public async getAllFunctions(): Promise<any[]> {
        return this.functions.slice();
    }

    public async deployFunction(name: string): Promise<void> {
        this.operations.push(`deploy:${name}`);
        this.transition(name, 'deployed');
    }

    public async undeployFunction(name: string): Promise<void> {
        this.operations.push(`undeploy:${name}`);
        this.transition(name, 'undeployed');
    }

    public async pauseFunction(name: string): Promise<void> {
        this.operations.push(`pause:${name}`);
        this.transition(name, 'paused');
    }

    public async resumeFunction(name: string): Promise<void> {
        this.operations.push(`resume:${name}`);
        this.transition(name, 'deployed');
    }

    public async functionsStatus(): Promise<any> {
        this.statusReads += 1;
        const current = Array.from(this.statesByName.values()).filter((state) => {
            const omitted = this.omittedStatusRows.get(state.name) || 0;
            if (!omitted) {
                return true;
            }
            this.omittedStatusRows.set(state.name, omitted - 1);
            return false;
        });
        this.pendingStates = this.pendingStates.filter((pending) => {
            pending.remainingReads -= 1;
            if (pending.remainingReads <= 0) {
                this.statesByName.set(pending.name, this.state(pending.name, pending.status));
                return false;
            }
            return true;
        });
        return {functions: current};
    }

    private transition(name: string, status: string): void {
        if (!this.delayTransitions) {
            this.statesByName.set(name, this.state(name, status));
            return;
        }
        this.pendingStates.push({name, remainingReads: 2, status});
    }

    private state(name: string, status: string): any {
        if (status === 'paused') {
            return {
                deploymentStatus: 'deployed',
                name,
                processingStatus: 'paused',
                status: 'paused',
            };
        }
        if (status === 'undeployed') {
            return {
                deploymentStatus: 'undeployed',
                name,
                processingStatus: 'paused',
                status: 'undeployed',
            };
        }
        return {
            deploymentStatus: 'deployed',
            name,
            processingStatus: 'running',
            status: 'deployed',
        };
    }
}

const controller = (
    manager: FakeEventingManager,
    definitions: EventingDefinition[] = [handler()],
    options: any = {}
) =>
    createEventingWithManager({
        definitions,
        manager,
        metadataKeyspace: metadata,
        namespace: 'couchset',
        ...options,
    });

describe('Eventing control plane', () => {
    it('creates a namespace-prefixed function through the SDK Eventing manager', async () => {
        const manager = new FakeEventingManager();
        const eventing = controller(manager);

        const report = await eventing.apply();

        expect(manager.operations).to.deep.equal([
            'upsert:couchset__audit_orders',
            'deploy:couchset__audit_orders',
        ]);
        expect(manager.functions[0].name).to.equal('couchset__audit_orders');
        expect(manager.functions[0].sourceKeyspace).to.deep.equal(source);
        expect(manager.functions[0].metadataKeyspace).to.deep.equal(metadata);
        expect(report.created).to.have.length(1);
        expect(report.created[0].physicalName).to.equal('couchset__audit_orders');
    });

    it('uses pause, upsert, resume for ordinary deployed changes and no-ops unchanged code', async () => {
        const manager = new FakeEventingManager();
        const eventing = controller(manager);
        await eventing.apply();
        manager.operations = [];

        const changed = await eventing.apply(handler({code: 'function OnUpdate(doc) { log(doc.type); }'}));

        expect(manager.operations).to.deep.equal([
            'pause:couchset__audit_orders',
            'upsert:couchset__audit_orders',
            'resume:couchset__audit_orders',
        ]);
        expect(changed.updated).to.have.length(1);
        expect(changed.paused).to.have.length(1);
        expect(changed.resumed).to.have.length(1);

        manager.operations = [];
        const unchanged = await eventing.apply();
        expect(manager.operations).to.deep.equal([]);
        expect(unchanged.unchanged).to.have.length(1);
    });

    it('waits for Couchbase to report each lifecycle transition before the next incompatible call', async () => {
        const manager = new FakeEventingManager();
        const eventing = controller(manager, [handler()], {
            lifecyclePollIntervalMs: 0,
            lifecycleTimeoutMs: 1000,
        });
        await eventing.apply();
        manager.delayReportedTransitions();
        manager.requirePausedBeforeUpdate = true;
        manager.operations = [];
        manager.statusReads = 0;

        await eventing.apply(handler({code: 'function OnUpdate(doc) { log(doc.status); }'}));

        expect(manager.operations).to.deep.equal([
            'pause:couchset__audit_orders',
            'upsert:couchset__audit_orders',
            'resume:couchset__audit_orders',
        ]);
        expect(manager.statusReads).to.be.greaterThan(4);

        manager.requireUndeployedBeforeDrop = true;
        manager.omitStatusRows('couchset__audit_orders', 2);
        manager.operations = [];
        await eventing.remove('audit_orders');
        expect(manager.operations).to.deep.equal([
            'undeploy:couchset__audit_orders',
            'drop:couchset__audit_orders',
        ]);
    });

    it('deploys after upsert when Couchbase changes a paused handler to undeployed', async () => {
        const manager = new FakeEventingManager();
        const eventing = controller(manager);
        await eventing.apply();
        manager.operations = [];
        manager.upsertUndeploysExisting = true;

        await eventing.apply(handler({code: 'function OnUpdate(doc) { log(doc.state); }'}));

        expect(manager.operations).to.deep.equal([
            'pause:couchset__audit_orders',
            'upsert:couchset__audit_orders',
            'deploy:couchset__audit_orders',
        ]);
    });

    it('requires an explicit undeployed status row before recreating a keyspace change', async () => {
        const manager = new FakeEventingManager();
        manager.seed({
            bucketBindings: [],
            code: handler().code,
            constantBindings: [],
            metadataKeyspace: {...metadata, collection: 'old_eventing_metadata'},
            name: 'couchset__audit_orders',
            settings: {},
            sourceKeyspace: source,
            urlBindings: [],
        });
        manager.delayReportedTransitions();
        manager.requireUndeployedBeforeUpdate = true;
        manager.omitStatusRows('couchset__audit_orders', 2);
        const eventing = controller(manager, [handler()], {
            lifecyclePollIntervalMs: 0,
            lifecycleTimeoutMs: 1000,
        });

        await eventing.apply({allowRecreate: true});

        expect(manager.operations).to.deep.equal([
            'undeploy:couchset__audit_orders',
            'upsert:couchset__audit_orders',
            'deploy:couchset__audit_orders',
        ]);
    });

    it('resumes an unchanged paused function', async () => {
        const manager = new FakeEventingManager();
        const eventing = controller(manager);
        await eventing.apply();
        await eventing.pause('audit_orders');
        manager.operations = [];

        const report = await eventing.apply();

        expect(manager.operations).to.deep.equal(['resume:couchset__audit_orders']);
        expect(report.resumed).to.have.length(1);
    });

    it('requires an explicit destructive opt-in for source or metadata keyspace changes', async () => {
        const manager = new FakeEventingManager();
        manager.seed({
            bucketBindings: [],
            code: handler().code,
            constantBindings: [],
            metadataKeyspace: {...metadata, collection: 'old_eventing_metadata'},
            name: 'couchset__audit_orders',
            settings: {},
            sourceKeyspace: source,
            urlBindings: [],
        });
        const eventing = controller(manager);

        const blocked = await eventing.apply();
        expect(blocked.requiresRecreate).to.have.length(1);
        expect(manager.operations).to.deep.equal([]);

        const recreated = await eventing.apply({allowRecreate: true});
        expect(manager.operations).to.deep.equal([
            'undeploy:couchset__audit_orders',
            'upsert:couchset__audit_orders',
            'deploy:couchset__audit_orders',
        ]);
        expect(recreated.updated[0]).to.include({timerStateLost: true});
    });

    it('prunes only stale functions owned by its namespace, while dynamic apply never prunes', async () => {
        const manager = new FakeEventingManager();
        manager.seed({name: 'couchset__old', sourceKeyspace: source, metadataKeyspace: metadata, settings: {}});
        manager.seed({name: 'another_team__old', sourceKeyspace: source, metadataKeyspace: metadata, settings: {}});
        const eventing = controller(manager);

        await eventing.apply(handler({name: 'one_off'}));
        expect(manager.functions.map((item) => item.name)).to.include.members([
            'couchset__old',
            'another_team__old',
            'couchset__one_off',
        ]);

        manager.operations = [];
        const report = await eventing.apply();
        expect(manager.operations).to.deep.equal([
            'upsert:couchset__audit_orders',
            'deploy:couchset__audit_orders',
            'undeploy:couchset__old',
            'drop:couchset__old',
        ]);
        expect(manager.functions.map((item) => item.name)).to.include('another_team__old');
        expect(report.pruned[0]).to.include({name: 'old', timerStateLost: true});
    });

    it('pauses and removes only namespace-owned functions, reporting timer-state loss on removal', async () => {
        const manager = new FakeEventingManager();
        const eventing = controller(manager);
        await eventing.apply();
        manager.operations = [];

        const paused = await eventing.pause('audit_orders');
        expect(paused.paused).to.have.length(1);

        const removed = await eventing.remove('audit_orders');
        expect(manager.operations).to.deep.equal([
            'pause:couchset__audit_orders',
            'undeploy:couchset__audit_orders',
            'drop:couchset__audit_orders',
        ]);
        expect(removed.removed[0]).to.include({timerStateLost: true});
        expect(removed.removed[0].message).to.contain('timers and checkpoints');
    });

    it('requires explicit ownership and a dedicated metadata collection', () => {
        const manager = new FakeEventingManager();

        expect(() =>
            createEventingWithManager({
                manager,
                metadataKeyspace: metadata,
                namespace: '',
            })
        ).to.throw('explicit, non-empty namespace');
        expect(() =>
            createEventingWithManager({
                manager,
                metadataKeyspace: {bucket: 'app', collection: '_default'},
                namespace: 'couchset',
            })
        ).to.throw('dedicated non-default collection');
    });
});
