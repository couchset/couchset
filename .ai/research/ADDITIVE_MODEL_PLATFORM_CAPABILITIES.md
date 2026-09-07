# CouchSet additive model and platform research

## Direction

The client, transaction, CAS, provisioning, typed-model, index-planning,
Eventing, and test-fixture primitives described earlier have now established a
broader foundation than a conventional ODM. The next additions should build on
that foundation rather than redirect CouchSet toward a mutable, implicit
Mongoose-style architecture.

Ottoman remains a useful source of ideas. In particular, its schema plugins,
lifecycle hooks, custom model methods, runtime constraints, full-text search,
query builder, and CLI demonstrate conveniences users value in an ODM. CouchSet
can adopt the capabilities while expressing them through local, typed,
client-owned, and opt-in primitives.

References:

- [Ottoman schema, hooks, plugins, methods, and indexes](https://ottomanjs.com/docs/basic/schema)
- [Ottoman model API](https://ottomanjs.com/docs/basic/model)
- [Ottoman query builder](https://ottomanjs.com/docs/basic/query-builder)
- [Ottoman full-text search](https://ottomanjs.com/docs/advanced/fts)
- [Ottoman transactions](https://ottomanjs.com/docs/advanced/transactions)

### Candidate priority

| Priority | Addition | CouchSet-shaped direction |
| --- | --- | --- |
| P0 | Typed model extensions and plugins | Pure or locally applied extensions over `ModelDefinition<T>` and bound models; no mutable global plugin registry. |
| P0 | Full-text and vector search | Typed search operations plus reviewable `planSearchIndexes()` and `applySearchIndexPlan()` infrastructure workflows. |
| P0 | Reusable typed query scopes | Named and parameterized scopes that compose with `defaultWhere`, soft-delete modes, pagination, projections, and includes. |
| P1 | Typed lifecycle hooks | Explicit per-model hooks around inserts, replacements, patches, deletes, and reads, with transaction retry behavior documented. |
| P1 | Runtime-validator adapters | A standard adapter boundary for Standard Schema, Zod, Valibot, and similar libraries, alongside the existing validation hooks. |
| P1 | Typed key strategies | Declarative Couchbase document-key creation and parsing for domain keys, while retaining generated and caller-provided IDs. |
| P1 | Operation instrumentation | Per-client tracing, metrics, structured logging, retry, and slow-operation callbacks, designed to support OpenTelemetry adapters. |
| P1 | Bulk operations | Concurrency-controlled typed reads and mutations with per-item results, CAS values, mutation tokens, and partial-failure reporting. |
| Later | Custom model and hydrated-document methods | Type-safe domain methods added without requiring subclassing or changing the base model surface. |
| Later | Administrative CLI | Model scaffolding and inspect/plan/apply commands for collections, indexes, search indexes, and Eventing. |

### Typed extensions and plugins

Reusable model behavior should be composable without introducing global state:

```ts
const users = defineModel<User>({
  name: 'User',
  plugins: [audited(), ownedByTenant(), optimisticVersion()],
});
```

A plugin may contribute definitions, hooks, scopes, indexes, codecs, or domain
methods. Applying the same ordered plugin list should produce the same model
definition. Conflicting contributions should fail during definition or client
registration rather than depend on import order.

Useful first-party or example plugins could cover audit metadata, tenant
ownership, slugs, document versioning, field encryption, and optimistic
locking. Global plugins are deliberately excluded because they make model
behavior depend on ambient process state.

### Typed lifecycle hooks

Hooks can extend the existing `validateCreate`, `validateReplace`, and `parse`
points without changing their behavior:

```ts
const users = defineModel<User>({
  name: 'User',
  beforeInsert: async (input, context) => input,
  afterInsert: async (document, context) => {},
  beforeDelete: async (document, context) => {},
});
```

Candidate phases include `beforeInsert`, `afterInsert`, `beforeReplace`,
`afterReplace`, `beforePatch`, `afterPatch`, `beforeDelete`, `afterDelete`, and
`afterRead`. Hooks should be local to a definition, ordered deterministically,
and bypassable through explicit raw SDK and SQL++ escape hatches.

Transaction-bound hooks need especially clear semantics: a callback and its
pre-commit hooks may execute more than once. Irreversible work such as email,
webhooks, or queue publication must not occur inside a retryable phase. If
post-commit effects are eventually supported, they need a distinct API and
must not be confused with ordinary `afterInsert` hooks.

### Runtime-validator adapters

CouchSet should not recreate Ottoman's full runtime schema language. It can
instead accept an optional validator implementing a small adapter contract:

```ts
const users = defineModel<User>({
  name: 'User',
  validator: standardSchema(userSchema),
});
```

Adapters may provide defaults, coercion, required fields, enums, ranges,
immutable-field checks, and structured errors. The existing validation hooks
remain valid and dependency-free. Validation timing must be explicit for
insert, replace, patch, query hydration, and transaction-bound operations.

### Full-text and vector search

Search is the most important Couchbase platform surface not yet represented by
the model layer:

```ts
const result = await users.search({
  index: 'users_search',
  query: {match: 'ceddy', field: 'displayName'},
  fields: ['displayName', 'bio'],
});
```

Search definitions should participate in a safe infrastructure lifecycle:

```ts
const plan = await db.planSearchIndexes();
await db.applySearchIndexPlan(plan);
```

The plan should distinguish missing, matching, and drifted definitions; expose
the server-side change before applying it; wait for readiness; and never delete
or replace an existing search index without explicit opt-in. Vector queries,
hybrid text/vector search, highlighting, facets, scoring, and raw SDK escape
hatches can be layered onto the same model-owned surface.

### Reusable typed query scopes

Generalize the successful `defaultWhere`, `withDeleted()`, `onlyDeleted()`, and
`withoutDefaultWhere()` pattern into composable named scopes:

```ts
const users = defineModel<User>({
  name: 'User',
  scopes: {
    active: () => ({where: {disabledAt: {$isNotValued: true}}}),
    forTenant: (tenantId: string) => ({where: {tenantId: {$eq: tenantId}}}),
  },
});

await db.model(users).scopes.active().forTenant(tenantId).page();
```

Scopes should merge through a documented composition rule, remain inspectable,
and preserve the types of projections, includes, codecs, and result shapes.

### Typed Couchbase key strategies

Document keys are a core Couchbase modeling tool and deserve an explicit,
type-safe abstraction:

```ts
const users = defineModel<User>({
  name: 'User',
  key: {
    create: ({tenantId, userId}) => `tenant::${tenantId}::user::${userId}`,
    parse: userKey.parse,
  },
});
```

This remains optional. Caller-provided IDs and CouchSet-generated IDs continue
to work. Key strategies should also help generate related keys and validate a
key before a KV operation without forcing key components into every stored
document.

### Instrumentation

Client-owned instrumentation should expose useful operation facts without
requiring applications to patch models or enable global logging:

```ts
const db = createCouchsetClient({
  instrumentation: {
    onQuery,
    onMutation,
    onRetry,
    onSlowOperation,
  },
});
```

Events should include operation name, model and keyspace, duration, outcome,
retry count, and a safely redacted statement or parameter summary. They must
not emit document bodies, credentials, or query parameters by default.

### Bulk operations

Bulk helpers should be thin, predictable orchestration over existing model
operations rather than pretend Couchbase offers an atomic multi-document batch:

```ts
const result = await users.insertMany(records, {
  concurrency: 20,
  ordered: false,
});
```

Results should retain input ordering and report success or failure per item,
including document ID, CAS, mutation token, and typed error. Options should make
fail-fast versus complete-all behavior explicit. Atomic multi-document work
continues to use `db.transaction()`.

### Domain methods and administrative CLI

Bound models and hydrated documents can eventually accept typed local domain
methods without subclassing. This offers Ottoman-style statics and instance
methods while retaining CouchSet's existing model surface and client ownership.

A small CLI can then make the infrastructure capabilities discoverable:

```sh
couchset model User
couchset collections plan
couchset indexes plan
couchset search-indexes plan
couchset eventing plan
couchset inspect
```

Plan commands should be read-only. Apply commands should require an explicit
action and print a reviewable result. Runtime startup must remain free of
implicit DDL.

### Guardrails for this horizon

- Every capability is additive and opt-in; existing imports and behavior stay
  unchanged.
- Prefer immutable definitions and client-local composition over global mutable
  registries.
- Do not turn ordinary CRUD into implicit DDL, search-index deployment, or
  external side effects.
- Preserve raw Couchbase SDK and SQL++ escape hatches.
- Keep runtime validation adapter-based rather than coupling CouchSet to one
  schema package.
- Treat transaction retries, partial bulk failures, redaction, and
  infrastructure drift as first-class correctness concerns.
- Adopt Ottoman's useful affordances without adopting an active-record or
  Mongoose-compatible identity as CouchSet's architectural direction.

