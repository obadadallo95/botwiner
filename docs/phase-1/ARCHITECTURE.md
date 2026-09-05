# Phase 1 architecture and milestone

## Exact milestone

Phase 1 is complete when the system can:

1. open a Solana PubSub connection and subscribe to transactions mentioning the Pump bonding-curve program;
2. record every received JSON-RPC log notification before any filtering outcome is discarded;
3. recognize and decode current official Pump `CreateEvent` and `TradeEvent` records;
4. normalize successful events without floating-point amount loss or invented values;
5. append raw records, normalized events, diagnostics, and a session manifest to local files;
6. replay `raw.jsonl`, apply identical duplicate rules, and reproduce `events.jsonl` byte-for-byte as proven by SHA-256;
7. demonstrate parsing, malformed-input behavior, duplicate handling, persistence, and replay in automated tests.

No strategy simulator, wallet, transaction construction, private key, live trading, Telegram integration, or dashboard belongs to this milestone.

## Repository shape

```text
apps/
  collector/       bounded or continuous live collection CLI
  replay/          deterministic raw-to-normalized replay CLI
packages/
  market-data/     versioned raw/normalized contracts and validation
  pumpfun/         pinned IDL facts, Borsh event decoder, normalization
  solana/          WebSocket lifecycle and logsSubscribe transport
  storage/         append-only JSONL dataset writer and readers
docs/phase-1/      research and architecture decisions
tests/             behavior tests and deterministic fixtures
```

Strategy and simulation packages are intentionally deferred. Adding empty abstractions for them now would not improve data trustworthiness.

## Data flow

```text
Solana logsSubscribe frame
  -> capture wall + monotonic receive clocks
  -> parse JSON and Pump event synchronously
  -> enqueue one serialized append operation
       -> raw.jsonl (always)
       -> events.jsonl (successful, recognized, unique events)
       -> diagnostics.jsonl (connections, parse errors, duplicates)
  -> manifest.json updated on clean close

raw.jsonl
  -> replay the same validator/parser/normalizer
  -> apply the same eventId de-duplication
  -> replay/events.jsonl
  -> compare SHA-256 with captured events.jsonl
```

The receive callback does no network lookup and no blocking synchronous filesystem operation. Writes are serialized so raw and normalized ordering remains stable.

## Persistence decision

Phase 1 uses append-only JSONL.

| Option | Advantages | Costs | Decision |
| --- | --- | --- | --- |
| JSONL | streaming append, human inspectable, preserves observed order, easy hashing/replay, no native dependency | joins and ad-hoc analytics are less convenient; indexes must be built later | selected for raw and normalized truth |
| SQLite | transactions, indexes, SQL queries, mature local tooling | native/runtime dependency, schema migrations, easy temptation to mutate raw truth | defer as a derived analytical store |
| columnar files | efficient scans and later research workloads | poor per-event appends and less inspectable during parser development | derive from validated datasets later |

A session directory contains:

- `raw.jsonl`: complete parsed JSON-RPC notifications and collector timing metadata;
- `events.jsonl`: normalized, successful, de-duplicated launch/trade events;
- `diagnostics.jsonl`: lifecycle, malformed-event, invalid-message, and duplicate evidence;
- `manifest.json`: source label, parser/IDL revision, status, counts, and limitations.

Endpoint labels contain only protocol and host. URL paths and query strings are deliberately omitted because provider URLs often contain API keys.

## Identity and duplicate policy

`eventId = transaction signature + transaction log index + event type`.

The transaction log index is stable for the same transaction payload. Duplicate PubSub delivery is preserved in `raw.jsonl` but does not create a second normalized event. The decision is recorded in diagnostics. Failed transactions are also preserved raw but emit no normalized market event because their state changes rolled back.

## Normalized event schema

Every normalized event contains:

- schema and parser versions;
- event ID and raw record reference;
- source transport, endpoint label, commitment, and program ID;
- signature, slot, collector sequence, and transaction log index;
- chain event time, collector receive time, collector parse completion/duration, explicit unknown provider time, and explicit unknown block time;
- token mint and trailing-byte count.

Launch events add metadata, bonding curve, creator/submitting wallets, token/quote programs, initial reserves/supply, and current mode flags.

Trade events add buy/sell side, trader and creator, instruction name, exact base-unit token/SOL/quote amounts, post-trade reserves, protocol/creator/cashback/buyback fee fields, volume tracking fields, and shareholders. `bondingCurve` is explicitly `null` because `TradeEvent` does not supply it.

All `u64`/`i64` values are decimal strings in JSON. No integer passes through a JavaScript `number`. Price is represented only as the exact pair `{quoteBaseUnits, tokenBaseUnits}`. Token decimals, SOL conversion, and executable price are not inferred.

## Timestamp semantics

| Field | Meaning | Precision / limitation |
| --- | --- | --- |
| `chainEventUnixSeconds` | Pump program event timestamp | seconds; program supplied |
| `ordering.slot` | RPC context slot | ordering bucket, not wall time |
| `rpcProviderReceivedAtUnixMs` | provider ingress time | always `null`; not exposed by standard RPC |
| `collectorReceivedAtUnixMs` | local wall clock at WebSocket callback entry | millisecond wall clock |
| `collectorReceivedMonotonicNs` | local monotonic callback-entry clock | nanosecond unit; process-local origin |
| `collectorParseCompletedAtUnixMs` | local wall clock after JSON + Pump parse | millisecond wall clock |
| `collectorParseDurationNs` | monotonic parse interval from callback entry | suitable for local interval measurement |
| `blockTimeUnixSeconds` | confirmed block time | `null` in Phase 1; later enrichment |

Monotonic timestamps compare intervals within one process only. Wall-clock timestamps require clock-offset monitoring before cross-host latency claims.

## Failure behavior

- Unknown program data is ignored; known discriminators with invalid bodies become diagnostics.
- Invalid JSON-RPC notification shapes remain raw and become diagnostics.
- Connection closes are recorded. Reconnecting creates an acknowledged observation gap; the code never labels the dataset complete across that interval.
- Writes are append-only and ordered. Files are flushed and synced on clean shutdown.
- Parser version and official IDL revision are embedded in every event/session.

## Deferred next milestone

The next milestone should enrich each signature after confirmation with block time, transaction fee, compute/priority-fee evidence, account keys, and canonical transaction index; backfill disconnect ranges; then compare public PubSub against a replay-capable Yellowstone source. Only after coverage and latency are measured should strategy simulation begin.
