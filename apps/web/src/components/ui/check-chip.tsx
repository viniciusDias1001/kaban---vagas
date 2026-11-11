import { Checkbox as CheckboxPrimitive } from 'radix-ui';
import { Check } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import type { ReactNode } from 'react';
import { springSnap } from '@/lib/motion';
import { cn } from '@/lib/utils';

interface CheckChipProps {
  /** Nome acessível da opção (o que `getByLabel` e leitores de tela enxergam). */
  label: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  /** Enfeite à esquerda do texto (monograma da fonte, por exemplo). */
  adornment?: ReactNode;
  /** `block` ocupa a largura da célula (grades); `pill` abraça o conteúdo. */
  shape?: 'pill' | 'block';
  className?: string;
  /** `data-testid` do próprio checkbox. */
  testId?: string;
  disabled?: boolean;
}

/**
 * Opção marcável em forma de chip. É um checkbox de verdade (Radix: `role="checkbox"`, `aria-checked`,
 * Espaço alterna), só que o chip inteiro é o alvo de clique e o estado aparece como preenchimento + ✓.
 */
function CheckChip({ label, checked, onCheckedChange, adornment, shape = 'pill', className, testId, disabled }: CheckChipProps) {
  return (
    <CheckboxPrimitive.Root asChild checked={checked} onCheckedChange={(c) => onCheckedChange(c === true)} aria-label={label} disabled={disabled}>
      <motion.button
        type="button"
        data-slot="check-chip"
        data-testid={testId}
        whileTap={{ scale: 0.95 }}
        transition={springSnap}
        className={cn(
          'group/chip inline-flex h-9 cursor-pointer select-none items-center gap-2 border text-[13px] font-medium',
          'transition-[background-color,border-color,color,box-shadow] duration-150 ease-out-soft',
          'border-line bg-surface-2/70 text-ink-2 hover:border-line-strong hover:bg-surface-3 hover:text-ink',
          'data-[state=checked]:border-accent/55 data-[state=checked]:bg-accent/14 data-[state=checked]:text-ink',
          'data-[state=checked]:shadow-[inset_0_1px_0_rgb(255_255_255/0.06),0_0_0_3px_rgb(142_166_255/0.08)]',
          'focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-accent/45 disabled:cursor-not-allowed disabled:opacity-50',
          shape === 'pill' ? 'rounded-full pl-2.5 pr-3.5' : 'w-full rounded-xl pl-2 pr-2.5',
          className,
        )}
      >
        {shape === 'pill' && <Mark checked={checked} />}
        {adornment}
        <span className="whitespace-nowrap">{label}</span>
        {shape === 'block' && <Mark checked={checked} className="ml-auto" />}
      </motion.button>
    </CheckboxPrimitive.Root>
  );
}

function Mark({ checked, className }: { checked: boolean; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        'grid size-4 shrink-0 place-items-center rounded-full border transition-[background-color,border-color] duration-150 ease-out-soft',
        checked ? 'border-accent bg-accent text-on-accent' : 'border-line-strong bg-bg/50 group-hover/chip:border-faint',
        className,
      )}
    >
      <AnimatePresence initial={false}>
        {checked && (
          <motion.span
            initial={{ scale: 0.2, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.2, opacity: 0 }}
            transition={springSnap} className="grid place-items-center"
          >
            <Check className="size-2.5" strokeWidth={4} />
          </motion.span>
        )}
      </AnimatePresence>
    </span>
  );
}

export { CheckChip };
