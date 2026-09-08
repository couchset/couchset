import 'dotenv/config';
import {strict as assert} from 'assert';

import {connect, QueryScanConsistency} from 'couchbase';

import {createCouchsetClient, defineModel} from '../src/next';

async function main() {
    const url = process.env.COUCHBASE_URL || '';
    assert(/^couchbases?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(url));
    assert.equal(process.env.COUCHBASE_BUCKET, 'test');
    const cluster = await connect(url, {
        username: process.env.COUCHBASE_USERNAME,
        password: process.env.COUCHBASE_PASSWORD,
    });
    const db = createCouchsetClient({bucketName: 'test', dependencies: {cluster}});
    const suffix = `${Date.now()}_${Math.floor(Math.random() * 1e9)}`;
    const searchName = `cs_geo_${suffix}`;
    const gsiName = `cs_gsi_${suffix}`;
    const id = `cs_geo::${suffix}`;
    const definition = defineModel<{location: {lat: number; lon: number}}>({
        name: `Geo${suffix}`,
        indexes: [{name: gsiName, fields: ['location.lat', 'location.lon']}],
        searchIndexes: [{name: searchName, fields: {location: {type: 'geopoint'}}}],
    });
    const model = db.model(definition);
    let inserted = false;
    let gsi = false;
    let search = false;
    try {
        await model.insert({id, location: {lat: 43.65, lon: -79.44}} as any);
        inserted = true;
        await model.ensureIndexes();
        gsi = true;
        const radius = await db.geo(definition).withinRadius({
            strategy: 'gsi',
            field: 'location',
            center: {lat: 43.65, lon: -79.44},
            radius: '5km',
            queryOptions: {scanConsistency: QueryScanConsistency.RequestPlus},
        });
        assert.equal(radius.length, 1);
        await db.applySearchIndexPlan(await db.planSearchIndexes());
        search = true;
        const end = Date.now() + 60000;
        for (;;) {
            const result = await db.search(definition, searchName).withinRadius({
                strategy: 'search',
                field: 'location',
                center: {lat: 43.65, lon: -79.44},
                radius: '5km',
            });
            if (result.rows.some((row) => row.id === id)) break;
            if (Date.now() >= end) throw new Error('Search ingestion timed out');
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
        console.log('Local GSI and Search geo queries passed');
        const repeat = await db.planSearchIndexes();
        assert.equal(repeat.items[0].status, 'matching');
    } finally {
        try {
            if (inserted) await model.deleteById(id, {hard: true});
        } finally {
            try {
                if (gsi) await cluster.query(`DROP INDEX \`test\`.\`${gsiName}\``);
            } finally {
                try {
                    if (search) await cluster.searchIndexes().dropIndex(searchName);
                } finally {
                    await db.shutdown();
                }
            }
        }
    }
}
main().catch((error) => {
    console.error(error.name, error.message);
    process.exitCode = 1;
});
