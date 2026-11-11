import type { CSSProperties } from 'react';
import { cn } from '@/lib/utils';

/** Monograma e cor de cada fonte: dá para reconhecer de onde veio a vaga sem ler o nome. */
const SOURCES: Record<string, { mark: string; color: string; name: string }> = {
  linkedin: { mark: 'in', color: '#4ea1ff', name: 'LinkedIn' },
  gupy: { mark: 'gu', color: '#35d3c3', name: 'Gupy' },
  remotive: { mark: 'rm', color: '#ff9a76', name: 'Remotive' },
  remoteok: { mark: 'ok', color: '#ff7a8c', name: 'RemoteOK' },
  greenhouse: { mark: 'gh', color: '#46d68c', name: 'Greenhouse' },
  lever: { mark: 'lv', color: '#c3cbe3', name: 'Lever' },
  arbeitnow: { mark: 'ab', color: '#f6c05c', name: 'Arbeitnow' },
  himalayas: { mark: 'hi', color: '#b9a0ff', name: 'Himalayas' },
  indeed: { mark: 'id', color: '#7f9bff', name: 'Indeed' },
};

export function sourceInfo(source: string) {
  return SOURCES[source] ?? { mark: source.slice(0, 2).toLowerCase(), color: '#9ba4c2', name: source };
}

const SIZES = {
  sm: 'size-[1.125rem] rounded-[5px] text-[9px]',
  md: 'size-6 rounded-[7px] text-[11px]',
  lg: 'size-10 rounded-xl text-base',
} as const;

export function SourceMark({ source, size = 'sm', className }: { source: string; size?: keyof typeof SIZES; className?: string }) {
  const info = sourceInfo(source);
  return (
    <span
      aria-hidden
      title={info.name}
      className={cn('kv-source', SIZES[size], className)}
      style={{ '--src': info.color } as CSSProperties}
    >
      {info.mark}
    </span>
  );
}

/** Só a bolinha da cor da fonte, sem texto (para dentro de rótulos de formulário). */
export function SourceDot({ source, className }: { source: string; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn('inline-block size-2 shrink-0 rounded-full', className)}
      style={{ background: sourceInfo(source).color }}
    />
  );
}
