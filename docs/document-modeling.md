# Document Modeling

CouchSet keeps document modeling explicit. Large application objects should not
be the documents that list pages paginate over. Use one model for lightweight
list and routing metadata, then keep the full payload in a separate document
that is fetched by id when a detail view, offline view, export, or worker needs
the whole object.

## Large Documents

Prefer this read shape:

- Fetch large documents by id with `getById()` or `findDocById()`.
- Page smaller metadata documents with `page()` or `findMany()`.
- Denormalize the fields needed for cards, tables, filters, sort order, auth,
  and cleanup onto the paged metadata document.
- Store the heavy nested state, snapshots, logs, source data, or arrays in a
  companion model.
- Join or fetch the companion document only after the caller has selected the
  specific item that needs it.

This keeps list queries fast and predictable. A list page should not read a
large payload only to render a title, status, timestamp, and a few counters.

## Example

```ts
import {Model} from 'couchset/next';

type ReportSummary = {
    id: string;
    tenantId: string;
    payloadId: string;
    title: string;
    status: 'draft' | 'running' | 'complete';
    updatedAt: Date;
    itemCount: number;
    errorCount: number;
};

type ReportPayload = {
    id: string;
    reportId: string;
    tenantId: string;
    sourceRows: unknown[];
    generatedSections: unknown[];
    auditLog: unknown[];
};

const reports = new Model('Report', {
    indexes: [
        {
            name: 'idx_report_tenant_updated',
            fields: ['tenantId', 'updatedAt'],
        },
    ],
});

const reportPayloads = new Model('ReportPayload');
```

Page the lightweight model:

```ts
const page = await reports.page<ReportSummary>({
    select: [
        'id',
        'tenantId',
        'payloadId',
        'title',
        'status',
        'updatedAt',
        'itemCount',
        'errorCount',
    ],
    where: {tenantId: {$eq: tenantId}},
    orderBy: {updatedAt: 'DESC'},
    limit: 25,
});
```

Fetch the heavy document by id only when needed:

```ts
const summary = await reports.getById<ReportSummary>(reportId);
const payload = await reportPayloads.getById<ReportPayload>(summary.payloadId);
```

Use stable id formulas so the relationship is obvious and easy to backfill:

```ts
const reportId = 'report::123';
const payloadId = `report-payload::${reportId}`;
```

## Joining

CouchSet includes can join related documents by key, but large payload joins
should be reserved for focused detail reads or small result sets.

```ts
const report = await reports.findOne({
    where: {id: {$eq: reportId}},
    include: [
        {
            as: 'payload',
            key: 'payloadId',
            model: reportPayloads,
            optional: true,
        },
    ],
});
```

For client-bound models, the related type is inferred and `payload` may be absent
or null for an unmatched optional join. See [joined reads](joins-and-consistency.md)
for ANSI predicates, projection codecs, and alias requirements.

For list pages, keep the companion model out of the query and rely on summary
fields instead.

## Migrations

When splitting an existing large document:

- Add the summary fields to the lightweight model first.
- Backfill companion payload documents with deterministic ids.
- Keep ownership fields such as `tenantId`, `workspaceId`, or `userId` on both
  documents when they are needed for authorization or cleanup.
- Keep lifecycle fields such as `createdAt`, `updatedAt`, `deleted`, and
  `deletedAt` on both documents if each document can be cleaned up separately.
- Switch list reads to the lightweight model before removing legacy heavy
  fields from the list path.

The split is a read-model decision, not a CouchSet requirement. Keep a single
document when callers normally need the whole object and the document remains
small enough for the expected list and query volume.
