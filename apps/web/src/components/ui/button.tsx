import { Slot } from 'radix-ui';
import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

const buttonVariants = cva(
  'inline-flex shrink-0 cursor-pointer select-none items-center justify-center gap-2 whitespace-nowrap rounded-xl text-sm font-medium ' +
    'transition-[background-color,border-color,color,box-shadow,transform,filter] duration-150 ease-out-soft ' +
    'active:scale-[0.97] disabled:cursor-not-allowed disabled:border disabled:border-line disabled:bg-none disabled:bg-surface-2 disabled:text-faint disabled:shadow-none disabled:brightness-100 disabled:translate-y-0 disabled:active:scale-100 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        primary:
          'bg-linear-to-b from-[#a6b8ff] to-accent-strong font-semibold text-on-accent shadow-accent hover:-translate-y-px hover:brightness-110',
        secondary: 'border border-line bg-surface-2 text-ink shadow-card hover:border-line-strong hover:bg-surface-3',
        ghost: 'text-muted hover:bg-surface-3 hover:text-ink',
        danger: 'border border-bad/25 text-bad hover:border-bad/50 hover:bg-bad/12',
      },
      size: {
        sm: 'h-8 px-3 text-[13px]',
        md: 'h-9 px-3.5',
        lg: 'h-10 px-4',
        icon: 'size-8 rounded-lg',
      },
    },
    defaultVariants: { variant: 'secondary', size: 'md' },
  },
);

type ButtonProps = ComponentProps<'button'> & VariantProps<typeof buttonVariants> & { asChild?: boolean };

function Button({ className, variant, size, asChild = false, ...props }: ButtonProps) {
  const Comp = asChild ? Slot.Root : 'button';
  return <Comp data-slot="button" className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}

export { Button, buttonVariants };
