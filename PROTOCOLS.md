# Protocols

Four providers, four different trust models. This file covers
settlement model, what the server does, and what the SDK verifies
locally for each.


---

## `atomicswap` — BTC ↔ XMR

The full protocol — custody walk-through, transaction tree,
every verification gate with code references, recovery paths,
and an attack-by-attack analysis — is in
[`ATOMIC-SWAP-PAPER.md`](./ATOMIC-SWAP-PAPER.md).

---

## `thorchain` — multi-chain via TSS vaults

Multi-chain swaps through THORChain's Asgard TSS vaults.
Currently 12 connected chains (BTC, ETH, BSC, AVAX, BASE, BCH,
DOGE, LTC, SOL, TRON, XRP, Cosmos ATOM). The destination is
committed in the swap memo on the inbound tx; refunds default
to the inbound sender, or to `REFUNDADDR` if specified in the
memo. A 2/3 validator collusion can move vault funds — that's
the trust assumption.

The SDK reads the active vault list from THORNode and Midgard
directly (hardcoded per-network URLs in
[`thorchain-networks.ts`](./src/verification/thorchain-networks.ts))
and confirms the deposit address is current and the memo binds
the user's destination.

---

## `chainflip` — per-swap deposit channels

Per-swap deposit channels through Chainflip's broker + state
chain. Mainnet covers Bitcoin, Ethereum, Arbitrum, Solana,
Polkadot, and Polkadot Assethub, plus USDC and USDT on the EVM
chains and Solana. The broker opens a channel that binds
destination and Fill-or-Kill refund addresses; the JIT-AMM
state chain executes the swap and the egress lands at the bound
destination. Refunds fire on FoK price-failure, DCA-retry
exhaustion, or channel expiry. Trust assumption: Chainflip's
validator set and state chain.

The SDK reads the channel binding from the Chainflip broker
REST or state-chain JSON-RPC (hardcoded per-network endpoints in
[`chainflip-networks.ts`](./src/verification/chainflip-networks.ts))
and confirms destination, refund, and source/destination chains
match. Misbinding fails closed with
`E_CHAINFLIP_CHANNEL_MISBINDING`.

---

## `near_intents` — NEAR Intents

NEAR Intents covers ~45 chains across EVM L1s and L2s, Bitcoin
and forks, and L1s like NEAR, Solana, TON, TRON, XRP, Aptos,
Sui, Cardano, Stellar, Starknet, Aleo, and others. An intent
backend returns a per-quote deposit address, optional memo, and
deadline; off-chain solvers compete to fulfil the intent through
the NEAR Verifier contract, drawing the destination payout from
solver inventory once the deposit is detected. Refunds return to
the bound refund address on deadline expiry, no-fill, or
slippage. Trust assumption: the intent backend, the NEAR
Verifier contract, and the solver set.

The SDK reads intent status from the backend directly
([`near-intents.ts`](./src/verification/near-intents.ts)) and
confirms the deposit address and registered destination match
the user's request.

---

## Custody matrix

| Provider | Funds during swap | Refund mechanism |
| --- | --- | --- |
| `atomicswap` | 2-of-2 multisig (Bob + Alice) on BTC and XMR; SDK holds `b`, `s_b`, `v_b` in the host runtime | Bob refunds locally via timelocked Refund/Reclaim transactions the SDK builds and broadcasts |
| `thorchain` | Asgard TSS vault (validator set) | Auto-refund to inbound sender, or `REFUNDADDR` from the memo |
| `chainflip` | State-chain deposit channel (validator set) | Auto-refund to bound refund address on FoK price-failure, DCA exhaustion, or channel expiry |
| `near_intents` | NEAR Verifier contract during solver settlement | Auto-refund to bound refund address on deadline expiry, no-fill, or slippage |
