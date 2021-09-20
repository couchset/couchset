export type SchemaTypes = 'string' | 'number' | 'date' | 'object';

const parseValue = (fieldType: SchemaTypes, value: any): any => {
    switch (fieldType) {
        case 'date':
            return new Date(value);
        default:
            return value;
    }
};

/**
 * Convert date strings to data objects
 * @param data
 */
export const parseSchema = (schema: any, iItem: any): any => {
    // Get all schema types and parse with data
    const keys = Object.keys(iItem);

    const finalObject = {};

    keys.forEach((xField) => {
        // check if xField exists
        const xFieldExistsInSchema = schema[xField];

        if (xFieldExistsInSchema) {
            finalObject[xField] = parseValue(xFieldExistsInSchema, iItem[xField]);
        } else {
            finalObject[xField] = iItem[xField];
        }
    });

    return finalObject;
};
