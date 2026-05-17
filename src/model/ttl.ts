export interface TtlOptions {
    ttl?: string | number;
    ttlSeconds?: number;
    strictTtl?: boolean;
}

const unitSeconds: Record<string, number> = {
    s: 1,
    m: 60,
    h: 60 * 60,
    d: 60 * 60 * 24,
    w: 60 * 60 * 24 * 7,
};

const parseTtlString = (ttl: string, strictTtl?: boolean): number | undefined => {
    const match = ttl.trim().match(/^(\d+)([smhdw])$/i);

    if (!match) {
        if (strictTtl) {
            throw new Error('ttl must include a supported unit: s, m, h, d, or w');
        }

        return undefined;
    }

    const amount = Number(match[1]);
    const unit = match[2].toLowerCase();

    return amount * unitSeconds[unit];
};

export const ttlToSeconds = (ttl: string | number, strictTtl?: boolean): number | undefined => {
    if (typeof ttl === 'number') {
        if (strictTtl) {
            throw new Error('numeric ttl is ambiguous; use ttlSeconds or a unit string');
        }

        return ttl;
    }

    return parseTtlString(ttl, strictTtl);
};

export const applyTtlOptions = <T extends {expiry?: number}>(
    options?: T & TtlOptions
): T | undefined => {
    if (!options) {
        return undefined;
    }

    const {ttl, ttlSeconds, strictTtl, ...sdkOptions} = options as T & TtlOptions;
    const normalizedOptions: any = {...sdkOptions};

    if (typeof ttlSeconds === 'number') {
        normalizedOptions.expiry = ttlSeconds;
    } else if (ttl !== undefined) {
        const expiry = ttlToSeconds(ttl, strictTtl);
        if (typeof expiry === 'number') {
            normalizedOptions.expiry = expiry;
        }
    }

    return normalizedOptions;
};
