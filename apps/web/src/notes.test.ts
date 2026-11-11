import { describe, expect, it, vi } from 'vitest';
import { NotesController, NotesStore } from './notes';

/** Um `save` controlado pelo teste: cada chamada fica pendente até `resolve`/`reject`. */
function deferredSave() {
  const calls: { text: string; resolve: () => void; reject: (e: Error) => void }[] = [];
  const save = vi.fn(
    (text: string) =>
      new Promise<void>((resolve, reject) => {
        calls.push({ text, resolve, reject });
      }),
  );
  return { save, calls };
}

const make = (save: (text: string) => Promise<unknown>, onDetachedError?: (m: string) => void) =>
  new NotesController({ save, maxLength: 20, onDetachedError });

describe('NotesController', () => {
  it('seeds once and ignores later server data, dirty or not', () => {
    const c = make(async () => {});
    expect(c.getSnapshot().seeded).toBe(false);
    c.seed('do servidor');
    expect(c.getSnapshot()).toMatchObject({ text: 'do servidor', dirty: false, seeded: true, status: 'idle' });
    c.seed('refetch');
    expect(c.getSnapshot().text).toBe('do servidor');
    c.edit('digitado');
    c.seed('outro refetch');
    expect(c.getSnapshot()).toMatchObject({ text: 'digitado', dirty: true });
  });

  it('does not save when nothing changed', async () => {
    const save = vi.fn(async () => {});
    const c = make(save);
    c.seed('igual');
    await c.flush();
    c.edit('mudou');
    c.edit('igual');
    await c.flush();
    expect(save).not.toHaveBeenCalled();
    expect(c.getSnapshot().status).toBe('idle');
  });

  it('saves the dirty text on flush and reports saving, then saved', async () => {
    const { save, calls } = deferredSave();
    const c = make(save);
    c.seed('');
    c.edit('minha nota');
    const done = c.flush();
    expect(c.getSnapshot()).toMatchObject({ status: 'saving', dirty: true });
    expect(calls[0].text).toBe('minha nota');
    calls[0].resolve();
    await done;
    expect(c.getSnapshot()).toMatchObject({ status: 'saved', dirty: false, error: null, text: 'minha nota' });
    expect(c.settled).toBe(true);
  });

  it('keeps text typed while a save is in flight and saves it next', async () => {
    const { save, calls } = deferredSave();
    const c = make(save);
    c.seed('');
    c.edit('primeira');
    const first = c.flush();
    c.edit('primeira e segunda');
    // Um refetch do detalhe chegando agora (com "primeira" ou com o texto antigo) não mexe no campo.
    c.seed('primeira');
    const second = c.flush(); // blur de novo, ou o painel fechando
    expect(save).toHaveBeenCalledTimes(1);
    calls[0].resolve();
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    expect(calls[1].text).toBe('primeira e segunda');
    expect(c.getSnapshot().text).toBe('primeira e segunda');
    calls[1].resolve();
    await Promise.all([first, second]);
    expect(c.getSnapshot()).toMatchObject({ status: 'saved', dirty: false });
  });

  it('stays dirty, without saving again, when text changes mid-save and nobody flushes', async () => {
    const { save, calls } = deferredSave();
    const c = make(save);
    c.seed('');
    c.edit('a');
    const done = c.flush();
    c.edit('ab');
    calls[0].resolve();
    await done;
    expect(save).toHaveBeenCalledTimes(1);
    expect(c.getSnapshot()).toMatchObject({ text: 'ab', dirty: true });
    expect(c.settled).toBe(false);
  });

  it('keeps the text and the error when the save fails, and retries on the next flush', async () => {
    const { save, calls } = deferredSave();
    const c = make(save);
    c.seed('antiga');
    c.edit('nova');
    const failed = c.flush();
    calls[0].reject(new Error('A API falhou ao responder (erro 500).'));
    await failed;
    expect(c.getSnapshot()).toMatchObject({ text: 'nova', dirty: true, status: 'error', error: 'A API falhou ao responder (erro 500).' });
    expect(c.settled).toBe(false);

    const retried = c.flush();
    expect(c.getSnapshot()).toMatchObject({ status: 'saving', error: null });
    calls[1].resolve();
    await retried;
    expect(calls[1].text).toBe('nova');
    expect(c.getSnapshot()).toMatchObject({ status: 'saved', dirty: false, error: null });
  });

  it('clears the error when the text goes back to what is saved', async () => {
    const c = make(async () => {
      throw new Error('falhou');
    });
    c.seed('antiga');
    c.edit('nova');
    await c.flush();
    expect(c.getSnapshot().status).toBe('error');
    c.edit('antiga');
    expect(c.getSnapshot()).toMatchObject({ status: 'idle', error: null, dirty: false });
  });

  it('enforces the maximum length', () => {
    const c = make(async () => {});
    c.seed('');
    c.edit('x'.repeat(50));
    expect(c.getSnapshot().text).toHaveLength(20);
  });

  it('notifies subscribers with a new snapshot only when something changes', () => {
    const c = make(async () => {});
    const listener = vi.fn();
    const unsubscribe = c.subscribe(listener);
    const before = c.getSnapshot();
    expect(c.getSnapshot()).toBe(before);
    c.seed('a');
    expect(listener).toHaveBeenCalledTimes(1);
    expect(c.getSnapshot()).not.toBe(before);
    c.edit('a');
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    c.edit('b');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('reports a failed save through onDetachedError only when nobody is subscribed (drawer closed)', async () => {
    const detached = vi.fn();
    const c = make(async () => {
      throw new Error('sem rede');
    }, detached);
    c.seed('');
    const unsubscribe = c.subscribe(() => {});
    c.edit('a');
    await c.flush();
    expect(detached).not.toHaveBeenCalled();
    unsubscribe();
    await c.flush();
    expect(detached).toHaveBeenCalledWith('sem rede');
  });
});

describe('NotesStore', () => {
  it('drops a settled controller and keeps one with unsaved or failed text for the next open', async () => {
    const store = new NotesStore();
    let fail = true;
    const create = () =>
      make(async () => {
        if (fail) throw new Error('falhou');
      });

    const first = store.acquire(7, create);
    first.seed('');
    store.release(7);
    expect(store.has(7)).toBe(false);

    // Digitou, fechou o painel e o salvamento falhou: o texto continua guardado.
    const second = store.acquire(7, create);
    second.seed('');
    second.edit('não pode sumir');
    await second.flush();
    store.release(7);
    expect(store.has(7)).toBe(true);

    // Reabriu: é o mesmo controlador, com o texto; o servidor (ainda com o texto antigo) não o sobrescreve.
    const reopened = store.acquire(7, create);
    expect(reopened).toBe(second);
    reopened.seed('');
    expect(reopened.getSnapshot()).toMatchObject({ text: 'não pode sumir', status: 'error' });

    fail = false;
    await reopened.flush();
    store.release(7);
    expect(store.has(7)).toBe(false);
  });

  it('keeps the controller while a save is still in flight', async () => {
    const store = new NotesStore();
    const { save, calls } = deferredSave();
    const c = store.acquire(1, () => make(save));
    c.seed('');
    c.edit('a');
    const done = c.flush();
    store.release(1);
    expect(store.has(1)).toBe(true);
    calls[0].resolve();
    await done;
    store.release(1);
    expect(store.has(1)).toBe(false);
  });
});
