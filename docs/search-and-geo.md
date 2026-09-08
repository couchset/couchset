# Search and geospatial queries

Client definitions may declare `searchIndexes` with `name`, optional `scoped`,
and a `fields` map. Fields support text, number, boolean, datetime, geopoint,
geoshape and vector mappings. Vector fields require `dims`; similarity defaults
to dot_product. Search indexes cover the declared collection; model queries
add a keyword `_type` constraint.

```ts
const places = defineModel<Place>({name: 'Place', searchIndexes: [{
  name: 'places_search', fields: {
    name: {type: 'text', store: true},
    location: {type: 'geopoint'},
    embedding: {type: 'vector', dims: 3},
  },
}]});
db.model(places);
const plan = await db.planSearchIndexes();
await db.applySearchIndexPlan(plan);
const search = db.search(places, 'places_search');
await search.match('name', 'coffee');
await search.withinRadius({field: 'location', center: {lat: 43.65, lon: -79.44},
  radius: '5km', strategy: 'search'});
await search.vector('embedding', [0.1, 0.2, 0.3], {numCandidates: 20});
```

`query(rawSearchQuery, sdkOptions)` exposes Search JSON and SDK options,
including facets, highlighting, sorting, pagination, and mutation-state
consistency. `vector` accepts a `filter` prefilter and optional `searchQuery`
for hybrid search. Results are SDK hits and metadata; stored fields remain
unknown and are not presented as fully hydrated model documents. Vector and
scoped-index support depend on the server version and available services.

The Search surface refuses definitions with SQL++ defaultWhere or softDelete
enabled because these predicates cannot be safely translated automatically.
Use a separate explicit Search definition and supply Search filters as needed;
do not treat any model filter as an authorization boundary. Raw SDK access is
still available.

`withinBox`, `withinPolygon`, and `shape` target geopoint/geoshape mappings.
Points use `{lat, lon}`; GeoJSON coordinate arrays use `[lon, lat]`. Geometry
relation compatibility and GeoJSON shape validation are ultimately enforced by
Couchbase. SDK sorting can order by geo_distance. Search result limits do not
bound all candidate work; inspect SDK metadata for timing and hit counts.

For numeric GSI geo operations use `db.geo(definition)` and an explicit
`strategy: 'gsi'`. `withinBox` uses normal model reads and filters. `withinRadius`
uses a bounding-box prefilter followed by great-circle distance calculation in
SQL++ before ordering and pagination, returning `{document, distanceKm}` rows.
It preserves the definition's default predicate or soft-delete filter and parses
document codecs. Coordinates are `field.lat` and `field.lon`. Named scope views
are separate; pass extra predicates with `where`. Provision appropriate numeric
GSI indexes explicitly. The helper handles antimeridian and polar bounds;
distances assume a spherical Earth with radius 6371 km.

Search planning is read-only. Applying a plan checks catalog UUIDs and refuses
stale plans. Missing indexes are created explicitly; drift requires
`allowReplace: true`, which updates that index and can rebuild it. There are no
automatic drops. The planner compares managed mappings and partition count,
normalizing catalog defaults; server storage-tuning settings are not managed.
Readiness means a Search query can execute, not that all mutations are indexed.
Use consistency tokens or application-specific ingestion checks when required.

Live verification: `npx tsx scripts/test-search-live.ts` uses only `.env`'s local
test bucket and cleans up its own document and generated GSI/Search indexes.
