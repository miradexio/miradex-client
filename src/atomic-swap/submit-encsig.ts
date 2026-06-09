// Standalone submit_encsig helper. driveSwapToCompletion does this inline.

import { TERMINAL_STATUSES, ProtocolError, isPreFunding } from '../types/index.js';
import { computeRedeemDigest } from './presign.js';
import { encsignDigest } from '../lib/crypto/wasm.js';
import { delay } from '../lib/delay.js';
import { SwapCancelledError, type SubmitEncsigParams } from './types.js';

const TIMEOUT_MS = 3_600_000;
const POLL_MS = 10_000;

// @internal Production consumers should use MiradexEngine / AtomicFlow.
export async function submitEncsigWhenReady(options: SubmitEncsigParams): Promise<void> {
  const { api, swapId, keys, signedPsbtBase64, network, onProgress, signal } = options;
  const deadline = Date.now() + TIMEOUT_MS;

  while (true) {
    if (signal?.aborted) throw new SwapCancelledError();

    const detail = await api.getSwapDetail(swapId);
    if (TERMINAL_STATUSES.has(detail.status)) return;

    if (Date.now() >= deadline && isPreFunding(detail.status)) {
      throw new ProtocolError(
        'E_DRIVE_TIMEOUT',
        'timed out waiting for submit_encsig signal',
      );
    }

    const actionType = detail.requiredAction?.type;

    if (actionType === 'submit_encsig') {
      onProgress({ stage: 'submit_encsig', message: 'Computing encrypted signature', swapId });

      const protocolParams =
        detail.protocolData?.type === 'atomicswap' ? detail.protocolData.params : null;
      if (!protocolParams) {
        throw new ProtocolError(
          'E_PROTOCOL_PARAMS_MISSING',
          'server requested submit_encsig but protocolParams are missing',
        );
      }

      const redeemDigest = computeRedeemDigest({
        signedPsbtBase64,
        protocolParams,
        bPubHex: keys.B,
        network,
      });
      const txRedeemEncsig = encsignDigest(keys.b, protocolParams.S_a_bitcoin, redeemDigest);

      onProgress({ stage: 'submit_encsig', message: 'Submitting encrypted signature', swapId });
      await api.executeAction(swapId, {
        type: 'submit_encsig',
        tx_redeem_encsig: txRedeemEncsig,
      });

      onProgress({ stage: 'submit_encsig', message: 'Encrypted signature submitted', swapId });
      return;
    }

    if (actionType === 'cancel' || actionType === 'refund' || actionType === 'sweep') return;

    await delay(POLL_MS, signal);
  }
}
