import { describe, it, expect } from 'vitest';
import {
  createFlowContext,
  mergeFlowContext,
  validateBase,
  validatePopulated,
  validateVerified,
} from '../../../src/engine/flow-context.js';
import type { FlowContext } from '../../../src/engine/flow-context.js';

describe('FlowContext Zod validation', () => {
  describe('restricted flag', () => {
    it('defaults restricted to false', () => {
      expect(createFlowContext({}).restricted).toBe(false);
    });

    it('carries restricted=true through base validation', () => {
      const ctx = createFlowContext({ restricted: true });
      const result = validateBase(ctx, 'restricted-test');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.restricted).toBe(true);
      }
    });
  });

  describe('validateBase', () => {
    it('accepts a valid base context with all nulls', () => {
      const ctx = createFlowContext({});
      const result = validateBase(ctx, 'test');
      expect(result.ok).toBe(true);
    });

    it('accepts a context with some fields set', () => {
      const ctx = createFlowContext({ fromToken: 'BTC', toToken: 'XMR' });
      const result = validateBase(ctx, 'test');
      expect(result.ok).toBe(true);
    });
  });

  describe('validatePopulated', () => {
    it('rejects when required fields are null', () => {
      const ctx = createFlowContext({ fromToken: 'BTC' });
      const result = validatePopulated(ctx, 'awaiting-deposit');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.phase).toBe('awaiting-deposit');
        expect(result.error.fields).toContain('destAddress');
        expect(result.error.fields).toContain('depositAddr');
        expect(result.error.fields).toContain('qr');
        expect(result.error.fields).toContain('provider');
      }
    });

    it('rejects when required fields are empty strings', () => {
      const ctx: FlowContext = {
        ...createFlowContext({}),
        depositAddr: '',
        destAddress: '',
        fromToken: '',
        toToken: '',
        qr: '',
        provider: '',
      };
      const result = validatePopulated(ctx, 'awaiting-deposit');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.fields.length).toBeGreaterThan(0);
        expect(result.error.message).toContain('awaiting-deposit');
      }
    });

    it('accepts when all required fields are non-empty', () => {
      const ctx = createFlowContext({
        depositAddr: 'bc1qtest',
        destAddress: '72QfzK...',
        fromToken: 'BTC',
        toToken: 'XMR',
        qr: 'QR_DATA',
        provider: 'atomicswap',
        expectedOut: '1.5',
      });
      const result = validatePopulated(ctx, 'awaiting-deposit');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.destAddress).toBe('72QfzK...');
        expect(result.data.depositAddr).toBe('bc1qtest');
      }
    });

    it('returns structured error with all missing fields listed', () => {
      const ctx = createFlowContext({ fromToken: 'BTC', toToken: 'XMR' });
      const result = validatePopulated(ctx, 'test-phase');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.phase).toBe('test-phase');
        expect(result.error.fields.length).toBeGreaterThan(0);
        expect(result.error.message).toContain("test-phase");
        expect(result.error.message).toContain('depositAddr');
      }
    });
  });

  describe('validateVerified', () => {
    it('rejects when verification is null', () => {
      const ctx = createFlowContext({
        depositAddr: 'bc1qtest',
        destAddress: '72QfzK...',
        fromToken: 'BTC',
        toToken: 'XMR',
        qr: 'QR_DATA',
        provider: 'atomicswap',
        expectedOut: '1.5',
        verification: null,
      });
      const result = validateVerified(ctx, 'confirming');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.fields).toContain('verification');
      }
    });

    it('accepts when verification is present', () => {
      const ctx = createFlowContext({
        depositAddr: 'bc1qtest',
        destAddress: '72QfzK...',
        fromToken: 'BTC',
        toToken: 'XMR',
        qr: 'QR_DATA',
        provider: 'atomicswap',
        expectedOut: '1.5',
        verification: {
          verified: true,
          provider: 'atomicswap',
          checks: [{ name: 'test', passed: true, detail: 'ok' }],
          timestamp: Date.now(),
        },
      });
      const result = validateVerified(ctx, 'confirming');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.verification.verified).toBe(true);
        expect(result.data.destAddress).toBe('72QfzK...');
      }
    });
  });

  describe('mergeFlowContext', () => {
    it('preserves existing fields when merging partial', () => {
      const base = createFlowContext({ destAddress: '72QfzK...', fromToken: 'BTC' });
      const merged = mergeFlowContext(base, { toToken: 'XMR' });
      expect(merged.destAddress).toBe('72QfzK...');
      expect(merged.fromToken).toBe('BTC');
      expect(merged.toToken).toBe('XMR');
    });

    it('overwrites fields present in partial', () => {
      const base = createFlowContext({ destAddress: 'old' });
      const merged = mergeFlowContext(base, { destAddress: 'new' });
      expect(merged.destAddress).toBe('new');
    });

    it('null in partial overwrites to null', () => {
      const base = createFlowContext({ destAddress: '72QfzK...' });
      const merged = mergeFlowContext(base, { destAddress: null });
      expect(merged.destAddress).toBeNull();
    });
  });
});
