import isEmpty from 'lodash/isEmpty';
import pickBy from 'lodash/pickBy';
import identity from 'lodash/identity';

import {Model} from '../model';

interface CreateUpdate {
    model: Model;
    id?: string;
    owner?: string;
    data: any;
}

export const createUpdate = async <T>(args: CreateUpdate): Promise<T | null> => {
    const {model, id} = args;
    const data: any = pickBy(args.data, identity);

    try {
        if (!isEmpty(id)) {
            // update
            await model.updateById(id, data);
            return data;
        }
        // create
        const createdItem = await model.create(data);
        return createdItem;
    } catch (error) {
        console.error(`error creating for ${model.collectionName}`, error);
        return null;
    }
};
