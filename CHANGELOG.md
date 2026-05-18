# Changelog

## 0.3.0 - 2026-05-18

### Compatibility

- Kept the default `couchset` entrypoint on the legacy API so existing projects can upgrade without rewriting model imports.
- Kept `couchset/legacy` as an explicit legacy alias.
- Added `couchset/next` for the modern API.
- Shared one Couchbase connection singleton across legacy and modern models, allowing both APIs to run side by side during gradual migrations.

### Modern API

- Added strict modern model helpers: `insert`, `upsert`, `getById`, `replaceById`, `patchById`, `deleteById`, `findMany`, `findOne`, `page`, `exists`, and `count`.
- Removed old model method names from the modern model surface so the new API can evolve independently.
- Added hydrated document helpers for reload/save/patch/delete workflows.
- Added soft-delete/default-scope helpers, TTL helpers, validation/parse hooks, scoped collection support, include helpers, and declarative index helpers.
- Added safe SQL++ query helpers with named/positional parameters: `queryRows`, `queryOne`, and `queryPage`.
- Added safer keyspace helpers: `Model.bucket()` and `Model.from(alias?)`.

### Connection Lifecycle

- Added lazy model binding so models can be constructed before `couchset()` connects.
- Added lifecycle helpers: `ready`, `ping`, `health`, `shutdown`, and `ensureIndexes`.
- Added reconnect support that is enabled by default, with `COUCHSET_RECONNECT` and `COUCHSET_RECONNECT_INTERVAL_MS` environment controls.
- Added retry/rebind behavior for reconnectable operation failures.

### Starters

- Added modern env-based starter helpers on `couchset/next`: `getConnectionOptions`, `connectionOptions`, `startCouchbase`, and `startCouchbaseServerless`.
- Starter helpers read `COUCHBASE_URL`, `COUCHBASE_BUCKET`, `COUCHBASE_USERNAME`, `COUCHBASE_PASSWORD`, and `COUCHBASE_PROXY`.

### Documentation

- Updated the README for the legacy-default and modern-next import paths.
- Added beta migration notes for running legacy and modern models together.

### Maintenance

- Cleared high and critical `npm audit` findings.
- Updated the publish workflow to the two-job version bump and npm publish flow.
