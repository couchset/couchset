# Model definition plugins

`couchset/next` exports `defineModelPlugin<T>()` for local, synchronous option
composition. Plugins run when `defineModel()` resolves the definition. Passing
an unresolved definition to `db.model()` also resolves its plugins.

```ts
const searchableName = defineModelPlugin<User>(() => ({
  indexes: [{name: 'user_name', fields: ['name']}],
}));
const users = defineModel<User>({name: 'User', plugins: [searchableName]});
```

Plugins receive a deeply frozen copy of options accumulated so far and return
only their contributions. Named indexes and date fields deduplicate; schema,
codec and collection-setting maps merge by field. Conflicting contributions
throw. Scalar options and validation functions must agree if already declared.
Plugins cannot change the model name, scope or collection or add nested plugins.

Input and contribution objects are copied, preserving function references.
Plugin-enabled definitions accept plain objects, arrays and functions; mutable
class instances and cycles are rejected. Plugin functions must be synchronous
and free of side effects. Resolution removes the plugin list, so binding an
already resolved definition does not run plugins again. A plugin that creates
fresh functions on each resolution should be resolved once and the resulting
definition reused for repeated registration.

Models without plugins keep their existing behavior. No connection or DDL is
performed during composition. Index provisioning remains explicit.

Plugins can contribute existing model options. Search and operational helpers
have dedicated guides in search-and-geo.md and operations.md. Research examples
remain API sketches; these guides describe the implemented entrypoints.

## Lifecycle hooks

Client definitions accept `hooks` with optional before/after Insert, Upsert,
Replace, Patch, Delete phases and `afterRead`. Before write hooks return the
input to persist; beforeDelete receives the ID and returns nothing. After hooks
observe the parsed result; delete hooks receive the ID. Read observers receive
each row and must allow partial projections. No hook is enabled by default.

Contexts include the operation and `transaction`. Transaction hooks run within
the SDK's retryable attempt and may run repeatedly. They are not post-commit
callbacks and must not send email or perform other irreversible effects.
After-hook failures produce `ModelAfterHookError`: an ordinary operation has
already succeeded, while a transaction attempt may roll back. Do not blindly
retry an ordinary mutation after this error.

Hooks cover model insert/upsert, replaceById, patchById, deleteById and reads.
Aliases that delegate to those operations inherit the hooks. Raw queries,
mutateById, incrementById, consumeOnce, and manual parse/hydrate calls are
explicit bypasses. Direct softDeleteById/restoreById delegate to patchById and
therefore run Patch hooks. A soft delete through deleteById runs beforeDelete,
beforePatch, the mutation, afterPatch, then afterDelete. Transaction get/insert/replace/
remove use the corresponding read/insert/replace/delete hooks. Definition hooks
are available on client-bound models; ordinary `new Model()` is unchanged.

## Consumer-defined keys and runtime validation

`defineModel<T>({name, key: {create, parse?, explicitId?}})` enables a key
strategy. Without `key`, ID behavior is unchanged. `create(document)` runs
synchronously only when an insert/upsert has no ID. An explicit ID passes
through by default; `explicitId: 'validate'` requires `parse(id)` to return a
non-null, non-false synchronous result, while `'reject'` rejects supplied IDs.
Strategies do not rewrite read, patch, replace, delete, or existing keys.
Transactions currently require an explicit insert ID, which follows the same
explicit-ID policy. A reject policy therefore disallows that transaction insert.

`withModelValidator(schema)` adapts a Standard Schema v1 validator into a model
plugin. It supports synchronous or asynchronous validation, structured
`ModelValidationError.issues`, and output transformations. CouchSet's generated
metadata is preserved even when the validator strips unknown fields. Validation
uses existing create/upsert and replace pipelines, including transaction
preparation. Patches, raw mutations, and reads do not run full-document
validation. Existing validation hooks are not silently replaced: composition
conflicts throw. No validation package is required by CouchSet.

## Query scopes and domain methods

`withModelScopes(model, definitions)` creates a query view with typed,
parameterized scopes:

```ts
const scoped = withModelScopes(users, {
  forTenant: (tenantId: string) => ({where: {tenantId}}),
  summary: () => ({select: ['name'] as const}),
});
const query = scoped.scopes.forTenant('acme').scopes.summary();
query.inspect();
await query.findMany({limit: 20});
```

Predicates combine with AND. Other options use the last declaration, with
arguments supplied to a read taking precedence. Projection and include types
flow through the chain. `queryOptions` is replaced as a whole so incompatible
consistency modes are never combined implicitly. Definitions and inspection
results copy plain data; SDK objects retain their identity. Scopes are query
views and do not provide scoped writes or raw SQL++ execution.

`withDeleted()`, `onlyDeleted()`, and `withoutDefaultWhere()` preserve named
scope predicates while forwarding their existing behavior to the base model.
These filters are conveniences, not an authorization boundary.

`withModelMethods(model, methods)` adds methods on a new local view:

```ts
const directory = withModelMethods(users, {
  findByName(name: string) { return this.findOne({where: {name}}); },
});
await directory.findByName('Jane');
```

Methods get a typed model `this` and cannot replace existing members. The
original model and global prototypes are unchanged. Call methods on the view;
detaching a method loses its `this`. `withDocumentMethods` provides a separate
hydrated-copy extension helper; see operations.md.

Live verification: `npx tsx scripts/test-plugins-live.ts` reads `.env`, requires
a localhost connection and bucket `test`, and removes only its own test document
and generated index.
