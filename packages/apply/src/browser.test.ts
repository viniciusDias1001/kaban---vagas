import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserContext, Page } from 'playwright';
import { createBrowserSession, detectBrowserChannel, realLaunch } from './browser';

const launchPersistentContext = vi.hoisted(() => vi.fn(async () => ({})));
vi.mock('playwright', () => ({ chromium: { launchPersistentContext } }));

describe('realLaunch', () => {
  beforeEach(() => launchPersistentContext.mockClear());
  it('turns a channel into channel, always headed with the given profile', async () => {
    await realLaunch('msedge')('/profile');
    expect(launchPersistentContext).toHaveBeenCalledWith('/profile', { headless: false, channel: 'msedge' });
  });
  it('turns { executablePath } into executablePath, always headed', async () => {
    await realLaunch({ executablePath: '/opt/opera/opera' })('/profile');
    expect(launchPersistentContext).toHaveBeenCalledWith('/profile', { headless: false, executablePath: '/opt/opera/opera' });
  });
  it('forwards serviceWorkers only when asked, and leaves the default call unchanged', async () => {
    await realLaunch('chrome', { serviceWorkers: 'block' })('/profile');
    expect(launchPersistentContext).toHaveBeenLastCalledWith('/profile', { headless: false, channel: 'chrome', serviceWorkers: 'block' });
    await realLaunch('chrome', { serviceWorkers: 'allow' })('/profile');
    expect(launchPersistentContext).toHaveBeenLastCalledWith('/profile', { headless: false, channel: 'chrome', serviceWorkers: 'allow' });
    await realLaunch('chrome', {})('/profile');
    expect(launchPersistentContext).toHaveBeenLastCalledWith('/profile', { headless: false, channel: 'chrome' });
  });
});

describe('detectBrowserChannel', () => {
  it('honours APPLY_BROWSER=chrome or msedge without looking at the disk', () => {
    const never = () => false;
    expect(detectBrowserChannel({ APPLY_BROWSER: 'chrome' }, never, 'linux')).toBe('chrome');
    expect(detectBrowserChannel({ APPLY_BROWSER: 'msedge' }, never, 'linux')).toBe('msedge');
  });
  it('turns an absolute APPLY_BROWSER path into an executablePath when it exists', () => {
    const opera = 'C:\\Users\\x\\AppData\\Local\\Programs\\Opera GX\\opera.exe';
    expect(detectBrowserChannel({ APPLY_BROWSER: opera }, (p) => p === opera, 'win32')).toEqual({ executablePath: opera });
    expect(detectBrowserChannel({ APPLY_BROWSER: '/opt/opera/opera' }, (p) => p === '/opt/opera/opera', 'linux')).toEqual({ executablePath: '/opt/opera/opera' });
  });
  it('returns null when the APPLY_BROWSER path does not exist', () => {
    expect(detectBrowserChannel({ APPLY_BROWSER: '/nope/browser' }, () => false, 'linux')).toBeNull();
  });
  it('looks for Chrome, then Edge, at the default install paths', () => {
    const env = { ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)', LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local' };
    const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
    const chrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
    expect(detectBrowserChannel(env, (p) => p === edge || p === chrome, 'win32')).toBe('chrome');
    expect(detectBrowserChannel(env, (p) => p === edge, 'win32')).toBe('msedge');
    expect(detectBrowserChannel(env, () => false, 'win32')).toBeNull();
    expect(detectBrowserChannel({}, (p) => p === '/usr/bin/microsoft-edge', 'linux')).toBe('msedge');
    expect(detectBrowserChannel({}, (p) => p === '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', 'darwin')).toBe('chrome');
  });
});

function stubContext() {
  const startTab = {} as Page; // a tab the browser opened by itself: must never be used
  const mine = { isClosed: () => false, bringToFront: vi.fn(async () => {}) } as unknown as Page;
  const handlers: Record<string, () => void> = {};
  const context = {
    pages: () => [startTab],
    newPage: vi.fn(async () => mine),
    on: (event: string, h: () => void) => { handlers[event] = h; },
    close: vi.fn(async () => { handlers.close?.(); }),
  } as unknown as BrowserContext;
  return { context, mine, handlers };
}

describe('createBrowserSession', () => {
  it('opens lazily, creates its own page with newPage and keeps it', async () => {
    const { context, mine } = stubContext();
    const launch = vi.fn(async () => context);
    let t = 100;
    const session = createBrowserSession({ userDataDir: '/p', launch, now: () => t });
    expect(session.isOpen()).toBe(false);
    expect(launch).not.toHaveBeenCalled();
    expect(await session.page()).toBe(mine);
    t = 250;
    expect(await session.page()).toBe(mine);
    expect(launch).toHaveBeenCalledTimes(1);
    expect(launch).toHaveBeenCalledWith('/p');
    expect(context.newPage).toHaveBeenCalledTimes(1);
    expect(session.isOpen()).toBe(true);
    expect(session.lastUsedAt()).toBe(250);
  });
  it('does not open two pages for concurrent calls, even after the page was closed', async () => {
    const { context } = stubContext();
    let closed = false;
    const mk = () => ({ isClosed: () => closed }) as unknown as Page;
    const first = mk();
    const second = mk();
    (context.newPage as ReturnType<typeof vi.fn>).mockResolvedValueOnce(first).mockResolvedValue(second);
    const session = createBrowserSession({ userDataDir: '/p', launch: async () => context });
    expect(await session.page()).toBe(first);
    closed = true;
    const [a, b] = await Promise.all([session.page(), session.page()]);
    expect(a).toBe(second);
    expect(b).toBe(second);
    expect(context.newPage).toHaveBeenCalledTimes(2);
  });
  it('closes a browser whose launch finishes after close() was called', async () => {
    const { context } = stubContext();
    let release!: () => void;
    const launch = vi.fn(() => new Promise<BrowserContext>((r) => { release = () => r(context); }));
    const session = createBrowserSession({ userDataDir: '/p', launch });
    const pending = session.page();
    const outcome = expect(pending).rejects.toThrow();
    await session.close();
    release();
    await outcome;
    expect(context.close).toHaveBeenCalledTimes(1);
    expect(session.isOpen()).toBe(false);
  });
  it('reopens after close, and notices when the owner closes the window', async () => {
    const { context, handlers } = stubContext();
    const launch = vi.fn(async () => context);
    const session = createBrowserSession({ userDataDir: '/p', launch });
    await session.page();
    handlers.close();
    expect(session.isOpen()).toBe(false);
    await session.page();
    expect(launch).toHaveBeenCalledTimes(2);
    await session.close();
    expect(session.isOpen()).toBe(false);
  });
});
