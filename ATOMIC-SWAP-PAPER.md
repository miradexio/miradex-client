# BTC↔XMR atomic swaps

How the SDK runs the BTC↔XMR atomic-swap protocol —
primitives, transactions, verification, recovery.

The cryptographic core ships as a Rust→WASM module at
[`./wasm/miradex-rust/`](./wasm/miradex-rust/), pinned by
SHA256 in [`./src/wasm-pins.ts`](./src/wasm-pins.ts) and
verifiable at load with `MIRADEX_VERIFY_WASM=1`. 
Protocol reference: [`eigenwallet/core`](https://github.com/eigenwallet/core).

---

## Scope

Three actors. **Bob** is the SDK in the user's host process
(browser or Node); it holds the private keys, signs locally,
and verifies every server claim on-chain. **SERVER** is the
public-facing API that drives the libp2p connection on Bob's
behalf, watches the chains for timelock expiry, and exposes
Monero-RPC tooling; it sees Bob's public spend keys, the DLEQ
proof, and the joint view-key share `v_b`, but never the
spend secrets `b` or `s_b`. **Alice** is the remote ASB
maker, an external party running `swap-asb` from
[`eigenwallet/core`](https://github.com/eigenwallet/core).

The other three providers are out of scope here; their trust
models are in [`PROTOCOLS.md`](./PROTOCOLS.md).

### Adversaries

Two cryptographic adversaries: **Alice malicious** and
**SERVER malicious**. Collusion is their union. Network
attacks reduce to SERVER malicious; host-runtime compromise
is out of cryptographic scope.

### Trust assumptions

The host runtime is Bob's: it holds `b`, `s_b`, `v_b`, and the
BIP39 mnemonic; compromising it steals everything in the
keystore. Bitcoin script semantics enforce timelocks and
signature checks. The Electrum and monerod quorums
collectively return chain truth; a single compromised
endpoint causes a verification failure, not a stolen
transaction.

---

## Roles and naming

| Role | Holds | Source |
| --- | --- | --- |
| **Bob** | `b`, `s_b`, `v_b` (secret) | `@miradexio/client` running in the host runtime ([`./src`](./src)) |
| **SERVER** | `v_b` (view-key share) + public material | external infrastructure |
| **Alice** | `a`, `s_a`, `v_a` (secret) | `swap-asb` from [`eigenwallet/core`](https://github.com/eigenwallet/core) |

Lowercase scalars (`a`, `b`, `s_a`, …) are secret; uppercase
points (`A`, `B`, `S_a_bitcoin`, …) are public.


---

## Key generation and the DLEQ proof

### Mnemonic-driven derivation

Bob's keys come from a single 24-word BIP39 mnemonic
([`mnemonic.ts`](./src/lib/crypto/mnemonic.ts)). The mnemonic
is the master recovery key; everything else is deterministically
derived.

### Pre-deposit DLEQ self-check

Before showing Bob a deposit address, the SDK calls
`api.verifyKeys` with `s_b_bitcoin`, `s_b_monero`, `dleq_proof`,
and `v_b` ([`run.ts`](./src/atomic-swap/run.ts)). SERVER runs
the same WASM verifier — the call ensures Bob never submits
keys SERVER will silently reject later.

### Per-swap libp2p identity

SERVER dials Alice over libp2p; libp2p needs an Ed25519
identity keypair (PeerId). The SDK derives this per swap from
a fresh 32-byte random seed via `deriveLibp2pIdentity`
([`run.ts`](./src/atomic-swap/run.ts)) and includes the seed
in the swap-creation request so SERVER can derive the matching
PeerId for the dial. 

---




## The Bitcoin transaction tree

### Lock script

The 2-of-2 lock script is a P2WSH wrapping
`<A> CHECKSIGVERIFY <B> CHECKSIG`, derived from Alice's and
Bob's compressed secp256k1 public keys via
`buildMultisigWitnessScript`
([`presign.ts`](./src/atomic-swap/presign.ts)). The lock
address is `p2wsh(redeem: { output: witnessScript })`. The SDK
calls the same code for both deriving the expected lock address
(verification) and building the actual deposit address
(funding PSBT), so a SERVER-claimed lock address that differs
is a verification failure.

### TxLock — Bob locks BTC

TxLock is a normal Bitcoin transaction paying `lockValueSats`
to the P2WSH lock address with change back to Bob's temp
wallet. The unsigned PSBT is built by `buildUnsignedFundingPsbt`
([`wallet.ts`](./src/lib/bitcoin/wallet.ts)) and signed via the
platform-supplied `signFundingPsbt` (so a hardware wallet can
plug in). Order of operations in
[`drive.ts`](./src/atomic-swap/drive.ts):

1. Build unsigned PSBT.
2. Compute pre-signatures (`computePreSigs`).
3. Submit unsigned PSBT + pre-sigs to SERVER via `/presigs`.
4. Persist the recovery snapshot (`maybeWriteSnapshot`); the
   snapshot must hit disk before TxLock broadcasts, otherwise
   `E_SNAPSHOT_WRITE_FAILED`.
5. Sign locally.
6. Submit the signed PSBT to SERVER via `/fund`.

### Pre-signatures

Bob signs three (or six, with amnesty) transactions before
TxLock is broadcast, so any of them can be assembled into a
valid witness later. All sighashes are BIP143 over the lock
outpoint with `SIGHASH_ALL`, computed by `computePreSigs` in
[`presign.ts`](./src/atomic-swap/presign.ts).

| Pre-sig | Sighash bound to | Sequence | Purpose |
| --- | --- | --- | --- |
| `tx_cancel_sig` | TxCancel(lock → 2-of-2 cancel output) | `cancel_timelock` | Refund-path step 1 |
| `tx_punish_sig` | TxPunish(cancel → punish_address) | `punish_timelock` | Lets Alice punish if Bob never refunds |
| `tx_early_refund_sig` | TxEarlyRefund(lock → refundAddress) | `SEQUENCE_FINAL` | Cooperative early refund (no timelock) |
| `tx_reclaim_sig` (amnesty) | TxReclaim(amnesty → refundAddress) | `remaining_refund_timelock` | Reclaim the amnesty output |
| `tx_withhold_sig` (amnesty) | TxWithhold(amnesty → 2-of-2) | `SEQUENCE_FINAL` | Alice withholds amnesty |
| `tx_mercy_sig` (amnesty) | TxMercy(withhold → refundAddress) | `SEQUENCE_FINAL` | Mercy-after-withhold |

Mandatory bounds-checks (timelocks, fees, dust floors, amnesty
cap) run before signing; details and error codes are in
Verification gates above.

### TxRedeem — Alice spends TxLock

TxRedeem is a single-output transaction spending TxLock to
Alice's `redeem_address`. Alice cannot construct a
fully-signed TxRedeem alone because the witness needs Bob's
signature too. The protocol works:

1. Bob adaptor-signs the BIP143 sighash of TxRedeem:
   `t̂ = encsign(b, S_a_bitcoin, sighash)`.
2. Bob sends `t̂` to Alice via SERVER (which forwards it onto
   the libp2p stream).
3. Alice decrypts `t̂` to a real signature using `s_a`:
   `t = decrypt_signature(s_a, t̂)`. This is the only way she
   can spend TxRedeem because the witness construction requires
   Bob's pre-sig portion to be `t`-shaped.
4. When Alice broadcasts TxRedeem, the witness contains her
   ECDSA signature (built with `a`) plus `t`. From `t`, `t̂`,
   and `S_a_bitcoin`, anyone can recover `s_a` via
   `recover_adaptor_scalar`.

SERVER watches the chain for TxRedeem, extracts `s_a` from
its witness, and surfaces it to the SDK as `s_a_hex`. The SDK
validates `s_a` against `S_a_monero` before using it (Monero
side, below). Before adaptor-signing, the SDK requires
`S_a_monero` to be present (`AV-C.3`,
`E_S_A_MONERO_MISSING`), recomputes the redeem digest from
the signed PSBT (or the on-chain TxLock on resume), and
`constantTimeEqualHex`-compares to SERVER's claim
([`drive.ts`](./src/atomic-swap/drive.ts), `AV-B.2`,
`E_REDEEM_DIGEST_MISMATCH`). The encsig binds to the locally
recomputed digest, so it can only spend TxLock to the protocol
params' `redeem_address`.

### TxCancel — refund-path enabler

After `cancel_timelock` blocks since TxLock confirmed, anyone
holding `tx_cancel_sig` (Bob has his own; Alice's came in
Message3) can broadcast TxCancel, which spends TxLock to a new
2-of-2 P2WSH output. SERVER publishes it in production; the
SDK retains `tx_cancel_sig` in its snapshot for a future
autonomous-cancel binary. Before Bob refunds, the SDK
discovers the on-chain TxCancel via Electrum lock-address
history (`discoverAndVerifyTxCancel`,
[`atomic-flow.ts`](./src/engine/flows/atomic-flow.ts)) — the
real TxCancel is found from chain state, not trusted from
SERVER.

### TxRefund / TxPartialRefund / TxReclaim

After TxCancel confirms, Bob can broadcast TxRefund (or
TxPartialRefund for the amnesty path). `buildFullRefund` in
[`refund.ts`](./src/atomic-swap/refund.ts) builds the unsigned
tx; `signRefund` verifies Alice's adaptor-encsig refund
signature with `verifyEncsig` before calling
`decryptSignature` (a malformed encsig never feeds `s_b` into
decryption — `E_ENCSIG_REFUND_INVALID`), decrypts with `s_b`,
signs with `b`, enforces low-S form on both signatures,
re-verifies with `ecc.verify`, and assembles the witness. The
re-verify catches WASM-level bugs that would otherwise produce
unbroadcastable transactions.

### TxPunish

If Bob fails to refund within `punish_timelock` blocks of
TxCancel's confirmation (BIP68 relative timelock on the cancel
output), Alice can broadcast TxPunish, spending the TxCancel
output to her `punish_address`. The SDK signs the pre-sig
that allows this during pre-sig generation
([`presign.ts`](./src/atomic-swap/presign.ts)). If Bob ends
up in `BtcPunished`, the cooperative-redeem path lets him
recover XMR (see Recovery below).

---

## The Monero side

### Joint output key

The XMR lock output's spend key is `s = s_a + s_b`; its view
key is `v = v_a + v_b`. Neither party can spend the output
alone. When Alice redeems BTC (revealing `s_a`), Bob computes
`s = s_a + s_b` and controls the XMR. Symmetrically, if Bob
publishes a refund and reveals `s_b` to Alice (cooperative
redeem), Alice computes the same sum and controls the XMR.

### XMR-lock verification

Before Bob releases his adaptor signature on TxRedeem — the
moment he gives Alice the ability to take BTC — the SDK
verifies that Alice's claimed XMR lock is real, sufficient,
and unencumbered. `verifyXmrLocked` in
[`verify-lock.ts`](./src/lib/monero/verify-lock.ts) pulls the
lock-tx from ≥ `monerodQuorum` nodes (default 2) via
`fetchTransactionQuorum` ([`rpc.ts`](./src/lib/monero/rpc.ts));
the agreeing bucket is picked by hashing each tx's `extra`,
`unlock_time`, `vout`, `ecdhInfo`, and `outPk`, with median
block height across the bucket. Below `MIN_XMR_CONFIRMATIONS`
(10) the call returns a retryable failure for the drive loop
to retry. Non-zero `unlock_time` fails as `E_XMR_LOCK_FAILED`
(`AV-A.5`) — otherwise the output would stay spend-locked past
Bob's cancel window. When Alice supplies `tx_key`, the SDK
verifies `R = tx_key · G` against the `extra` field's tx
public key.

The SDK then walks every `vout`, derives the expected output
key from the shared view secret, the tx pub key, the output
index, and the joint spend key `(S_a_monero + S_b_monero)`,
and `decryptAmount`s any matching output. If a matching output
decrypts to the expected amount, `verified = true`.

The eigenwallet desktop binary does additional checks via
`monero-wallet-ng`'s `verify_transfer`; this SDK does the
minimum needed so encsig is never released against a fake
lock.

### Sweep

Once Alice publishes TxRedeem, SERVER extracts `s_a` from the
witness and surfaces `s_a_hex`, `v_hex`, `lock_tx_hash`, and
`monero_lock_address` to the SDK
([`monero-sweep/index.ts`](./src/atomic-swap/monero-sweep/index.ts)).

Before combining `s_a + s_b`, the SDK verifies
`s_a · G == S_a_monero` (`AV-C.5`); a dishonest SERVER
returning a wrong `s_a` is caught here as `E_S_A_MISMATCH`.
The SDK then wipes the individual `s_a` and combined `s_full`
buffers after use, scans the lock-tx outputs to find the
matching index (`scanTransactionOutputs` in
[`output-scanner.ts`](./src/lib/monero/output-scanner.ts)),
selects a 16-member decoy ring via WASM (`selectDecoys`,
gamma distribution), validates that the ring's members exist
on-chain and are unlocked
([`ring-select.ts`](./src/atomic-swap/monero-sweep/ring-select.ts)),
builds construction data, signs via WASM, and broadcasts.
`verifySweepTx`
([`verify-sweep.ts`](./src/lib/monero/verify-sweep.ts))
confirms the result on-chain.

Sweep retries up to 15 times with exponential backoff,
filtered by `isRetryableSweepError` so transient monerod
failures and unlucky decoy selections retry automatically;
non-retryable errors surface immediately.

---


## Recovery

### Refund

If Bob's BTC is locked and Alice never produces a transfer
proof (or the SDK rejects it), Bob refunds. The host runtime
fetches Alice's encsig from the recovery snapshot, builds and
signs TxRefund via
[`refund.ts`](./src/atomic-swap/refund.ts), and broadcasts
through the platform adapter. Refund is built and broadcast
locally; `s_b` and `b` never go to SERVER, and SERVER outages
cannot block it.

### The recovery snapshot

[`snapshot.ts`](./src/atomic-swap/snapshot.ts), captured in
[`drive.ts`](./src/atomic-swap/drive.ts) after `/presigs` and
before `/fund`. It contains Alice's protocol params (`A`,
`S_a_bitcoin`, `S_a_monero`, fees, timelocks, both refund
encsigs, the cancel pre-sig), the unsigned PSBT (so the digest
can be recomputed), the lock-tx metadata (txid, vout, amount),
and the maker's libp2p hints (so eigenwallet's CLI can resume
by re-dialing). It is plaintext JSON — same trust model as the
keystore.

### Cooperative redeem after punish

If Bob ends up in `BtcPunished` (Alice has the BTC; Bob still
has `s_b`), the cooperative-redeem path lets Bob recover his
XMR: SERVER's libp2p layer asks Alice for `s_a`, Bob combines
`s_a + s_b` and sweeps. SDK-side validation in
[`cooperative-redeem.ts`](./src/cooperative-redeem.ts) checks
`s_a` two ways — adaptor-recovery from the published TxRedeem
witness (`recoverAdaptorScalar(S_a_bitcoin, aliceSigA,
bobEncsig)`) and `s_a · G == S_a_monero`. The sweep
([`monero-sweep/index.ts`](./src/atomic-swap/monero-sweep/index.ts))
is reused unchanged. Server-side support is implemented in
swap-engine, which exposes a `COOPERATIVE_REDEEM` state and a
`sweep` required-action.

If Alice refuses to cooperate, Bob is stuck — the XMR sits in
the joint output.

---

## Attack scenarios and defences

Two adversaries: Alice malicious and SERVER malicious.
Collusion adds no new primitives — every safety-critical
value is recomputed locally, so a coordinated lie surfaces as
one of the existing verification failures rather than a
stolen swap.

### Alice malicious

**Take BTC without locking XMR.** Alice supplies a fake
`lock_transfer_proof` and hopes Bob will release his TxRedeem
encsig. Defence: before encsig submission the SDK pulls the
raw lock tx from a monerod quorum
([`verify-lock.ts`](./src/lib/monero/verify-lock.ts)),
re-derives the output key from `S_a_monero + S_b_monero` and
the joint view key, and checks the decrypted amount. A fake
proof fails one of those checks — `E_XMR_LOCK_FAILED`.

**Tx-locked Monero output.** Alice publishes a real Monero tx
paying the joint key but with `unlock_time != 0`. Defence:
non-zero `unlock_time` returns `E_XMR_LOCK_FAILED`
([`verify-lock.ts`](./src/lib/monero/verify-lock.ts)).

**Invalid DLEQ proof.** Alice supplies `(S_a_bitcoin,
S_a_monero)` not derived from a single scalar — `s_a +
s_b` would not open the joint Monero output. Defence: `V-2`
verifies Alice's DLEQ in WASM before any BTC is broadcast
([`drive.ts`](./src/atomic-swap/drive.ts)); missing fails as
`E_DLEQ_PROOF_REQUIRED`, invalid as `E_DLEQ_PROOF_INVALID`.

**Bogus encsig on TxFullRefund.** Alice provides a
`tx_full_refund_encsig` that does not validate against
`(A, S_b_bitcoin, refundDigest)`. Defence: `verifyEncsig`
runs before `decryptSignature`
([`refund.ts`](./src/atomic-swap/refund.ts)); a failing
encsig throws `E_ENCSIG_REFUND_INVALID` and `s_b` is never
fed to decryption.

**TxPunish after both timelocks expire.** If Bob misses both
`cancel_timelock` and `punish_timelock`, Alice can broadcast
TxPunish. No client-side defence against being offline
through both windows; the cooperative-redeem path is the only
post-hoc recourse for the XMR.

### SERVER malicious

**Lies about the lock address.** SERVER's `prepareSwap`
returns a `deposit_address` that pays its own P2WSH instead
of the protocol's `(A, B)` 2-of-2. Defence: `AV-B.1` derives
the lock address locally from the protocol params and rejects
mismatches ([`drive.ts`](./src/atomic-swap/drive.ts)) —
`E_LOCK_ADDR_MISMATCH`.

**Lies about the redeem digest.** SERVER pairs the wrong
digest with the right `S_a_bitcoin` so Bob signs a useful
adaptor for SERVER's own TxRedeem. Defence: `AV-B.2`
recomputes the digest from `(signedPSBT or on-chain TxLock,
protocol params, B, network)` and constant-time-compares
([`drive.ts`](./src/atomic-swap/drive.ts)) —
`E_REDEEM_DIGEST_MISMATCH`. Even if SERVER omits the digest,
the locally recomputed value is what the encsig binds to.

**Lies about Alice's `s_a`.** After Alice publishes TxRedeem,
SERVER fabricates `s_a_hex`. Defence: `AV-C.5` rejects any
`s_a` not satisfying `s_a · G == S_a_monero`
([`monero-sweep/index.ts`](./src/atomic-swap/monero-sweep/index.ts))
— `E_S_A_MISMATCH`.

**Fabricates TxCancel state.** SERVER tells Bob `state =
CANCEL_CONFIRMED` with a fabricated `txCancelHex`. Defence:
the SDK doesn't trust SERVER's hex at all —
`discoverAndVerifyTxCancel`
([`atomic-flow.ts`](./src/engine/flows/atomic-flow.ts))
queries Electrum lock-address history for the real TxCancel.
A state that does not exist on chain surfaces as a
verification failure.

**Withholds messages.** SERVER replies "wait" forever.
Defence: cancel-timelock plus local refund.

**Replays a previous swap's params.** SERVER returns Alice's
params from an earlier swap. Defence: the redeem digest binds
to Bob's *current* TxLock outpoint via BIP143; the SDK's
recomputation cannot match a different outpoint —
`E_REDEEM_DIGEST_MISMATCH`.

**Alters params in flight.** SERVER intercepts the maker's
response and rewrites `redeem_address`, `tx_redeem_fee_sats`,
or `S_a_bitcoin`. Same defence: local recomputation against
locally-held params surfaces tampering as
`E_REDEEM_DIGEST_MISMATCH` or `E_DLEQ_PROOF_INVALID`.

**Plays Alice as well.** With no real maker, SERVER runs both
halves; cryptographically indistinguishable from a legitimate
Alice. The protocol is the defence: the SDK still verifies
the DLEQ, locks BTC into a real 2-of-2 (where the fake-Alice
does not control Bob's `b`), and releases the encsig only
against the locally-recomputed digest. At redeem the
fake-Alice broadcasts TxRedeem; Bob extracts `s_a` and
sweeps.

---

## Residual risks

The SDK does not promise liveness — the protocol is atomic
about funds outcomes, not about time-bounded completion. It
does not promise privacy from the SERVER operator: SERVER
sees the IP, the amount, and the PeerId, so for network-level
privacy run the SDK behind Tor Browser, a VPN, or a proxy.
And it does not promise recovery without the keystore: the
mnemonic recovers `b`, `s_b`, and `v_b`, but the swap state
(Alice's `S_a_bitcoin`, her encsigs, the lock txid) lives
only in the snapshot. Back up both.


---

