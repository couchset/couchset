export type ValidationHook<T = any> = (document: T) => T | void | Promise<T | void>;
export type ParseHook<T = any> = (document: T) => T;

export const applyValidation = async <T>(document: T, hook?: ValidationHook<T>): Promise<T> => {
    if (!hook) {
        return document;
    }

    const result = await hook(document);

    return result === undefined ? document : (result as T);
};

export const schemaFromDateFields = (dateFields?: string[]): Record<string, 'date'> => {
    return (dateFields || []).reduce((schema, field) => {
        schema[field] = 'date';

        return schema;
    }, {} as Record<string, 'date'>);
};

const parseDateValue = (value: any): any => {
    if (value === undefined || value === null || value instanceof Date) {
        return value;
    }

    return new Date(value);
};

export const parseDateFields = <T>(document: T, dateFields?: string[]): T => {
    if (!dateFields || !dateFields.length || !document) {
        return document;
    }

    const cloned: any = {...(document as any)};

    dateFields.forEach((field) => {
        const parts = field.split('.');
        let target = cloned;

        for (let index = 0; index < parts.length - 1; index += 1) {
            const part = parts[index];
            if (!target[part]) {
                return;
            }
            target[part] = {...target[part]};
            target = target[part];
        }

        const leaf = parts[parts.length - 1];
        if (Object.prototype.hasOwnProperty.call(target, leaf)) {
            target[leaf] = parseDateValue(target[leaf]);
        }
    });

    return cloned;
};
