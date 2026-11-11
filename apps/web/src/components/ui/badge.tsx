import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

const badgeVariants = cva(
  'inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md px-1.5 py-px text-[11px] font-medium leading-[1.45]',
  {
    variants: {
      tone: {
        neutral: 'bg-surface-3 text-ink-2 ring-1 ring-inset ring-white/6',
        accent: 'bg-accent/15 text-accent ring-1 ring-inset ring-accent/20',
        ok: 'bg-ok/14 text-ok ring-1 ring-inset ring-ok/20',
        warn: 'bg-warn/14 text-warn ring-1 ring-inset ring-warn/20',
        bad: 'bg-bad/14 text-bad ring-1 ring-inset ring-bad/20',
        outline: 'text-muted ring-1 ring-inset ring-line-strong',
      },
      size: {
        sm: '',
        md: 'rounded-lg px-2 py-0.5 text-xs',
      },
    },
    defaultVariants: { tone: 'neutral', size: 'sm' },
  },
);

function Badge({ className, tone, size, ...props }: ComponentProps<'span'> & VariantProps<typeof badgeVariants>) {
  return <span data-slot="badge" className={cn(badgeVariants({ tone, size }), className)} {...props} />;
}

export { Badge, badgeVariants };
