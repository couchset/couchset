import 'mocha';
import {expect} from 'chai';
import {buildIncludedSelectionQuery, joinField} from './include';
import {findMany} from './read-helpers';

const build = (path: string, sourceAlias = 'doc') =>
    buildIncludedSelectionQuery({
        keyspace: '`test`',
        collectionName: 'Battle',
        sourceAlias,
        include: [
            {as: 'mediaDocuments', keys: path, type: 'leftNest', keyspace: '`test`.`aura`.`media`'},
        ],
        where: {[path]: 'profile::demo'},
        orderBy: {[path]: 'ASC'},
    });

describe('Include array field paths', () => {
    for (const [path, expected] of [
        ['participantIds[0]', '`doc`.`participantIds`[0]'],
        ['participantIds[1]', '`doc`.`participantIds`[1]'],
        ['media[*].mediaId', '`doc`.`media`[*].`mediaId`'],
        ['groups[0].media[*].mediaId', '`doc`.`groups`[0].`media`[*].`mediaId`'],
        ['matrix[0][1].value', '`doc`.`matrix`[0][1].`value`'],
        ['profile.owner.id', '`doc`.`profile`.`owner`.`id`'],
        ['doc.media[*].mediaId', '`doc`.`media`[*].`mediaId`'],
        ['`doc`.`media`[*].`mediaId`', '`doc`.`media`[*].`mediaId`'],
        ['`media[*]`', '`doc`.`media[*]`'],
        ['`literal.dot`[0].`a``b`', '`doc`.`literal.dot`[0].`a``b`'],
        ['select[0].owner`name', '`doc`.`select`[0].`owner``name`'],
        ['name; DROP INDEX x', '`doc`.`name; DROP INDEX x`'],
    ])
        it(`quotes identifiers but retains selectors: ${path}`, () => {
            const result = build(path);
            expect(result.query).to.contain(`ON KEYS ${expected}`);
            expect(result.query).to.contain(`WHERE ${expected}=$cs_param_0`);
            expect(result.query).to.contain(`ORDER BY ${expected} ASC`);
            expect(result.parameters.cs_param_0).to.equal('profile::demo');
        });

    it('handles custom source aliases and ANSI references through the same parser', () => {
        expect(build('battle.media[*].mediaId', 'battle').query).to.contain(
            'ON KEYS `battle`.`media`[*].`mediaId`'
        );
        const result = buildIncludedSelectionQuery({
            keyspace: '`test`',
            collectionName: 'Battle',
            sourceAlias: 'battle',
            include: [
                {
                    as: 'select',
                    on: {
                        $and: [
                            {
                                left: joinField('select.ownerIds[0]'),
                                op: '$eq',
                                right: joinField('`battle`.participantIds[1]'),
                            },
                            {left: joinField('select.name'), op: '$eq', right: 'participantIds[0]'},
                        ],
                    },
                },
            ],
        });
        expect(result.query).to.contain('`select`.`ownerIds`[0] = `battle`.`participantIds`[1]');
        expect(result.parameters.cs_param_0).to.equal('participantIds[0]');
    });

    for (const path of [
        '',
        '.id',
        'a.',
        'a..b',
        'a[]',
        'a[-1]',
        'a[01]',
        'a[1.5]',
        'a[x]',
        'a[1:2]',
        'a[0',
        'a]',
        'a[*]id',
        'a[0].',
        'a[9007199254740992]',
        '`unclosed',
        '`name`junk',
        'a\0b',
    ]) {
        it(`rejects malformed/unsupported paths: ${JSON.stringify(path)}`, () => {
            expect(() => build(path)).to.throw();
            expect(() =>
                buildIncludedSelectionQuery({
                    keyspace: '`test`',
                    collectionName: 'Battle',
                    include: [
                        {as: 'other', on: {left: joinField(`other.${path}`), op: '$eq', right: 1}},
                    ],
                })
            ).to.throw();
        });
    }
    it('does not treat an indexed source or internal output alias as an ON binding', () => {
        for (const path of ['doc[0].id', '__cs_root.id', 'unknown.media[0]'])
            expect(() =>
                buildIncludedSelectionQuery({
                    keyspace: '`test`',
                    collectionName: 'Battle',
                    include: [
                        {
                            as: 'other',
                            on: {left: joinField('other.id'), op: '$eq', right: joinField(path)},
                        },
                    ],
                })
            ).to.throw('Unknown ON alias');
    });
    it('hydrates fixture media without changing LEFT NEST row count or received array order', async () => {
        let sql = '';
        const rows = await findMany<any>(
            {
                bucketName: '`test`',
                collectionName: 'Battle',
                parse: (data) => data,
                cluster: {
                    query: async (query: string) => {
                        sql = query;
                        return {
                            rows: [
                                {
                                    __cs_root: {id: 'b1'},
                                    mediaDocuments: [
                                        {id: 'm2', takenAt: '2026-09-05'},
                                        {id: 'm1', takenAt: '2026-09-04'},
                                    ],
                                },
                                {__cs_root: {id: 'b2'}, mediaDocuments: []},
                            ],
                        };
                    },
                } as any,
            },
            {
                where: {'participantIds[0]': 'profile::demo'},
                include: [
                    {
                        as: 'mediaDocuments',
                        keys: 'media[*].mediaId',
                        type: 'leftNest',
                        model: {
                            keyspace: () => '`test`.`aura`.`media`',
                            parse: <T>(data: T): T => ({
                                ...data,
                                takenAt: new Date((data as any).takenAt),
                            }),
                        },
                    },
                ],
            }
        );
        expect(sql).to.contain('ON KEYS `doc`.`media`[*].`mediaId`');
        expect(sql).to.contain('`doc`.`participantIds`[0]=$cs_param_1');
        expect(rows.map((row) => row.id)).to.deep.equal(['b1', 'b2']);
        expect(rows[0].mediaDocuments.map((item: any) => item.id)).to.deep.equal(['m2', 'm1']);
        expect(rows[0].mediaDocuments[0].takenAt).to.be.instanceOf(Date);
        expect(rows[1].mediaDocuments).to.deep.equal([]);
    });
});
