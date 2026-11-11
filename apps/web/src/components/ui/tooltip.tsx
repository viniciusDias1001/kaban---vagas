import { Tooltip as TooltipPrimitive } from 'radix-ui';
import type { ComponentProps, ReactNode } from 'react';

const TooltipProvider = TooltipPrimitive.Provider;

/** Dica curta para botões só com ícone. O nome acessível continua vindo do `aria-label` do botão. */
function Tooltip({
  label, children, side = 'bottom',
}: { label: string; children: ReactNode; side?: ComponentProps<typeof TooltipPrimitive.Content>['side'] }) {
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          data-slot="tooltip"
          side={side}
          sideOffset={6}
          className="z-50 rounded-lg border border-line-strong bg-surface-4 px-2 py-1 text-xs text-ink shadow-pop"
        >
          {label}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}

export { Tooltip, TooltipProvider };
