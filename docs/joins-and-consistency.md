# Joined reads and query consistency

The 0.5.0 source already supported `JOIN`, `LEFT JOIN`, `NEST`, and `LEFT NEST`
with `ON KEYS`. This extends that include API with structured ANSI `ON`, related
model decoding, inferred client-model reads, and SDK query options. Raw
`queryRows`, `queryOne`, and `queryPage` already accepted SDK options; they now
share consistency validation with the other supported SQL++ reads.

## ANSI predicates

```ts
import {createCouchsetClient, defineModel, dateCodec, joinField} from 'couchset/next';
import {QueryScanConsistency} from 'couchbase';

const db = createCouchsetClient({bucketName: 'app' /* connection settings */});
const battles = db.model(defineModel<{
    createdByUserId: string;
    startsAt: Date;
}>({name: 'Battle', scope: 'app', collection: 'battles', codecs: {startsAt: dateCodec}}));
const profiles = db.model(defineModel<{
    ownerUserId: string;
    displayName: string;
    birthday: Date;
}>({name: 'Profile', scope: 'app', collection: 'profiles', codecs: {birthday: dateCodec}}));

const result = await battles.page({
    sourceAlias: 'battle',
    include: [{
        as: 'creator',
        model: profiles,
        type: 'leftJoin',
        on: {
            left: joinField('creator.ownerUserId'),
            op: '$eq',
            right: joinField('battle.createdByUserId'),
        },
    }],
    limit: 20,
    queryOptions: {scanConsistency: QueryScanConsistency.RequestPlus},
});
// LEFT JOIN ... profiles AS creator
// ON creator.ownerUserId = battle.createdByUserId
result.items[0]?.creator?.birthday; // Date | undefined
```

A `joinField('alias.path')` is a field reference; an ordinary string on the
right is always a bound value, even when it contains a dot. Aliases must refer
to the root (default `doc`), the current include, or an earlier include. Field
paths use dots as separators and quote every identifier segment. Alias strings
are quoted, including reserved words. A literal dot inside a field name is not
supported by the structured field-reference syntax.

Comparisons support `$eq`, `$neq`, `$gt`, `$gte`, `$lt`, and `$lte`. Nest nonempty
`$and` and `$or` arrays to combine predicates:

```ts
on: {$and: [
    {left: joinField('creator.ownerUserId'), op: '$eq', right: joinField('battle.createdByUserId')},
    {$or: [
        {left: joinField('creator.displayName'), op: '$eq', right: 'A. Person'},
        {left: joinField('creator.displayName'), op: '$eq', right: 'B. Person'},
    ]},
]}
```

`type` accepts `join`, `leftJoin`, `nest`, or `leftNest`. `optional: true` turns
an inner kind into its left kind. Exactly one of `key`, `keys`, `on`, or `onRaw`
is required. `key`/`keys` remain source-document paths used with `ON KEYS`:

```ts
include: [{as: 'creator', model: profiles, key: 'createdByUserId', optional: true}]
```

Without an explicit type, `keys` means NEST and `key` means JOIN. An explicit
`type: 'join'` with `keys` now means JOIN, producing one row per matched key.
ANSI and lookup (`ON KEYS`) clauses cannot be mixed in one query. Unsupported
kinds, unknown aliases, empty groups, conflicting modes, duplicate aliases,
and keyspace expressions are rejected. Model keyspaces and quoted or simple
dotted keyspace identifiers are accepted.

For advanced predicates, `onRaw: {sql: 'META(`creator`).id = ?', values: [id]}`
is an explicit trusted-SQL escape hatch. Every `?` is replaced, left to right,
by a generated SDK parameter; do not put `?` inside SQL literals or comments.
Only use application-owned SQL in `sql`. Use `queryRows` for arbitrary
projections, UNNEST, subqueries, or other SQL++ beyond the structured API.

The related model supplies its keyspace, declared result type, and codecs.
It does not automatically apply that model's `_type`, default filters, or
soft-delete policy. Add required related predicates to `on` (especially when
several document types share one keyspace), or use explicit SQL for key-based
reads that need additional predicates. Definitions describe expected data;
read inference is not runtime schema validation or referential integrity.

Couchbase requires suitable indexes for ANSI joins. CouchSet does not create
them implicitly. See the official [JOIN reference](https://docs.couchbase.com/server/current/n1ql/n1ql-language-reference/join.html)
for supported chaining and indexing requirements.

## Result shapes, projections, and codecs

Client-bound models infer reads from their definition. Literal include aliases
and bound related models determine the relation types; no row generic is
needed. In a separately stored options object, use `as const` to retain literal
aliases/kinds/selections. Broad or raw selections return `unknown`; dynamic
include arrays expose unknown relation values. Widened field arrays return
partial field selections; only tuples of definite individual literal keys
guarantee each selected field. Union-valued tuple entries also produce partial
selections. Union or dynamic alias names do not guarantee any particular alias.
Optional include settings retain their possible runtime defaults in the result type. Untyped keyspace targets have
unknown document fields. TypeScript 5 or newer is required for literal inference.

| Include kind | Relation value per returned row |
| --- | --- |
| JOIN | One related document object |
| LEFT JOIN | Related object, explicit `null`, or an absent property (`undefined` when accessed) |
| NEST | Array of matching related documents |
| LEFT NEST | Array; unmatched absent/null array values normalize to `[]` |

Inner clauses remove unmatched source rows on the server. CouchSet does not
invent those rows. JOIN cardinality is preserved, including repeated root IDs.
`page()` takes `limit + 1` result rows, not distinct root documents. NEST arrays
are decoded in the order received: neither source-key ordering nor any other
nested ordering is promised. Stable pagination needs an appropriate explicit
`orderBy`; it does not provide a snapshot across requests. See Couchbase's
[NEST reference](https://docs.couchbase.com/server/current/n1ql/n1ql-language-reference/nest.html).

Supported joined projections are `'*'` (the default) or arrays of distinct
top-level root fields, plus an optional `select` array on each include:

```ts
const rows = await battles.findMany({
    select: ['startsAt'],
    include: [{as: 'creators', model: profiles, type: 'leftNest',
        on: {left: joinField('creators.ownerUserId'), op: '$eq', right: joinField('doc.createdByUserId')},
        select: ['displayName', 'birthday'],
    }],
});
// rows: {startsAt: Date; creators: {displayName: string; birthday: Date}[]}[]
```

Projections happen in SQL++, before rows reach the client. Present selected
fields run the model's codecs, schema date transforms, and `dateFields`.
Full-document parse hooks run only for full documents; projected documents
skip these hooks because omitted fields may be required by application code.
This applies independently to root and related documents. Full root decoding
is preserved. Raw/computed non-joined projections are returned unchanged and
do not run model codecs. Use an explicit decoder after `queryRows` for renamed
fields or computed expressions. Nested/dotted joined selections are not supported.

Root and relation columns are kept separate internally and combined after
decoding. An include alias must not overwrite a root field or another alias;
known root conflicts are type errors, and actual returned-field conflicts are
runtime errors. Choose `creator` alongside a source `creatorId`, not `creator`
as both the source key field and the populated result. Internal alias
`__cs_root` and prototype-related include aliases are reserved.

## Read consistency

Set SDK options through `queryOptions` on `findMany`, `findOne`, `page`, `count`,
`exists`, standalone `Pagination`, and `CustomQuery`. They are forwarded on each
query, including joined reads. For `queryRows`, `queryOne`, and `queryPage`, use
the existing third options argument. Defaults remain unchanged: no consistency
mode is added by CouchSet. `count` and `exists` support root reads only and reject
includes; use an explicit aggregate `queryRows` query to count joined rows.

```ts
import {MutationState, QueryScanConsistency} from 'couchbase';

await battles.findMany({
    queryOptions: {scanConsistency: QueryScanConsistency.RequestPlus},
});

// Capture the SDK mutation result from a successful KV operation.
const mutation = await profiles.getCollection().upsert(profileId, storedProfile);
if (!mutation.token) throw new Error('Mutation token unavailable');
const state = new MutationState(mutation.token);
await battles.findMany({queryOptions: {consistentWith: state}});
await battles.queryRows('SELECT RAW 1', {}, {consistentWith: state});
```

`request_plus` waits for indexes to catch up to mutations preceding the query.
`consistentWith` requests read-your-writes for the supplied SDK mutation state.
Neither option is a multi-document transaction or a stable snapshot across
multiple reads. KV reads and transaction-attempt queries keep their SDK-specific
APIs. See [SDK consistency options](https://docs.couchbase.com/nodejs-sdk/current/howtos/n1ql-queries-with-sdk.html).

`scanConsistency` and `consistentWith` cannot be combined, including an explicit
`not_bounded` mode. Unsupported scan modes and raw consistency overrides are
rejected before querying, even with `throwOnError: false`. SDK failures still
follow the existing fallback policy. SDK parameters remain separate from SQL.

## Compatibility and validation

- Existing `ON KEYS` inputs remain available. Explicit JOIN with `keys` now honors
  JOIN cardinality; omit the type or use NEST to retain the previous array shape.
- Client-bound `TypedModel` reads replace caller row generics with inference.
  `new Model()` retains its existing generic read API for compatibility. For
  arbitrary SQL++ result assertions, use the explicitly typed `queryRows<T>` API.
- Includes no longer overwrite root fields. Change colliding aliases. The SDK
  row envelope has changed internally; public flat root-plus-relations results
  remain, and mocked query responses must use the new separate columns.
- Arbitrary joined selections now fail explicitly; move them to `queryRows`.
  Partial projections skip full-document hooks; raw projections skip decoding.
- Aggregate helpers reject includes they previously ignored. Conflicting
  consistency options now fail early instead of relying on SDK behavior.

Run `npm run test:unit` for deterministic mocked SQL/binding, decoding, shape,
cardinality, and option-forwarding tests. Run `npm run test:types` for a build
and strict public-declaration inference fixtures. These tests do not execute a
Couchbase server, prove an index plan, or measure freshness under concurrency.


### Local server validation

On 2026-09-05, 20 live probes passed against the configured local Couchbase
Query 8.0.3 server. The probes used a fresh isolated scope, synthetic documents,
and dedicated primary/lookup indexes; that scope and all its contents were
removed afterward. They exercised all ANSI and ON KEYS join kinds, duplicate
JOIN rows, compound predicates and binding, missing LEFT JOIN relations, empty
LEFT NEST arrays, root/related date codecs and projections, raw ON, pagination,
alias rejection, immediate `request_plus` reads, and normal/joined reads using
real SDK mutation tokens via `consistentWith`.

The first run exposed an example error: `MutationState` takes `mutation.token`,
not the whole mutation result. The example is corrected and covered by a strict
type fixture; the corrected live run passed all 20 probes. These observations
validate this local server and synthetic workload; they do not establish a
concurrent multi-document snapshot, a production index plan, or compatibility
with every supported server version.
