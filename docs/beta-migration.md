# CouchSet Beta Migration

The beta release keeps the main `couchset` import on the legacy implementation so existing projects can upgrade safely. The modern implementation is available from `couchset/next`.

```ts
import {Model as LegacyModel} from 'couchset';
import {Model as NextModel} from 'couchset/next';

const legacyUsers = new LegacyModel('User');
const nextUsers = new NextModel('User');
```

Use `couchset` when an application depends on old pagination or custom query behavior. New work should use `couchset/next`.

Modern and legacy models share the same connection singleton. Initialize CouchSet once and use both model APIs side by side while migrating.

```ts
import {couchset, Model} from 'couchset';
import {Model as NextModel} from 'couchset/next';

await couchset(args);

const legacyUsers = new Model('User');
const nextUsers = new NextModel('User');
```

## Connection Lifecycle

Models can be constructed before the Couchbase connection is ready. Model methods wait for the shared connection before touching the bucket or collection.

```ts
import {couchset, Model, ready, health, ping, shutdown} from 'couchset/next';

const users = new Model('User');

await couchset({
    connectionString: process.env.COUCHBASE_URL || 'couchbase://localhost',
    username: process.env.COUCHBASE_USERNAME || 'admin',
    password: process.env.COUCHBASE_PASSWORD || '1234',
    bucketName: process.env.COUCHBASE_BUCKET || 'dev',
});

await ready();
await ping();
console.log(health());

await couchset.ready();

const user = await users.insert({userId: 'ceddy'});

await shutdown();
```

Reconnect is enabled by default. It can be controlled with connection args or environment variables.

```ts
await couchset({
    connectionString: 'couchbase://localhost',
    username: 'admin',
    password: '1234',
    bucketName: 'dev',
    autoReconnect: true,
    reconnectIntervalMs: 5000,
});
```

Environment flags:

- `COUCHSET_RECONNECT`: defaults to enabled. Use `false`, `0`, or `no` to disable.
- `COUCHSET_RECONNECT_INTERVAL_MS`: reconnect and health-check interval in milliseconds. Defaults to `5000`.

`couchset/next` also exports env-based starter helpers:

```ts
import {startCouchbase, startCouchbaseServerless} from 'couchset/next';

await startCouchbase();
await startCouchbaseServerless();
```

The starters can instead read one `DB_URL` such as `couchbase://user:password@localhost/bucket` (or `couchbases://` for TLS). It takes precedence over `COUCHBASE_URL`, `COUCHBASE_BUCKET`, `COUCHBASE_USERNAME`, and `COUCHBASE_PASSWORD`; `COUCHBASE_PROXY` and explicit `CouchsetArgs` overrides remain supported.

## Query Behavior

Modern query helpers throw by default. This makes production failures visible and keeps silent fallbacks explicit.

```ts
const rows = await users.findMany({
    where: {userId: {$eq: 'ceddy'}},
});

const page = await users.page({
    where: {userId: {$eq: 'ceddy'}},
    limit: 25,
    page: 0,
});

const customRows = await users.queryRows(
    `SELECT * FROM ${users.bucket()} WHERE userId=$userId LIMIT $limit`,
    {userId: 'ceddy', limit: 25}
);
```

If a caller intentionally wants the old empty-result fallback, pass `throwOnError: false`.

```ts
const rows = await users.findMany({
    where: {userId: {$eq: 'ceddy'}},
    limit: 25,
    page: 0,
    throwOnError: false,
});
```

## Safer SQL++ Helpers

Use the model keyspace helpers instead of hardcoding bucket names.

```ts
users.bucket(); // `dev`
users.from('u'); // `dev` AS u
```

For scoped collections, `from()` includes the full keyspace.

```ts
const audit = new Model('AuditEvent', {
    scope: 'app',
    collection: 'events',
});

audit.from('event'); // `dev`.`app`.`events` AS event
```

## New Model APIs

The modern path includes safer read, write, document, TTL, include, index, and time series helpers.

```ts
await users.insert({id: 'user::1', userId: 'ceddy'});
await users.patchById('user::1', {$set: {email: 'ceddy@example.com'}});
await users.softDeleteById('user::1');
await users.restoreById('user::1');

const exists = await users.exists({where: {userId: {$eq: 'ceddy'}}});
const count = await users.count({where: {userId: {$eq: 'ceddy'}}});
```

## Removed Modern Model Aliases

The old method names belong to the default `couchset` entrypoint and the explicit `couchset/legacy` alias.

| Old method | Modern method |
| --- | --- |
| `create()` | `insert()` or `upsert()` |
| `findById()` | `getById()` |
| `updateById()` / `save()` | `replaceById()` or `patchById()` |
| `delete()` | `deleteById()` |
| `pagination()` | `findMany()` or `page()` |
| `customQuery()` | `queryRows()`, `queryOne()`, or `queryPage()` |

Index declarations can live on the model and be created at app boot.

```ts
const users = new Model('User', {
    indexes: [
        {
            name: 'idx_user_userId',
            fields: ['userId'],
        },
    ],
});

await couchset.ensureIndexes();
```
