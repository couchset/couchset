import 'mocha';

import {expect} from 'chai';

import CouchbaseConnection from '../connection';

import {Model} from './index';

describe('Model write helpers', () => {
    const model = new Model('User', {schema: {createdAt: 'date', updatedAt: 'date'}});
    let documents: Record<string, any>;
    let calls: Array<{method: string; key?: string; value?: any; specs?: any[]; options?: any}>;

    beforeEach(() => {
        documents = {};
        calls = [];
        CouchbaseConnection.Instance.bucketName = 'test';
        CouchbaseConnection.Instance.bucket = {
            defaultCollection: () => ({
                insert: async (key: string, value: any, options?: any) => {
                    calls.push({method: 'insert', key, value, options});
                    if (documents[key]) {
                        throw new Error('document exists');
                    }
                    documents[key] = value;
                },
                upsert: async (key: string, value: any, options?: any) => {
                    calls.push({method: 'upsert', key, value, options});
                    documents[key] = value;
                },
                replace: async (key: string, value: any, options?: any) => {
                    calls.push({method: 'replace', key, value, options});
                    documents[key] = value;
                },
                mutateIn: async (key: string, specs: any[], options?: any) => {
                    calls.push({method: 'mutateIn', key, specs, options});
                    documents[key] = {
                        ...(documents[key] || {id: key, _type: 'User', _scope: '_default'}),
                        patched: true,
                        updatedAt: '2026-05-17T22:00:00.000Z',
                    };
                },
                get: async (key: string) => ({
                    content: documents[key],
                    cas: 'cas-value',
                    expiryTime: new Date('2026-05-18T00:00:00.000Z'),
                }),
            }),
        } as any;
    });

    it('insert uses collection.insert and fails when the id already exists', async () => {
        const inserted = await model.insert({id: 'user-1', userId: 'ceddy'});

        expect(calls[0].method).to.equal('insert');
        expect(calls[0].key).to.equal('user-1');
        expect(inserted).to.deep.include({
            id: 'user-1',
            userId: 'ceddy',
            _type: 'User',
            _scope: '_default',
        });

        try {
            await model.insert({id: 'user-1', userId: 'duplicate'});
            throw new Error('expected insert to fail');
        } catch (error) {
            expect((error as Error).message).to.equal('document exists');
        }
    });

    it('upsert uses collection.upsert explicitly', async () => {
        const upserted = await model.upsert({id: 'user-1', userId: 'ceddy'});

        expect(calls[0].method).to.equal('upsert');
        expect(calls[0].key).to.equal('user-1');
        expect(upserted.id).to.equal('user-1');
    });

    it('replaceById performs a full replace and honors silent timestamps', async () => {
        const replaced = await model.replaceById(
            'user-1',
            {userId: 'ceddy', updatedAt: new Date('2020-01-01T00:00:00.000Z')},
            {silent: true}
        );

        expect(calls[0].method).to.equal('replace');
        expect(calls[0].key).to.equal('user-1');
        expect(replaced.id).to.equal('user-1');
        expect(replaced.updatedAt.toISOString()).to.equal('2020-01-01T00:00:00.000Z');
    });

    it('patchById uses subdocument specs and returns the patched document', async () => {
        documents['user-1'] = {id: 'user-1', userId: 'ceddy', _type: 'User', _scope: '_default'};

        const patched = await model.patchById('user-1', {
            $set: {fullname: 'Ceddy'},
            $unset: ['oldField'],
            $inc: {loginCount: 1},
        });

        expect(calls[0].method).to.equal('mutateIn');
        expect(calls[0].specs.map((spec) => spec._path)).to.deep.equal([
            'fullname',
            'oldField',
            'loginCount',
            'updatedAt',
        ]);
        expect(patched.patched).to.equal(true);
        expect(patched.updatedAt).to.be.instanceOf(Date);
    });

    it('mutateById is a raw subdocument mutation escape hatch', async () => {
        const specs = [{_path: 'custom'}];

        await model.mutateById('user-1', specs, {timeout: 1000});

        expect(calls[0]).to.deep.include({
            method: 'mutateIn',
            key: 'user-1',
            specs,
            options: {timeout: 1000},
        });
    });

    it('mutateById rejects empty specs before calling the SDK', async () => {
        try {
            await model.mutateById('user-1', []);
            throw new Error('expected mutateById to reject');
        } catch (error) {
            expect((error as Error).message).to.equal(
                'mutateById requires at least one mutation spec'
            );
        }

        expect(calls).to.deep.equal([]);
    });

    it('incrementById uses an atomic increment spec', async () => {
        documents['user-1'] = {id: 'user-1', userId: 'ceddy', _type: 'User', _scope: '_default'};

        await model.incrementById('user-1', 'loginCount', 2);

        expect(calls[0].method).to.equal('mutateIn');
        expect(calls[0].specs.map((spec) => spec._path)).to.deep.equal([
            'loginCount',
            'updatedAt',
        ]);
    });

    it('findByIdWithMeta returns parsed content and SDK metadata', async () => {
        documents['user-1'] = {
            id: 'user-1',
            userId: 'ceddy',
            createdAt: '2026-05-17T22:00:00.000Z',
            _type: 'User',
            _scope: '_default',
        };

        const found = await model.findByIdWithMeta('user-1');

        expect(found.content.createdAt).to.be.instanceOf(Date);
        expect(found.cas).to.equal('cas-value');
        expect(found.expiryTime?.toISOString()).to.equal('2026-05-18T00:00:00.000Z');
    });
});
