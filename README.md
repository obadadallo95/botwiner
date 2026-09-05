# Botwiner research

Botwiner is a production-minded research system for testing whether an ultra-short-horizon edge exists in the first seconds of newly launched Pump.fun tokens. The correct result may be that no edge survives latency, fees, slippage, and execution uncertainty.

## Current scope

Phase 1 collects Pump bonding-curve launch and trade events from Solana, preserves raw RPC notifications, normalizes successful events, and replays datasets deterministically. It contains no trading, wallet, private-key, transaction-sending, Telegram, dashboard, or strategy code.

The current source is Solana standard `logsSubscribe`, filtered by the official Pump program ID. The decoder is pinned to the official Pump IDL revision recorded in each dataset. See [technical research](docs/phase-1/RESEARCH.md) and [architecture](docs/phase-1/ARCHITECTURE.md).

## Requirements

- Node.js 20.10 or newer
- pnpm 11
- outbound WebSocket access for live collection

Install the free open-source dependencies:

```bash
pnpm install
```

## Collect live data

Run until interrupted:

```bash
pnpm collector:start
```

Run a bounded collection and choose the dataset directory:

```bash
pnpm collector:start --duration-seconds 30 --output data/sessions/sample
```

The output must be a new session directory. The collector refuses to append to existing session files because doing so would make sequence-based raw references ambiguous.

The default endpoint is `wss://api.mainnet-beta.solana.com/` at `processed` commitment. Override it with `SOLANA_WS_URL` and `SOLANA_COMMITMENT`, or the matching CLI flags. Do not commit provider URLs containing keys; manifests retain only protocol and hostname.

Each session writes `raw.jsonl`, `events.jsonl`, `diagnostics.jsonl`, and `manifest.json`. A disconnect in diagnostics represents a collection gap because standard PubSub has no resume cursor.

## Replay and verify

```bash
pnpm replay data/sessions/sample
```

Replay writes `data/sessions/sample/replay/events.jsonl` and compares its SHA-256 digest with the captured `events.jsonl`. A mismatch returns exit code 2.

## Validate the code

```bash
pnpm check
```

This runs strict TypeScript checking, the test suite, and ESLint.

## Architecture

- `apps/collector`: live WebSocket CLI and session lifecycle
- `apps/replay`: deterministic replay CLI
- `packages/market-data`: schemas and boundary validation
- `packages/pumpfun`: official-IDL-derived Borsh parsing and normalization
- `packages/solana`: reconnecting Solana PubSub transport
- `packages/storage`: append-only datasets, duplicate control, and hashing

## Known limitations

- Public RPC is a functional baseline, not a completeness or latency SLA.
- Provider-side receive time is unavailable; it remains `null`.
- Block time and canonical transaction index require post-confirmation enrichment.
- `processed` events can roll back. Notifications already marked failed are kept raw and excluded from normalized events; later fork reconciliation is not yet implemented.
- Disconnects are visible but not backfilled in Phase 1.
- Parser compatibility is pinned to one official IDL revision. Trailing bytes are counted, but incompatible future or historical layouts require another parsing version.
- Local wall-clock offset is not monitored, so cross-host latency comparisons are not yet valid.
- PumpSwap trades after bonding-curve migration are outside Phase 1.

## External dependencies

Runtime uses only `ws`. TypeScript, `tsx`, and ESLint are development tools. Live collection uses the free Solana public mainnet endpoint by default. No paid API or infrastructure is configured.

## Next milestone

Add confirmed-transaction/block enrichment and gap backfill, then run simultaneous feeds to quantify loss and latency. A replay-capable Yellowstone/Geyser mainnet stream is the appropriate reliability comparison, but managed options are generally paid; evaluate one only after the baseline measures expected event volume and after explicit approval.
