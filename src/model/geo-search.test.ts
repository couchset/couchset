import 'mocha';
import {expect} from 'chai';
import {createCouchsetClient, defineModel, radiusBounds, geoRadiusKm, geoPoint} from '../next';

describe('Search and geo capabilities', () => {
    const setup = () => {
        const catalog: any[] = [];
        const calls: any[] = [];
        const manager = {getAllIndexes: async () => catalog,
            upsertIndex: async (index: any) => {calls.push(index); catalog.push({...index, uuid: 'uuid'});}};
        const cluster: any = {bucket: () => ({defaultCollection: () => ({}), scope: () => ({searchIndexes: () => manager})}),
            searchIndexes: () => manager, search: async (...args: any[]) => {calls.push(args); return {rows: [], meta: {}};},
            query: async (...args: any[]) => {calls.push(args); return {rows: []};}};
        const db = createCouchsetClient({bucketName: 'test', dependencies: {cluster}});
        const definition = defineModel<{location: {lat: number; lon: number}; embedding: number[]}>({name: 'Place', searchIndexes: [{name: 'places', fields: {
            location: {type: 'geopoint'}, embedding: {type: 'vector', dims: 3},
        }}]});
        db.model(definition);
        return {db, definition, catalog, calls};
    };
    it('plans without writes and detects stale plans before apply', async () => {
        const {db, catalog, calls} = setup();
        const plan = await db.planSearchIndexes();
        expect(plan.items[0].status).to.equal('create');
        expect(calls).to.have.length(0);
        catalog.push({...plan.items[0].index, uuid: 'concurrent'});
        try {await db.applySearchIndexPlan(plan); throw new Error('accepted');}
        catch (error) {expect(error.message).to.contain('stale');}
        expect(calls).to.have.length(0);
    });
    it('applies missing indexes explicitly and leaves matching indexes alone', async () => {
        const {db, calls} = setup();
        await db.applySearchIndexPlan(await db.planSearchIndexes());
        expect((await db.planSearchIndexes()).items[0].status).to.equal('matching');
        const count = calls.length;
        await db.applySearchIndexPlan(await db.planSearchIndexes());
        expect(calls).to.have.length(count);
    });
    it('preserves model discriminator and geo coordinates in Search query', async () => {
        const {db, definition, calls} = setup();
        await db.search(definition, 'places').withinRadius({strategy: 'search', field: 'location', center: {lat: 0, lon: 0}, radius: '5km'});
        expect(calls[0][1].searchQuery.toJSON().conjuncts).to.deep.equal([
            {term: 'Place', field: '_type'}, {field: 'location', location: {lat: 0, lon: 0}, distance: '5km'},
        ]);
    });
    it('validates vectors against declared dimensions', async () => {
        const {db, definition} = setup();
        try {await db.search(definition, 'places').vector('embedding', [1]); throw new Error('accepted');}
        catch (error) {expect(error.message).to.contain('dimensions');}
    });
    it('handles antimeridian/polar bounds and rejects invalid coordinates', () => {
        const crossing = radiusBounds({lat: 0, lon: 179}, 500);
        expect(crossing.west).to.be.greaterThan(crossing.east);
        expect(radiusBounds({lat: 89, lon: 0}, 500)).to.include({east: 180, west: -180});
        expect(geoRadiusKm('1000m')).to.equal(1);
        expect(() => geoPoint({lat: 100, lon: 0})).to.throw('latitude');
    });
    it('parameterizes GSI radius filters before pagination', async () => {
        const {db, definition, calls} = setup();
        await db.geo(definition).withinRadius({field: 'location', center: {lat: 43, lon: -79}, radius: '10km', strategy: 'gsi'});
        const [sql, options] = calls[0];
        expect(sql).to.contain('ASIN').and.contain('<= $geoRadius ORDER BY');
        expect(sql).not.to.match(/AND\s+AND|AND\s*\)/);
        expect(options.parameters.geoLat).to.equal(43);
        expect(options.parameters.geoRadius).to.equal(10);
    });
});
