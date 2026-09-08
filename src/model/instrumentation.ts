export interface ModelOperationEvent {
    model: string;
    operation: string;
    durationMs: number;
    outcome: 'success' | 'failure';
}
export interface ModelInstrumentation {
    onRetry?: (event: {operation: 'transaction'; attempt: number}) => void | Promise<void>;
    onOperation?: (event: ModelOperationEvent) => void | Promise<void>;
    onQuery?: (event: ModelOperationEvent) => void | Promise<void>;
    onMutation?: (event: ModelOperationEvent) => void | Promise<void>;
    onSlowOperation?: (event: ModelOperationEvent) => void | Promise<void>;
    slowOperationMs?: number;
}
const observe = (
    callback: ((event: ModelOperationEvent) => void | Promise<void>) | undefined,
    event: ModelOperationEvent
): void => {
    if (!callback) return;
    try {
        Promise.resolve(callback({...event})).catch(() => {});
    } catch (_) {
        /* observers cannot affect operations */
    }
};

export const attachModelInstrumentation = <M extends object>(
    model: M,
    name: string,
    options?: ModelInstrumentation
): M => {
    if (!options) return model;
    const reads = [
        'getById',
        'findByIdWithMeta',
        'findMany',
        'findOne',
        'page',
        'exists',
        'count',
        'queryRows',
        'queryOne',
        'queryPage',
    ];
    const writes = [
        'insert',
        'upsert',
        'replaceById',
        'patchById',
        'mutateById',
        'incrementById',
        'deleteById',
        'consumeOnce',
    ];
    for (const operation of [...reads, ...writes]) {
        const original = (model as any)[operation];
        Object.defineProperty(model, operation, {
            configurable: true,
            value: async function (...args: any[]) {
                const start = Date.now();
                let outcome: 'success' | 'failure' = 'success';
                try {
                    return await original.apply(this, args);
                } catch (error) {
                    outcome = 'failure';
                    throw error;
                } finally {
                    const event = {model: name, operation, durationMs: Date.now() - start, outcome};
                    observe(options.onOperation, event);
                    observe(
                        reads.includes(operation) ? options.onQuery : options.onMutation,
                        event
                    );
                    if (
                        event.durationMs >=
                        (options.slowOperationMs === undefined ? 1000 : options.slowOperationMs)
                    )
                        observe(options.onSlowOperation, event);
                }
            },
        });
    }
    for (const method of ['withDeleted', 'onlyDeleted', 'withoutDefaultWhere']) {
        const original = (model as any)[method];
        Object.defineProperty(model, method, {
            configurable: true,
            value: function () {
                return attachModelInstrumentation(original.call(this), name, options);
            },
        });
    }
    return model;
};
