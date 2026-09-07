import type {ModelDefinition} from '../next';

export type ModelPluginContribution<T> = Omit<
    ModelDefinition<T>,
    'name' | 'plugins' | 'scope' | 'collection'
>;
export type ModelPlugin<T> = (
    definition: Readonly<ModelDefinition<T>>
) => ModelPluginContribution<T>;

/** Plugins contribute options locally; they never mutate a model or perform DDL. */
export const defineModelPlugin = <T>(plugin: ModelPlugin<T>): ModelPlugin<T> => {
    if (typeof plugin !== 'function') throw new Error('Model plugin must be a function');
    return plugin;
};

const plain = (value: any): boolean =>
    !!value &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

// Copy only declarative data. Functions retain identity so equivalent registrations
// continue to compare correctly. Cycles and mutable class instances are rejected.
const copy = (value: any, ancestors: any[] = []): any => {
    if (!value || typeof value !== 'object') return value;
    if (!Array.isArray(value) && !plain(value)) {
        throw new Error('Plugin definitions must contain plain objects, arrays, or functions');
    }
    if (ancestors.indexOf(value) >= 0) throw new Error('Cyclic plugin definition');
    const next = ancestors.concat([value]);
    if (Array.isArray(value)) return value.map((item) => copy(item, next));
    const result: any = {};
    Object.keys(value).forEach((key) => {
        Object.defineProperty(result, key, {
            value: copy(value[key], next),
            enumerable: true,
            writable: true,
            configurable: true,
        });
    });
    return result;
};

const freeze = (value: any): any => {
    if (value && typeof value === 'object') {
        Object.keys(value).forEach((key) => freeze(value[key]));
        Object.freeze(value);
    }
    return value;
};

const equal = (left: any, right: any): boolean => {
    if (left === right) return true;
    if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
    if (Array.isArray(left) !== Array.isArray(right)) return false;
    const keys = Object.keys(left);
    return (
        keys.length === Object.keys(right).length &&
        keys.every(
            (key) =>
                Object.prototype.hasOwnProperty.call(right, key) && equal(left[key], right[key])
        )
    );
};

const conflict = (path: string): never => {
    throw new Error(`Conflicting model plugin contribution: ${path}`);
};

export const composeModelPlugins = <T>(definition: ModelDefinition<T>): ModelDefinition<T> => {
    if (!definition.plugins?.length) return {...definition};
    const {plugins, ...base} = definition;
    const result: any = copy(base);
    const maps = ['schema', 'codecs', 'collectionSettings'];
    for (const plugin of plugins) {
        if (typeof plugin !== 'function') throw new Error('Model plugin must be a function');
        const contribution: any = plugin(freeze(copy(result)));
        if (!plain(contribution))
            throw new Error('Model plugin must return a synchronous options object');
        for (const key of Object.keys(contribution)) {
            if (key === 'name' || key === 'plugins' || key === 'scope' || key === 'collection') {
                throw new Error(
                    `Model plugins cannot set ${key}; declare the model target explicitly`
                );
            }
            const value = copy(contribution[key]);
            if (value === undefined) continue;
            if (key === 'indexes') {
                if (!Array.isArray(value)) throw new Error('Plugin indexes must be an array');
                result.indexes = result.indexes || [];
                for (const index of value) {
                    if (!plain(index) || !index.name)
                        throw new Error('Plugin indexes require a name');
                    const existing = result.indexes.find((entry: any) => entry.name === index.name);
                    if (existing && !equal(existing, index)) conflict(`indexes.${index.name}`);
                    if (!existing) result.indexes.push(index);
                }
            } else if (key === 'dateFields') {
                if (!Array.isArray(value) || value.some((field) => typeof field !== 'string')) {
                    throw new Error('Plugin dateFields must be strings');
                }
                result.dateFields = Array.from(new Set([...(result.dateFields || []), ...value]));
            } else if (maps.indexOf(key) >= 0) {
                if (!plain(value)) throw new Error(`Plugin ${key} must be an object`);
                const merged = {...result[key]};
                for (const field of Object.keys(value)) {
                    if (
                        Object.prototype.hasOwnProperty.call(merged, field) &&
                        !equal(merged[field], value[field])
                    )
                        conflict(`${key}.${field}`);
                    Object.defineProperty(merged, field, {
                        value: value[field],
                        enumerable: true,
                        writable: true,
                        configurable: true,
                    });
                }
                result[key] = merged;
            } else {
                if (Object.prototype.hasOwnProperty.call(result, key) && !equal(result[key], value))
                    conflict(key);
                Object.defineProperty(result, key, {
                    value,
                    enumerable: true,
                    writable: true,
                    configurable: true,
                });
            }
        }
    }
    return result;
};
