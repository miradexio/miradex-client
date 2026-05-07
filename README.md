# @miradexio/client

TypeScript SDK for cross-chain swaps. Runs in-process in the
browser or in Node, holding keys and signing locally. The server
is untrusted: every state claim is verified on-chain. For BTC↔XMR
the SDK runs the full atomic-swap drive loop itself; for THORChain,
Chainflip, and NEAR Intents it verifies the deposit binding against
the upstream's own infrastructure (THORNode/Midgard, Chainflip
broker, 1Click).

## Quick start

```bash
pnpm add @miradexio/client
# or
npm install @miradexio/client
```

```ts
import { MiradexEngine, type PlatformAdapter } from '@miradexio/client';

const platform: PlatformAdapter = /* see PlatformAdapter below */;

const engine = new MiradexEngine(
  {
    apiUrl: 'https://api.miradex.io/',
    network: 'mainnet',
    slippageBps: 300,
  },
  platform,
);

engine.on('state', (s) => {
  console.log(s.activeFlow?.kind, s.activeFlow?.snapshot.phase);
});

// BTC ↔ XMR (atomicswap)
await engine.startAtomicSwap({
  amount: '0.01',
  destAddress: '8...',
  refundAddress: 'bc1q...',
});

// Routed providers (thorchain, chainflip, near_intents)
const { quotes } = await engine.apiClient.getQuotes({
  from: 'BTC',
  to: 'ETH',
  amount: '0.01',
});
await engine.startSwap({
  fromToken: 'BTC',
  fromChain: 'bitcoin',
  toToken: 'ETH',
  toChain: 'ethereum',
  amount: '0.01',
  destAddress: '0x...',
  refundAddress: 'bc1q...',
  selectedQuote: quotes[0],
});
```

---

## Providers

**`atomicswap`** — BTC ↔ XMR via the btc-xmr two-curve
atomic-swap protocol. BTC locks into a 2-of-2 P2WSH; adaptor
signatures tie Alice's BTC redemption to revealing the Monero
scalar Bob needs to sweep. Refund is timelocked Bitcoin script
and the SDK builds and broadcasts it without the server.

**`thorchain`** — 12 connected chains (BTC, ETH, BSC, AVAX,
BASE, SOL, TRON, XRP, …) via THORChain Asgard TSS vaults. The
SDK reads the active vault list from THORNode and Midgard
directly.

**`chainflip`** — Bitcoin, Ethereum, Arbitrum, Solana, Polkadot,
and Polkadot Assethub via per-swap deposit channels with
destination and Fill-or-Kill refund addresses bound at channel
creation. The SDK reads the channel from the broker and
confirms.

**`near_intents`** — roughly 45 chains via NEAR Intents 1Click
solver settlement. The SDK reads intent status from 1Click
directly.

---

## The SDK surface

The default import is `@miradexio/client`. Sub-path exports cover
atomic-swap-only, verification-only, and bundler-friendly subsets;
see the `exports` field in `package.json`.

### `PlatformAdapter`

The engine is decoupled from host I/O. Implement
[`PlatformAdapter`](./src/engine/platform.ts) for your environment;
see the [miradex-web browser adapter](https://github.com/miradexio/miradex-web/blob/main/lib/miradex-web/browser-adapter.ts)
for a reference.

### Direct entry points

Drive flows without the engine:

```ts
import { runAtomicSwap, SwapExecutor } from '@miradexio/client';

// Atomic swap, low-level:
await runAtomicSwap({
  api: apiClient,
  params: { amount: '0.01', destAddress: '8...', refundAddress: 'bc1q...', network: 'mainnet' },
  callbacks: { onProgress, onDepositRequired, saveKeystore, loadKeystore },
  signal: abortController.signal,
});

// Routed swap, low-level:
const executor = new SwapExecutor(apiClient);
const result = await executor.executeSwap({
  from: 'BTC', to: 'ETH', amount: '0.01',
  destAddress: '0x...', refundAddress: 'bc1q...',
  provider: 'thorchain',
});
```



---

## Security model

The server is untrusted. Bitcoin state is verified against Electrum servers, Monero against monerod RPC servers, THORChain against THORNode + Midgard, Chainflip against the broker, NEAR
Intents against 1Click.

---

## Configuration

### `EngineConfig`

The first argument to `new MiradexEngine`:

| Field | Type | Default |
| --- | --- | --- |
| `apiUrl` | `string` | required |
| `network` | `'mainnet' \| 'testnet' \| 'regtest'` | `'mainnet'` |
| `slippageBps` | `number` | `100` (1.00%) |
| `apiTimeout` | `number` | `60_000` ms |
| `apiMaxRetries` | `number` | `3` |
| `monerodNodes` | `readonly string[]` | network default |
| `fetchFn` | `typeof fetch` | `globalThis.fetch` |

Defaults are exported from [`src/lib/default-config.ts`](./src/lib/default-config.ts).

---

## Build

```bash
pnpm install
pnpm -F @miradexio/client build       # tsc → dist/
pnpm -F @miradexio/client typecheck
pnpm -F @miradexio/client test
```

---

## License

MIT. See [LICENSE](./LICENSE).
