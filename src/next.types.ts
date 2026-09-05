/* eslint-disable @typescript-eslint/ban-ts-comment -- this file verifies compiler errors. */
import type {AutoModelFields, ModelReadArgs} from './model';
import {createCouchsetClient, dateCodec, defineModel, FieldCodec, joinField} from './next';

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

// Model read inference is based on the bound model, literal aliases, kinds and projections.
const client = createCouchsetClient();
const sessions = client.model(
    defineModel<TypedSession>({name: 'ReadSession', codecs: {expiresAt: dateCodec}})
);
const profiles = client.model(
    defineModel<{name: string; birthday: Date}>({
        name: 'ReadProfile',
        codecs: {birthday: dateCodec},
    })
);
async function inferredReads() {
    const rows = await sessions.findMany({
        include: [
            {
                as: 'creator',
                model: profiles,
                type: 'leftJoin',
                on: {left: joinField('creator.id'), op: '$eq', right: joinField('doc.userId')},
            },
            {
                as: 'friends',
                model: profiles,
                type: 'leftNest',
                on: {left: joinField('friends.id'), op: '$eq', right: 'literal.id'},
                select: ['name'],
            },
        ],
    });
    const expiry: Date = rows[0].expiresAt;
    const birthday: Date | undefined = rows[0].creator?.birthday;
    const friends: Array<{name: string}> = rows[0].friends;
    // @ts-expect-error JOIN is an object, not a relation array.
    rows[0].creator.map(() => 1);
    // @ts-expect-error Related projection excludes birthday.
    rows[0].friends[0].birthday;
    // @ts-expect-error Related fields come from its model.
    rows[0].creator.nonexistent;
    const selected = await sessions.findOne({select: ['expiresAt']});
    const selectedDate: Date = selected.expiresAt;
    // @ts-expect-error Unselected root field must not be claimed.
    selected.userId;
    // @ts-expect-error Cannot assert an unrelated result by supplying a row generic.
    sessions.findMany<{madeUp: string}>();
    // @ts-expect-error Include aliases must not overwrite known root fields.
    sessions.findMany({include: [{as: 'userId', model: profiles, key: 'userId'}]});
    const raw = await sessions.findMany({select: 'RAW COUNT(1)'});
    // @ts-expect-error Arbitrary SQL++ projections have unknown shape.
    raw[0].expiresAt;
    const keyJoined = await sessions.findMany({
        include: [{as: 'profile', model: profiles, key: 'userId'}],
    });
    const name: string = keyJoined[0].profile.name;
    const keyedNest = await sessions.page({
        include: [{as: 'people', model: profiles, keys: 'userId'}],
    });
    const people: Array<{name: string; birthday: Date} & AutoModelFields> =
        keyedNest.items[0].people;
    const scoped = await sessions.withDeleted().findOne();
    const stillDate: Date = scoped.expiresAt;
    return {expiry, birthday, friends, selectedDate, name, people, stillDate};
}

async function conservativeInputs(args: ModelReadArgs, optional: boolean) {
    const dynamic = await sessions.findMany(args);
    // @ts-expect-error Broad read args can contain arbitrary projections.
    dynamic[0].expiresAt;
    const optionalRows = await sessions.findMany({
        include: [{as: 'profile', model: profiles, key: 'userId', optional}],
    });
    type OptionalKey = {} extends Pick<(typeof optionalRows)[number], 'profile'> ? true : false;
    const optionalKey: OptionalKey = true;
    const literalRows = await sessions.findMany({
        include: [{as: 'profile', model: profiles, type: 'leftJoin', key: 'userId'}],
    });
    type LeftKey = {} extends Pick<(typeof literalRows)[number], 'profile'> ? true : false;
    const leftKey: LeftKey = true;
    const innerRows = await sessions.findMany({
        include: [{as: 'profile', model: profiles, type: 'join', key: 'userId'}],
    });
    type InnerKey = {} extends Pick<(typeof innerRows)[number], 'profile'> ? true : false;
    const innerKey: InnerKey = false;
    return {optionalKey, leftKey, innerKey};
}

// Keep compile-only cases referenced without executing reads.
void inferredReads;
void conservativeInputs;
