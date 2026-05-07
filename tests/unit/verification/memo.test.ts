import { describe, it, expect } from 'vitest';
import {
  parseThorchainMemo,
  requireMemoBindsDestination,
} from '../../../src/verification/memo.js';
import { VerificationError } from '../../../src/types/index.js';

describe('parseThorchainMemo', () => {
  it('parses SWAP:ASSET:DEST', () => {
    const parsed = parseThorchainMemo('SWAP:BTC.BTC:bc1qxyzabc');
    expect(parsed.asset).toBe('BTC.BTC');
    expect(parsed.destAddress).toBe('bc1qxyzabc');
  });

  it('parses = short form with min-out and affiliate', () => {
    const parsed = parseThorchainMemo('=:ETH.ETH:0xabcd:1000:affx:10');
    expect(parsed.asset).toBe('ETH.ETH');
    expect(parsed.destAddress).toBe('0xabcd');
    expect(parsed.minOut).toBe(1000n);
    expect(parsed.affiliate).toBe('affx');
    expect(parsed.affiliateFeeBps).toBe(10);
  });

  it('parses streaming swap memo (LIMIT/INTERVAL/QUANTITY)', () => {
    const parsed = parseThorchainMemo(
      '=:BSC.BNB:0xa6bd713aee5936f466b8705606fc49b933542a6d:740370988/1/0',
    );
    expect(parsed.asset).toBe('BSC.BNB');
    expect(parsed.destAddress).toBe('0xa6bd713aee5936f466b8705606fc49b933542a6d');
    expect(parsed.minOut).toBe(740370988n);
    expect(parsed.streamingInterval).toBe(1);
    expect(parsed.streamingQuantity).toBe(0);
    expect(parsed.affiliate).toBeUndefined();
    expect(parsed.affiliateFeeBps).toBeUndefined();
  });

  it('parses streaming swap memo with affiliate', () => {
    const parsed = parseThorchainMemo('=:ETH.ETH:0xabcd:1000/3/5:affx:10');
    expect(parsed.minOut).toBe(1000n);
    expect(parsed.streamingInterval).toBe(3);
    expect(parsed.streamingQuantity).toBe(5);
    expect(parsed.affiliate).toBe('affx');
    expect(parsed.affiliateFeeBps).toBe(10);
  });

  it('throws E_MEMO_MALFORMED on garbage', () => {
    let caught: VerificationError | undefined;
    try { parseThorchainMemo('junk:'); } catch (err) { caught = err as VerificationError; }
    expect(caught?.code).toBe('E_MEMO_MALFORMED');
  });
});

describe('requireMemoBindsDestination', () => {
  it('passes when dest field equals expected', () => {
    expect(() =>
      requireMemoBindsDestination('SWAP:BTC.BTC:bc1qhonest', 'bc1qhonest'),
    ).not.toThrow();
  });

  it('rejects substring-only collisions (AV-K.6)', () => {
    // The old `includes()` would have passed this attacker memo; strict
    // parser rejects it as either malformed or dest-mismatch — either is
    // safe. The guarantee is: never pass silently.
    let caught: VerificationError | undefined;
    try {
      // The affiliate field stricty allows [A-Za-z0-9]+ (no underscores),
      // so this memo bypasses memo validation before field compare.
      requireMemoBindsDestination('SWAP:ETH.ETH:0xATTACKER:0:prefix.bc1qhonest.suffix', 'bc1qhonest');
    } catch (err) {
      caught = err as VerificationError;
    }
    expect(
      caught?.code === 'E_MEMO_DEST_MISMATCH' || caught?.code === 'E_MEMO_MALFORMED',
    ).toBe(true);
  });

  it('rejects a plainly wrong destination', () => {
    let caught: VerificationError | undefined;
    try {
      requireMemoBindsDestination('SWAP:BTC.BTC:bc1qattacker', 'bc1qhonest');
    } catch (err) {
      caught = err as VerificationError;
    }
    expect(caught?.code).toBe('E_MEMO_DEST_MISMATCH');
  });

  it('passes streaming memo when dest matches', () => {
    expect(() =>
      requireMemoBindsDestination(
        '=:BSC.BNB:0xa6bd713aee5936f466b8705606fc49b933542a6d:740370988/1/0',
        '0xa6bd713aee5936f466b8705606fc49b933542a6d',
      ),
    ).not.toThrow();
  });
});
