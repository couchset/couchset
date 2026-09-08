import Link from 'next/link';

export default function HomePage() {
  return (
    <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col justify-center px-6 py-20">
      <div className="max-w-3xl">
        <p className="mb-4 font-mono text-sm text-fd-muted-foreground">Couchbase model layer for TypeScript</p>
        <h1 className="text-5xl font-bold tracking-tight sm:text-7xl">Model Couchbase without hiding it.</h1>
        <p className="mt-6 text-lg leading-8 text-fd-muted-foreground">Typed models, safe SQL++ reads, explicit provisioning, transactions, Search, Eventing, and practical operational tools.</p>
        <div className="mt-9 flex flex-wrap gap-3">
          <Link href="/docs" className="rounded-lg bg-fd-primary px-5 py-3 font-medium text-fd-primary-foreground">Read the docs</Link>
          <Link href="/docs/getting-started" className="rounded-lg border px-5 py-3 font-medium">Get started</Link>
        </div>
      </div>
      <div className="mt-16 grid gap-4 md:grid-cols-3">
        {[
          ['Typed by design', 'Definitions, projections, includes, codecs, and extensions keep application types useful.'],
          ['Explicit operations', 'Collections, indexes, Search indexes, and Eventing change only when you ask.'],
          ['Two entrypoints', 'Keep the legacy API from couchset, or use the modern API from couchset/next.'],
        ].map(([title, body]) => <div key={title} className="rounded-xl border bg-fd-card p-5"><h2 className="font-semibold">{title}</h2><p className="mt-2 text-sm leading-6 text-fd-muted-foreground">{body}</p></div>)}
      </div>
    </main>
  );
}
