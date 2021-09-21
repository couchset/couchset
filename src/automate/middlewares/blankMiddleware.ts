import {MiddlewareFn} from 'type-graphql';

import {ContextType} from '../../shared';

/**s
 * Default isAuth middleware
 * @returns
 */
export const blankMiddleware: MiddlewareFn<ContextType> | MiddlewareFn<void> = (_args, next) => {
    return next ? next() : (() => {})();
};

export default blankMiddleware;
