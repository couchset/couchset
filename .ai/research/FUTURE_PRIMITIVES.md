# CouchSet additive future primitives

## Direction

CouchSet should continue building on its existing model-first Couchbase API.
The modern `couchset/next` entrypoint already provides a strong foundation:
models, scoped collections, direct document operations, indexes, TTL, safe
SQL++ parameters, hydrated documents, validation hooks, time-series helpers,
and raw SDK escape hatches.

The additions below make correctness-sensitive application work more ergonomic
while retaining the existing simple model API, modern APIs, raw query support,
and legacy compatibility.

## Existing API stays intact

This is an additive roadmap. It does not propose removing or weakening any
existing feature.

- `import {Model} from 'couchset'` and its established behavior remain stable.
- `couchset/next` remains the place for new opt-in APIs.
- Existing models, query helpers, indexes, validation hooks, hydrated
  documents, TTL helpers, time-series helpers, and raw SQL++/SDK escape hatches
  remain available.
- New APIs should complement current methods and be introduced beside them,
  using the same compatibility approach as the existing modern entrypoint.

## Explicit non-goal: application schema migrations

Couchbase is schemaless. Application document-field evolution remains owned by
the application backend rather than a new CouchSet migration runner.

Applications can use a `version` field when it helps, compatible reads,
normalizing on the next write, and exceptional one-off backfills. CouchSet
continues to declare and create indexes with `ensureIndexes()` because indexes
are operational infrastructure, not application document-schema migrations.

## Priority matrix

| Priority | Addition | Why it matters |
| --- | --- | --- |
| P0 | Transaction-bound client and model API | Adds a typed, model-level path to Couchbase transactions while retaining direct `cluster.transactions()` access for applications that want it. It makes retry-safe callback semantics explicit. |
| P0 | Client factory and dependency injection | Adds `createCouchsetClient()` alongside the convenient shared singleton, so applications and isolated tests can own a connection when useful. |
| P0 | CAS convenience APIs | Builds on existing metadata and mutation support with typed `getWithCas`, `replaceIfCas`, and `consumeOnce` helpers for optimistic concurrency and one-time document consumption. |
| P0 | Scope and collection provisioning | Adds an explicit, idempotent `ensureCollections()` or `provision()` step that creates the named model scopes and collections before existing index provisioning runs. |
| P1 | Strong model typing | Adds an opt-in `defineModel<T>()` layer for document shapes, inserts, projections, patches, codecs, and declared index fields while preserving current generic model calls. |
| P1 | CouchSet test kit | Adds disposable isolated scopes or collections, cleanup helpers, and index-readiness waiting for deterministic repository tests. |
| Later | Typed SQL++ template helper | Complements existing parameterized raw-query helpers with richer inference for advanced SQL++ use cases. |

## Transaction API shape

Transactions are the highest-value addition. New transaction-bound model
methods should bind to the transaction context while existing model and raw SDK
paths continue to work as they do today.

```ts
const db = createCouchsetClient(config);

await db.transaction(async (tx) => {
  const identities = tx.model(identityModel);
  const sessions = tx.model(sessionModel);

  // Reads and writes are part of one Couchbase transaction.
  // The callback can be retried, so it contains no email, webhook, or other
  // external side effect.
});
```

The API should document that callbacks may run more than once. Applications
perform external side effects only after `await db.transaction(...)` resolves.

## Scope and collection provisioning

Models already declare their Couchbase target:

```ts
const sessions = new Model('Session', {
  scope: 'auth',
  collection: 'sessions',
});
```

CouchSet can use its registered model targets to provide an explicit bootstrap
operation:

```ts
await couchset.ensureCollections();
await couchset.ensureIndexes();

// Or, as a convenience for an administrative bootstrap process:
await couchset.provision({collections: true, indexes: true});
```

It should have these semantics:

- Create missing named scopes, then missing named collections, and treat
  already-exists results as success.
- De-duplicate targets when several models share one collection.
- Skip the built-in `_default` scope and `_default` collection.
- Optionally accept supported collection settings such as a collection-level
  maximum expiry.
- Wait until created collections are usable before running the existing index
  provisioning path.
- Never drop, rename, reconcile, or alter an existing scope or collection.

Provisioning must stay explicit rather than being silently run by every
application process at startup. Normal runtime credentials should be limited to
data access; a bootstrap command or dedicated administrative client can carry
the extra Couchbase `Manage Scopes` privilege needed to create resources.

Buckets remain cluster infrastructure and stay outside this helper. CouchSet
can create resources *inside* an existing bucket, but should not create or
resize buckets.

## CAS helpers

The existing metadata and raw SDK escape hatches stay available. These helpers
make common correctness operations first-class:

```ts
const document = await links.getWithCas(id);
await links.consumeOnce(id, document.cas);

await users.replaceIfCas(id, nextUser, document.cas);
```

`consumeOnce` should surface a clear missing-or-already-consumed result, so
short-lived verification documents do not need application-specific CAS loops.

## Type-system direction

Keep validation library-agnostic. An initial typed-model API can complement the
existing model and validation APIs without inventing a new runtime schema
language:

```ts
type Session = {
  id: string;
  userId: string;
  expiresAt: Date;
};

const sessions = defineModel<Session>({
  name: 'Session',
  scope: 'auth',
  collection: 'sessions',
  codecs: {expiresAt: dateCodec},
  indexes: [{name: 'idx_session_user', fields: ['userId']}],
});
```

This should make invalid field names in patches, projections, and index
definitions a TypeScript error while retaining `validateCreate`,
`validateReplace`, and `parse` hooks for runtime validation and transforms.

### What a codec does

Codecs are optional field transformers. They keep an application's TypeScript
value pleasant to use while consistently converting it to the JSON value stored
in Couchbase.

For example, Couchbase documents store JSON, so a JavaScript `Date` becomes a
string or timestamp when persisted. A date codec makes the conversion explicit:

```ts
dateCodec.toDatabase(new Date('2026-09-04T12:00:00.000Z'));
// "2026-09-04T12:00:00.000Z"

dateCodec.fromDatabase('2026-09-04T12:00:00.000Z');
// Date instance
```

Then `codecs: {expiresAt: dateCodec}` means application code reads and writes
`expiresAt` as a `Date`, without repeatedly parsing the stored JSON string.
This is an additive, more explicit companion to CouchSet's existing
`dateFields` and date-schema handling; it does not replace either.

## Additive design boundaries

- Preserve all existing API surfaces and add new behavior as opt-in methods or
  entrypoints.
- Keep raw SQL++ and SDK escape hatches available for applications that need
  advanced joins, projections, or Couchbase-specific operations.
- Keep validation dependency-free: adapters and hooks remain the integration
  point for Zod, Yup, or application-provided validators.
- Keep application document evolution in the backend that owns each document.
