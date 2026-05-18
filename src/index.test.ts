import 'reflect-metadata';
import 'mocha';
import 'dotenv/config';
import {expect} from 'chai';

import {couchset, Model, QueryBuilder} from './index';

const cbURL = process.env.COUCHBASE_URL || 'couchbase://localhost';
const cbBucket = process.env.COUCHBASE_BUCKET || 'dev';
const cbUsername = process.env.COUCHBASE_USERNAME || 'admin';
const cbPw = process.env.COUCHBASE_PASSWORD || '1234';

before(async () => {
    await couchset({
        connectionString: cbURL,
        username: cbUsername,
        password: cbPw,
        bucketName: cbBucket,
    });
    console.log('couchbase started');
});

let sampleData: any = null;

const model = new Model('User', {schema: {createdAt: 'date'}});

describe('CouchSet', () => {
    it('should insert into couchbase', async () => {
        const created = await model.insert({
            userId: 'ceddy',
            password: 'i love couchbase',
        });

        console.log('sample data created', JSON.stringify(created));


        sampleData = created;
        expect(created.id).to.not.null;

        await new Promise((resolve) => setTimeout(resolve, 500));
    });

    it('should get into couchbase', async () => {
        const foundData = await model.getById(sampleData.id);

        console.log('found data', foundData);
        console.log('sample data', sampleData);
        expect(foundData.id).to.be.equal(sampleData.id);
    });

    it('should update into couchbase', async () => {
        const someValueupdate = 'some update value';
        const updatedData = await model.replaceById(sampleData.id, {
            ...sampleData,
            someValue: someValueupdate,
        });
        expect(updatedData.id).to.be.equal(sampleData.id);
        expect(updatedData.someValue).to.be.equal(someValueupdate);
    });

    it('should page couchbase rows with select', async () => {
        const paginationData = await model.findMany({
            select: ['id', 'password', 'createdAt', 'email', 'phone', 'fullname'],
            where: {
                userId: {$eq: 'ceddy'},
                $or: [{userId: {$eq: 'ceddy'}}, {phone: 10}],
            },
            limit: 100,
            page: 0,
        });

        console.log('pagination data', paginationData);
        expect(paginationData).to.be.not.empty;
    });

    it('should return page metadata without select', async () => {
        const paginationData = await model.page({
            select: '*',
            where: {
                userId: {$eq: 'ceddy'},
                $or: [{userId: {$eq: 'ceddy'}}, {phone: 10}],
            },
            limit: 100,
            page: 0,
        });

        console.log('pagination data', paginationData);
        expect(paginationData.items).to.be.not.empty;
    });

    it('should create query', async () => {
        const query = new QueryBuilder({}, cbBucket).select('*').build();

        console.log('query is', query);

        expect(query).to.be.not.null;
    });

    it('should delete into couchbase', async () => {
        const deletedData = await model.deleteById(sampleData.id, {hard: true});
        expect(deletedData).to.be.equal(true);
    });
});
