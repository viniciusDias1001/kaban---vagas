import { win32 } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { browserUnavailableReason, detectBrowserChannel, newestOperaGx, realLaunch } from './browser';

const launchPersistentContext = vi.hoisted(() => vi.fn(async () => ({})));
vi.mock('playwright', () => ({ chromium: { launchPersistentContext } }));

/** Um disco de mentira no formato do Windows: cada pasta com os arquivos que ela tem. */
function disk(tree: Record<string, string[]>) {
  const files = new Set<string>();
  for (const [dir, names] of Object.entries(tree)) for (const name of names) files.add(win32.join(dir, name));
  const exists = (path: string) => files.has(path);
  const list = (dir: string) => [...new Set([...files]
    .filter((f) => f.startsWith(dir + win32.sep))
    .map((f) => f.slice(dir.length + 1).split(win32.sep)[0]!)
    .filter((name) => !files.has(win32.join(dir, name))))];
  return { exists, list };
}
const LOCAL = win32.join('C:', 'Users', 'x', 'AppData', 'Local');
const GX = win32.join(LOCAL, 'Programs', 'Opera GX');
const exe = (version: string) => win32.join(GX, version, 'opera.exe');

describe('APPLY_BROWSER=opera-gx (K2)', () => {
  beforeEach(() => launchPersistentContext.mockClear());
  const fs = disk({
    [GX]: ['launcher.exe'],
    [win32.join(GX, '112.0.5197.60')]: ['opera.exe'],
    [win32.join(GX, '114.0.5282.21')]: ['opera.exe'],
    [win32.join(GX, '114.0.5282.102')]: ['opera.exe'],
    [win32.join(GX, '115.0.1.1')]: ['notes.txt'],
  });

  it('resolves to the opera.exe of the highest version folder that has one', () => {
    expect(newestOperaGx({ LOCALAPPDATA: LOCAL }, fs.exists, fs.list)).toBe(exe('114.0.5282.102'));
    expect(newestOperaGx({ LOCALAPPDATA: LOCAL }, () => false, () => [])).toBeNull();
    expect(newestOperaGx({}, fs.exists, fs.list)).toBeNull();
  });

  it('is chosen when installed, and is nothing (with a reason) when not', () => {
    expect(detectBrowserChannel({ APPLY_BROWSER: 'opera-gx', LOCALAPPDATA: LOCAL }, fs.exists, 'win32', fs.list)).toBe('opera-gx');
    expect(browserUnavailableReason({ APPLY_BROWSER: 'opera-gx', LOCALAPPDATA: LOCAL }, fs.exists, 'win32', fs.list)).toBeNull();
    expect(detectBrowserChannel({ APPLY_BROWSER: 'opera-gx', LOCALAPPDATA: LOCAL }, () => false, 'win32', () => [])).toBeNull();
    expect(browserUnavailableReason({ APPLY_BROWSER: 'opera-gx', LOCALAPPDATA: LOCAL }, () => false, 'win32', () => []))
      .toMatch(/Opera GX não foi encontrado/);
  });

  it('is resolved again at each launch, so an update between two launches is followed', async () => {
    let newest: string | null = exe('1.0');
    const launch = realLaunch('opera-gx', { resolveOperaGx: () => newest });
    await launch('/profile');
    newest = exe('2.0');
    await launch('/profile');
    expect(launchPersistentContext).toHaveBeenNthCalledWith(1, '/profile', { headless: false, executablePath: exe('1.0') });
    expect(launchPersistentContext).toHaveBeenNthCalledWith(2, '/profile', { headless: false, executablePath: exe('2.0') });
    newest = null;
    await expect(launch('/profile')).rejects.toThrow(/Opera GX/);
    expect(launchPersistentContext).toHaveBeenCalledTimes(2);
  });
});

describe('browserUnavailableReason (K2)', () => {
  it('is null when a browser is found', () => {
    expect(browserUnavailableReason({ APPLY_BROWSER: 'chrome' }, () => false, 'win32', () => [])).toBeNull();
  });

  it('names the newest sibling version when an absolute path no longer exists', () => {
    const fs = disk({
      [win32.join(GX, '114.0.5282.102')]: ['opera.exe'],
      [win32.join(GX, '113.0.1.1')]: ['opera.exe'],
      [win32.join(GX, '120.0.0.1')]: ['other.exe'],
    });
    const old = exe('112.0.5197.60');
    const reason = browserUnavailableReason({ APPLY_BROWSER: old }, fs.exists, 'win32', fs.list)!;
    expect(reason).toContain(old);
    expect(reason).toContain(exe('114.0.5282.102'));
    expect(reason).not.toContain('120.0.0.1');
    expect(reason).toMatch(/opera-gx/);
    expect(detectBrowserChannel({ APPLY_BROWSER: old }, fs.exists, 'win32', fs.list)).toBeNull();
  });

  it('says the path does not exist when there is no sibling version', () => {
    const reason = browserUnavailableReason({ APPLY_BROWSER: '/opt/x/1.0/browser' }, () => false, 'linux', () => [])!;
    expect(reason).toContain('"/opt/x/1.0/browser"');
    expect(reason).toMatch(/não existe/);
    expect(reason).not.toMatch(/mais nova/);
  });

  it('explains an unknown name and the case with nothing installed', () => {
    expect(browserUnavailableReason({ APPLY_BROWSER: 'firefox' }, () => false, 'win32', () => [])).toMatch(/"firefox".*chrome, msedge, opera-gx/);
    expect(browserUnavailableReason({}, () => false, 'win32', () => [])).toMatch(/Nenhum navegador encontrado.*opera-gx/);
  });
});
