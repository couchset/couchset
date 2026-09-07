# Operational helpers

`createCouchsetClient({instrumentation})` accepts onOperation, onQuery,
onMutation, onSlowOperation and a slowOperationMs threshold. Events contain
model name, method, duration and outcome only; no documents, credentials,
parameters or raw error messages are emitted. Observers are not awaited and
their failures do not change operation outcomes. Nested model operations may
produce separate events (for example soft-delete includes a patch). SDK retries
are opaque; onRetry reports repeated transaction callback attempts only.
These callbacks can feed application-owned tracing/metrics adapters without
requiring an instrumentation package. Instrumentation is disabled by default.

`bulkMap(items, asyncOperation, {ordered, concurrency})` returns input-ordered
fulfilled/rejected/skipped results. The default is ordered, serial execution
which stops after failure. `ordered: false` completes all work with bounded
concurrency (default 8). Results retain the operation's exact return value,
including SDK CAS and mutation tokens when using an SDK operation. Bulk work is
not atomic and failed items are never silently retried.

`withModelBulk(model)` preserves ordinary model methods on a local view and
adds insertMany, getMany and deleteMany, rejecting member collisions and using existing
model semantics, keys, validators and hooks. getMany returns model CAS metadata;
insertMany returns existing model insert results, which do not include mutation
tokens. Use bulkMap with SDK operations when those exact SDK mutation results
are required; that path intentionally bypasses model hooks. No extra read is
performed to fabricate mutation metadata.

`withDocumentMethods(hydratedDocument, methods)` creates a hydrated copy with
non-enumerable domain methods. Its own data remains available to save/toJSON,
and existing members cannot be replaced. This copies data shallowly, matching
normal hydrated-document object behavior. Use normal functions for a typed this.

## CLI

The package exposes `couchset`. `couchset model User` prints a starter definition
without writing files. `--help` lists commands. Administrative commands require
`--config ./couchset.config.cjs`, trusted application code exporting `db` as a
CouchsetClient with model registrations. Export an Eventing controller as
`eventing` to use `eventing plan`. Config loading itself can run application
code; keep configuration free of provisioning side effects.

- `inspect`: model and index names without configuration secrets.
- `collections plan`: missing/matching model collections, read-only.
- `collections apply`: explicit create-only provisioning.
- `indexes plan` and `search-indexes plan`: print JSON plans.
- `indexes apply --plan ./plan.json`: apply a reviewed index plan.
- `search-indexes apply --plan ./plan.json`: apply a reviewed Search plan;
  replacement additionally requires `--allow-replace`.
- `eventing plan`: read-only function-definition drift and stale owned names.
  This is a definition report, not a deployment/lifecycle readiness report.

There is no automatic index drop, Eventing prune, package import DDL, or startup
provisioning in the CLI. Explicit Eventing deployment remains available through
the existing application API. The CLI closes its configured client on exit.
