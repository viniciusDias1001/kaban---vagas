import { useSyncExternalStore } from 'react';

export interface Toast {
  text: string;
  tone: 'error' | 'info';
}

let current: Toast | null = null;
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | undefined;

const emit = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export function showToast(text: string, tone: Toast['tone'] = 'error') {
  current = { text, tone };
  emit();
  clearTimeout(timer);
  timer = setTimeout(() => {
    current = null;
    emit();
  }, 4000);
}

export function useToast(): Toast | null {
  return useSyncExternalStore(subscribe, () => current);
}

// ---------------------------------------------------------------------------------------------
// Barras de ação fixas no rodapé (Configurações, Meu perfil): o aviso flutuante sobe para não cobri-las.
// ---------------------------------------------------------------------------------------------

/** Altura atual de cada barra registrada (0 quando ela está escondida). */
const bars = new Map<Element, number>();
let barHeight = 0;

function publishBars() {
  const next = Math.max(0, ...bars.values());
  if (next === barHeight) return;
  barHeight = next;
  emit();
}

/**
 * Callback ref para uma barra de ações presa ao rodapé da tela. Enquanto ela está montada, a altura dela é
 * medida (e medida de novo quando muda: quebra de linha em tela estreita, `hidden`), e o aviso flutuante
 * passa a aparecer acima dela. A função é estável: o React não a chama de novo a cada renderização.
 */
export function bottomBarRef(el: HTMLElement | null): (() => void) | void {
  if (!el) return;
  const measure = () => {
    bars.set(el, Math.round(el.getBoundingClientRect().height));
    publishBars();
  };
  measure();
  const observer = new ResizeObserver(measure);
  observer.observe(el);
  return () => {
    observer.disconnect();
    bars.delete(el);
    publishBars();
  };
}

/** Quantos pixels do rodapé da janela estão ocupados por uma barra de ações fixa (0 = nenhuma). */
export function useBottomBarHeight(): number {
  return useSyncExternalStore(subscribe, () => barHeight);
}
