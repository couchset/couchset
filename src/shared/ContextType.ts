import {Request, Response} from 'express';
import {ObjectType, Field, InputType} from 'type-graphql';
import GraphQLJSON from 'graphql-type-json';
import {RedisPubSub} from 'graphql-redis-subscriptions';
export interface ContextType {
    req: Request;
    res: Response;
    payload?: any;
    pubsub: RedisPubSub;
}

/**
 * GraphQL Types start
 */

/**
 * ResType
 */
@ObjectType()
export class ResType {
    @Field(() => Boolean)
    success: boolean;

    @Field(() => String, {nullable: true})
    message?: string;

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    @Field((type) => GraphQLJSON, {nullable: true})
    data?: any;
}

@InputType('GeoTypeInput')
@ObjectType()
export class GeoType {
    @Field(() => Number, {nullable: true})
    lat: number;

    @Field(() => Number, {nullable: true})
    lon: number;
}

export interface GeoLocationType {
    lat: number;
    lon: number;
}
