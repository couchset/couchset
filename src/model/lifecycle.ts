export interface ModelHookContext {
    operation: string;
    /** Transaction hooks run inside a retryable attempt, never after commit. */
    transaction: boolean;
}
export interface ModelHooks<T> {
    beforeInsert?: (data: T, context: ModelHookContext) => T | Promise<T>;
    afterInsert?: (data: T, context: ModelHookContext) => void | Promise<void>;
    beforeUpsert?: (data: T, context: ModelHookContext) => T | Promise<T>;
    afterUpsert?: (data: T, context: ModelHookContext) => void | Promise<void>;
    beforeReplace?: (data: T, context: ModelHookContext) => T | Promise<T>;
    afterReplace?: (data: T, context: ModelHookContext) => void | Promise<void>;
    beforePatch?: (
        patch: import('./write-helpers').PatchByIdArgs,
        context: ModelHookContext
    ) => import('./write-helpers').PatchByIdArgs | Promise<import('./write-helpers').PatchByIdArgs>;
    afterPatch?: (data: T, context: ModelHookContext) => void | Promise<void>;
    beforeDelete?: (id: string, context: ModelHookContext) => void | Promise<void>;
    afterDelete?: (id: string, context: ModelHookContext) => void | Promise<void>;
    afterRead?: (data: Partial<T>, context: ModelHookContext) => void | Promise<void>;
}

export class ModelAfterHookError extends Error {
    constructor(readonly cause: unknown, readonly context: ModelHookContext) {
        super(
            `After hook failed for ${context.operation}; ${
                context.transaction
                    ? 'transaction attempt may roll back'
                    : 'operation already succeeded'
            }`
        );
        this.name = 'ModelAfterHookError';
        Object.setPrototypeOf(this, ModelAfterHookError.prototype);
    }
}

/** Internal: attach only to a freshly client-owned model or transaction model. */
export const attachModelHooks = <M extends object>(
    model: M,
    hooks?: ModelHooks<any>,
    transaction = false
): M => {
    if (!hooks || !Object.keys(hooks).length) return model;
    const rules: Array<[string, string, number]> = transaction
        ? [
              ['insert', 'Insert', 1],
              ['replace', 'Replace', 1],
              ['remove', 'Delete', 0],
          ]
        : [
              ['insert', 'Insert', 0],
              ['upsert', 'Upsert', 0],
              ['replaceById', 'Replace', 1],
              ['patchById', 'Patch', 1],
              ['deleteById', 'Delete', 0],
          ];
    for (const [method, phase, position] of rules) {
        const before = hooks[`before${phase}`];
        const after = hooks[`after${phase}`];
        if (!before && !after) continue;
        const original = (model as any)[method];
        Object.defineProperty(model, method, {
            configurable: true,
            value: async function (...args: any[]) {
                const context = {operation: method, transaction};
                const id = transaction && phase === 'Delete' ? args[0].content.id : args[0];
                if (before) {
                    if (phase === 'Delete') await before(id, context);
                    else args[position] = await before(args[position], context);
                }
                const result = await original.apply(this, args);
                if (after) {
                    try {
                        await after(
                            phase === 'Delete' ? id : transaction ? result.content : result,
                            context
                        );
                    } catch (error) {
                        throw new ModelAfterHookError(error, context);
                    }
                }
                return result;
            },
        });
    }
    if (hooks.afterRead) {
        for (const method of transaction
            ? ['get']
            : ['getById', 'findByIdWithMeta', 'findMany', 'findOne', 'page']) {
            const original = (model as any)[method];
            Object.defineProperty(model, method, {
                configurable: true,
                value: async function (...args: any[]) {
                    const result = await original.apply(this, args);
                    const rows =
                        result == null
                            ? []
                            : method === 'findMany'
                            ? result
                            : method === 'page'
                            ? result.items
                            : [
                                  transaction || method === 'findByIdWithMeta'
                                      ? result.content
                                      : result,
                              ];
                    try {
                        for (const row of rows)
                            await hooks.afterRead(row, {operation: method, transaction});
                    } catch (error) {
                        throw new ModelAfterHookError(error, {operation: method, transaction});
                    }
                    return result;
                },
            });
        }
    }
    if (!transaction)
        for (const method of ['withDeleted', 'onlyDeleted', 'withoutDefaultWhere']) {
            const original = (model as any)[method];
            Object.defineProperty(model, method, {
                configurable: true,
                value: function () {
                    return attachModelHooks(original.call(this), hooks);
                },
            });
        }
    return model;
};
