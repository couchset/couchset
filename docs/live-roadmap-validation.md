# Additive roadmap live validation

Run `npm run test:roadmap:live` from the repository root. The scripts read the
local `.env` and refuse non-local URLs or a bucket other than `test`. Credentials
are not printed or written into generated CLI configuration. The CLI tests use
the built package entrypoint in real subprocesses, not a mocked command runner.

Verified on September 7, 2026 against Couchbase Enterprise **8.0.3-5933** with
Data, Query, Index, Search, Eventing, Analytics and Backup services enabled.
Analytics and Backup are not used by this feature set.

## Coverage

| Capability | Live assertions |
| --- | --- |
| Definition plugins | Composition, frozen inputs, one-time resolution, conflict rejection, persisted transforms, explicit index provisioning |
| Key strategies | Unconfigured defaults, generated insert/upsert IDs, explicit-ID allow/validate/reject, transaction explicit-ID validation |
| Standard Schema | Sync and async validation, transformations, preserved metadata, stripped unknown fields, rejected replacements leave stored data unchanged, upsert/replace, documented patch bypass |
| Lifecycle hooks | Before/after insert, upsert, replace, patch and delete; reads and projections; soft-delete/restore; before-hook prevention; after-hook errors with persisted writes |
| Query scopes | AND composition, caller/chained undefined predicates, default-filter bypass, projections, findMany/findOne/page/count/exists |
| Domain methods | Local model view, hydrated document save, original-instance isolation, serialization excluding methods |
| Bulk helpers | Model insert/get/delete, CAS reads, ordered fail-fast/skipped items, unordered partial failures, concurrency bound, raw SDK CAS and mutation tokens |
| Transactions | Insert/read/replace/remove hooks and context, validation, key policy, commit, rollback, CAS conflict failure, actual SDK retry notification, after-hook rollback |
| Instrumentation | Operation/query/mutation/slow/failure events, payload exclusion, synchronous/asynchronous observer-error isolation, retry events |
| Search mappings | Text, keyword, numeric, boolean, datetime, geopoint, geoshape and vector mappings on global and scoped indexes |
| Search queries | Text, numeric/boolean/date filters, stored fields, facets, sorting, pagination, returned highlight fragments, mutation-token consistency, model discriminator |
| Vector/hybrid | Dimension guard, nearest-vector results, prefiltered vectors, hybrid text/vector queries, global and scoped indexes |
| Search geo | Radius, box, polygon, geoshape intersects/within/contains |
| GSI geo | Radius and box, distance ordering, offset/limit, codecs, default predicates, soft-delete filtering, additional predicates, antimeridian and polar bounds |
| Search index administration | Create/readiness, matching/no-op planning, stale-plan rejection, replacement opt-in, replacement and convergence |
| CLI | Help, scaffold, inspect, collection plan/apply/idempotence, reviewed GSI plan/apply, Search plan/apply/replacement, missing-plan rejection |
| Eventing plan | Live undeployed function fixtures: create, matching, definition drift and stale-owned reporting; planning does not mutate functions |

The original two smoke scripts remain in the command as regression checks.
`scripts/test-roadmap-live.ts` adds feature-level assertions against stored data
and real query results. `scripts/test-cli-live.ts` covers all CLI command paths.

## Retry semantics observed

With the installed SDK, an operation failure that escapes the transaction
callback is surfaced as `TransactionFailedError`. The conflict test verifies
that a failed transaction does not overwrite the competing non-transactional
write. A separate test creates contention between two real transactions and
allows the native finalize step to process a caught
`TransactionOperationFailedError`; this causes the SDK to rerun the callback
and verifies `onRetry`. The test does not implement an application retry loop.
This is coverage of the callback notification, not a promise that every SDK
operation failure retries automatically, and not general advice to suppress
transaction errors in application code.

## Isolation and limits

Expanded suites create uniquely named `cs_live_*` / `cs_cli_*` scopes and Search
indexes in `test`. Eventing fixtures are saved **undeployed**, never deployed,
and have unique owned names. Cleanup removes only the run's own resources.
The original smoke tests likewise remove their own documents and indexes.
Do not interrupt the process during cleanup; a hard kill can leave fixtures.

This covers every newly introduced feature area on this local server, including
positive and important failure paths. It is not an exhaustive test of every
input, geometry, option combination, cluster topology or server version. No
cluster restart, failover, network partition, or durability reconfiguration is
performed. Compile-time inference and pure composition edge cases are also
covered by the unit/type suites rather than being described as server tests.
