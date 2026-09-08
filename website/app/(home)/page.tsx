import Link from 'next/link';
import Image from 'next/image';
import { ArrowRight, Braces, SlidersHorizontal, Layers } from 'lucide-react';

export default function HomePage() {
  return (
    <main className="mx-auto w-full max-w-6xl flex-1 px-4 pb-12 pt-5 sm:px-6 sm:pt-8">
      <section className="relative isolate overflow-hidden rounded-3xl border border-black/10 bg-[#f4eee7] text-[#202020]">
        <div className="relative z-10 mx-auto max-w-3xl px-5 pb-2 pt-10 text-center sm:px-8 sm:pt-14">
          <p className="mb-5 font-mono text-sm text-[#a91d28]">Couchbase model layer for TypeScript</p>
          <h1 className="text-4xl font-semibold leading-[1.08] tracking-tight sm:text-6xl lg:text-7xl">Model Couchbase<br className="hidden sm:block" /> without hiding it.</h1>
          <p className="mx-auto mt-5 max-w-xl text-base leading-7 text-[#57514d] sm:text-lg">Typed models, safe SQL++ reads, explicit provisioning, transactions, Search, Eventing, and practical operational tools.</p>
          <div className="mt-7 flex flex-wrap justify-center gap-3">
            <Link href="/docs/getting-started" className="brand-link inline-flex items-center gap-2 rounded-xl bg-[#bc202b] px-5 py-3 text-sm font-semibold text-white transition-colors hover:bg-[#9f1923]">Get started <ArrowRight className="size-4" aria-hidden="true" /></Link>
            <Link href="/docs" className="brand-link rounded-xl border border-black/15 bg-white/70 px-5 py-3 text-sm font-semibold transition-colors hover:bg-white">Read the docs</Link>
          </div>
          <p className="mt-5 font-mono text-sm text-[#665e58]">npm install couchset</p>
        </div>
        <Image src="/brand/couchset-hero.webp" alt="The red CouchSet couch mascot waving among neatly arranged data blocks." width={1672} height={941} sizes="(max-width: 1152px) 100vw, 1152px" unoptimized priority className="brand-hero-art relative -mt-10 block h-auto w-full sm:-mt-20" />
      </section>
      <section aria-label="Why CouchSet" className="mt-8 grid gap-4 md:grid-cols-3">
        {[
          { title: 'Typed by design', body: 'Definitions, projections, includes, codecs, and extensions keep application types useful.', icon: Braces },
          { title: 'Explicit operations', body: 'Collections, indexes, Search indexes, and Eventing change only when you ask.', icon: SlidersHorizontal },
          { title: 'Two entrypoints', body: 'Keep the legacy API from couchset, or use the modern API from couchset/next.', icon: Layers },
        ].map(({title, body, icon: Icon}) => <div key={title} className="rounded-2xl border bg-fd-card p-6"><Icon className="mb-4 size-5 text-fd-primary" aria-hidden="true" /><h2 className="font-semibold tracking-tight">{title}</h2><p className="mt-2 text-sm leading-6 text-fd-muted-foreground">{body}</p></div>)}
      </section>
      <footer className="mt-10 flex items-center justify-center gap-3 text-sm text-fd-muted-foreground">
        <Image src="/brand/couchset-mascot.webp" alt="" width={84} height={56} unoptimized />
        <span>CouchSet · Built for Couchbase. Written for TypeScript.</span>
      </footer>
    </main>
  );
}
