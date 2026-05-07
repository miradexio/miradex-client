import type { Logger } from '../interfaces/logger.js';
import { noopLogger } from '../interfaces/logger.js';
import type { CreateSwapResponse, ClientKeys } from '../types/index.js';
import { generateClientKeysFromSeed } from '../lib/crypto/wasm.js';
import { generateMnemonicKeys } from '../lib/crypto/mnemonic.js';
import { walletFromWif } from '../lib/bitcoin/wallet.js';
import type { TempBtcWallet } from '../lib/bitcoin/wallet.js';
import { createKeystore } from '../lib/keystore.js';
import { deriveLibp2pIdentity } from '../lib/crypto/libp2p-identity.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { randomBytes } from '@noble/hashes/utils.js';
import { watchForDeposit, estimateLockTxFee } from '../lib/bitcoin/deposit-watcher.js';
import type { DetectedDeposit } from '../lib/bitcoin/deposit-watcher.js';
import { solveChallenge, encodePowHeader } from '../lib/pow-solver.js';
import {
  driveSwapToCompletion,
  createFundingProof,
} from './drive.js';
import {
  SwapCancelledError,
  type RunAtomicSwapOptions,
  type ResumeAtomicSwapOptions,
} from './types.js';
import { ProtocolError } from '../types/protocol.js';

// @internal Prefer SwapExecutor.executeAtomicSwap or MiradexEngine.
// Throws SwapCancelledError on abort, VerificationError on a failed crypto
// check, ProtocolError on unrecoverable protocol state.
export async function runAtomicSwap(
  options: RunAtomicSwapOptions,
): Promise<{ swapId: string; keystoreId: string; depositAddress: string }> {
  const { api, params, callbacks, signal, fetchFn = globalThis.fetch } = options;
  const { destAddress, refundAddress, network = 'mainnet' } = params;
  const log: Logger = params.logger ?? noopLogger;
  const { onProgress } = callbacks;

  log.info(
    { network, destAddress, refundAddress, amount: params.amount },
    'Starting atomic swap',
  );

  onProgress({ stage: 'keygen', message: 'Generating swap keys' });
  const mnemonicKeys = generateMnemonicKeys(network);
  const keys: ClientKeys = generateClientKeysFromSeed(
    mnemonicKeys.s_b_seed,
    mnemonicKeys.v_b_seed,
    mnemonicKeys.b_seed,
  );
  const wallet: TempBtcWallet = walletFromWif(mnemonicKeys.wif, network);

  const verification = await api.verifyKeys({
    s_b_bitcoin: keys.s_b_bitcoin,
    s_b_monero: keys.s_b_monero,
    dleq_proof: keys.dleq_proof,
    v_b: keys.v_b,
  });
  if (!verification.valid) {
    log.error({ reason: verification.reason }, 'Key verification failed');
    throw new Error(`Key verification failed: ${verification.reason}. DO NOT DEPOSIT.`);
  }

  log.info({ network, destAddress, refundAddress }, '[run] starting new atomic swap');
  const masterSeedHex = bytesToHex(randomBytes(32));
  const libp2pIdentity = await deriveLibp2pIdentity(masterSeedHex);
  log.info(
    { peerId: libp2pIdentity.libp2pPeerId },
    '[run] per-swap libp2p identity derived (seed in keystore, peer-id forwarded to sidecar)',
  );
  const keystore = createKeystore({
    wif: wallet.wif,
    btcAddress: wallet.address,
    network,
    s_b: keys.s_b,
    v_b: keys.v_b,
    S_b_bitcoin: keys.s_b_bitcoin,
    S_b_monero: keys.s_b_monero,
    dleq_proof: keys.dleq_proof,
    b: keys.b,
    B: keys.B,
    eigenwallet_master_seed: masterSeedHex,
    libp2p_peer_id: libp2pIdentity.libp2pPeerId,
    receiveAddress: destAddress,
    refundAddress,
    mnemonic: mnemonicKeys.mnemonic,
    derivation: mnemonicKeys.derivation,
  });

  const keystoreId = `swap-backup-${String(Date.now())}`;
  await callbacks.saveKeystore(keystoreId, JSON.stringify(keystore, null, 2));

  onProgress({
    stage: 'keystore_saved',
    message: `Keystore saved (contains recovery mnemonic): ${keystoreId}`,
    keystoreId,
    depositAddress: wallet.address,
  });

  const { feeSats: preFee } = await estimateLockTxFee({
    network, fetchFn, blockchain: params.blockchain,
  });
  const userAmountSats = Math.round(parseFloat(params.amount) * 1e8);
  const requiredDepositSats = userAmountSats + preFee;
  const requiredDepositBtc = (requiredDepositSats / 1e8).toFixed(8);

  let expectedXmr = '';
  try {
    const quotes = await api.getQuotes({ from: 'BTC', to: 'XMR', amount: params.amount });
    const atomicQuote = quotes.quotes?.find((q) => q.provider === 'atomicswap');
    expectedXmr = atomicQuote?.expectedOutput ?? '';
  } catch {
    /* quote unavailable — non-fatal */
  }

  callbacks.onDepositRequired(wallet.address, requiredDepositBtc);

  onProgress({
    stage: 'awaiting_deposit',
    message: `Send ${requiredDepositBtc} BTC to the address above. The swap will start automatically once the deposit is detected.`,
    depositAddress: wallet.address,
    depositAmount: requiredDepositBtc,
    keystoreId,
    expectedOutput: expectedXmr,
  });

  if (signal?.aborted) {
    onProgress({ stage: 'cancelled', message: 'Swap cancelled.' });
    throw new SwapCancelledError();
  }

  let deposit: DetectedDeposit;
  try {
    deposit = await watchForDeposit({
      address: wallet.address,
      network,
      signal,
      fetchFn,
      blockchain: params.blockchain,
    });
  } catch (error: unknown) {
    if (signal?.aborted) {
      onProgress({ stage: 'cancelled', message: 'Swap cancelled. No BTC was deposited.' });
      throw new SwapCancelledError();
    }
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Deposit watch failed: ${reason}`);
  }

  const depositBtc = (deposit.value / 1e8).toFixed(8);

  onProgress({
    stage: 'deposit_detected',
    message: `Deposit detected: ${depositBtc} BTC (txid: ${deposit.txid.slice(0, 16)}...)`,
    depositAddress: wallet.address,
  });

  if (signal?.aborted) throw new SwapCancelledError();

  onProgress({ stage: 'creating_swap', message: 'Estimating fee' });

  const { feeSats, feeRate } = await estimateLockTxFee({
    network, fetchFn, blockchain: params.blockchain,
  });
  const swapSats = deposit.value - feeSats;
  if (swapSats <= 0) {
    throw new Error(`Deposit too small: ${deposit.value} sats cannot cover ${feeSats} sat fee`);
  }
  const swapBtc = (swapSats / 1e8).toFixed(8);

  onProgress({
    stage: 'creating_swap',
    message: `Fee: ${String(feeSats)} sats (${String(feeRate)} sat/vB). Swapping ${swapBtc} BTC.`,
  });

  const { fundingProof } = createFundingProof(wallet, deposit);

  onProgress({ stage: 'creating_swap', message: 'Solving proof of work' });
  const challenge = await api.getChallenge();
  const powPayload = await solveChallenge(challenge);
  const powHeader = encodePowHeader(powPayload);

  const swapRes: CreateSwapResponse = await api.createSwap(
    {
      from: 'BTC',
      to: 'XMR',
      amount: swapBtc,
      destAddress,
      refundAddress,
      provider: 'atomicswap',
      ...(params.variantId !== undefined ? { variantId: params.variantId } : {}),
      protocol: {
        type: 'atomicSwap',
        atomicSwap: {
          S_b_bitcoin: keys.s_b_bitcoin,
          S_b_monero: keys.s_b_monero,
          dleq_proof: keys.dleq_proof,
          v_b: keys.v_b,
          B: keys.B,
          libp2p_seed_hex: keystore.keys.eigenwallet_master_seed,
        },
        fundingProof: [...fundingProof],
      },
    },
    powHeader,
  );

  const swapId = swapRes.swapNumber;
  log.info(
    { swapNumber: swapRes.swapNumber, amount: swapBtc, variantId: params.variantId ?? null },
    'Swap created on server',
  );
  onProgress({
    stage: 'creating_swap',
    message: `Swap created: ${swapRes.swapNumber}`,
    swapId,
    expectedOutput: swapRes.expectedAmountOut ?? undefined,
    swapNumber: swapRes.swapNumber,
  });

  onProgress({ stage: 'creating_swap', message: 'Negotiating with maker', swapId });
  await driveSwapToCompletion({
    api, swapId, keystoreId, wallet, deposit, keystore, network, onProgress, signal, logger: log,
    blockchain: params.blockchain,
    saveProtocolSnapshot: callbacks.saveProtocolSnapshot,
    loadProtocolSnapshot: callbacks.loadProtocolSnapshot,
    monerodNodes: params.monerodNodes,
  });

  return { swapId, keystoreId, depositAddress: wallet.address };
}

// @internal Prefer MiradexEngine.resume / AtomicFlow.resumeFromKeystore.
// With existingSwapId set, picks up the swap from its current requiredAction
// instead of creating a new one.
export async function resumeAtomicSwap(
  options: ResumeAtomicSwapOptions,
): Promise<{ swapId: string }> {
  const { api, params, onProgress, signal, fetchFn = globalThis.fetch } = options;
  const { keystore, deposit, network = 'mainnet' } = params;
  const log: Logger = params.logger ?? noopLogger;
  const destAddress = keystore.swap.receiveAddress;
  const refundAddress = keystore.swap.refundAddress;
  const wallet = walletFromWif(keystore.btc.wif, network);

  let swapId = params.existingSwapId ?? '';

  if (swapId) {
    onProgress({ stage: 'creating_swap', message: 'Resuming existing swap', swapId });
  } else {
    // V2-migrated keystores have no master seed; their libp2p identity is
    // unrecoverable and cross-binary recovery wouldn't work. Force a fresh
    // keystore for new swaps.
    if (!keystore.keys.eigenwallet_master_seed) {
      throw new ProtocolError(
        'E_LIBP2P_SEED_REQUIRED',
        'This keystore has no libp2p master seed. Create a fresh keystore to start a new swap.',
      );
    }
    const depositBtc = (deposit.value / 1e8).toFixed(8);
    onProgress({
      stage: 'deposit_detected',
      message: `Deposit: ${depositBtc} BTC (txid: ${deposit.txid.slice(0, 16)}...)`,
      depositAddress: wallet.address,
    });

    if (signal?.aborted) throw new SwapCancelledError();

    const { feeSats, feeRate } = await estimateLockTxFee({
      network, fetchFn, blockchain: params.blockchain,
    });
    const swapSats = deposit.value - feeSats;
    if (swapSats <= 0) {
      throw new Error(`Deposit too small: ${deposit.value} sats cannot cover ${feeSats} sat fee`);
    }
    const swapBtc = (swapSats / 1e8).toFixed(8);
    onProgress({
      stage: 'creating_swap',
      message: `Fee: ${String(feeSats)} sats (${String(feeRate)} sat/vB). Swapping ${swapBtc} BTC.`,
    });

    const { fundingProof } = createFundingProof(wallet, deposit);

    onProgress({ stage: 'creating_swap', message: 'Solving proof of work' });
    const challenge = await api.getChallenge();
    const powPayload = await solveChallenge(challenge);
    const powHeader = encodePowHeader(powPayload);

    const swapRes: CreateSwapResponse = await api.createSwap(
      {
        from: 'BTC',
        to: 'XMR',
        amount: swapBtc,
        destAddress,
        refundAddress,
        provider: 'atomicswap',
        ...(params.variantId !== undefined ? { variantId: params.variantId } : {}),
        protocol: {
          type: 'atomicSwap',
          atomicSwap: {
            S_b_bitcoin: keystore.keys.S_b_bitcoin,
            S_b_monero: keystore.keys.S_b_monero,
            dleq_proof: keystore.keys.dleq_proof,
            v_b: keystore.keys.v_b,
            B: keystore.keys.B,
            libp2p_seed_hex: keystore.keys.eigenwallet_master_seed,
          },
          fundingProof: [...fundingProof],
        },
      },
      powHeader,
    );

    swapId = swapRes.swapNumber;
    onProgress({
      stage: 'creating_swap',
      message: `Swap created: ${swapRes.swapNumber}`,
      swapId,
      expectedOutput: swapRes.expectedAmountOut ?? undefined,
      swapNumber: swapRes.swapNumber,
    });
  }

  // Caller doesn't carry the keystoreId through, so derive a stable
  // placeholder from the BTC address for snapshot bookkeeping.
  const resumedKeystoreId = `resumed-${keystore.btc.address}`;
  await driveSwapToCompletion({
    api, swapId, keystoreId: resumedKeystoreId,
    wallet, deposit, keystore, network, onProgress, signal, logger: log,
    blockchain: params.blockchain,
    saveProtocolSnapshot: options.saveProtocolSnapshot,
    loadProtocolSnapshot: options.loadProtocolSnapshot,
    monerodNodes: params.monerodNodes,
  });
  return { swapId };
}
