import {MiddlewareFn} from 'type-graphql';

import {ContextType} from '../../shared';

/**s
 * Default isAuth middleware
 * @returns
 */
export const blankMiddleware: MiddlewareFn<ContextType> | MiddlewareFn<void> = ({}, next) => {
    if (next) {
        return next();
    }
    return null;
};

export default blankMiddleware;
