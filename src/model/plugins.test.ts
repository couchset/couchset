import 'mocha';
import {expect} from 'chai';
import {createCouchsetClient, defineModel, defineModelPlugin} from '../next';

describe('definition plugins', () => {
    it('composes in order and isolates nested inputs and contributions', () => {
        const options = {codecs: {value: {toDatabase: (v: any) => v, fromDatabase: (v: any) => v}}};
        const seen: any[] = [];
        const definition = defineModel({name: 'Item', plugins: [
            defineModelPlugin(() => options),
            defineModelPlugin((current) => {
                seen.push(current);
                expect(Object.isFrozen(current.codecs.value)).to.equal(true);
                return {indexes: [{name: 'value_idx', fields: ['value']}]};
            }),
        ]});
        expect(seen).to.have.length(1);
        expect(definition.plugins).to.equal(undefined);
        expect(definition.codecs).not.to.equal(options.codecs);
        expect(Object.isFrozen(options.codecs)).to.equal(false);
        expect(definition.indexes[0].name).to.equal('value_idx');
    });

    it('rejects conflicting named indexes and scalar options', () => {
        expect(() => defineModel({name: 'Item', softDelete: false,
            plugins: [() => ({softDelete: true})]})).to.throw('softDelete');
        expect(() => defineModel({name: 'Item', indexes: [{name: 'idx', fields: ['a']}],
            plugins: [() => ({indexes: [{name: 'idx', fields: ['b']}]})]})).to.throw('indexes.idx');
    });

    it('deduplicates compatible indexes and date fields', () => {
        const index = {name: 'idx', fields: ['value']};
        const definition = defineModel({name: 'Item', indexes: [index], dateFields: ['date'],
            plugins: [() => ({indexes: [index], dateFields: ['date', 'other']})]});
        expect(definition.indexes).to.have.length(1);
        expect(definition.dateFields).to.deep.equal(['date', 'other']);
    });

    it('does not allow target changes, asynchronous plugins or nested plugins', () => {
        for (const contribution of [{name: 'Other'}, {scope: 'Other'}, {collection: 'Other'}, {plugins: []}]) {
            expect(() => defineModel({name: 'Item', plugins: [(() => contribution) as any]})).to.throw('cannot set');
        }
        expect(() => defineModel({name: 'Item', plugins: [(async () => ({})) as any]})).to.throw('synchronous');
    });

    it('retains the no-plugin shallow-copy contract', () => {
        const codecs = {value: {toDatabase: (v: any) => v, fromDatabase: (v: any) => v}};
        expect(defineModel({name: 'Item', codecs}).codecs).to.equal(codecs);
    });

    it('binds composed definitions without connecting or running DDL', () => {
        const plugin = defineModelPlugin(() => ({softDelete: true}));
        const db = createCouchsetClient({dependencies: {connect: async () => {throw new Error('unexpected connection');}}});
        const definition = defineModel({name: 'Item', plugins: [plugin]});
        expect(db.model(definition)).to.equal(db.model(definition));
        expect(db.definitions()[0].softDelete).to.equal(true);
        expect(db.model({name: 'Raw', plugins: [plugin]})).to.equal(db.model({name: 'Raw', plugins: [plugin]}));
    });
});
