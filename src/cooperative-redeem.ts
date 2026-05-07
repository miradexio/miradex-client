import { Point } from '@noble/ed25519';
import { bytesToHex } from '@noble/hashes/utils.js';
import { VerificationError } from './types/index.js';
import { recoverAdaptorScalar } from './lib/crypto/wasm.js';
import { bytesToBigInt, hexToBytes } from './lib/crypto/scalars.js';
import { constantTimeEqualHex } from './lib/crypto/bytes.js';

// AV-A.17: validate s_a Alice returns out-of-band after a punish round.

export interface CooperativeRedeemInput {
  /** Alice's on-chain ECDSA signature over TxRedeem, 64B hex. */
  readonly aliceSigA: string;
  /** Adaptor (encrypted) signature Bob released, hex. */
  readonly bobEncsig: string;
  /** Alice's compressed secp256k1 adaptor pubkey, 33B hex. */
  readonly S_a_bitcoin: string;
  /** Alice's ed25519 public spend key, 32B hex. */
  readonly S_a_monero: string;
  /** s_a scalar Alice returned, 32B hex. */
  readonly claimedSA: string;
}

// Returns claimedSA so callers can pipe it forward.
// Throws E_COOP_SA_ADAPTOR_MISMATCH on adaptor recovery mismatch,
// E_COOP_SA_PUBKEY_MISMATCH if claimedSA * G != S_a_monero.
export function validateCooperativeRedeem(input: CooperativeRedeemInput): string {
  const recovered = recoverAdaptorScalar(input.aliceSigA, input.bobEncsig, input.S_a_bitcoin);
  if (!constantTimeEqualHex(recovered, input.claimedSA)) {
    throw new VerificationError(
      'E_COOP_SA_ADAPTOR_MISMATCH',
      'cooperative s_a does not match adaptor-recovery target',
    );
  }
  const claimedBytes = hexToBytes(input.claimedSA);
  const claimedPoint = Point.BASE.multiply(bytesToBigInt(claimedBytes));
  const expectedPoint = Point.fromHex(input.S_a_monero);
  if (bytesToHex(claimedPoint.toBytes()) !== bytesToHex(expectedPoint.toBytes())) {
    throw new VerificationError(
      'E_COOP_SA_PUBKEY_MISMATCH',
      'cooperative s_a does not hash to S_a_monero',
    );
  }
  return input.claimedSA;
}
