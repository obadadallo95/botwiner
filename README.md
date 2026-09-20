# Botwiner research

Botwiner is a production-minded research system for testing whether an ultra-short-horizon edge exists in the first seconds of newly launched Pump.fun tokens. The correct result may be that no edge survives latency, fees, slippage, and execution uncertainty.

This repository is research-only. It does not contain a trading wallet or a transaction-sending strategy, and the experiments reported here do not justify live trading.

## Research result

The completed capital-aware sweep did not find a stable, executable profit edge in the tested launch-and-exit rules. Idealized last-observation marks can look profitable, but the apparent edge disappears with modest latency and becomes negative when an exit is not freshly observable or migration is unresolved. This is a negative result about the tested hypothesis and data boundary; it is not a claim that every crypto strategy is impossible.

Read the [negative-result report](docs/research/NEGATIVE-RESULT.md) and the [machine-readable scenario summary](docs/research/SCENARIO-SWEEP-2026-09-17.json) for the experiment design, assumptions, and results. The report is intended to help other researchers reproduce the reasoning without treating it as investment advice.

## Current scope

Phase 1 collects and deterministically replays Pump bonding-curve events. Phase 2 enriches captured signatures with finalized transaction evidence, preserves separate observed and canonical views, records failed-transaction congestion inputs, detects bounded reconnect gaps, and produces a rebuildable feed-quality report. Phase 2.5B adds a controlled same-host, separate-process comparison of public Solana and Helius standard WebSockets. The comparison code contains no trading, wallet, private-key, transaction-sending, or Telegram integration; the repository also includes a read-only research dashboard.

The live source remains Solana standard `logsSubscribe`, filtered by the official Pump program ID. The decoder is pinned to the official Pump IDL revision recorded in each dataset. See [Phase 1](docs/phase-1/ARCHITECTURE.md) and [Phase 2](docs/phase-2/ARCHITECTURE.md).

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

The collector records an SNTP offset sample at startup and every five minutes by default. These samples are clock evidence, not a synchronization SLA. Local monotonic time remains authoritative for within-process intervals.

Each session writes `raw.jsonl`, `events.jsonl`, `diagnostics.jsonl`, and `manifest.json`. A disconnect in diagnostics represents a collection gap because standard PubSub has no resume cursor.

### Local capture with the cloud dashboard

The collector can keep the authoritative dataset and paper portfolio state on the laptop while publishing dashboard telemetry to the existing Firestore-backed dashboard. This hybrid mode does not upload the event stream to GCS and telemetry failures do not stop local collection.

Authenticate the local Google application credentials once:

```bash
gcloud auth application-default login
```

On macOS, keep the laptop awake for the duration and run a bounded local capture with the free public RPC feed:

```bash
caffeinate -i pnpm collector:start \
  --provider public \
  --sink local \
  --telemetry cloud \
  --duration-seconds 21600 \
  --session-id local-6h \
  --output data/sessions/local-6h
```

The cloud dashboard receives a heartbeat every 60 seconds and portfolio, paper-trading, market, and creator summaries every 30 minutes. The complete raw dataset remains under `data/sessions/local-6h` for replay. If the laptop loses connectivity, the collector records the gap and continues reconnecting; if Firestore is unavailable, the local files and in-memory paper portfolios continue independently.

## Replay and verify

```bash
pnpm replay data/sessions/sample
```

Replay writes `data/sessions/sample/replay/events.jsonl` and compares its SHA-256 digest with the captured `events.jsonl`. A mismatch returns exit code 2.

## Phase 2 enrichment and quality

After a session has finalized on-chain:

```bash
pnpm phase2:enrich data/sessions/sample
pnpm phase2:quality data/sessions/sample
```

The default enrichment path fetches only captured transactions, then small signature-only blocks for canonical indexes. RPC evidence is appended in bounded batches. `--source full-blocks` exists only for controlled evidence capture and is streamed; it is not the default.

Derived files under `phase2-v1/derived/` have strict roles:

- `venue-events.jsonl`: live events in collector order with post-finalization fields forced to null; causal input candidate for a later simulator.
- `transactions-observed.jsonl`: every observed transaction, including failures, in collector order and without later finalized metadata.
- `venue-events-canonical.jsonl`: finalized/backfill-inclusive chain order for post-hoc evaluation only.
- `transactions.jsonl`: finalized metadata, compute budget, observable same-transaction Jito tips, balances, instructions, logs, and errors.
- `feed-quality.json`: explicit quality metrics and limitations.

Rebuild derived outputs without touching Phase 1 or raw Phase 2 evidence:

```bash
pnpm phase2:rebuild data/sessions/sample
```

## Phase 2.5B feed comparison

With `HELIUS_API_KEY` present only in the local environment, run the bounded five-minute smoke harness:

```bash
pnpm comparison:run --comparison-id phase-2-5b-smoke --duration-seconds 300
```

The orchestrator launches two collector processes, calibrates their monotonic clocks over local IPC, applies one shared window, then writes sanitized JSON and Markdown reports under `data/comparisons/<comparison-id>/`. The Helius URL and key are never persisted. Re-analyze an existing completed comparison with:

```bash
pnpm comparison:analyze data/comparisons/phase-2-5b-smoke
```

See [Phase 2.5B architecture and methodology](docs/phase-2.5/ARCHITECTURE.md).

## Validate the code

```bash
pnpm check
```

This runs strict TypeScript checking, the test suite, and ESLint.

## Architecture

- `apps/collector`: live WebSocket CLI and session lifecycle
- `apps/replay`: deterministic replay CLI
- `apps/phase2`: finalized enrichment, rebuild, and quality-report CLIs
- `apps/comparator`: dual-process orchestration and deterministic comparison analysis
- `packages/market-data`: schemas and boundary validation
- `packages/pumpfun`: official-IDL-derived Borsh parsing and normalization
- `packages/solana`: reconnecting Solana PubSub transport
- `packages/storage`: append-only datasets, duplicate control, and hashing
- `packages/research`: raw RPC evidence, enrichment, ordering, gaps, and derived reports

## Known limitations

- Public RPC is a functional baseline, not a completeness or latency SLA.
- Provider-side receive time is unavailable; it remains `null`.
- Finalized enrichment is post-observation evidence and cannot be exposed to a causal simulator before its recorded availability.
- `processed` events can roll back. Notifications already marked failed are kept raw and excluded from normalized events; later fork reconciliation is not yet implemented.
- Gap recovery is bounded address history and cannot prove the absence of silent PubSub loss.
- Parser compatibility is pinned to one official IDL revision. Trailing bytes are counted, but incompatible future or historical layouts require another parsing version.
- SNTP samples improve clock observability but do not make wall-clock timestamps provider-ingress timestamps.
- PumpSwap trades after bonding-curve migration are outside Phase 1.
- Same-transaction Jito transfers are observable; tips in another transaction of a bundle, bundle membership, auction competition, and required winning tips remain unknown.
- Pump TradeEvent reserves are post-trade. Standard non-Mayhem pre-state can be reconstructed from amounts; Mayhem-mode pre-state and an exact future executable quote require additional state and official venue math.

## External dependencies

Runtime uses only `ws`. TypeScript, `tsx`, and ESLint are development tools. Live collection uses the free Solana public mainnet endpoint by default. No paid API or infrastructure is configured.

## Decision gate

The current public-RPC dataset is suitable for continued data engineering and coarse strategy research, but not yet for a credible ultra-short-horizon profitability claim. Before Phase 3, run a simultaneous controlled comparison against a replay-capable mainnet feed, measure silent loss and first-arrival latency, and pin exact Pump quoting/rounding behavior including Mayhem and migration. No paid provider is configured or authorized. See [the Phase 2 decision gate](docs/phase-2/ARCHITECTURE.md#phase-3-decision-gate).
