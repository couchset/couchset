# Website docs conventions

Guidance for agents editing `website/content/docs/*.mdx`.

## Linking

- **Pages already on the site** (`website/content/docs/*.mdx`): use root-absolute site paths with the `/docs/` prefix, e.g. `[Eventing](/docs/eventing)` or `[Operations and CLI](/docs/operations-cli-eventing)`. Match the Capability map and Card `href`s. Do not use `./…` relative MDX links for in-site navigation, and do not point those pages at GitHub blob URLs.
- **See also**: only link pages that are actually related to the current topic (e.g. Eventing → CLI / provisioning / API; not Time series). Do not cross-link unrelated sibling topics just because they were split in the same docs pass.
- **Repo docs not published on the site yet** (root `docs/*.md`, research notes): use full GitHub links, e.g. `https://github.com/couchset/couchset/blob/master/docs/next-primitives.md#eventing-functions`.
- Prefer promoting important root `docs/` material into MDX over leaving readers on GitHub long-term.

## Scope

Unless asked otherwise, website doc passes change only `website/**` (MDX, `meta.json`, and closely related site files). One topic per pass when expanding terse pages.
