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
- [Couchbase geospatial Search request properties](https://docs.couchbase.com/server/current/search/search-request-params.html)
- [Couchbase Node.js SDK Search query types](https://docs.couchbase.com/sdk-api/couchbase-node-client/classes/SearchQuery.html)
- [CouchSet's earlier geospatial performance investigation](https://www.couchbase.com/forums/t/performance-with-geospacial-queries/31660)

### Candidate priority

| Priority | Addition | CouchSet-shaped direction |
| --- | --- | --- |
| P0 | Typed model extensions and plugins | Pure or locally applied extensions over `ModelDefinition<T>` and bound models; no mutable global plugin registry. |
| P0 | Full-text and vector search | Typed search operations plus reviewable `planSearchIndexes()` and `applySearchIndexPlan()` infrastructure workflows. |
| P0 | Geospatial search and queries | Typed radius, bounding-box, polygon, and GeoJSON operations with explicit Search-service and GSI execution strategies. |
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

### Geospatial search and queries

Geospatial operations are not currently first-class in CouchSet. Applications
can express numeric latitude/longitude predicates and distance formulas through
raw SQL++, or use the Couchbase SDK directly, but CouchSet does not yet provide
typed geopoints, geoshapes, spatial predicates, distance projections, or search
index definitions.

Geo should be designed as part of the P0 Search surface while retaining two
explicit execution strategies:

```ts
const nearby = await places.geo.withinRadius({
  field: 'location',
  center: {lat: 43.65, lon: -79.44},
  radius: '25km',
  strategy: 'search',
});

const visible = await places.geo.withinBox({
  field: 'location',
  bounds: {north: 44, south: 43, east: -79, west: -80},
  strategy: 'gsi',
});
```

The Search-service strategy should support:

- `geopoint` fields queried by distance/radius, bounding box, and polygon;
- `geoshape` fields using GeoJSON Point, LineString, Polygon, MultiPolygon,
  Circle, Envelope, and GeometryCollection values where supported;
- spatial relations such as `intersects`, `contains`, and `within`;
- distance sorting, distance projection, facets, pagination, and raw SDK query
  escape hatches;
- scoped and global Search indexes, with their distinct SDK entrypoints;
- mutation-state consistency options where supported.

The GSI strategy should support:

- typed numeric latitude and longitude fields;
- index-friendly bounding-box prefilters for map viewports;
- exact great-circle distance projection and filtering after the coarse
  bounding box;
- correct handling of the antimeridian, poles, invalid coordinates, units,
  and longitude normalization;
- reusable index definitions for the numeric fields involved.

The strategy must never be chosen invisibly. Search is the natural choice for
rich shapes and spatial relations. GSI can be attractive for broad map queries,
large result sets, and application-controlled distance math, but implementing
correct spatial logic is non-trivial. An `auto` strategy, if ever added, should
first expose its selected plan and documented constraints.

The earlier CouchSet performance investigation provides an important design
lesson: a Search `size` limit truncates returned results but does not necessarily
reduce the number of candidate hits the Search service evaluates. Very broad
radii can therefore become slower even with a small result limit. CouchSet
should expose total-hit and timing metadata, allow score calculation to be
disabled when irrelevant, and document that narrower predicates, appropriately
sized Search infrastructure, or a GSI prefilter may be required.

Search index planning should understand spatial field mappings:

```ts
const places = defineModel<Place>({
  name: 'Place',
  searchIndexes: [{
    name: 'places_geo',
    fields: {
      location: {type: 'geopoint'},
      serviceArea: {type: 'geoshape'},
    },
  }],
});

const plan = await db.planSearchIndexes();
await db.applySearchIndexPlan(plan);
```

The planner should validate coordinate representation and mappings before
deployment, distinguish missing, matching, and drifted spatial definitions,
and preserve the same explicit, non-destructive apply rules proposed for other
Search indexes.

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

Key strategies are strictly opt-in and consumer-defined. If `key` is absent,
CouchSet must preserve today's behavior exactly: caller-provided IDs continue
to work, generated IDs use the existing algorithm, existing documents remain
addressable, and no key validation, parsing, transformation, or normalization
occurs.

A configured strategy should affect only creation of a missing key by default.
It must not silently rewrite an explicit caller-provided ID:

```ts
await users.insert({
  id: 'custom-existing-key',
  tenantId: 'acme',
  userId: '42',
});
```

The consumer can explicitly choose how supplied IDs interact with the strategy:

```ts
const users = defineModel<User>({
  name: 'User',
  key: {
    create: createUserKey,
    parse: userKey.parse,
    explicitId: 'allow', // compatibility default; alternatives: validate, reject
  },
});
```

CouchSet may export optional composition utilities such as `keyTemplate()`,
`prefixedKey()`, and `uuidKey()`, but none becomes an implicit or global
default. Even `uuidKey()` is explicit syntax, not a replacement for current ID
generation. Strategies may also help generate related keys and validate a key
before a KV operation without forcing key components into every stored
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

### Compatibility contract

All capabilities in this document can be implemented without breaking current
`couchset/next` consumers, but additive syntax alone does not guarantee
compatibility. The implementation contract is:

> A model using none of the new options retains identical runtime behavior,
> generated keys, SQL++, result shapes, types, errors, consistency defaults,
> and infrastructure side effects.

The expected risk and activation boundary for each capability is:

| Capability | Compatibility boundary |
| --- | --- |
| Search, vector, and geo | New model methods and definitions only; no Search DDL during construction, `ready()`, or CRUD. |
| Query scopes | Existing `defaultWhere` and soft-delete composition remains unchanged unless a named scope is called. |
| Plugins and extensions | Activated only by a model's `plugins`; no global registry or import-order behavior. |
| Lifecycle hooks | No hook runs unless declared on that model; raw SDK and SQL++ paths remain explicit bypasses. |
| Validator adapters | Existing `validateCreate`, `validateReplace`, and `parse` contracts remain unchanged. |
| Key strategies | Existing generated and caller-provided ID behavior remains the default when `key` is absent. |
| Instrumentation | Disabled by default; observers cannot change an operation's result or error. |
| Bulk operations | New methods over existing operations; partial failure is represented rather than hidden. |
| Domain methods | Opt-in local extensions; base models are not globally mutated. |
| CLI | A separate executable with no effect on library startup or runtime behavior. |

Implementation must also avoid source-level TypeScript breaks. In particular:

- Do not add required members to public interfaces that consumers may implement
  or mock.
- Do not tighten existing generic constraints solely to support a stronger new
  API.
- Do not change `ModelDefinition<T>` inference for definitions that omit new
  options.
- Prefer new capability interfaces and intersections where adding a required
  method to an existing structural interface would break implementors.
- Avoid wildcard-export name collisions and mandatory runtime dependencies.
- Keep optional validator and instrumentation integrations in adapters or peer
  packages rather than requiring Zod, OpenTelemetry, or another ecosystem.

Each capability should carry compatibility tests that prove:

1. Existing `couchset/next` examples continue to compile unchanged.
2. Generated SQL++ for unchanged operations remains equivalent, with golden
   snapshots where practical.
3. New hooks, plugins, validators, strategies, instrumentation, and DDL remain
   dormant by default.
4. Generated IDs, explicit IDs, projections, hydration, errors, query ordering,
   and consistency defaults remain unchanged without opt-in.
5. Existing public interfaces do not gain new required implementation members.
6. Every administrative capability has an explicit plan or apply activation
   point and never executes implicitly during ordinary runtime startup.

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
