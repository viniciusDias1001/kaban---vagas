import { RadioGroup as RadioGroupPrimitive } from 'radix-ui';
import { motion } from 'motion/react';
import { useId } from 'react';
import { spring } from '@/lib/motion';
import { cn } from '@/lib/utils';

interface SegmentedProps<T extends string> {
  value: T;
  onValueChange: (value: T) => void;
  options: readonly { value: T; label: string; ariaLabel?: string }[];
  'aria-labelledby'?: string;
  className?: string;
}

/** Controle segmentado (Radix RadioGroup: setas navegam, um só marcado) com a pílula ativa animada pelo Motion. */
function Segmented<T extends string>({ value, onValueChange, options, className, ...props }: SegmentedProps<T>) {
  const pill = useId();
  return (
    <RadioGroupPrimitive.Root
      data-slot="segmented"
      value={value}
      onValueChange={(v) => onValueChange(v as T)}
      orientation="horizontal"
      className={cn('grid auto-cols-fr grid-flow-col rounded-xl border border-line bg-bg/60 p-1 shadow-[inset_0_1px_2px_rgb(3_5_14/0.5)]', className)}
      {...props}
    >
      {options.map((o) => {
        const active = o.value === value;
        return (
          <RadioGroupPrimitive.Item
            key={o.value}
            value={o.value}
            aria-label={o.ariaLabel}
            className={cn(
              'relative h-8 cursor-pointer select-none rounded-lg px-2 text-[13px] font-medium tabular-nums transition-colors duration-150 active:scale-[0.97]',
              'focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-accent/45',
              active ? 'text-ink' : 'text-muted hover:text-ink',
            )}
          >
            {active && (
              <motion.span
                layoutId={pill} transition={spring}
                className="absolute inset-0 rounded-lg bg-accent/18 shadow-[inset_0_1px_0_rgb(255_255_255/0.08)] ring-1 ring-inset ring-accent/40"
              />
            )}
            <span className="relative">{o.label}</span>
          </RadioGroupPrimitive.Item>
        );
      })}
    </RadioGroupPrimitive.Root>
  );
}

export { Segmented };
