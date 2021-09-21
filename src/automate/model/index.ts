/* eslint-disable @typescript-eslint/ban-ts-comment */
import camelCase from 'lodash/camelCase';
import pickBy from 'lodash/pickBy';
import GraphQLJSON from 'graphql-type-json';
import {Model} from '../../model';
import {awaitTo, log} from '../../utils';
import {identity} from 'lodash';
import {
    Field,
    Mutation,
    ObjectType,
    UseMiddleware,
    Arg,
    ClassType,
    Resolver,
    Query,
} from 'type-graphql';
import {isAuth} from '../middlewares';
import {createUpdate, ResType} from '../../shared';
import {generateClient} from './client';

interface PaginationResults {
    items: any[];
    hasNext: boolean;
    params: any;
}

export interface AutomaticModelOptions extends AutomaticMethodOptions {
    model: Model;
}

export interface AutomaticMethodOptions {
    authMiddleware?: any; // authentication middleware

    // Query
    pagination?: {
        public?: boolean;
        method?: (params: any) => Promise<PaginationResults>;
    };

    getById?: {
        public?: boolean;
        matchOwner?: boolean;
        method?: <T>(params: any) => Promise<T & any>;
    };

    // Mutations
    deleteById?: {
        method?: (args: any) => Promise<ResType>;
        matchOwner?: boolean;
    };

    createUpdate?: {
        method?: <T>(args: T) => Promise<ResType>;
    };

    // TODO in the future
    // fragmentMapping
}

/**
 *
 * @param c
 * @returns
 */
export const automateImplementation = <T>(
    ClassModelType: T & ClassType,
    options: AutomaticModelOptions
) => {
    const createUpdateOptions = options?.createUpdate;
    const deleteByIdOptions = options?.deleteById;
    const getByIdOptions = options?.getById;
    const paginationOptions = options?.pagination;

    type ClassModelTYPE = typeof ClassModelType;

    const ClassModel = options.model;
    const name = (ClassModelType as any).name;
    const _type = ClassModel.collectionName;
    const nameCamel = camelCase(name);
    // const nameSNAKE_CASE = toUpper(snakeCase(name));
    const modelKeys: string[] = Object.getOwnPropertyNames(new ClassModelType());

    const authMiddleware = options.authMiddleware || isAuth;

    @ObjectType(`${nameCamel}Pagination`)
    class PaginationClass {
        @Field(() => [ClassModelType], {nullable: true})
        items: [typeof ClassModelType];

        @Field({nullable: true})
        hasNext?: boolean;

        @Field(() => GraphQLJSON, {nullable: true})
        params?: any;
    }
    // return Pagination;

    @Resolver()
    class ResolverClass {
        @Query(() => PaginationClass)
        @UseMiddleware(authMiddleware)
        async [`${nameCamel}Pagination`](
            @Arg('filter', {nullable: true}) filter?: string,
            @Arg('sort', {nullable: true}) sort?: string,
            @Arg('before', {nullable: true}) before?: Date,
            @Arg('after', {nullable: true}) after?: Date,
            @Arg('limit', {nullable: true}) limit = 10
        ): Promise<{
            items: ClassModelTYPE[];
            hasNext: boolean;
            params: any;
        }> {
            const copyParams = pickBy(
                {
                    filter,
                    sort,
                    before,
                    after,
                    limit,
                },
                identity
            );

            try {
                // Apply it from the methods
                if (paginationOptions && paginationOptions.method) {
                    return await paginationOptions.method(copyParams);
                }

                const bucket = ClassModel.getBucketName();

                const query = `
          SELECT ${modelKeys.join(',')}
          FROM \`${bucket}\` ${nameCamel}
          WHERE ${nameCamel}._type = "${_type}"
          LIMIT ${limit};
      `;

                const [errorFetching, data = []] = await awaitTo(
                    ClassModel.customQuery<any>({
                        limit,
                        query,
                        params: copyParams,
                    })
                );

                if (errorFetching) {
                    throw errorFetching;
                }

                const [rows = [], options = {hasNext: false, params: copyParams}] = data;

                const dataToSend = rows.map((d) => {
                    const {chat, attachments, owner} = d;
                    return ClassModel.parse({
                        ...chat,
                        attachments,
                        owner: owner[0] || null,
                    });
                });

                return {items: dataToSend, ...options};
            } catch (error) {
                log(`error paginating ${nameCamel}`, error);
                return {items: [], hasNext: false, params: copyParams};
            }
        }

        @Query(() => ResType)
        @UseMiddleware(authMiddleware)
        async [`${nameCamel}Get`](
            @Arg('id', {nullable: false}) id: string,
            @Arg('owner', {nullable: true}) owner: string
        ): Promise<ResType> {
            try {
                // Apply it from the methods
                if (getByIdOptions && getByIdOptions.method) {
                    return await getByIdOptions.method({id, owner});
                }

                // TODO check if we own this payment method
                const foundDocument = await ClassModel.findById(id);
                if (!foundDocument) {
                    throw new Error(`${nameCamel} not found`);
                }

                return {
                    success: true,
                };
            } catch (error) {
                log(`error finding ${nameCamel}`, error);
                return {success: false, message: error && error.message};
            }
        }

        @Mutation(() => ResType)
        @UseMiddleware(authMiddleware)
        async [`${nameCamel}Delete`](
            @Arg('id', {nullable: false}) id: string,
            @Arg('owner', {nullable: true}) owner: string
        ): Promise<ResType> {
            try {
                // Apply it from the methods
                if (deleteByIdOptions && deleteByIdOptions.method) {
                    return await deleteByIdOptions.method({id, owner});
                }

                // TODO check if we own this payment method
                const deleted = await ClassModel.delete(id);
                if (!deleted) {
                    throw new Error(`${nameCamel} not deleted`);
                }

                return {
                    success: true,
                };
            } catch (error) {
                log(`error deleting ${nameCamel}`, error);
                return {success: false, message: error && error.message};
            }
        }

        @Mutation(() => ResType)
        @UseMiddleware(authMiddleware)
        async [`${nameCamel}Create`](
            // @ts-ignore
            @Arg('args') args: ClassModelType
        ): Promise<ResType> {
            try {
                // Apply it from the methods
                if (createUpdateOptions && createUpdateOptions.method) {
                    return await createUpdateOptions.method(args);
                }

                // If updating
                const createdOrUpdate = await createUpdate({
                    model: ClassModel,
                    data: {
                        ...args,
                    },
                    ...args, // id and owner if it exists
                });

                if (createdOrUpdate) {
                    return {success: true, data: createdOrUpdate};
                }

                throw new Error(`error creating ${nameCamel} method `);
            } catch (err) {
                console.error(err && err.message, err);
                return {success: false, message: err && err.message};
            }
        }
    }

    // GQL
    // { FRAGMENT, GET, DELETE, CREATE, PAGE }
    const client = generateClient({
        name,
        fields: modelKeys,
    });

    return {
        pagination: PaginationClass,
        resolver: ResolverClass,
        modelKeys,
        client,
    };
};
