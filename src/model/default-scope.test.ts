import 'mocha';

import {expect} from 'chai';

import CouchbaseConnection from '../connection';

import {Model} from './index';

describe('Model default scopes and soft delete', () => {
    let calls: Array<{method?: string; query?: string; options?: any; specs?: any[]; key?: string}>;
    let documents: Record<string, any>;

    beforeEach(() => {
        calls = [];
        documents = {
            'user-1': {id: 'user-1', userId: 'ceddy', _type: 'User', _scope: '_default'},
        };
        CouchbaseConnection.Instance.bucketName = 'test';
        CouchbaseConnection.Instance.bucket = {
            defaultCollection: () => ({
                mutateIn: async (key: string, specs: any[], options?: any) => {
                    calls.push({method: 'mutateIn', key, specs, options});
                    documents[key] = {
                        ...(documents[key] || {id: key, _type: 'User', _scope: '_default'}),
                        updatedAt: '2026-05-17T22:00:00.000Z',
                    };
                },
                get: async (key: string) => ({content: documents[key]}),
                remove: async (key: string, options?: any) => {
                    calls.push({method: 'remove', key, options});
                    delete documents[key];
                },
            }),
        } as any;
        CouchbaseConnection.Instance.cluster = {
            query: async (query: string, options?: any) => {
                calls.push({query, options});
                return {rows: []};
            },
        } as any;
    });

    it('applies soft-delete defaultWhere to new read helpers', async () => {
        const model = new Model('User', {softDelete: true});

        await model.findMany({where: {userId: 'ceddy'}, limit: 1});

        expect(calls[0].query).to.equal(
            'SELECT * FROM `test` WHERE (_type=$cs_param_0 AND (deleted IS MISSING AND userId=$cs_param_1)) LIMIT $cs_limit OFFSET $cs_offset'
        );
    });

    it('withDeleted removes the default soft-delete filter', async () => {
        const model = new Model('User', {softDelete: true}).withDeleted();

        await model.findMany({where: {userId: 'ceddy'}, limit: 1});

        expect(calls[0].query).to.equal(
            'SELECT * FROM `test` WHERE (_type=$cs_param_0 AND userId=$cs_param_1) LIMIT $cs_limit OFFSET $cs_offset'
        );
    });

    it('onlyDeleted filters to soft-deleted documents', async () => {
        const model = new Model('User', {softDelete: true}).onlyDeleted();

        await model.findMany({where: {userId: 'ceddy'}, limit: 1});

        expect(calls[0].query).to.equal(
            'SELECT * FROM `test` WHERE (_type=$cs_param_0 AND (deleted=$cs_param_1 AND userId=$cs_param_2)) LIMIT $cs_limit OFFSET $cs_offset'
        );
        expect(calls[0].options.parameters).to.deep.include({cs_param_1: true});
    });

    it('supports custom defaultWhere and withoutDefaultWhere', async () => {
        const model = new Model('User', {
            defaultWhere: {workspaceId: {$eq: 'workspace-1'}},
        });

        await model.findMany({where: {userId: 'ceddy'}, limit: 1});
        expect(calls[0].query).to.equal(
            'SELECT * FROM `test` WHERE (_type=$cs_param_0 AND (workspaceId=$cs_param_1 AND userId=$cs_param_2)) LIMIT $cs_limit OFFSET $cs_offset'
        );

        calls = [];
        await model.withoutDefaultWhere().findMany({where: {userId: 'ceddy'}, limit: 1});
        expect(calls[0].query).to.equal(
            'SELECT * FROM `test` WHERE (_type=$cs_param_0 AND userId=$cs_param_1) LIMIT $cs_limit OFFSET $cs_offset'
        );
    });

    it('softDeleteById marks the document as deleted', async () => {
        const model = new Model('User', {softDelete: true});

        await model.softDeleteById('user-1');

        expect(calls[0].method).to.equal('mutateIn');
        expect(calls[0].specs.map((spec) => spec._path)).to.deep.equal([
            'deleted',
            'deletedAt',
            'updatedAt',
        ]);
    });

    it('restoreById removes soft-delete fields', async () => {
        const model = new Model('User', {softDelete: true});

        await model.restoreById('user-1');

        expect(calls[0].method).to.equal('mutateIn');
        expect(calls[0].specs.map((spec) => spec._path)).to.deep.equal([
            'deleted',
            'deletedAt',
            'updatedAt',
        ]);
    });

    it('deleteById soft-deletes by default and hard-deletes when requested', async () => {
        const model = new Model('User', {softDelete: true});

        await model.deleteById('user-1');
        expect(calls[0].method).to.equal('mutateIn');

        await model.deleteById('user-1', {hard: true});
        expect(calls[1].method).to.equal('remove');
    });
});
