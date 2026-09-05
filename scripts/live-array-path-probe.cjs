// Opt-in local integration probe: node scripts/live-array-path-probe.cjs
// Requires a current build. Creates and removes only a uniquely named test scope.
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert').strict;
const crypto = require('crypto');
const root = path.resolve(__dirname, '..');
require('dotenv').config({path: path.join(root, '.env')});
const cb = require('couchbase');
const {getConnectionOptions} = require('../dist/database');
const {createCouchsetClient, defineModel, dateCodec, joinField} = require('../dist/next');
const settings = getConnectionOptions();
const scope = 'cs_path_probe_' + crypto.randomBytes(6).toString('hex');
const reportPath = path.join(os.tmpdir(), 'couchset-array-path-report.json');
const report = {startedAt: new Date().toISOString(), scope, tests: [], cleanup: false};
let cluster;
let created = false;
const cleanError = (error) => {
    let message = String(error.message || error);
    for (const secret of [settings.username, settings.password, settings.connectionString]) {
        if (secret) message = message.split(secret).join('[redacted]');
    }
    return {name: error.name, message};
};
const test = async (name, run) => {
    try {
        await run();
        report.tests.push({name, passed: true});
        console.log('PASS ' + name);
    } catch (error) {
        report.tests.push({name, passed: false, error: cleanError(error)});
        console.log('FAIL ' + name + ': ' + JSON.stringify(cleanError(error)));
    }
};
(async () => {
    try {
        assert(
            ['localhost', '127.0.0.1', '[::1]'].includes(
                new URL(settings.connectionString).hostname
            ),
            'Only loopback servers are allowed'
        );
        cluster = await cb.connect(settings.connectionString, {
            username: settings.username,
            password: settings.password,
            timeouts: {connectTimeout: 10000, queryTimeout: 15000},
        });
        report.version = (await cluster.query('SELECT RAW VERSION()')).rows[0];
        const bucket = cluster.bucket(settings.bucketName);
        const manager = bucket.collections();
        await manager.createScope(scope);
        created = true;
        for (const name of ['battles', 'media']) await manager.createCollection(name, scope);
        const db = createCouchsetClient({...settings, dependencies: {cluster, bucket}});
        const battles = db.model(defineModel({name: 'PathBattle', scope, collection: 'battles'}));
        const media = db.model(
            defineModel({
                name: 'PathMedia',
                scope,
                collection: 'media',
                codecs: {takenAt: dateCodec},
            })
        );
        for (const model of [battles, media])
            await cluster.query('CREATE PRIMARY INDEX ON ' + model.keyspace());
        for (const id of ['a', 'b', 'c'])
            await media.insert({id: 'media::' + id, takenAt: new Date('2026-09-05T00:00:00Z')});
        const references = [{mediaId: 'media::b'}, {mediaId: 'missing'}, {mediaId: 'media::a'}];
        await battles.insert({
            id: 'b1',
            participantIds: ['profile::demo', 'profile::other'],
            media: references,
            assets: {groups: [{media: references}]},
            'media[*]': 'media::c',
        });
        await battles.insert({
            id: 'b2',
            participantIds: ['profile::other', 'profile::demo'],
            media: [],
            assets: {groups: [{media: []}]},
        });
        await battles.insert({
            id: 'b3',
            participantIds: ['profile::unrelated'],
            media: [{mediaId: 'media::c'}],
        });
        const queryOptions = {scanConsistency: cb.QueryScanConsistency.RequestPlus, timeout: 15000};
        const include = [
            {as: 'mediaDocuments', model: media, keys: 'media[*].mediaId', type: 'leftNest'},
        ];
        const ids = (rows) => rows.map((row) => row.id).sort();
        const mediaIds = (row) => row.mediaDocuments.map((document) => document.id).sort();
        await test('wildcard ON KEYS hydrates media and preserves LEFT NEST cardinality', async () => {
            const rows = await battles.findMany({include, queryOptions});
            assert.equal(rows.length, 3);
            assert.deepEqual(mediaIds(rows.find((row) => row.id === 'b1')), [
                'media::a',
                'media::b',
            ]);
            assert.deepEqual(rows.find((row) => row.id === 'b2').mediaDocuments, []);
            for (const row of rows)
                for (const document of row.mediaDocuments) assert(document.takenAt instanceof Date);
        });
        await test('participantIds[0] filters the correct battle and hydrates its media', async () => {
            const rows = await battles.findMany({
                where: {'participantIds[0]': 'profile::demo'},
                include,
                queryOptions,
            });
            assert.deepEqual(ids(rows), ['b1']);
            assert.deepEqual(mediaIds(rows[0]), ['media::a', 'media::b']);
        });
        await test('participantIds[1] retains an unmatched LEFT NEST root', async () => {
            const rows = await battles.findMany({
                where: {'participantIds[1]': 'profile::demo'},
                include,
                queryOptions,
            });
            assert.deepEqual(ids(rows), ['b2']);
            assert.deepEqual(rows[0].mediaDocuments, []);
        });
        await test('OR participant filters and indexed orderBy preserve expression meaning', async () => {
            const rows = await battles.findMany({
                where: {
                    $or: [
                        {'participantIds[0]': 'profile::demo'},
                        {'participantIds[1]': 'profile::demo'},
                    ],
                },
                orderBy: {'participantIds[1]': 'ASC'},
                include,
                queryOptions,
            });
            assert.deepEqual(
                rows.map((row) => row.id),
                ['b2', 'b1']
            );
        });
        await test('nested array traversal and custom source aliases', async () => {
            const rows = await battles.findMany({
                sourceAlias: 'battle',
                where: {'battle.participantIds[0]': 'profile::demo'},
                include: [{...include[0], keys: 'battle.assets.groups[0].media[*].mediaId'}],
                queryOptions,
            });
            assert.deepEqual(ids(rows), ['b1']);
            assert.deepEqual(mediaIds(rows[0]), ['media::a', 'media::b']);
        });
        await test('ANSI joinField accepts an indexed field-to-field reference', async () => {
            const rows = await battles.findMany({
                where: {'participantIds[0]': 'profile::demo'},
                include: [
                    {
                        as: 'firstMedia',
                        model: media,
                        on: {
                            left: joinField('firstMedia.id'),
                            op: '$eq',
                            right: joinField('doc.media[0].mediaId'),
                        },
                    },
                ],
                queryOptions,
            });
            assert.equal(rows.length, 1);
            assert.equal(rows[0].firstMedia.id, 'media::b');
            assert(rows[0].firstMedia.takenAt instanceof Date);
        });
        await test('quoted array-looking field is literal, not traversal', async () => {
            const rows = await battles.findMany({
                where: {id: 'b1'},
                include: [{as: 'literalMedia', model: media, key: '`media[*]`'}],
                queryOptions,
            });
            assert.equal(rows.length, 1);
            assert.equal(rows[0].literalMedia.id, 'media::c');
        });
        await test('LEFT NEST pagination counts source rows without ordering nested matches', async () => {
            const result = await battles.page({
                include,
                orderBy: {id: 'ASC'},
                limit: 2,
                queryOptions,
            });
            assert.equal(result.items.length, 2);
            assert(result.hasNext);
            assert.deepEqual(ids(result.items), ['b1', 'b2']);
            assert.deepEqual(mediaIds(result.items[0]), ['media::a', 'media::b']);
        });
    } catch (error) {
        report.fatal = cleanError(error);
        console.log('FATAL ' + JSON.stringify(report.fatal));
    } finally {
        if (cluster && created) {
            try {
                const manager = cluster.bucket(settings.bucketName).collections();
                await manager.dropScope(scope);
                assert(!(await manager.getAllScopes()).some((item) => item.name === scope));
                report.cleanup = true;
            } catch (error) {
                report.cleanupError = cleanError(error);
            }
        }
        if (cluster) await cluster.close();
        report.finishedAt = new Date().toISOString();
        report.passed = report.tests.filter((item) => item.passed).length;
        report.failed = report.tests.filter((item) => !item.passed).length;
        fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
        console.log(
            JSON.stringify({
                version: report.version,
                passed: report.passed,
                failed: report.failed,
                cleanup: report.cleanup,
                reportPath,
            })
        );
        if (report.fatal || report.failed || !report.cleanup) process.exitCode = 1;
    }
})();
