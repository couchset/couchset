export interface ModelKeyStrategy<T> {
    create: (document: T) => string;
    parse?: (id: string) => unknown;
    explicitId?: 'allow' | 'validate' | 'reject';
}

/** Only called when a consumer explicitly configures a key strategy. */
export const resolveModelKey = <T>(strategy: ModelKeyStrategy<T>, data: T): string => {
    const policy = strategy.explicitId || 'allow';
    if (['allow', 'validate', 'reject'].indexOf(policy) < 0)
        throw new Error('Unknown explicitId policy');
    const explicit = (data as any)?.id;
    if (explicit !== undefined) {
        if (policy === 'reject')
            throw new Error('Explicit document IDs are disabled for this model');
        if (policy === 'allow') return explicit;
        if (!strategy.parse) throw new Error('Key validation requires a parse function');
        if (typeof explicit !== 'string' || !explicit.length)
            throw new Error('Document key must be a nonempty string');
        const parsed = strategy.parse(explicit);
        if (parsed === false || parsed === null || parsed === undefined || (parsed as any)?.then) {
            throw new Error('Key parse must synchronously return a valid result');
        }
        return explicit;
    }
    const key = strategy.create(data);
    if (typeof key !== 'string' || !key.length)
        throw new Error('Key strategy must return a nonempty string');
    return key;
};
