import 'reflect-metadata';
import 'mocha';
import { expect } from 'chai';
import { couchset, Model, QueryBuilder } from './index';

before((done) => {
    couchset({
        connectionString: 'couchbase://localhost',
        username: 'admin',
        password: '1234567',
        bucketName: 'stq',
    })
        .then((started) => {
            console.log('couchbase started');
            done()
        })
        .catch((error) => {
            console.error(error);
        });
});

let sampleData: any = null;


const model = new Model('User', { schema: { createdAt: 'date' } });

describe('CouchSet', () => {
    it('should insert into couchbase', async () => {
        const created = await model.create({
            userId: 'ceddy',
            password: 'i love couchbase',
        });

        console.log('sample data created', JSON.stringify(created));


        sampleData = created;
        expect(created.id).to.not.null;

        await new Promise((resolve) => setTimeout(resolve, 500));
    });

    it('should get into couchbase', async () => {
        const foundData = await model.findById(sampleData.id);

        console.log('found data', foundData);
        console.log('sample data', sampleData);
        expect(foundData.id).to.be.equal(sampleData.id);
    });

    it('should update into couchbase', async () => {
        const someValueupdate = "some update value"
        const updatedData = await model.updateById(sampleData.id, { ...sampleData, someValue: someValueupdate });
        expect(updatedData.id).to.be.equal(sampleData.id);
        expect(updatedData.someValue).to.be.equal(someValueupdate);
    });

    it('should paginate into couchbase with select', async () => {
        const paginationData = await model.pagination({
            select: ['id', 'password', 'createdAt', 'email', 'phone', 'fullname'],
            where: {
                userId: { $eq: 'ceddy' },
                $or: [{ userId: { $eq: 'ceddy' } }, { phone: 10 }],
            },
            limit: 100,
            page: 0,
        });

        console.log('pagination data', paginationData);
        expect(paginationData).to.be.not.empty;
    });

    it('should paginate into couchbase without select', async () => {
        const paginationData = await model.pagination({
            select: '*',
            where: {
                userId: { $eq: 'ceddy' },
                $or: [{ userId: { $eq: 'ceddy' } }, { phone: 10 }],
            },
            limit: 100,
            page: 0,
        });

        console.log('pagination data', paginationData);
        expect(paginationData).to.be.not.empty;
    });

    it('should create query', async () => {
        const dbName = 'stq';
        const query = new QueryBuilder({}, dbName).select('*').build();

        console.log('query is', query);

        expect(query).to.be.not.null;
    });

    it('should delete into couchbase', async () => {
        const deletedData = await model.delete(sampleData.id);
        expect(deletedData).to.be.equal(true);
    });
});
