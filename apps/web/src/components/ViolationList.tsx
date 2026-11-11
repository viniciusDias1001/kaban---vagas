import type { Violation } from '@kv/shared/client';
import { violationView } from '../lib/ai';
import { cn } from '../lib/utils';

/**
 * Lista de violações (ou avisos) do verificador de não invenção: o que é, o termo que divergiu, onde, e a
 * explicação. É a mesma apresentação nos avisos de um salvamento e na recusa do PDF. O termo vem do modelo
 * ou do usuário: entra como texto, nunca como marcação.
 */
export function ViolationList({ violations, className }: { violations: readonly Violation[]; className?: string }) {
  if (violations.length === 0) return null;
  return (
    <ul data-testid="violation-list" className={cn('mt-1.5 space-y-2', className)}>
      {violations.map((v, i) => {
        const view = violationView(v);
        return (
          <li key={i} data-code={v.code} className="min-w-0 break-words">
            <p className="text-ink">
              <span className="font-medium">{view.label}</span>
              {view.term !== null && (
                <>
                  : <span data-testid="violation-term" className="rounded-md bg-surface-3 px-1 py-px font-mono text-xs text-ink">{view.term}</span>
                </>
              )}
              {view.place !== null && <span className="text-muted"> · {view.place}</span>}
            </p>
            <p className="text-xs leading-snug text-muted">{view.help}</p>
          </li>
        );
      })}
    </ul>
  );
}
