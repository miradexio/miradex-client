import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  __resetPlatformCache,
  detectPlatform,
} from '../../../src/lib/crypto/platform.js';

afterEach(() => {
  __resetPlatformCache();
  vi.unstubAllGlobals();
});

describe('detectPlatform', () => {
  it('returns "react-native" when navigator.product is ReactNative', () => {
    vi.stubGlobal('navigator', { product: 'ReactNative' });
    expect(detectPlatform()).toBe('react-native');
  });

  it('returns "electron-renderer" when process.type is renderer', () => {
    const proc = { ...process, type: 'renderer' };
    vi.stubGlobal('process', proc);
    expect(detectPlatform()).toBe('electron-renderer');
  });

  it('returns "node" in the default vitest environment', () => {
    expect(detectPlatform()).toBe('node');
  });

  it('caches the result across calls', () => {
    const first = detectPlatform();
    const second = detectPlatform();
    expect(first).toBe(second);
  });
});
