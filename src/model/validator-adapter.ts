import type {ModelPlugin} from './plugins';

export interface StandardModelSchema<T> {
    readonly '~standard': {
        readonly version: 1;
        readonly vendor: string;
        readonly validate: (
            value: unknown
        ) =>
            | {value: T; issues?: undefined}
            | {issues: readonly {message: string; path?: readonly unknown[]}[]}
            | Promise<
                  | {value: T; issues?: undefined}
                  | {issues: readonly {message: string; path?: readonly unknown[]}[]}
              >;
    };
}

export class ModelValidationError extends Error {
    constructor(readonly issues: readonly {message: string; path?: readonly unknown[]}[]) {
        super(issues.map((issue) => issue.message).join('; '));
        this.name = 'ModelValidationError';
        Object.setPrototypeOf(this, ModelValidationError.prototype);
    }
}

/** Bridge a Standard Schema validator into existing create/replace hooks. */
export const withModelValidator = <T>(schema: StandardModelSchema<T>): ModelPlugin<T> => {
    if (schema['~standard']?.version !== 1 || typeof schema['~standard'].validate !== 'function') {
        throw new Error('A Standard Schema v1 validator is required');
    }
    const validate = async (document: any): Promise<any> => {
        const result = await schema['~standard'].validate(document);
        if (result.issues) throw new ModelValidationError(result.issues);
        // Schema libraries may strip unknown fields. Persistence metadata belongs
        // to CouchSet and must not disappear or be rewritten by an adapter.
        const output: any = {...(result as {value: T}).value};
        for (const field of ['id', '_type', '_scope', 'createdAt', 'updatedAt']) {
            if (Object.prototype.hasOwnProperty.call(document, field))
                output[field] = document[field];
        }
        return output;
    };
    return () => ({validateCreate: validate, validateReplace: validate});
};
