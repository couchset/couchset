import {MiddlewareFn} from 'type-graphql';

import {ContextType} from '../../shared';

/**s
 * Default isAuth middleware
 * @returns
 */
export const blankMiddleware: MiddlewareFn<ContextType> = (args, next) => {
    return next();
};

export default blankMiddleware;
