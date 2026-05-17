import 'mocha';

import {expect} from 'chai';

import CouchbaseConnection from '../connection';

import {Model} from './index';

describe('Model validation and hydrated documents', () => {
    let documents: Record<string, any>;
    let calls: Array<{method: string; key?: string; value?: any; specs?: any[]}>;

    beforeEach(() => {
        documents = {};
        calls = [];
        CouchbaseConnection.Instance.bucketName = 'test';
        CouchbaseConnection.Instance.bucket = {
            defaultCollection: () => ({
                upsert: async (key: string, value: any) => {
                    calls.push({method: 'upsert', key, value});
                    documents[key] = value;
                },
                insert: async (key: string, value: any) => {
                    calls.push({method: 'insert', key, value});
                    documents[key] = value;
                },
                replace: async (key: string, value: any) => {
                    calls.push({method: 'replace', key, value});
                    documents[key] = value;
                },
                mutateIn: async (key: string, specs: any[]) => {
                    calls.push({method: 'mutateIn', key, specs});
                    documents[key] = {
                        ...(documents[key] || {id: key, _type: 'User', _scope: '_default'}),
                        patched: true,
                        updatedAt: '2026-05-17T22:10:00.000Z',
                    };
                },
                get: async (key: string) => ({content: documents[key]}),
                remove: async (key: string) => {
                    calls.push({method: 'remove', key});
                    delete documents[key];
                },
            }),
        } as any;
        CouchbaseConnection.Instance.cluster = {
            query: async () => ({
                rows: [
                    {
                        test: documents['user-1'],
                    },
                ],
            }),
        } as any;
    });

    it('runs validation hooks and uses transformed documents', async () => {
        const model = new Model('User', {
            validateCreate: (doc) => ({...doc, createdValidated: true}),
            validateUpdate: (doc) => ({...doc, updateValidated: true}),
            validateReplace: (doc) => ({...doc, replaceValidated: true}),
        });

        const created = await model.create({id: 'user-1', userId: 'ceddy'});
        const inserted = await model.insert({id: 'user-2', userId: 'ceddy'});
        const updated = await model.updateById('user-1', created);
        const replaced = await model.replaceById('user-1', created);

        expect(created.createdValidated).to.equal(true);
        expect(inserted.createdValidated).to.equal(true);
        expect(updated.updateValidated).to.equal(true);
        expect(replaced.replaceValidated).to.equal(true);
        expect(documents['user-1'].replaceValidated).to.equal(true);
    });

    it('supports custom parse hooks and nested date fields', async () => {
        const model = new Model('User', {
            dateFields: ['profile.birthDate'],
            parse: (doc) => ({...doc, parsed: true}),
        });

        documents['user-1'] = {
            id: 'user-1',
            profile: {birthDate: '2020-01-01T00:00:00.000Z'},
            _type: 'User',
            _scope: '_default',
        };

        const found = await model.findById('user-1');

        expect(found.profile.birthDate).to.be.instanceOf(Date);
        expect(found.parsed).to.equal(true);
    });

    it('findDocById returns a hydrated document with clean JSON', async () => {
        const model = new Model('User', {schema: {createdAt: 'date'}});
        documents['user-1'] = {
            id: 'user-1',
            userId: 'ceddy',
            createdAt: '2026-05-17T22:00:00.000Z',
            _type: 'User',
            _scope: '_default',
        };

        const doc = await model.findDocById('user-1');

        expect(doc.userId).to.equal('ceddy');
        expect(doc.createdAt).to.be.instanceOf(Date);
        expect(doc.toJSON()).to.not.have.property('__model');
        expect(JSON.parse(JSON.stringify(doc))).to.deep.include({id: 'user-1', userId: 'ceddy'});
    });

    it('findDocOne hydrates query results', async () => {
        const model = new Model('User');
        documents['user-1'] = {
            id: 'user-1',
            userId: 'ceddy',
            _type: 'User',
            _scope: '_default',
        };

        const doc = await model.findDocOne({where: {userId: 'ceddy'}});

        expect(doc?.id).to.equal('user-1');
        expect(doc?.toJSON()).to.deep.include({id: 'user-1', userId: 'ceddy'});
    });

    it('hydrated documents can save, patch, reload, and delete', async () => {
        const model = new Model('User');
        documents['user-1'] = {
            id: 'user-1',
            userId: 'ceddy',
            fullname: 'Old',
            _type: 'User',
            _scope: '_default',
        };

        const doc = await model.findDocById('user-1');
        doc.fullname = 'New';
        await doc.save();

        expect(calls[0].method).to.equal('replace');
        expect(doc.fullname).to.equal('New');

        await doc.patch({$set: {patched: true}});
        expect(calls[1].method).to.equal('mutateIn');
        expect(doc.patched).to.equal(true);

        documents['user-1'].fullname = 'Reloaded';
        await doc.reload();
        expect(doc.fullname).to.equal('Reloaded');

        await doc.delete({hard: true});
        expect(calls[calls.length - 1].method).to.equal('remove');
    });
});
