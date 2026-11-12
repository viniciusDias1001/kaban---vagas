import { CircleAlert, CircleCheck, Info, TriangleAlert } from 'lucide-react';
import type { ComponentProps, ReactNode } from 'react';
import { cn } from '@/lib/utils';

const TONES = {
  info: { box: 'border-accent/25 bg-accent/7', icon: 'text-accent', Icon: Info },
  ok: { box: 'border-ok/25 bg-ok/8', icon: 'text-ok', Icon: CircleCheck },
  warn: { box: 'border-warn/25 bg-warn/8', icon: 'text-warn', Icon: TriangleAlert },
  bad: { box: 'border-bad/25 bg-bad/8', icon: 'text-bad', Icon: CircleAlert },
} as const;

export type NoticeTone = keyof typeof TONES;

interface NoticeProps extends Omit<ComponentProps<'div'>, 'title'> {
  tone?: NoticeTone;
  /** Primeira linha, em destaque. */
  title?: ReactNode;
  /** Botões à direita (ou abaixo, quando não cabem). */
  action?: ReactNode;
  /** Troca o ícone padrão do tom. */
  icon?: ReactNode;
}

/**
 * Aviso em bloco: ícone do tom + título + texto + ação. O tom nunca é a única pista: há sempre ícone e
 * texto. Quem usa decide o papel ARIA (`role="status"`, `role="alert"`) conforme a urgência.
 */
function Notice({ tone = 'info', title, action, icon, className, children, ...props }: NoticeProps) {
  const t = TONES[tone];
  return (
    <div
      data-slot="notice" data-tone={tone}
      className={cn('flex flex-wrap items-start gap-x-3 gap-y-2.5 rounded-2xl border px-4 py-3', t.box, className)}
      {...props}
    >
      <span aria-hidden className={cn('mt-0.5 shrink-0 [&_svg]:size-4', t.icon)}>{icon ?? <t.Icon />}</span>
      <div className="min-w-48 flex-1 text-[13px] leading-relaxed text-ink-2">
        {title && <p className="font-semibold text-ink">{title}</p>}
        {children}
      </div>
      {action && <div className="flex shrink-0 flex-wrap items-center gap-2 self-center">{action}</div>}
    </div>
  );
}

export { Notice };
