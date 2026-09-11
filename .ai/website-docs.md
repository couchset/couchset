# Website docs conventions

Guidance for agents editing `website/content/docs/*.mdx`.

## Linking

- **Pages already on the site** (`website/content/docs/*.mdx`): use relative MDX links such as `[Eventing](./eventing)` or `[Operations and CLI](./operations-cli-eventing)`. Do not point those at GitHub blob URLs.
- **Repo docs not published on the site yet** (root `docs/*.md`, research notes): use full GitHub links, e.g. `https://github.com/couchset/couchset/blob/master/docs/next-primitives.md#eventing-functions`.
- Prefer promoting important root `docs/` material into MDX over leaving readers on GitHub long-term.

## Scope

Unless asked otherwise, website doc passes change only `website/**` (MDX, `meta.json`, and closely related site files). One topic per pass when expanding terse pages.
