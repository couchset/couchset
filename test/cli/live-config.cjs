'use strict';
require('dotenv/config');
const {createCouchsetClient, defineModel} = require('../../next');
const scope = process.env.COUCHSET_LIVE_SCOPE;
if (!/^cs_cli_\d+_\d+$/.test(scope || '') || process.env.COUCHBASE_BUCKET !== 'test' ||
    !/^couchbases?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(process.env.COUCHBASE_URL || '')) {
    throw new Error('Explicit local test fixture required');
}
const db = createCouchsetClient({connectionString: process.env.COUCHBASE_URL, bucketName: 'test',
    username: process.env.COUCHBASE_USERNAME, password: process.env.COUCHBASE_PASSWORD});
db.model(defineModel({name: 'CliLive', scope, collection: 'docs',
    indexes: [{name: 'cli_value', fields: ['value']}],
    searchIndexes: [{name: `${scope}_search`, scoped: true, fields: {
        value: {type: 'text', store: process.env.COUCHSET_LIVE_DRIFT === '1'},
    }}],
}));
const eventing = db.eventing({namespace: scope,
    metadataKeyspace: {bucket: 'test', scope, collection: 'metadata'},
    definitions: [{name: 'probe', code: 'function OnUpdate(doc, meta) {}',
        sourceKeyspace: {bucket: 'test', scope, collection: 'docs'}}],
});
module.exports = {db, eventing};
