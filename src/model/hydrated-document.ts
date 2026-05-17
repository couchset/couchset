import type {MutateInOptions, RemoveOptions, ReplaceOptions} from 'couchbase';

import type {PatchByIdArgs} from './write-helpers';

import type {AutoModelFields, DeleteByIdOptions, UpdateOptions} from './index';

export interface HydratedModel<T> {
    findById(id: string): Promise<T & AutoModelFields>;
    replaceById(id: string, data: T, options?: UpdateOptions): Promise<T & AutoModelFields>;
    patchById(
        id: string,
        patch: PatchByIdArgs,
        options?: MutateInOptions
    ): Promise<T & AutoModelFields>;
    deleteById(id: string, options?: DeleteByIdOptions): Promise<boolean | (T & AutoModelFields)>;
    delete(id: string, options?: RemoveOptions): Promise<boolean>;
}

export type HydratedDocumentData<T> = T & AutoModelFields;

export class HydratedDocument<T extends {id: string} = any> {
    private readonly __model: HydratedModel<T>;

    constructor(model: HydratedModel<T>, data: HydratedDocumentData<T>) {
        Object.defineProperty(this, '__model', {
            value: model,
            enumerable: false,
        });

        Object.assign(this, data);
    }

    public async save(options?: ReplaceOptions & {validate?: boolean; cas?: any}): Promise<this> {
        const data = this.toJSON() as T & {id: string};
        const saved = await this.__model.replaceById(data.id, data, options as UpdateOptions);
        Object.assign(this, saved);

        return this;
    }

    public async patch(patch: PatchByIdArgs, options?: MutateInOptions): Promise<this> {
        const data = this.toJSON() as T & {id: string};
        const patched = await this.__model.patchById(data.id, patch, options);
        Object.assign(this, patched);

        return this;
    }

    public async reload(): Promise<this> {
        const data = this.toJSON() as T & {id: string};
        const reloaded = await this.__model.findById(data.id);
        Object.assign(this, reloaded);

        return this;
    }

    public async delete(options?: DeleteByIdOptions): Promise<boolean | (T & AutoModelFields)> {
        const data = this.toJSON() as T & {id: string};

        return this.__model.deleteById(data.id, options);
    }

    public toJSON(): HydratedDocumentData<T> {
        const json: any = {};

        Object.keys(this).forEach((key) => {
            json[key] = this[key];
        });

        return json;
    }
}

export type Hydrated<T extends {id: string} = any> = HydratedDocument<T> & HydratedDocumentData<T>;

export const hydrate = <T extends {id: string}>(
    model: HydratedModel<T>,
    data: HydratedDocumentData<T>
): Hydrated<T> => new HydratedDocument<T>(model, data) as Hydrated<T>;
