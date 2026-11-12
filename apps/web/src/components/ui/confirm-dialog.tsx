import { TriangleAlert } from 'lucide-react';
import { AlertDialog as AlertDialogPrimitive } from 'radix-ui';
import { AnimatePresence, motion } from 'motion/react';
import type { ReactNode } from 'react';
import { spring } from '@/lib/motion';
import { Button } from './button';

interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  /** O que vai acontecer, em uma ou duas frases. */
  children: ReactNode;
  /** Rótulo do botão que confirma a ação destrutiva. */
  confirmLabel: string;
  onConfirm: () => void;
  /** A ação está em curso: os botões ficam desabilitados e a caixa não fecha. */
  busy?: boolean;
  /** Prefixo dos `data-testid` da caixa e dos dois botões. */
  testId?: string;
}

/**
 * Confirmação de uma ação destrutiva, no centro da tela. É o AlertDialog do Radix (`role="alertdialog"`: foco
 * preso, Esc cancela, o foco começa em "Cancelar" e volta para quem abriu), com o mesmo véu e a mesma superfície
 * do painel lateral (`sheet.tsx`) e entrada/saída do Motion.
 */
function ConfirmDialog({ open, onOpenChange, title, children, confirmLabel, onConfirm, busy = false, testId }: ConfirmDialogProps) {
  return (
    <AlertDialogPrimitive.Root open={open} onOpenChange={(next) => (busy ? undefined : onOpenChange(next))}>
      <AnimatePresence>
        {open && (
          <AlertDialogPrimitive.Portal forceMount>
            <AlertDialogPrimitive.Overlay asChild forceMount>
              <motion.div
                data-slot="confirm-overlay"
                className="fixed inset-0 z-[70] bg-[#03040a]/70"
                initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                transition={{ duration: 0.18, ease: 'easeOut' }}
              />
            </AlertDialogPrimitive.Overlay>
            <div className="pointer-events-none fixed inset-0 z-[70] grid place-items-center overflow-y-auto p-4">
              <AlertDialogPrimitive.Content asChild forceMount>
                <motion.div
                  data-slot="confirm-dialog" data-testid={testId}
                  className="pointer-events-auto w-full max-w-md rounded-3xl border border-line-strong bg-surface p-5 shadow-pop outline-none"
                  initial={{ opacity: 0, y: 10, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: 6, scale: 0.98 }} transition={spring}
                >
                  <div className="flex items-start gap-3.5">
                    <span aria-hidden className="grid size-10 shrink-0 place-items-center rounded-xl bg-bad/12 text-bad ring-1 ring-inset ring-bad/25">
                      <TriangleAlert className="size-5" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <AlertDialogPrimitive.Title className="text-base font-semibold leading-snug text-ink">{title}</AlertDialogPrimitive.Title>
                      <AlertDialogPrimitive.Description asChild>
                        <div className="mt-1.5 space-y-1.5 break-words text-[13px] leading-relaxed text-ink-2">{children}</div>
                      </AlertDialogPrimitive.Description>
                    </div>
                  </div>
                  <div className="mt-5 flex flex-wrap justify-end gap-2">
                    <AlertDialogPrimitive.Cancel asChild>
                      <Button type="button" disabled={busy} data-testid={testId && `${testId}-cancel`}>Cancelar</Button>
                    </AlertDialogPrimitive.Cancel>
                    {/* Botão comum (não o Action do Radix, que fecharia na hora): a caixa só fecha quando a ação termina. */}
                    <Button type="button" variant="danger" disabled={busy} onClick={onConfirm} data-testid={testId && `${testId}-confirm`}>
                      {confirmLabel}
                    </Button>
                  </div>
                </motion.div>
              </AlertDialogPrimitive.Content>
            </div>
          </AlertDialogPrimitive.Portal>
        )}
      </AnimatePresence>
    </AlertDialogPrimitive.Root>
  );
}

export { ConfirmDialog };
