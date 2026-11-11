import { Settings, Sparkles } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from './ui/button';
import { Notice } from './ui/notice';

/**
 * Aviso "IA não configurada", igual em todas as áreas de IA: o motivo (vem da API), o que isso impede
 * nesta tela e o atalho para Configurações, que é onde mora o passo a passo.
 */
export function AiNotConfigured({ problem, onOpenSettings, children, className }: {
  problem: string | null | undefined; onOpenSettings: () => void; children?: ReactNode; className?: string;
}) {
  return (
    <Notice
      tone="info" role="status" data-testid="ai-not-configured" icon={<Sparkles />} title="IA não configurada" className={className}
      action={
        <Button type="button" data-testid="go-to-settings" onClick={onOpenSettings}>
          <Settings aria-hidden /> Abrir Configurações
        </Button>
      }
    >
      {problem && <p>{problem}</p>}
      {children}
    </Notice>
  );
}
