import {ObjectType, Field} from 'type-graphql';
import GraphQLJSON from 'graphql-type-json';
import gql from 'graphql-tag';
import {Model} from '../model';

@ObjectType()
export class CommonType {
    @Field(() => String, {nullable: true})
    id?: string;

    @Field(() => String, {nullable: true})
    env?: string;

    @Field(() => String, {nullable: true})
    owner?: string;

    @Field(() => Date, {nullable: true})
    createdAt?: Date;

    @Field(() => Date, {nullable: true})
    updatedAt?: Date;

    @Field(() => Boolean, {nullable: true})
    deleted?: boolean;
}

export const CommonSchema = {
    id: String,
    env: String,
    owner: String,
    createdAt: Date,
    updatedAt: Date,
    deleted: Boolean,
};

interface CreateUpdate {
    model: Model;
    id?: string;
    owner?: string;
    data: any;
}

export const createUpdate = async <T>(args: CreateUpdate): Promise<T | null> => {
    const {model, id, data} = args;
    try {
        if (id) {
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

/**
 * Creates a [className]Pagination ObjectType
 * @param c class
 * @returns
 */
export const getPagination = <T>(c: T): any => {
    @ObjectType(`${(c as any).name}Pagination`)
    class Pagination {
        @Field(() => [c], {nullable: true})
        items: [typeof c];

        @Field(() => Boolean, {nullable: true})
        hasNext?: boolean;

        @Field(() => GraphQLJSON, {nullable: true})
        params?: any;
    }
    return Pagination;
};

export interface IResType {
    success: boolean;
    message?: string;
    data?: any;
}

export const ResTypeFragment = gql`
    fragment ResTypeFragment on ResType {
        success
        message
        data
    }
`;
