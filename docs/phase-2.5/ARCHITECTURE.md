# Phase 2.5B: controlled dual-feed WebSocket comparison

Research date: 2026-09-05

## Goal and scope

Phase 2.5B measures the relative client-callback behavior of two standard Solana `logsSubscribe` feeds under matched local conditions:

- public Solana mainnet WebSocket, labeled `solana-public-mainnet-wss`;
- Helius managed mainnet WebSocket, labeled `helius-mainnet-wss`.

Both use the official Pump program filter, `processed` commitment, and the same pinned parser/IDL revision. This phase does not implement strategy simulation, transaction submission, wallets, Jito execution, Telegram, paid infrastructure, or Yellowstone/gRPC.

## Architecture

```text
orchestrator process
  -> calibrate public child over IPC -> public collector process -> public/{raw,events,diagnostics,manifest}
  -> calibrate Helius child over IPC -> Helius collector process -> candidate/{raw,events,diagnostics,manifest}
  -> wait for both collectors and a common absolute window
  -> scan persisted artifacts for the in-memory API-key value
  -> post-run analyzer -> feed-comparison-report.{json,md}
```

Each collector is the existing Phase 1 collector, not a copied implementation. Comparison configuration adds only a sanitized feed identity, process ID, calibration ID, and connection epoch to new raw records. Those fields are optional at the raw schema boundary, so old Phase 1 datasets and deterministic replay remain unchanged.

Separate Node.js processes prevent parsing or JSONL serialization on one feed's event loop from delaying the other feed's WebSocket callback.

## Timing calibration

The raw callback continues to capture `Date.now()` and `process.hrtime.bigint()` immediately on `message`, before UTF-8 conversion, `JSON.parse`, schema validation, or Pump decoding.

Node documents `process.hrtime` as high-resolution time relative to an arbitrary point in the past. It does not make a portable cross-process-origin guarantee. Therefore the analyzer never subtracts raw child values directly. See [Node process timing](https://nodejs.org/api/process.html#processhrtimebigint) and [performance time origin](https://nodejs.org/api/perf_hooks.html#performancetimeorigin).

For each child, the orchestrator performs seven local IPC ping/pong exchanges:

1. parent records monotonic send time;
2. child samples wall and monotonic time immediately on receipt;
3. parent records monotonic response time;
4. the lowest-RTT exchange is selected;
5. the parent midpoint is paired with the child's monotonic sample;
6. uncertainty is bounded by half the observed RTT;
7. a wall-clock residual sanity check compares the mapped parent timeline with the child's wall sample.

Calibration is valid only when uncertainty is at most 10 ms and the wall residual is at most 100 ms. A normalized arrival is:

```text
parent_anchor + (child_arrival_monotonic - child_anchor)
```

This maps two independent origins onto one parent timeline while retaining the measured calibration uncertainty.

## Experiment controls

The orchestrator refuses to begin collection unless both children report:

- the expected public/candidate identity;
- different process IDs;
- identical commitment, Pump program ID, parser version, and IDL revision;
- the two fixed sanitized endpoint labels;
- valid timing calibration.

Both receive the same requested start and stop instants. The clean latency interval starts only after both subscriptions are confirmed and ends at the first reconnecting close or common requested end.

The Helius URL is constructed only in the candidate child from `HELIUS_API_KEY`. The public child does not receive the key. URLs are never placed in CLI arguments or persisted. Diagnostics receive a sanitized endpoint label and redact the key from error text. After collection, all dataset/manifests are scanned for the exact in-memory key before reports are produced. `.env` and `.env.*` are ignored by Git.

## Matching and metrics

The primary join key is transaction signature. Duplicate delivery remains in `raw.jsonl`; the first normalized monotonic arrival per feed is used for matching.

For every common signature, the JSON report records both wall/monotonic arrivals, normalized timestamps, signed/absolute delta, winner, observed slots, success status, Pump event count/classification, payload/parser compatibility, connection epochs, and clean-population eligibility.

`delta_ms = public_arrival - helius_arrival`:

- positive: Helius arrived first;
- negative: public RPC arrived first;
- absolute delta up to 1 ms: tie by default.

The report includes totals, asymmetric coverage, Jaccard coverage, launch/trade coverage, p25/p50/p75/p90/p95/p99, mean, standard deviation, IQR, directional tail thresholds, within-observed-slot order disagreements, disconnect duration, duplicate/error rates, and longest inter-message gap.

Canonical block position, finalized metadata, and Phase 2 enrichment are not read by the analyzer.

## Reconnect contamination

Every raw comparison record carries `connectionEpoch`. Epoch zero is the initial uninterrupted connection. All records after a reconnect are retained as evidence but excluded from the clean latency distribution.

Standard `logsSubscribe` provides no resume cursor and does not promise replay after reconnect. The harness therefore does not invent a backfill/replay-burst interpretation; it labels later records as reconnect-era observations and analyzes them outside the clean population. See [Solana logsSubscribe](https://solana.com/docs/rpc/websocket/logssubscribe).

## Helius free WebSocket role

This experiment uses Helius's standard `logsSubscribe` endpoint, not a gRPC feed. Helius documents the same `mentions` filter and `processed` commitment and indicates that API keys/free-plan WebSocket connections are supported. See [Helius logsSubscribe](https://www.helius.dev/docs/api-reference/rpc/websocket/logssubscribe) and [WebSocket FAQ](https://www.helius.dev/docs/faqs/websockets).

The result does not represent validator-ingress timing, true MEV/HFT latency, or executable advantage. Both feeds can share upstream infrastructure or processed-fork behavior, and neither exposes a provider-ingress timestamp.

## Reproduction

Keep the API key in the process environment and run a new directory:

```bash
HELIUS_API_KEY=<local-secret> pnpm comparison:run \
  --comparison-id phase-2-5b-smoke-YYYYMMDD \
  --duration-seconds 300
```

Rebuild only the deterministic reports later:

```bash
pnpm comparison:analyze data/comparisons/phase-2-5b-smoke-YYYYMMDD
```

The parent layout is:

```text
data/comparisons/<comparison-id>/
  public/
  candidate/
  comparison-manifest.json
  feed-comparison-report.json
  feed-comparison-report.md
```

## Decision gate for a stronger gRPC experiment

Do not move from this WebSocket harness to paid/stronger Yellowstone-compatible infrastructure unless all of these hold:

1. the five-minute smoke test completes for both feeds with all methodology controls true;
2. a follow-up standard-WebSocket run yields at least 10,000 clean matched signatures and no calibration, payload, parser, or reconnect contamination;
3. that follow-up reproduces at least one material signal: an absolute p95 lead above 50 ms, a p50 lead above 20 ms, or exclusive-signature coverage above 0.5% of the union;
4. the signal is directionally consistent across three non-overlapping five-minute windows in a 15-minute follow-up;
5. the research question requires distinguishing provider delivery from validator/Geyser ingress, which standard WebSockets cannot answer.

If the smoke volume is already at least 3,334 clean matches, 15 additional minutes should exceed the 10,000-match gate and provide three stability windows. Otherwise use 30 minutes and reassess; do not default to a two-hour run.

## Known limitations

- IPC midpoint assumes symmetric delay only within the reported half-RTT uncertainty.
- Local wall time is evidence and a sanity check, not the latency delta source.
- A five-minute sample is not enough for reliability or profitability conclusions.
- Exclusive processed notifications are not automatically missing finalized transactions.
- Zero disconnects or exclusives does not prove completeness.
- Helius documents an inactivity timeout; Pump traffic is normally active, but the harness does not yet add application-level ping frames for longer idle studies.
