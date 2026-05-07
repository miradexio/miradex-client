import { describe, it, expect } from 'vitest';
import { MiradexEngine } from '../../../src/engine/miradex-engine.js';
import type { PlatformAdapter } from '../../../src/engine/platform.js';

const minimalPlatform = {} as PlatformAdapter;

describe('MiradexEngine monerodNodes config', () => {
  it('stores monerodNodes on resolvedConfig when provided', () => {
    const engine = new MiradexEngine(
      { apiUrl: 'http://x', monerodNodes: ['https://xmr.example:18081'] },
      minimalPlatform,
    );
    expect(engine.config.monerodNodes).toEqual(['https://xmr.example:18081']);
  });

  it('leaves monerodNodes undefined on resolvedConfig when omitted', () => {
    const engine = new MiradexEngine({ apiUrl: 'http://x' }, minimalPlatform);
    expect(engine.config.monerodNodes).toBeUndefined();
  });
});
