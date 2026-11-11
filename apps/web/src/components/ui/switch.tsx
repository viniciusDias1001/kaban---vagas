import { Switch as SwitchPrimitive } from 'radix-ui';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

function Switch({ className, ...props }: ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        'peer inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-line-strong bg-surface-3 p-0.5',
        'transition-[background-color,border-color] duration-200 ease-out-soft',
        'data-[state=checked]:border-ok/60 data-[state=checked]:bg-ok/85',
        'focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-accent/40 disabled:opacity-50',
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className="block size-3.5 rounded-full bg-ink shadow-[0_1px_3px_rgb(3_5_14/0.6)] transition-transform duration-200 ease-out-soft data-[state=checked]:translate-x-4 data-[state=checked]:bg-on-accent"
      />
    </SwitchPrimitive.Root>
  );
}

export { Switch };
