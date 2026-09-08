import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';
import { appName, gitConfig } from './shared';
import { BrandLogo } from '@/components/brand-logo';

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: <span className="inline-flex items-center gap-2.5 font-semibold tracking-tight text-fd-foreground"><BrandLogo className="size-8 shrink-0" />{appName}</span>,
    },
    githubUrl: `https://github.com/${gitConfig.user}/${gitConfig.repo}`,
  };
}
