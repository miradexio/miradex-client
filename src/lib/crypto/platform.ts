// Result is cached after the first call; tests can call __resetPlatformCache.

export type Platform =
  | 'node'
  | 'browser'
  | 'react-native'
  | 'electron-renderer'
  | 'electron-main'
  | 'worker'
  | 'unknown';

let cached: Platform | null = null;

export function detectPlatform(): Platform {
  if (cached) return cached;
  cached = computePlatform();
  return cached;
}

function computePlatform(): Platform {
  const g = globalThis as Record<string, unknown>;

  const navigator = g['navigator'] as { product?: string } | undefined;
  if (navigator?.product === 'ReactNative') return 'react-native';

  if (typeof process !== 'undefined') {
    const type = (process as { type?: string }).type;
    if (type === 'renderer') return 'electron-renderer';
    if (type === 'browser') return 'electron-main';
  }

  const selfGlobal = g['self'] as { importScripts?: unknown } | undefined;
  if (selfGlobal && typeof selfGlobal.importScripts === 'function') return 'worker';

  if (typeof process !== 'undefined' && process.versions?.node) return 'node';

  if (g['window'] !== undefined && g['document'] !== undefined) return 'browser';

  return 'unknown';
}

// Test-only.
export function __resetPlatformCache(): void {
  cached = null;
}
