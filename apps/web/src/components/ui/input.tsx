import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

export const fieldClass =
  'w-full rounded-xl border border-line bg-bg/60 text-sm text-ink shadow-[inset_0_1px_2px_rgb(3_5_14/0.5)] outline-none ' +
  'transition-[border-color,box-shadow,background-color] duration-150 ease-out-soft placeholder:text-faint ' +
  'hover:border-line-strong focus-visible:border-accent focus-visible:bg-bg/80 focus-visible:ring-[3px] focus-visible:ring-accent/25 ' +
  'disabled:opacity-50';

function Input({ className, type, ...props }: ComponentProps<'input'>) {
  return <input type={type} data-slot="input" className={cn(fieldClass, 'h-10 px-3', className)} {...props} />;
}

function Textarea({ className, ...props }: ComponentProps<'textarea'>) {
  return (
    <textarea data-slot="textarea" className={cn(fieldClass, 'min-h-24 resize-y p-3 leading-relaxed', className)} {...props} />
  );
}

export { Input, Textarea };
