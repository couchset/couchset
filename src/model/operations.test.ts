import 'mocha';
import {expect} from 'chai';
import {bulkMap, withModelBulk, withDocumentMethods, createCouchsetClient, defineModel} from '../next';
import {hydrate} from './hydrated-document';
import {runCouchsetCli} from '../cli';

describe('operational additions', () => {
    it('retains ordinary model methods on a local bulk view and rejects collisions', async () => {
        const db = createCouchsetClient({bucketName: 'test', dependencies: {cluster: {
            bucket: () => ({defaultCollection: () => ({get: async () => ({content: {id: 'id', name: 'item'}})})}),
        } as any}});
        const model = db.model(defineModel<{name: string}>({name: 'Item'}));
        const bulk = withModelBulk(model);
        expect(bulk.keyspace()).to.equal(model.keyspace());
        expect((await bulk.getById('id')).name).to.equal('item');
        expect('insertMany' in model).to.equal(false);
        expect(() => withModelBulk(bulk)).to.throw('already exists');
    });
    it('routes read-only administrative plans and requires reviewed apply input', async () => {
        const output: string[] = [];
        for (const resource of ['collections', 'indexes', 'search-indexes', 'eventing']) {
            await runCouchsetCli([resource, 'plan', '--config', 'test/cli/config.cjs'], (value) => output.push(value));
        }
        expect(output).to.have.length(4);
        try {await runCouchsetCli(['indexes', 'apply', '--config', 'test/cli/config.cjs']); throw new Error('accepted');}
        catch (error) {expect(error.message).to.contain('--plan');}
        await runCouchsetCli(['indexes', 'apply', '--config', 'test/cli/config.cjs', '--plan', 'test/cli/plan.json'], (value) => output.push(value));
        expect(JSON.parse(output[4]).applied).to.equal(true);
    });
    it('bounds unordered concurrency and preserves item order and SDK results', async () => {
        let active = 0; let peak = 0;
        const rows = await bulkMap([0, 1, 2, 3], async (input) => {
            active++; peak = Math.max(peak, active);
            await new Promise((resolve) => setTimeout(resolve, 2)); active--;
            if (input === 2) throw new Error('failed');
            return {cas: input, token: `token${input}`};
        }, {concurrency: 2, ordered: false});
        expect(peak).to.equal(2);
        expect(rows.map((row) => row.status)).to.deep.equal(['fulfilled', 'fulfilled', 'rejected', 'fulfilled']);
        expect((rows[3] as any).value.token).to.equal('token3');
    });
    it('marks remaining ordered operations skipped after failure', async () => {
        const rows = await bulkMap([0, 1, 2], async (input) => {if (input === 1) throw new Error('failed'); return input;});
        expect(rows.map((row) => row.status)).to.deep.equal(['fulfilled', 'rejected', 'skipped']);
    });
    it('isolates instrumentation failures and emits no payloads', async () => {
        const events: any[] = [];
        const db = createCouchsetClient({bucketName: 'test', instrumentation: {onOperation: (event) => {events.push(event); throw new Error('observer');}},
            dependencies: {cluster: {bucket: () => ({defaultCollection: () => ({insert: async () => {}})})} as any}});
        const model = db.model(defineModel({name: 'Item'}));
        await model.insert({secret: 'not in event'});
        expect(events[0]).to.include({operation: 'insert', outcome: 'success'});
        expect(JSON.stringify(events)).not.to.contain('secret');
    });
    it('preserves hydrated data when adding instance methods', async () => {
        let saved: any;
        const original = hydrate({replaceById: async (_id, data) => {saved = data; return data;}} as any,
            {id: 'id', name: 'old'} as any);
        const extended = withDocumentMethods(original, {rename(name: string) {this.name = name; return this.save();}});
        await extended.rename('new');
        expect(saved).to.include({id: 'id', name: 'new'});
        expect(original.name).to.equal('old');
        expect(extended.toJSON()).not.to.have.property('rename');
    });
    it('prints scaffolds and help without loading a config or connecting', async () => {
        const output: string[] = [];
        await runCouchsetCli(['model', 'User'], (value) => output.push(value));
        expect(output[0]).to.contain("name: 'User'");
        await runCouchsetCli(['--help'], (value) => output.push(value));
        expect(output[1]).to.contain('--plan');
    });
});
