/* eslint-disable @typescript-eslint/ban-ts-comment -- this file verifies compiler errors. */
import {dateCodec, defineModel, FieldCodec} from './next';

interface TypedSession {
    expiresAt: Date;
    userId: string;
}

const booleanCodec: FieldCodec<boolean, string> = {
    fromDatabase: (value) => value === 'true',
    toDatabase: (value) => String(value),
};

defineModel<TypedSession>({
    codecs: {expiresAt: dateCodec},
    indexes: [{fields: ['userId'], name: 'idx_typed_session_user'}],
    name: 'TypedSession',
});

defineModel<TypedSession>({
    codecs: {
        // @ts-expect-error Codec keys must exist on the declared document type.
        missing: dateCodec,
    },
    name: 'InvalidCodecKey',
});

defineModel<TypedSession>({
    codecs: {
        // @ts-expect-error Codec input must match the declared field type.
        expiresAt: booleanCodec,
    },
    name: 'InvalidCodecValue',
});

defineModel<TypedSession>({
    indexes: [
        {
            // @ts-expect-error Declared index fields are checked against the document type.
            fields: ['missing'],
            name: 'idx_invalid_field',
        },
    ],
    name: 'InvalidTypedSession',
});
