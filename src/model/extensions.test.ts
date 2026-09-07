import 'mocha';
import {expect} from 'chai';
import {createCouchsetClient, defineModel, withModelMethods, withModelScopes} from '../next';

describe('local model extensions', () => {
    const setup = () => {
        const queries: any[] = [];
        const db = createCouchsetClient({bucketName: 'test', dependencies: {cluster: {
            bucket: () => ({defaultCollection: () => ({})}),
            query: async (statement: string, options: any) => {queries.push({statement, options}); return {rows: []};},
        } as any}});
        return {queries, model: db.model(defineModel<{name: string}>({name: 'Item', defaultWhere: {tenant: 'fixed'}}))};
    };

    it('ANDs scope predicates with caller predicates and existing defaults', async () => {
        const {model, queries} = setup();
        const scoped = withModelScopes(model, {named: (name: string) => ({where: {name}})});
        await scoped.scopes.named('a').scopes.named('b').findMany({where: {active: true}});
        expect(Object.values(queries[0].options.parameters)).to.include.members(['fixed', 'a', 'b', true]);
        expect(queries[0].statement).to.contain('AND');
        await model.findMany();
        expect(Object.values(queries[1].options.parameters)).not.to.include('a');
    });

    it('copies scope values and inspection data and lets call options override', async () => {
        const {model, queries} = setup();
        const contribution = {where: {name: 'original'}, limit: 5};
        const scoped = withModelScopes(model, {named: () => contribution}).scopes.named();
        contribution.where.name = 'mutated';
        scoped.inspect().where.name = 'inspection';
        await scoped.findMany({limit: 2});
        expect(Object.values(queries[0].options.parameters)).to.include('original');
        expect(queries[0].options.parameters.cs_limit).to.equal(2);
    });

    it('preserves explicit default-scope bypass without removing named predicates', async () => {
        const {model, queries} = setup();
        await withModelScopes(model, {named: () => ({where: {name: 'kept'}})}).scopes.named().withoutDefaultWhere().findMany();
        expect(Object.values(queries[0].options.parameters)).to.include('kept').and.not.include('fixed');
    });

    it('adds domain methods to a local view and rejects replacement', async () => {
        const {model, queries} = setup();
        const extended = withModelMethods(model, {byName(name: string) {return this.findOne({where: {name}});}});
        await extended.byName('example');
        expect(Object.values(queries[0].options.parameters)).to.include('example');
        expect('byName' in model).to.equal(false);
        expect(() => withModelMethods(model, {findOne() {}})).to.throw('already exists');
    });
});
