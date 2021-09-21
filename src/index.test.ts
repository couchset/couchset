import 'mocha';
import {expect} from 'chai';
import {couchset, Model, Query} from './index';
import { Field } from 'type-graphql';

before((done) => {
    couchset({
        connectionString: 'couchbase://localhost',
        username: 'admin',
        password: '123456',
        bucketName: 'stq',
    })
        .then((started) => done())
        .catch((error) => {
            console.error(error);
        });
});

let sampleData = null;

class modelType {
    @Field(() => String, {nullable: true });
    id: string = "";
};

const model = new Model('User', {schema: {createdAt: 'date'}, graphqlType: modelType });

describe('CouchSet', () => {
    it('should insert into couchbase', async () => {
        const created = await model.create({
            userId: 'ceddy',
            password: 'i love couchbase',
        });

        console.log('sample data created', JSON.stringify(created));

        sampleData = created;
        expect(created.id).to.not.null;
    });

    it('should get into couchbase', async () => {
        const foundData = await model.findById(sampleData.id);
        expect(foundData.id).to.be.equal(sampleData.id);
    });

    it('should update into couchbase', async () => {
        const updatedData = await model.updateById(sampleData.id, {...sampleData, someValiue: 'x'});
        expect(updatedData.id).to.be.equal(sampleData.id);
    });

    it('should update into couchbase', async () => {
        const id = 'currency';
        const updatedData = await model.updateById(id, {...sampleData, someValiue: 'x'});
        expect(updatedData.id).to.be.equal(id);
    });

    it('should delete into couchbase', async () => {
        const deletedData = await model.delete(sampleData.id);
        expect(deletedData).to.be.equal(true);
    });

    it('should paginate into couchbase', async () => {
        const paginationData = await model.pagination({
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

    it('should paginate into couchbase without select', async () => {
        const paginationData = await model.pagination({
            select: '*',
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

    it('should create query', async () => {
        const dbName = 'stq';
        const query = new Query({}, dbName).select('*').build();

        console.log('query is', query);

        expect(query).to.be.not.null;
    });

    it('should create automate model', async () => {
        
        const { client } = model.automate();

        console.log('client generated is', client);

        expect(client).to.be.not.null;
    });
});
