import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyDataDir, browserProfileDir, fakeBrowserProfileDir, resolveShot, shotPath } from './data-dir';

describe('data folder', () => {
  it('resolves the data folder per platform', () => {
    expect(applyDataDir({ LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local' }, 'win32', 'C:\\Users\\x')).toBe('C:\\Users\\x\\AppData\\Local\\kanban-vagas');
    expect(applyDataDir({}, 'linux', '/home/x')).toBe('/home/x/.local/share/kanban-vagas');
    expect(applyDataDir({ APPLY_DATA_DIR: '/data' }, 'linux', '/home/x')).toBe('/data');
  });
  it('covers macOS, XDG and the Windows fallback', () => {
    expect(applyDataDir({}, 'darwin', '/Users/x')).toBe('/Users/x/Library/Application Support/kanban-vagas');
    expect(applyDataDir({ XDG_DATA_HOME: '/xdg' }, 'linux', '/home/x')).toBe('/xdg/kanban-vagas');
    expect(applyDataDir({}, 'win32', 'C:\\Users\\x')).toBe('C:\\Users\\x\\AppData\\Local\\kanban-vagas');
  });
  it('names the profile folder and the shot paths', () => {
    expect(browserProfileDir('/data')).toBe(join('/data', 'browser'));
    const s = shotPath('/data', 7, 'filled');
    expect(s.relative).toBe('shots/7/filled.jpg');
    expect(s.absolute).toBe(join('/data', 'shots/7/filled.jpg'));
  });
  it('never resolves a shot outside the data folder', () => {
    expect(resolveShot('/data', 'shots/7/filled.jpg')).toBe(join('/data', 'shots/7/filled.jpg'));
    expect(resolveShot('/data', '../etc/passwd')).toBeNull();
    expect(resolveShot('/data', '/etc/passwd')).toBeNull();
  });
  it('serves only a photo under shots/<application id>/, never another file of the data folder', () => {
    for (const bad of ['browser/Default/Cookies', 'resumes/7/cv.pdf', 'smoke/lever-1.png', 'shots', 'shots/7', 'shots/x/filled.jpg',
      'shots/7/sub/filled.jpg', 'shots//filled.jpg', './shots/7/filled.jpg']) {
      expect(resolveShot('/data', bad), bad).toBeNull();
    }
    expect(resolveShot('/data', 'shots/12/confirmation.jpg')).toBe(join('/data', 'shots/12/confirmation.jpg'));
  });
  it('names the profile folder of the test site browser apart from the real one', () => {
    expect(fakeBrowserProfileDir('/data')).toBe(join('/data', 'browser-fake'));
    expect(fakeBrowserProfileDir('/data')).not.toBe(browserProfileDir('/data'));
  });
  it('rejects the Windows and nested traversal forms too', () => {
    for (const bad of ['..\\x', 'C:\\x', 'C:x', '\\\\srv\\s','a/../../x', 'a/../x']) {
      expect(resolveShot('/data', bad), bad).toBeNull();
    }
  });
});
