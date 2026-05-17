# Couchset Implementation Task Plan

This file is commit-safe implementation guidance for evolving couchset. It intentionally avoids private repo paths and private project names. Some downstream findings are summarized generically; Roadman usage can be referenced directly because it is public.

## Product Direction

Couchset should stay a small Couchbase ORM with a Mongoose-like developer feel:

- Keep the existing simple `new Model("Type")` workflow.
- Add safer, clearer APIs beside the old APIs.
- Make Couchbase scopes and collections first-class, while defaulting to the default scope/collection when unspecified.
- Keep raw N1QL escape hatches because real apps need joins, projections, time-series queries, and advanced filtering.
- Do not reintroduce GraphQL automation in core. Couchset core should be plain Couchbase/model/query functionality.
- Add validation and hydrated document support so a fetched document can be modified and saved with `doc.save()`.
- Pull generally useful pieces from `@roadmanjs/couchset` into couchset itself where they belong.

## Compatibility Rules

Existing consumers must be able to upgrade without rewriting old code.

- Keep `import { Model } from "couchset"` working.
- Keep `new Model(name, options?)` as the main public class.
- Keep current behavior for:
  - `create`
  - `findById`
  - `updateById`
  - `save`
  - `delete`
  - `pagination`
  - `customQuery`
- Keep old root exports and practical legacy deep paths working, including utilities currently imported from `couchset/dist/utils`.
- Add new APIs alongside old ones instead of replacing old behavior.
- Use opt-in strict mode for behavior changes that could expose hidden failures.
- If internals need a rewrite, make the current `Model` wrap or extend the new implementation. Do not force consumers to switch to a new class.
- Separate classes are acceptable for separate domains, such as `TimeSeriesModel`.

## Non-Goals

- No GraphQL resolver/query/mutation automation in core.
- No breaking change to `create()` semantics in the first implementation pass.
- No forced validation dependency. Support adapters/hooks for Zod, Yup, or user-provided functions.
- No removal of raw query support.
- No immediate removal of `pagination()` or `customQuery()`.

## Usage Drivers

Roadman public usage:

- Auth checks use `pagination()` for uniqueness and login lookups.
- Chat uses raw N1QL JOIN/NEST queries for owners, members, attachments, last messages, and sources.
- Chat cursor pagination manually uses `limit + 1`.
- Chat unread counts are read, incremented in JavaScript, then full-document replaced.
- Push/user-device flows use simple `where` lookups.
- `@roadmanjs/couchset` duplicates helper behavior such as `createUpdate`.
- Some packages import utilities from `couchset/dist/utils`.

Other downstream app usage, summarized:

- Many reads use `pagination({ where, limit: 1 })` as `findOne`.
- Soft deletes are manually represented as `deleted: true` plus repeated `deleted IS MISSING` filters.
- Raw N1QL strings interpolate values directly and sometimes hardcode bucket names.
- `customQuery()` tuple results are manually flattened.
- Some static models are re-created inside functions.
- App-level index arrays drift away from model/query definitions.
- TTL/expiry values are easy to misuse because raw SDK `expiry` uses seconds or absolute expiry.
- Time-series data is stored in chunk documents and queried with Couchbase `_timeseries(...)`.
- Date parsing is manually repeated for nested fields.

## Phase 1: Safe Query Layer

Goal: make raw and model queries safer without disturbing legacy APIs.

Add:

- `Model.queryRows<T>(query, params?, options?) => Promise<T[]>`
- `Model.queryOne<T>(query, params?, options?) => Promise<T | null>`
- `Model.queryPage<T>(query, params?, options?) => Promise<{ items: T[]; hasNext: boolean; params?: any }>`

Requirements:

- Pass named or positional params to `cluster.query(query, { parameters: params })`.
- Throw errors by default in the new APIs.
- Keep `customQuery()` behavior unchanged for compatibility.
- Add a debug/logger option instead of unconditional internal `console.log`.
- Add bucket/from helpers to reduce hardcoded bucket names:

```ts
const rows = await UserModel.queryRows(
  `
  SELECT *
  FROM ${UserModel.from("user")}
  WHERE user._type = $type
    AND user.username = $username
  LIMIT $limit
  `,
  { type: "User", username, limit: 1 }
);
```

Acceptance tests:

- Named parameters are passed to the Couchbase SDK query options.
- Positional parameters are passed to the Couchbase SDK query options.
- `queryRows()` returns rows directly.
- `queryOne()` returns first row or `null`.
- `queryPage()` fetches `limit + 1`, trims the extra row, and sets `hasNext`.
- Query failures reject in new APIs.
- `customQuery()` still returns `[rows, pagination]` and swallows errors as before.

## Phase 2: Model Read Helpers

Goal: stop using `pagination()` for every read shape.

Add:

- `findMany<T>(args) => Promise<T[]>`
- `findOne<T>(args) => Promise<T | null>`
- `exists(args) => Promise<boolean>`
- `count(args) => Promise<number>`
- Optional `page(args) => Promise<{ items; hasNext; pageInfo }>`

Requirements:

- Reuse the current query builder where possible.
- Keep `_type` injection for model-scoped reads.
- Support `select`, `where`, `orderBy`, `limit`, `page`, and `offset`.
- Add stricter variants/options that throw instead of returning empty arrays on query failure.
- Preserve `pagination()` as a compatibility wrapper.

Example:

```ts
const user = await UserModel.findOne({
  select: userPublicFields,
  where: { $or: [{ email: username }, { username }] },
});

const activeCount = await SandboxModel.count({
  where: { workspaceId, "app.status": "running" },
});
```

## Phase 3: Scope And Collection Targets

Goal: support real Couchbase scope/collection targeting while preserving the current default behavior.

Add model options:

```ts
const UserModel = new Model<User>("User", {
  scope: "app",
  collection: "users",
});

const LegacyUserModel = new Model<User>("User"); // default scope/collection
```

Requirements:

- If `scope` and `collection` are absent, use `bucket.defaultCollection()`.
- If `scope` or `collection` is present, use the matching SDK collection.
- Query builders must emit fully qualified keyspaces when needed.
- Keep `_type` as the logical model discriminator unless a model explicitly opts out.
- Preserve `_scope` metadata for old behavior, but do not confuse it with actual Couchbase scopes.

Acceptance tests:

- Default model uses bucket default collection.
- Scoped model writes to the configured collection.
- Scoped model queries use the configured keyspace.
- Legacy behavior remains unchanged.

## Phase 4: Write Semantics

Goal: make intent explicit and reduce race/data-loss risks.

Keep:

- `create()` as current upsert-like behavior for backward compatibility.

Add:

- `insert(data, options?)`: fail if id already exists.
- `upsert(data, options?)`: explicit insert-or-replace.
- `replaceById(id, doc, options?)`: full replace.
- `patchById(id, patch, options?)`: partial update.
- `mutateById(id, specs, options?)`: Couchbase subdocument mutation escape hatch.
- `incrementById(id, field, delta, options?)`: atomic numeric increment.
- `findByIdWithMeta(id)` or `findById(id, { meta: true })`.
- CAS-aware update options.

Patch sketch:

```ts
await ChatConvoModel.patchById(convo.id, {
  $set: { lastMessage: messageId },
  $inc: { unread: 1 },
});
```

Acceptance tests:

- `insert()` fails on duplicate ids.
- `upsert()` replaces or creates.
- `patchById()` preserves unspecified fields.
- `$inc` is atomic or implemented through subdocument mutation.
- CAS mismatch is surfaced clearly.
- Old `updateById()` still performs full replace.

## Phase 5: Soft Delete And Default Scopes

Goal: remove repeated `deleted IS MISSING` boilerplate.

Add model options:

```ts
const SandboxModel = new Model<Sandbox>("Sandbox", {
  softDelete: true,
  defaultWhere: { deleted: { $isMissing: true } },
});
```

Add:

- `softDeleteById(id)`
- `restoreById(id)`
- `deleteById(id, { hard?: boolean })`
- `withDeleted()`
- `onlyDeleted()`
- `withoutDefaultWhere()`

Requirements:

- Keep old `delete()` hard-delete behavior initially.
- New soft-delete helpers should update `deleted`, `deletedAt`, and `updatedAt`.
- Default scopes must apply to new read helpers but not surprise legacy `pagination()` unless strict/new mode opts in.

## Phase 6: Validation And Hydrated Documents

Goal: support Mongoose-like `doc.save()` and validation while keeping plain-object APIs stable.

Add model options:

```ts
const UserModel = new Model<User>("User", {
  validateCreate: (doc) => userSchema.validateSync(doc, { stripUnknown: true }),
  validateUpdate: (doc) => userSchema.validateSync(doc, { stripUnknown: true }),
  validateReplace: (doc) => userSchema.validateSync(doc, { stripUnknown: true }),
  parse: (doc) => doc,
  dateFields: ["createdAt", "updatedAt", "profile.birthDate"],
});
```

Add hydrated document APIs:

- `findDocById(id, options?)`
- `findDocOne(args)`
- `hydrate(raw)`

Hydrated document methods:

- `save(options?)`
- `patch(patch, options?)`
- `reload()`
- `delete(options?)`
- `toJSON()`

Example:

```ts
const user = await UserModel.findDocById(userId);
user.fullname = "Ceddy Muhoza";
await user.save({ validate: true, cas: "auto" });
```

Requirements:

- Keep `findById()` returning a plain parsed object for now.
- Hydrated document data fields should serialize cleanly.
- `save()` should preserve model metadata, timestamps, validation, optional CAS, and old update compatibility.
- Validation should be hook-based and library-agnostic.

## Phase 7: TTL Helpers

Goal: avoid raw expiry unit mistakes.

Add options:

```ts
await HeartbeatModel.upsert(heartbeat, { ttl: "2m" });
await LogsModel.create(logs, { ttl: "10d" });
await CookieModel.create(cookie, { ttlSeconds: 300 });
```

Requirements:

- Convert `ttl` and `ttlSeconds` into SDK `expiry`.
- Keep raw `expiry` pass-through.
- Reject ambiguous TTL values in strict mode.
- Document Couchbase expiry behavior.

## Phase 8: Index Declaration

Goal: define indexes near the models and generate/create them consistently.

Add:

```ts
const TradeModel = new Model<Trade>("TradeSession", {
  indexes: [
    {
      name: "idx_trade_conid_date",
      fields: ["instrument.conId", "_type", "date", { createdAt: "DESC" }],
    },
    {
      name: "idx_trade_active",
      fields: ["_type", "workspaceId", "deleted"],
      where: { deleted: { $isMissing: true } },
    },
  ],
});

await TradeModel.ensureIndexes();
await couchset.ensureIndexes();
```

Requirements:

- Support `CREATE INDEX IF NOT EXISTS` where available.
- Support partial indexes.
- Support deferred build.
- Support default collection and scoped collection keyspaces.
- Do not require Enterprise-only features for basic indexes.

## Phase 9: Relation/Populate Helpers

Goal: reduce repeated Roadman chat JOIN/NEST raw queries without hiding N1QL.

Add include support:

```ts
const convo = await ChatConvoModel.findOne({
  where: { owner, updatedAt: { $lte: before } },
  include: [
    { as: "owner", key: "owner" },
    { as: "members", keys: "members", type: "nest" },
    { as: "lastMessage", key: "lastMessage", optional: true },
    { as: "attachments", keys: "attachments", optional: true },
    { as: "source", key: "sourceId", optional: true },
  ],
});
```

Requirements:

- Keep raw query escape hatch for custom joins.
- Start with common `JOIN ON KEYS`, `LEFT JOIN ON KEYS`, and `NEST ON KEYS`.
- Do not build a complex ORM relation system before real call sites need it.

## Phase 10: Time-Series Helper

Goal: clean up chunked `_timeseries(...)` query generation used by downstream apps.

Add optional helper:

```ts
const MkdSeries = new TimeSeriesModel<MarketData>("mkd", {
  keyField: "ticker",
  timeField: "date",
  values: ["close", "high", "low", "open", "volume", "vwap"],
});

await MkdSeries.appendChunk(symbol, bars);
await MkdSeries.range(symbol, { startDate, endDate, interval: "5m" });
```

Requirements:

- Keep separate from core `Model`.
- Support chunk id generation.
- Support range queries.
- Support interval aggregation.
- Support custom value mappings.
- Keep raw query access for advanced time-series queries.

## Phase 11: Connection Management

Goal: make connection lifecycle safer and modern.

Add:

- Memoized connection promise.
- `isConnected()`
- `ready()`
- `ping()`
- `shutdown()`
- Clear behavior when `couchset()` is called again with different connection settings.

Requirements:

- Preserve current singleton ergonomics.
- If connection settings change, either close/reconnect with `force: true` or throw a clear error.
- Reassess whether the serverless package is still needed with current Couchbase SDK versions.

## SQL++ Query Examples

These examples are intentionally generic and should be used as implementation/test fixtures. SQL++ is the Couchbase query language formerly called N1QL.

Reference docs:

- SQL++ basics and keyspace paths: https://docs.couchbase.com/server/current/getting-started/try-a-query.html
- Node SDK query placeholders: https://docs.couchbase.com/nodejs-sdk/4.4/howtos/n1ql-queries-with-sdk.html
- Index creation: https://docs.couchbase.com/server/7.2/guides/create-index.html
- JOIN syntax: https://docs.couchbase.com/server/7.6/n1ql/n1ql-language-reference/join.html
- NEST/UNNEST syntax: https://docs.couchbase.com/server/7.6/guides/nest-unnest.html
- Pattern matching functions: https://docs.couchbase.com/server/7.6/n1ql/n1ql-language-reference/patternmatchingfun.html
- `_TIMESERIES` function: https://docs.couchbase.com/server/7.2/n1ql/n1ql-language-reference/timeseries.html

### Keyspace Formatting

Default bucket/default collection:

```sql
SELECT doc.*
FROM `bucketName` AS doc
WHERE doc._type = $type
LIMIT $limit;
```

Fully qualified collection path:

```sql
SELECT doc.*
FROM default:`bucket-name`.scopeName.collectionName AS doc
WHERE doc.status = $status
LIMIT $limit;
```

Implementation note:

- If a bucket, scope, or collection name contains a hyphen or reserved word, wrap that part in backticks.
- For default collection legacy models, `FROM \`bucketName\`` is valid and should remain the default.
- For scoped/collection models, the helper should return a full keyspace path unless a query context is explicitly used.

Suggested helper behavior:

```ts
LegacyModel.keyspace(); // `bucketName`
ScopedModel.keyspace(); // default:`bucketName`.`scopeName`.`collectionName` or equivalent escaped path
UserModel.from("user"); // `${UserModel.keyspace()} AS user`
```

### Named And Positional Parameters

Named parameters:

```ts
const query = `
  SELECT user.*
  FROM ${UserModel.from("user")}
  WHERE user._type = $type
    AND (user.email = $login OR user.username = $login)
  LIMIT $limit
`;

const { rows } = await cluster.query(query, {
  parameters: {
    type: "User",
    login,
    limit: 1,
  },
});
```

Positional parameters:

```ts
const query = `
  SELECT user.*
  FROM ${UserModel.from("user")}
  WHERE user._type = $1
    AND user.owner = $2
  LIMIT $3
`;

const { rows } = await cluster.query(query, {
  parameters: ["UserDevice", owner, 100],
});
```

### Find One

```sql
SELECT raw doc
FROM `bucketName` AS doc
WHERE doc._type = $type
  AND doc.id = $id
  AND doc.deleted IS MISSING
LIMIT 1;
```

Model API target:

```ts
await Model.findOne({
  where: { id, deleted: { $isMissing: true } },
});
```

### Exists

```sql
SELECT RAW COUNT(1) > 0
FROM `bucketName` AS doc
WHERE doc._type = $type
  AND doc.owner = $owner
LIMIT 1;
```

Alternative, often enough:

```sql
SELECT RAW 1
FROM `bucketName` AS doc
WHERE doc._type = $type
  AND doc.owner = $owner
LIMIT 1;
```

Model API target:

```ts
await Model.exists({ where: { owner } });
```

### Count

```sql
SELECT RAW COUNT(1)
FROM `bucketName` AS doc
WHERE doc._type = $type
  AND doc.workspaceId = $workspaceId
  AND doc.deleted IS MISSING;
```

Model API target:

```ts
await Model.count({
  where: {
    workspaceId,
    deleted: { $isMissing: true },
  },
});
```

### Soft-Delete-Aware Listing

```sql
SELECT doc.id, doc.name, doc.status, doc.createdAt, doc.updatedAt
FROM `bucketName` AS doc
WHERE doc._type = $type
  AND doc.deleted IS MISSING
  AND ($workspaceId IS NULL OR doc.workspaceId = $workspaceId)
  AND ($status IS NULL OR doc.status = $status)
ORDER BY doc.createdAt DESC, doc.id DESC
LIMIT $limit
OFFSET $offset;
```

Implementation note:

- The builder may choose to omit optional predicates instead of using nullable parameters.
- Either approach is acceptable as long as user values are passed as query parameters, not interpolated into the SQL++ string.

### Keyset/Cursor Page

```sql
SELECT doc.*
FROM `bucketName` AS doc
WHERE doc._type = $type
  AND doc.owner = $owner
  AND doc.updatedAt <= $before
ORDER BY doc.updatedAt DESC, doc.id DESC
LIMIT $limitPlusOne;
```

Implementation note:

- `queryPage()` should accept `limit`.
- It should execute with `limitPlusOne = limit + 1`.
- It should trim the extra row and set `hasNext`.

### Case-Insensitive Search

Useful for public user/contact-style search fields. Prefer parameters over interpolated regular expressions.

```sql
SELECT doc.id, doc.username, doc.fullname, doc.firstname, doc.lastname, doc.avatar
FROM `bucketName` AS doc
WHERE doc._type = $type
  AND (
    REGEXP_CONTAINS(LOWER(doc.firstname), $pattern)
    OR REGEXP_CONTAINS(LOWER(doc.lastname), $pattern)
    OR REGEXP_CONTAINS(LOWER(doc.fullname), $pattern)
    OR REGEXP_CONTAINS(LOWER(doc.phone), $pattern)
  )
LIMIT $limit;
```

Parameters:

```ts
{
  type: "User",
  pattern: `${search.toLowerCase()}.*`,
  limit,
}
```

Implementation note:

- Regex search may need dedicated indexes or a future FTS helper for large datasets.
- The immediate task is parameter safety and consistent row parsing, not full-text relevance ranking.

### JOIN ON KEYS

Useful for Roadman-style chat documents where a conversation stores document keys for owner/source/last message.

```sql
SELECT convo, owner, lastMessage, source
FROM `bucketName` AS convo
JOIN `bucketName` AS owner
  ON KEYS convo.owner
LEFT JOIN `bucketName` AS lastMessage
  ON KEYS convo.lastMessage
LEFT JOIN `bucketName` AS source
  ON KEYS convo.sourceId
WHERE convo._type = $convoType
  AND convo.owner = $owner
  AND convo.updatedAt <= $before
ORDER BY convo.updatedAt DESC
LIMIT $limitPlusOne;
```

Model include target:

```ts
await ChatConvoModel.findMany({
  where: { owner, updatedAt: { $lte: before } },
  include: [
    { as: "owner", key: "owner", join: "inner" },
    { as: "lastMessage", key: "lastMessage", join: "left" },
    { as: "source", key: "sourceId", join: "left" },
  ],
});
```

### NEST ON KEYS

Useful when the parent document stores an array of document keys.

```sql
SELECT convo, members
FROM `bucketName` AS convo
NEST `bucketName` AS members
  ON KEYS convo.members
WHERE convo._type = $convoType
  AND convo.id = $id
LIMIT 1;
```

Model include target:

```ts
await ChatConvoModel.findOne({
  where: { id },
  include: [{ as: "members", keys: "members", type: "nest" }],
});
```

### Array Predicate

Useful for checking whether an array contains a member id.

```sql
SELECT convo.*
FROM `bucketName` AS convo
WHERE convo._type = $convoType
  AND ANY memberId IN convo.members SATISFIES memberId = $memberId END
LIMIT $limit;
```

### Time-Series Range

Generic form for chunked documents with `ts_data`, `ts_start`, and `ts_end`.

```sql
WITH range_start AS ($startMs),
     range_end AS ($endMs)
SELECT t._t AS date,
       t._v0 AS close,
       t._v1 AS high,
       t._v2 AS low,
       t._v3 AS open,
       t._v4 AS volume
FROM `bucketName` AS d
UNNEST _timeseries(d, {"ts_ranges": [range_start, range_end]}) AS t
WHERE d._type = $type
  AND d.ticker = $ticker
  AND d.ts_start <= range_end
  AND d.ts_end >= range_start
ORDER BY t._t ASC;
```

Aggregated interval form:

```sql
WITH range_start AS ($startMs),
     range_end AS ($endMs)
SELECT IDIV(t._t, $intervalMs) AS bucket,
       AVG(t._v0) AS close,
       MAX(t._v1) AS high,
       MIN(t._v2) AS low,
       AVG(t._v3) AS open,
       SUM(t._v4) AS volume
FROM `bucketName` AS d
UNNEST _timeseries(d, {"ts_ranges": [range_start, range_end]}) AS t
WHERE d._type = $type
  AND d.ticker = $ticker
  AND d.ts_start <= range_end
  AND d.ts_end >= range_start
GROUP BY IDIV(t._t, $intervalMs)
ORDER BY bucket ASC;
```

Implementation note:

- Keep the range predicates in both `_timeseries(... ts_ranges ...)` and `WHERE`; Couchbase docs call this out as useful for pushing date range predicates to index scans.

### Indexes

Basic model discriminator and created date index:

```sql
CREATE INDEX IF NOT EXISTS idx_type_createdAt
ON `bucketName`(_type, createdAt DESC);
```

Soft-delete/list index:

```sql
CREATE INDEX IF NOT EXISTS idx_type_workspace_deleted_createdAt
ON `bucketName`(_type, workspaceId, deleted, createdAt DESC);
```

Partial index:

```sql
CREATE INDEX IF NOT EXISTS idx_active_by_workspace
ON `bucketName`(workspaceId, status, createdAt DESC)
WHERE _type = "Sandbox" AND deleted IS MISSING;
```

Document-key metadata index:

```sql
CREATE INDEX IF NOT EXISTS idx_doc_id
ON `bucketName`(META().id);
```

Array index:

```sql
CREATE INDEX IF NOT EXISTS idx_convo_members
ON `bucketName`(DISTINCT ARRAY memberId FOR memberId IN members END)
WHERE _type = "ChatConvo";
```

Deferred build:

```sql
CREATE INDEX IF NOT EXISTS idx_deferred_example
ON `bucketName`(_type, owner, updatedAt DESC)
WITH {"defer_build": true};
```

Implementation note:

- Avoid recommending primary indexes for app queries. Generate specific secondary indexes from model definitions.
- Use scoped keyspace paths for scoped models.

### CAS In SQL++ Results

Useful when mixing SQL++ reads with KV updates.

```sql
SELECT META(doc).id AS id,
       TOSTRING(META(doc).cas) AS cas,
       doc.*
FROM `bucketName` AS doc
WHERE doc._type = $type
  AND doc.id = $id
LIMIT 1;
```

Implementation note:

- JavaScript cannot safely represent Couchbase CAS as a normal number; use string conversion for SQL++ results and SDK CAS objects for KV operations.

## Public Export Cleanup

Add stable exports for intended utilities:

```ts
import { awaitTo, JSONDATA } from "couchset";
import { awaitTo, JSONDATA } from "couchset/utils";
```

Requirements:

- Keep existing deep import paths working during migration.
- Add package `exports` map when safe.
- Document supported subpaths.

## Testing Notes

Use unit tests for query generation and SDK option passing, and integration tests for real local Couchbase behavior.

Integration tests should read these environment variables:

```env
COUCHBASE_URL
COUCHBASE_BUCKET
COUCHBASE_USERNAME
COUCHBASE_PASSWORD
```

Do not commit local credential values.

Suggested test split:

- Unit tests with mocked Couchbase SDK collection/cluster.
- Integration tests guarded by env vars.
- Compatibility tests proving old APIs still behave as before.
- New strict-mode tests proving new APIs throw useful errors.

## First Implementation Ticket

Start with the query layer because it is high-value and low-risk.

1. Add `Model.queryRows<T>(query, params?, options?)`.
2. Add `Model.queryOne<T>(query, params?, options?)`.
3. Add `Model.queryPage<T>(query, params?, options?)`.
4. Pass params to `cluster.query`.
5. Throw by default in these new methods.
6. Add `Model.from(alias?)` or equivalent keyspace helper.
7. Add tests for params, errors, row shape, pagination, and legacy `customQuery()`.

This unlocks safer migrations in Roadman auth/chat and downstream apps without breaking existing consumers.
