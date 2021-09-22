import 'reflect-metadata';
import 'mocha';
import {expect} from 'chai';
import {couchset, Model, QueryBuilder, Field, ObjectType} from './index';

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

@ObjectType()
class UserType {
    @Field(() => String, {nullable: true })
    id: string = "";
};

const model = new Model('User', {schema: {createdAt: 'date'}, graphqlType: UserType });

describe('CouchSet', () => {
    it('should create automate model', async () => {
        
        const { client, resolver } = model.automate({ createUpdate: { public: true }});

        console.log('client generated is', client);

        expect(client).to.be.not.null;
    });
});
