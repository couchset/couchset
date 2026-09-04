# CouchSet next primitives

`couchset/next` adds a client-owned API without changing the singleton-based `Model` and `couchset` APIs. The new client is useful when an application needs dependency injection, isolated tests, model manifests, or an administrative bootstrap connection.

```ts
import {createCouchsetClient, dateCodec, defineModel} from 'couchset/next';

const sessions = defineModel<{id: string; userId: string; expiresAt: Date}>({
  name: 'Session',
  scope: 'auth',
  collection: 'sessions',
  codecs: {expiresAt: dateCodec},
  indexes: [{name: 'idx_session_user', fields: ['userId']}],
});

const db = createCouchsetClient({
  connectionString: process.env.COUCHBASE_URL,
  bucketName: 'app',
  username: process.env.COUCHBASE_USERNAME,
  password: process.env.COUCHBASE_PASSWORD,
  models: [sessions],
});
```

`defineModel()` only describes metadata; `db.model(sessions)` only binds and registers the model. Neither operation creates Couchbase resources. Legacy `new Model()` remains supported and continues to use the existing singleton.

## Provisioning and dynamic models

Run administrative DDL explicitly, with credentials that have `Manage Scopes` and query-index permissions:

```ts
await db.ensureCollections(); // creates missing named scopes, then collections
await db.ensureIndexes();     // CREATE INDEX IF NOT EXISTS only

// An explicitly dynamic model can provision itself.
const reports = await db.registerModel(reportDefinition, {
  provision: {collections: true, indexes: true, waitForIndexes: true},
});
```

Collection creation is idempotent: concurrent already-exists responses are accepted, while existing scopes and collections are never updated, renamed, or dropped. The built-in `_default` scope and collection are not created. A named collection in `_default` is supported. Conflicting collection settings declared for the same target fail instead of silently choosing one.

## Transactions and CAS

```ts
await db.transaction(async (tx) => {
  const session = tx.model(sessions);
  const found = await session.getById(id);
  if (found) await session.remove(found);
});
```

Transaction-bound models use only the SDK transaction attempt context. Couchbase may retry the callback, so it must not send an email, webhook, or other non-idempotent external side effect. Perform that work after the transaction resolves, or use an outbox/idempotency key. Commit-ambiguous errors are surfaced to the caller; CouchSet does not claim success or rerun external work.

For an optimistic single-document workflow:

```ts
const current = await model.getWithCas(id);
await model.replaceIfCas(id, nextValue, current.cas);

const outcome = await model.consumeOnce(id, current.cas);
// {status: 'consumed'} | {status: 'missing'} | {status: 'conflict'}
```

`consumeOnce` issues exactly one conditional remove. It does not re-read and retry with a fresh CAS.

## Index drift

`ensureIndexes()` remains intentionally create-only. It never compares, changes, drops, or rebuilds an existing index. Operators can instead review a plan:

```ts
const plan = await db.planIndexes();
await db.applyIndexPlan(plan); // create missing/versioned replacement indexes and wait for online
await db.applyIndexPlan(plan, {dropReplaced: true}); // explicit old-index removal after review
```

When a live definition drifts, the plan creates a versioned physical replacement and waits for it to become online before an old index can be dropped. This avoids an unindexed interval and makes destructive cleanup an affirmative operator action.

## Eventing functions

Eventing declarations use the Couchbase SDK's `EventingFunctionManager`; they are not document writes. Give each control plane an explicit namespace and a dedicated, already-provisioned metadata collection. CouchSet never opens that collection as application data or reads/writes its documents.

```ts
import {defineEventingFunction} from 'couchset/next';

const auditOrders = defineEventingFunction({
  name: 'audit_orders', // Couchbase function name: billing__audit_orders
  code: 'function OnUpdate(doc, meta) { log(meta.id); }',
  sourceKeyspace: {bucket: 'app', scope: 'sales', collection: 'orders'},
});

const eventing = db.eventing({
  namespace: 'billing',
  metadataKeyspace: {bucket: 'app', scope: 'eventing', collection: 'billing_metadata'},
  definitions: [auditOrders],
});

await eventing.apply();             // reconcile declarations and prune only billing__* stale functions
await eventing.apply(auditOrders);  // apply just this handler; never prunes other declarations
await eventing.pause('audit_orders');
await eventing.remove('audit_orders'); // undeploys then deletes; Eventing timers/checkpoints are lost
```

An ordinary code, setting, or binding change safely pauses, upserts, then reactivates a deployed function. Depending on the Eventing status after an upsert, reactivation uses either `resume` or the compatible `deploy` operation. Matching paused functions resume and matching deployed functions are no-ops. A source or Eventing metadata keyspace change is destructive because Couchbase must undeploy the function, which erases timers and checkpoints. `apply()` returns a `requiresRecreate` outcome without changing it; opt in only after reviewing that consequence:

```ts
await eventing.apply({allowRecreate: true});
```

Reports expose `created`, `updated`, `resumed`, `unchanged`, `pruned`, `paused`, `removed`, and `requiresRecreate` outcome arrays (plus `outcomes` in execution order).

## Tests

`createCouchsetTestFixture(client, definition)` provisions a unique named scope/collection and returns an explicit `cleanup()` helper. Use it in test setup/teardown; fixture cleanup is the only helper that drops a resource.
