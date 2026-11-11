import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';

/** O valor só muda depois de `delayMs` sem novas alterações (digitação no filtro, por exemplo). */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(id);
  }, [value, delayMs]);
  return debounced;
}

/**
 * Se ainda há conteúdo para rolar à esquerda/direita de um contêiner com rolagem horizontal. `ref` vai no
 * contêiner (é um callback ref: o elemento pode aparecer depois da primeira renderização) e `update` no
 * `onScroll` dele.
 */
export function useScrollEdges<T extends HTMLElement>(): { ref: (el: T | null) => void; left: boolean; right: boolean; update: () => void } {
  const [el, setEl] = useState<T | null>(null);
  const [edges, setEdges] = useState({ left: false, right: false });
  const update = useCallback(() => {
    if (!el) return;
    const left = el.scrollLeft > 1;
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
    setEdges((prev) => (prev.left === left && prev.right === right ? prev : { left, right }));
  }, [el]);

  useEffect(() => {
    if (!el) return;
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, [el, update]);

  return { ref: setEl, ...edges, update };
}

/** Se a media query casa agora; acompanha mudanças de tamanho da janela e de zoom. */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const media = window.matchMedia(query);
      media.addEventListener('change', onChange);
      return () => media.removeEventListener('change', onChange);
    },
    [query],
  );
  return useSyncExternalStore(subscribe, () => window.matchMedia(query).matches);
}
