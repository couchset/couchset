import type {TypedModel, ModelCreateInput} from '../next';

import {withModelMethods} from './extensions';

export interface BulkOptions {
    concurrency?: number;
    ordered?: boolean;
}
export type BulkItem<R> =
    | {index: number; status: 'fulfilled'; value: R}
    | {index: number; status: 'rejected'; error: unknown}
    | {index: number; status: 'skipped'};

/** Ordered means serial/fail-fast; unordered completes all items with bounded concurrency. */
export const bulkMap = async <T, R>(
    inputs: readonly T[],
    operation: (input: T, index: number) => Promise<R>,
    options: BulkOptions = {}
): Promise<BulkItem<R>[]> => {
    const requested = options.concurrency === undefined ? 8 : options.concurrency;
    if (!Number.isSafeInteger(requested) || requested < 1)
        throw new Error('Bulk concurrency must be a positive integer');
    const results: BulkItem<R>[] = inputs.map((_, index) => ({index, status: 'skipped'}));
    let next = 0;
    let stopped = false;
    const run = async () => {
        while (!stopped && next < inputs.length) {
            const index = next++;
            try {
                results[index] = {
                    index,
                    status: 'fulfilled',
                    value: await operation(inputs[index], index),
                };
            } catch (error) {
                results[index] = {index, status: 'rejected', error};
                if (options.ordered !== false) stopped = true;
            }
        }
    };
    await Promise.all(
        Array.from(
            {length: Math.min(inputs.length, options.ordered === false ? requested : 1)},
            run
        )
    );
    return results;
};

export const withModelBulk = <T>(model: TypedModel<T>) =>
    withModelMethods(model, {
        insertMany: (records: readonly ModelCreateInput<T>[], options?: BulkOptions) =>
            bulkMap(records, (record) => model.insert(record), options),
        getMany: (ids: readonly string[], options?: BulkOptions) =>
            bulkMap(ids, (id) => model.getWithCas(id), options),
        deleteMany: (ids: readonly string[], options?: BulkOptions) =>
            bulkMap(ids, (id) => model.deleteById(id), options),
    });
