import { Inter } from 'next/font/google';
import type { Metadata } from 'next';
import { Provider } from '@/components/provider';
import './global.css';

const inter = Inter({
  subsets: ['latin'],
});

export const metadata: Metadata = {
  title: { default: 'CouchSet — Model Couchbase without hiding it.', template: '%s | CouchSet' },
  description: 'Typed Couchbase models for TypeScript. Explore explicit provisioning, safe queries, transactions, Search, and practical operational tools.',
};

export default function Layout({ children }: LayoutProps<'/'>) {
  return (
    <html lang="en" className={inter.className} suppressHydrationWarning>
      <body className="flex flex-col min-h-screen">
        <Provider>{children}</Provider>
      </body>
    </html>
  );
}
