import {isEdge} from './utils/edge';

let couchbase;

const edge = isEdge();

if (edge) {
    couchbase = require('couchbase-serverless');
} else {
    couchbase = require('couchbase');
}

export default couchbase;
