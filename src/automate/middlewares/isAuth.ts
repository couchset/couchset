import {verify} from 'jsonwebtoken';
import {MiddlewareFn} from 'type-graphql';
import {isEmpty, get as _get} from 'lodash';

import {ContextType} from '../../shared';

/**
 * Default isAuth middleware
 * @returns
 */
export const isAuth: MiddlewareFn<ContextType> = (args, next) => {
    const context: any = (args && args.context) || {};
    const authorization = _get(context, 'req.headers.authorization', '');

    if (isEmpty(authorization)) {
        throw new Error('Not Authenticated');
    }

    try {
        const token = authorization.split(' ')[1];
        const verified = verify(token, process.env.ACCESS_TOKEN_SECRET!);
        context.payload = verified as any;
    } catch (err) {
        console.log('not authenticated');
        throw new Error('not authenticated');
    }

    return next();
};

export default isAuth;
