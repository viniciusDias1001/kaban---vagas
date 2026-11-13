import type { Browser, Route } from 'playwright';
import { describe, expect, it, vi } from 'vitest';
import { newRecordingPage } from './capture';

describe('newRecordingPage', () => {
  it('opens a page in a context that blocks service workers and aborts every request that is not a GET', async () => {
    const handlers: Array<(route: Route) => unknown> = [];
    const page = { id: 'page' };
    const context = {
      route: vi.fn(async (_pattern: string, handler: (route: Route) => unknown) => { handlers.push(handler); }),
      newPage: vi.fn(async () => page),
    };
    const browser = { newContext: vi.fn(async () => context) } as unknown as Browser;

    expect(await newRecordingPage(browser)).toBe(page);
    expect(browser.newContext).toHaveBeenCalledWith(expect.objectContaining({ serviceWorkers: 'block' }));
    // A rota vem antes da página: nada sai da página sem passar por ela.
    expect(context.route.mock.invocationCallOrder[0]).toBeLessThan(context.newPage.mock.invocationCallOrder[0]!);
    expect(handlers).toHaveLength(1);

    const routeFor = (method: string) => ({ request: () => ({ method: () => method }), abort: vi.fn(), fallback: vi.fn() });
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const route = routeFor(method);
      await handlers[0]!(route as unknown as Route);
      expect(route.abort).toHaveBeenCalled();
      expect(route.fallback).not.toHaveBeenCalled();
    }
    const get = routeFor('GET');
    await handlers[0]!(get as unknown as Route);
    expect(get.fallback).toHaveBeenCalled();
    expect(get.abort).not.toHaveBeenCalled();
  });
});
