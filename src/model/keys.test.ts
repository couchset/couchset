import 'mocha';
import {expect} from 'chai';
import {createCouchsetClient, defineModel, withModelValidator} from '../next';
import {resolveModelKey} from './keys';

describe('opt-in key strategies and validators', () => {
    it('preserves supplied IDs and calls create only for absent IDs', () => {
        let calls = 0;
        const key = {create: () => {calls++; return 'generated';}, parse: () => {throw new Error('not opted in');}};
        expect(resolveModelKey(key, {id: 'supplied'})).to.equal('supplied');
        expect(calls).to.equal(0);
        expect(resolveModelKey(key, {})).to.equal('generated');
        expect(calls).to.equal(1);
    });
    it('validates or rejects explicit IDs only when requested', () => {
        expect(() => resolveModelKey({create: () => 'x', explicitId: 'reject'}, {id: 'x'})).to.throw('disabled');
        expect(() => resolveModelKey({create: () => 'x', explicitId: 'validate'}, {id: 'x'})).to.throw('parse');
        expect(() => resolveModelKey({create: () => '', explicitId: 'allow'}, {})).to.throw('nonempty');
        expect(resolveModelKey({create: () => 'x', explicitId: 'validate', parse: (id) => ({id})}, {id: 'custom'})).to.equal('custom');
    });
    it('applies keys and validator transformations to stored documents, retains metadata', async () => {
        const stored: any[] = [];
        const db = createCouchsetClient({bucketName: 'test', dependencies: {cluster: {
            bucket: () => ({defaultCollection: () => ({insert: async (id: string, doc: any) => stored.push({id, doc})})}),
        } as any}});
        const definition = defineModel<{name: string}>({name: 'Person', key: {create: (doc) => `person::${doc.name}`},
            plugins: [withModelValidator({'~standard': {version: 1, vendor: 'test', validate: (value: any) => ({value: {name: value.name.toUpperCase()}})}})]});
        const result = await db.model(definition).insert({name: 'alice'});
        expect(result.id).to.equal('person::alice');
        expect(stored[0].doc.name).to.equal('ALICE');
        expect(stored[0].doc._type).to.equal('Person');
        expect(stored[0].doc.createdAt).to.be.instanceOf(Date);
    });
    it('surfaces schema issues and prevents writes', async () => {
        const plugin = withModelValidator({'~standard': {version: 1, vendor: 'test', validate: async () => ({issues: [{message: 'bad input'}]})}});
        const options = plugin({name: 'Person'});
        try { await options.validateCreate({}); throw new Error('accepted'); }
        catch (error) {expect(error.name).to.equal('ModelValidationError'); expect(error.issues[0].message).to.equal('bad input');}
    });
});
