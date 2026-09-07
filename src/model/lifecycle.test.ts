import 'mocha';
import {expect} from 'chai';
import {attachModelHooks, ModelAfterHookError} from './lifecycle';
import {createCouchsetClient, defineModel} from '../next';

describe('opt-in lifecycle hooks', () => {
    it('composes delete and patch hooks for soft delete and restore', async () => {
        const events: string[] = [];
        const db = createCouchsetClient({bucketName: 'test', dependencies: {cluster: {
            bucket: () => ({defaultCollection: () => ({
                mutateIn: async () => {events.push('mutation');},
                get: async () => ({content: {id: 'id'}}),
            })}),
        } as any}});
        const model = db.model(defineModel({name: 'Item', softDelete: true, hooks: {
            beforeDelete: () => {events.push('beforeDelete');},
            afterDelete: () => {events.push('afterDelete');},
            beforePatch: (patch) => {events.push('beforePatch'); return patch;},
            afterPatch: () => {events.push('afterPatch');},
        }}));
        await model.deleteById('id');
        expect(events).to.deep.equal(['beforeDelete', 'beforePatch', 'mutation', 'afterPatch', 'afterDelete']);
        for (const method of ['softDeleteById', 'restoreById']) {
            events.length = 0;
            await model[method]('id');
            expect(events).to.deep.equal(['beforePatch', 'mutation', 'afterPatch']);
        }
    });
    it('orders transforms before writes and observers after writes', async () => {
        const events: string[] = [];
        const model = {insert: async (data: any) => {events.push('write'); return data;},
            withDeleted() {return this;}, onlyDeleted() {return this;}, withoutDefaultWhere() {return this;}};
        attachModelHooks(model, {beforeInsert: (data) => {events.push('before'); return {...data, value: 2};},
            afterInsert: () => {events.push('after');}});
        expect((await model.insert({value: 1})).value).to.equal(2);
        expect(events).to.deep.equal(['before', 'write', 'after']);
    });
    it('distinguishes a failed after hook from a failed write', async () => {
        const model = {insert: async (data: any) => data};
        attachModelHooks(model, {afterInsert: () => {throw new Error('observer');}});
        try {await model.insert({}); throw new Error('accepted');}
        catch (error) {expect(error).to.be.instanceOf(ModelAfterHookError); expect(error.context.transaction).to.equal(false);}
    });
    it('marks retryable transaction hooks and unwraps transaction documents', async () => {
        const contexts: any[] = [];
        const model = {insert: async (id: string, data: any) => ({content: {...data, id}})};
        attachModelHooks(model, {beforeInsert: (data, context) => {contexts.push(context); return data;},
            afterInsert: (data) => expect(data.id).to.equal('id')}, true);
        await model.insert('id', {});
        await model.insert('id', {});
        expect(contexts).to.have.length(2);
        expect(contexts.every((context) => context.transaction)).to.equal(true);
    });
    it('leaves undeclared hooks dormant and propagates pre-hook failure before writes', async () => {
        let writes = 0;
        const model = {insert: async () => {writes++;}};
        const original = model.insert;
        attachModelHooks(model);
        expect(model.insert).to.equal(original);
        attachModelHooks(model, {beforeInsert: () => {throw new Error('pre');}});
        try {await model.insert();} catch (error) {expect(error.message).to.equal('pre');}
        expect(writes).to.equal(0);
    });
});
