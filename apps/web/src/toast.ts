import { useSyncExternalStore } from 'react';

export interface Toast {
  text: string;
  tone: 'error' | 'info';
}

let current: Toast | null = null;
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | undefined;

const emit = () => listeners.forEach((l) => l());

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
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
  );
}
