import { Dialog as DialogPrimitive } from 'radix-ui';
import { AnimatePresence, motion } from 'motion/react';
import { useRef, type ComponentProps, type ReactNode } from 'react';
import { springSoft } from '@/lib/motion';
import { cn } from '@/lib/utils';

/**
 * Painel lateral (estrutura do `sheet` do shadcn) sobre o Dialog do Radix: foco preso, Esc fecha e o foco
 * volta para quem abriu. Entrada e saída são do Motion — por isso o `forceMount` e o AnimatePresence.
 */
function Sheet({ open, onOpenChange, children }: { open: boolean; onOpenChange: (open: boolean) => void; children: ReactNode }) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <AnimatePresence>
        {open && (
          <DialogPrimitive.Portal forceMount>
            <DialogPrimitive.Overlay asChild forceMount>
              <motion.div
                data-slot="sheet-overlay"
                className="fixed inset-0 z-40 bg-[#03040a]/70"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.2, ease: 'easeOut' }}
              />
            </DialogPrimitive.Overlay>
            {children}
          </DialogPrimitive.Portal>
        )}
      </AnimatePresence>
    </DialogPrimitive.Root>
  );
}

function SheetContent({ className, children, onCloseAutoFocus, ...props }: ComponentProps<typeof DialogPrimitive.Content>) {
  // Sem um Dialog.Trigger o Radix não sabe para onde devolver o foco: guarda quem estava focado ao abrir.
  const opener = useRef<HTMLElement | null>(null);
  return (
    <DialogPrimitive.Content
      asChild forceMount aria-describedby={undefined}
      onOpenAutoFocus={() => {
        opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      }}
      onCloseAutoFocus={(e) => {
        // Quem usa o painel pode pôr o foco em outro lugar (chamando `preventDefault`); senão ele volta para quem abriu.
        onCloseAutoFocus?.(e);
        if (e.defaultPrevented) return;
        e.preventDefault();
        if (opener.current?.isConnected) opener.current.focus();
      }}
      {...props}
    >
      <motion.aside
        data-slot="sheet-content"
        className={cn(
          'fixed inset-y-2 right-2 z-50 flex w-[min(38rem,calc(100vw-1rem))] flex-col overflow-hidden rounded-3xl border border-line-strong bg-surface shadow-pop outline-none',
          className,
        )}
        initial={{ x: '104%', opacity: 0.6 }}
        animate={{ x: 0, opacity: 1 }}
        exit={{ x: '104%', opacity: 0 }}
        transition={springSoft}
      >
        {children}
      </motion.aside>
    </DialogPrimitive.Content>
  );
}

const SheetTitle = DialogPrimitive.Title;
const SheetClose = DialogPrimitive.Close;

export { Sheet, SheetClose, SheetContent, SheetTitle };
