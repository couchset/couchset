export const envFlag = (value: string | undefined, fallback: boolean): boolean => {
    if (value === undefined) {
        return fallback;
    }

    return !['0', 'false', 'off', 'no'].includes(value.toLowerCase());
};

export const envNumber = (value: string | undefined, fallback: number): number => {
    const parsed = Number(value);

    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};
