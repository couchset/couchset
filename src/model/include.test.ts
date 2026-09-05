import 'mocha';
import {expect} from 'chai';
import {createCouchsetClient, dateCodec, defineModel, joinField} from '../next';
import {buildIncludeClauses, buildIncludedSelectionQuery, IncludeDefinition} from './include';

const on = {
    left: joinField('creator.ownerUserId'),
    op: '$eq' as const,
    right: joinField('battle.createdByUserId'),
};
const build = (include: readonly IncludeDefinition[], extra: any = {}) =>
    buildIncludedSelectionQuery({
        keyspace: '`test`',
        collectionName: 'Battle',
        sourceAlias: 'battle',
        include,
        ...extra,
    });
const rejects = async (operation: () => Promise<any>, message: string) => {
    let error: any;
    try {
        await operation();
    } catch (caught) {
        error = caught;
    }
    expect(error?.message).to.contain(message);
};

function fixture(rows: any[]) {
    const calls: Array<{query: string; options: any}> = [];
    const connection = {
        getBucket: () => 'test',
        getCollection: () => ({}),
        ready: async () => connection,
        isConnected: () => true,
        shouldReconnect: () => false,
        markDisconnected: () => undefined,
        cluster: {
            query: async (query: string, options: any) => {
                calls.push({query, options});
                return {rows};
            },
        },
    };
    const client = createCouchsetClient({dependencies: {connection: connection as any}});
    const battles = client.model(
        defineModel<{createdByUserId: string; startsAt: Date}>({
            name: 'Battle',
            codecs: {startsAt: dateCodec},
            parse: (data: any) => ({...data, rootParsed: true}),
        })
    );
    const profiles = client.model(
        defineModel<{ownerUserId: string; birthday: Date; name: string}>({
            name: 'Profile',
            scope: 'app',
            collection: 'profiles',
            codecs: {birthday: dateCodec},
            parse: (data: any) => ({...data, relatedParsed: true}),
        })
    );
    return {calls, battles, profiles};
}

describe('Structured includes', () => {
    it('preserves ON KEYS join kinds and explicit JOIN with array keys', () => {
        expect(
            buildIncludeClauses('`test`', [
                {as: 'owner', key: 'ownerId'},
                {as: 'members', keys: 'memberIds'},
                {as: 'lastMessage', key: 'lastMessageId', optional: true},
                {as: 'others', keys: 'otherIds', type: 'leftNest'},
                {as: 'onePerKey', keys: 'ids', type: 'join'},
            ])
        ).to.equal(
            'JOIN `test` AS `owner` ON KEYS `doc`.`ownerId` NEST `test` AS `members` ON KEYS `doc`.`memberIds` LEFT JOIN `test` AS `lastMessage` ON KEYS `doc`.`lastMessageId` LEFT NEST `test` AS `others` ON KEYS `doc`.`otherIds` JOIN `test` AS `onePerKey` ON KEYS `doc`.`ids`'
        );
    });

    it('builds the creator ANSI LEFT JOIN with shared parameter binding and pagination', () => {
        const query = build(
            [
                {
                    as: 'creator',
                    keyspace: 'test.app.profiles',
                    type: 'leftJoin',
                    on: {
                        $and: [
                            on,
                            {
                                $or: [
                                    {
                                        left: joinField('creator.name'),
                                        op: '$eq',
                                        right: 'battle.createdByUserId',
                                    },
                                    {
                                        left: joinField('creator.name'),
                                        op: '$neq',
                                        right: 'x" OR true --',
                                    },
                                ],
                            },
                        ],
                    },
                },
            ],
            {where: {createdByUserId: 'user-1'}, limit: 2, page: 3}
        );
        expect(query.query).to.equal(
            'SELECT `battle` AS __cs_root, `creator` AS `creator` FROM `test` AS `battle` LEFT JOIN `test`.`app`.`profiles` AS `creator` ON (`creator`.`ownerUserId` = `battle`.`createdByUserId` AND (`creator`.`name` = $cs_param_0 OR `creator`.`name` != $cs_param_1)) WHERE `battle`.`createdByUserId`=$cs_param_2 LIMIT $cs_limit OFFSET $cs_offset'
        );
        expect(query.parameters).to.deep.equal({
            cs_param_0: 'battle.createdByUserId',
            cs_param_1: 'x" OR true --',
            cs_param_2: 'user-1',
            cs_limit: 2,
            cs_offset: 6,
        });
    });

    it('supports inner/left ANSI JOIN and NEST, preserving chain references', () => {
        for (const [type, operator] of [
            ['join', 'JOIN'],
            ['leftJoin', 'LEFT JOIN'],
            ['nest', 'NEST'],
            ['leftNest', 'LEFT NEST'],
        ] as const) {
            expect(build([{as: 'creator', on, type}]).query).to.contain(
                `${operator} \`test\` AS \`creator\` ON`
            );
        }
        expect(
            build([
                {as: 'creator', on},
                {
                    as: 'second',
                    on: {left: joinField('second.id'), op: '$eq', right: joinField('creator.id')},
                },
            ]).query
        ).to.contain('`second`.`id` = `creator`.`id`');
    });

    it('escapes identifier segments and accepts canonical model keyspaces', () => {
        expect(
            buildIncludeClauses('`test`', [
                {as: 'select', key: 'owner`name', keyspace: '`my``bucket`.`app`.`profiles`'},
            ])
        ).to.contain('AS `select` ON KEYS `doc`.`owner``name`');
        const {profiles} = fixture([]);
        expect(build([{as: 'creator', model: profiles, on}]).query).to.contain(
            'default:`test`.`app`.`profiles`'
        );
    });

    it('rejects unsupported combinations, malformed predicates, aliases and keyspace expressions', () => {
        const invalid: IncludeDefinition[][] = [
            [{as: 'creator'}],
            [{as: 'creator', key: 'id', on}],
            [{as: 'creator', key: 'id', keys: 'ids'}],
            [
                {as: 'creator', on},
                {as: 'other', key: 'id'},
            ],
            [
                {as: 'creator', on},
                {as: 'creator', on},
            ],
            [{as: 'battle', on}],
            [{as: '__cs_root', on}],
            [{as: '__proto__', on}],
            [{as: 'creator', on: {$and: []}}],
            [{as: 'creator', on: {...on, op: '$in'} as any}],
            [{as: 'creator', on: {...on, right: joinField('later.id')}}],
            [{as: 'creator', on: {...on, right: joinField('__cs_root.id')}}],
            [{as: 'creator', on, keyspace: 'profiles WHERE true'}],
            [{as: 'creator', key: 'id', type: 'rightJoin' as any}],
        ];
        for (const include of invalid) expect(() => build(include)).to.throw();
    });

    it('offers a trusted raw ON escape hatch while binding its values', () => {
        const query = build([
            {
                as: 'creator',
                onRaw: {
                    sql: 'META(`creator`).id = ? AND `creator`.active = ?',
                    values: ['profile-1', true],
                },
            },
        ]);
        expect(query.query).to.contain(
            'ON (META(`creator`).id = $cs_param_0 AND `creator`.active = $cs_param_1)'
        );
        expect(query.parameters.cs_param_0).to.equal('profile-1');
        expect(() => build([{as: 'creator', onRaw: {sql: 'x = ?', values: []}}])).to.throw(
            'placeholder'
        );
    });

    it('decodes root and related model dates, preserves JOIN rows and returns null for no row', async () => {
        const iso = '2026-09-05T00:00:00.000Z';
        const {battles, profiles, calls} = fixture([
            {__cs_root: {id: 'b1', startsAt: iso}, creator: {id: 'p1', birthday: iso}},
            {__cs_root: {id: 'b1', startsAt: iso}, creator: {id: 'p2', birthday: iso}},
        ]);
        const rows = await battles.findMany({
            sourceAlias: 'battle',
            include: [{as: 'creator', model: profiles, on}],
        });
        expect(rows.map((row) => row.id)).to.deep.equal(['b1', 'b1']);
        expect(rows[0].startsAt).to.be.instanceOf(Date);
        expect(rows[0].creator.birthday).to.be.instanceOf(Date);
        expect(rows[0]).to.have.property('rootParsed', true);
        expect(rows[0].creator).to.have.property('relatedParsed', true);
        expect(calls).to.have.length(1);
        const empty = fixture([]);
        expect(await empty.battles.findOne()).to.equal(null);
    });

    it('preserves missing/null LEFT JOIN and normalizes unmatched NEST to arrays', async () => {
        const {battles, profiles} = fixture([
            {__cs_root: {id: 'b1'}},
            {__cs_root: {id: 'b2'}, creator: null, people: []},
            {__cs_root: {id: 'b3'}, creator: {id: 'p'}, people: [{birthday: '2026-01-01'}]},
        ]);
        const rows = await battles.findMany({
            sourceAlias: 'battle',
            include: [
                {as: 'creator', model: profiles, on, type: 'leftJoin'},
                {
                    as: 'people',
                    model: profiles,
                    on: {
                        left: joinField('people.ownerUserId'),
                        op: '$eq',
                        right: joinField('battle.createdByUserId'),
                    },
                    type: 'leftNest',
                },
            ],
        });
        expect(rows[0]).not.to.have.property('creator');
        expect(rows[1].creator).to.equal(null);
        expect(rows[0].people).to.deep.equal([]);
        expect(rows[1].people).to.deep.equal([]);
        expect(rows[2].people[0].birthday).to.be.instanceOf(Date);
    });

    it('decodes ON KEYS related objects and arrays without reordering them', async () => {
        const {battles, profiles} = fixture([
            {
                __cs_root: {id: 'b'},
                creator: {birthday: '2026-01-01'},
                people: [
                    {name: 'second', birthday: '2026-02-02'},
                    {name: 'first', birthday: '2026-01-01'},
                ],
            },
        ]);
        const rows = await battles.findMany({
            include: [
                {as: 'creator', model: profiles, key: 'createdByUserId'},
                {as: 'people', model: profiles, keys: 'profileIds'},
            ],
        });
        expect(rows[0].creator.birthday).to.be.instanceOf(Date);
        expect(rows[0].people.map((person) => person.name)).to.deep.equal(['second', 'first']);
    });

    it('projects root and related fields, codecs selected dates, and skips full-document hooks', async () => {
        const {battles, profiles, calls} = fixture([
            {
                __cs_root: {startsAt: '2026-01-01'},
                creator: {birthday: '2026-02-02'},
                people: [{birthday: '2026-03-03'}],
            },
        ]);
        const rows = await battles.findMany({
            sourceAlias: 'battle',
            select: ['startsAt'],
            include: [
                {as: 'creator', model: profiles, on, type: 'leftJoin', select: ['birthday']},
                {
                    as: 'people',
                    model: profiles,
                    on: {left: joinField('people.id'), op: '$eq', right: 'id'},
                    type: 'nest',
                    select: ['birthday'],
                },
            ],
        });
        expect(calls[0].query).to.contain('{"startsAt": `battle`.`startsAt`} AS __cs_root');
        expect(calls[0].query).to.contain(
            'CASE WHEN `creator` IS MISSING THEN MISSING WHEN `creator` IS NULL THEN NULL ELSE {"birthday": `creator`.`birthday`} END'
        );
        expect(calls[0].query).to.contain(
            'ARRAY {"birthday": `__cs_item`.`birthday`} FOR `__cs_item` IN `people` END'
        );
        expect(rows[0].startsAt).to.be.instanceOf(Date);
        expect(rows[0].creator.birthday).to.be.instanceOf(Date);
        expect(rows[0].people[0].birthday).to.be.instanceOf(Date);
        expect(rows[0]).not.to.have.property('rootParsed');
        expect(rows[0].creator).not.to.have.property('relatedParsed');
        expect(() => build([{as: 'creator', on}], {select: 'RAW 1'})).to.throw('projections');
        expect(() => build([{as: 'creator', on, select: ['address.city']}])).to.throw('top-level');
    });

    it('rejects root and projection alias overwrites', async () => {
        const {battles, profiles} = fixture([
            {__cs_root: {id: 'b', creator: 'source value'}, creator: {id: 'p'}},
        ]);
        await rejects(
            () =>
                battles.findMany({
                    sourceAlias: 'battle',
                    include: [{as: 'creator', model: profiles, on}],
                }),
            'overwrite'
        );
        expect(() => build([{as: 'creator', on}], {select: ['creator']})).to.throw('conflicts');
    });

    it('paginates result rows, keeping duplicate root IDs and explicit offset', async () => {
        const {battles, profiles, calls} = fixture(
            [1, 2, 3].map((id) => ({__cs_root: {id: 'b'}, creator: {id: `p${id}`}}))
        );
        const result = await battles.page({
            sourceAlias: 'battle',
            include: [{as: 'creator', model: profiles, on}],
            limit: 2,
            page: 5,
            offset: 7,
        });
        expect(result.items.map((row) => row.creator.id)).to.deep.equal(['p1', 'p2']);
        expect(result.items.map((row) => row.id)).to.deep.equal(['b', 'b']);
        expect(result.hasNext).to.equal(true);
        expect(result.pageInfo.nextOffset).to.equal(9);
        expect(calls[0].options.parameters).to.include({cs_limit: 3, cs_offset: 7});
    });
});
