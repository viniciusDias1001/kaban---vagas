import { useCallback, useLayoutEffect, useRef, type ComponentProps } from 'react';
import { cn } from '@/lib/utils';

export const fieldClass =
  'w-full rounded-xl border border-line bg-bg/60 text-sm text-ink shadow-[inset_0_1px_2px_rgb(3_5_14/0.5)] outline-none ' +
  'transition-[border-color,box-shadow,background-color] duration-150 ease-out-soft placeholder:text-faint ' +
  'hover:border-line-strong focus-visible:border-accent focus-visible:bg-bg/80 focus-visible:ring-[3px] focus-visible:ring-accent/25 ' +
  'disabled:opacity-50 aria-invalid:border-bad/60 aria-invalid:focus-visible:border-bad aria-invalid:focus-visible:ring-bad/20';

function Input({ className, type, ...props }: ComponentProps<'input'>) {
  return <input type={type} data-slot="input" className={cn(fieldClass, 'h-10 px-3', className)} {...props} />;
}

/** Com `field-sizing: content` o próprio navegador dá à caixa a altura do texto; sem ele, a altura é calculada aqui. */
const NATIVE_AUTOSIZE =
  typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports('field-sizing', 'content');

/**
 * Caixa de texto que cresce com o conteúdo: mostra o texto inteiro, sem barra de rolagem própria nem alça de
 * redimensionar. Um `max-h-*` no `className` põe um teto; a partir dele a caixa rola (use com `overflow-y-auto`).
 */
function Textarea({ className, ref, ...props }: ComponentProps<'textarea'>) {
  const local = useRef<HTMLTextAreaElement | null>(null);
  const attach = useCallback(
    (el: HTMLTextAreaElement | null) => {
      local.current = el;
      if (typeof ref === 'function') ref(el);
      else if (ref) ref.current = el;
    },
    [ref],
  );

  useLayoutEffect(() => {
    const el = local.current;
    if (NATIVE_AUTOSIZE || !el) return;
    let width = -1;
    const fit = () => {
      // Sem barra durante a medida: ela estreitaria o texto e inflaria a altura.
      el.style.overflowY = 'hidden';
      el.style.height = 'auto';
      const height = el.scrollHeight + el.offsetHeight - el.clientHeight;
      el.style.height = `${height}px`;
      if (height > Number.parseFloat(getComputedStyle(el).maxHeight)) el.style.overflowY = 'auto';
      width = el.clientWidth;
    };
    fit();
    if (typeof ResizeObserver === 'undefined') return;
    // A largura muda a quebra das linhas (janela, painel abrindo); a altura é refeita.
    const observer = new ResizeObserver(() => {
      if (el.clientWidth !== width) fit();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [props.value]);

  return (
    <textarea
      ref={attach}
      data-slot="textarea"
      className={cn(fieldClass, 'field-sizing-content min-h-24 resize-none p-3 leading-relaxed', className)}
      {...props}
    />
  );
}

export { Input, Textarea };
