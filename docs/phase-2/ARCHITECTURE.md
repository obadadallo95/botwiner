# Phase 2 architecture and decision gate

Research date: 2026-09-05

## Scope and invariants

Phase 2 turns Phase 1 observations into auditable research evidence. It does not send transactions or implement a simulator. `raw.jsonl`, `events.jsonl`, and their deterministic replay contract remain unchanged.

The derived store remains JSONL because the workload is sequential, files are inspectable and hashable, and no native database dependency is needed yet. Every derived file is replaceable from immutable Phase 1 data plus `phase2-v1/raw-rpc/`.

## Enrichment flow

```text
Phase 1 signatures
  -> finalized getTransaction per observed/backfilled signature (bounded batches)
  -> finalized getBlock(transactionDetails="signatures") per relevant slot
  -> canonical transaction index from signature position
  -> stream raw evidence to JSONL
  -> rebuild derived transaction/event/report files
```

The optional `full-blocks` source is retained for controlled archival evidence. It writes a bounded concurrent batch at a time, and rebuild reads one full-block record at a time. The default avoids full cluster blocks.

Each transaction enrichment records final slot/status, version, fee, compute units, compute-budget instructions, effective CU limit and fee calculation evidence, static/loaded keys, balances, outer/inner instructions, logs, errors, and directly observable Jito transfers.

## Ordering and anti-look-ahead contract

There are two intentionally different event views:

| File | Order | Backfill | Permitted use |
| --- | --- | --- | --- |
| `derived/venue-events.jsonl` | collector sequence, then log index | no; finalized-only fields forced to null | later causal simulation input |
| `derived/transactions-observed.jsonl` | collector sequence | no; includes failures and excludes finalized enrichment | congestion/failure inputs available at observation time |
| `derived/venue-events-canonical.jsonl` | finalized slot, transaction index, instruction/log/event index | yes | post-hoc truth and evaluation only |

Canonical metadata is future information. A simulator must not use canonical position, backfilled events, finalized status, block time, or later enrichment before their observation time. When a canonical transaction index is unavailable, ordering falls back to observed collector order, never signature lexicographic order.

Runtime invocation logs are correlated with the authoritative outer message program list. The original log index is always retained. Correlation handles unlogged earlier instructions by searching forward for the next matching depth-1 program rather than counting logs as message indexes.

## Gaps and completeness

A reconnect gap is bounded by the last observation before close and first observation after reopen. Before querying address history, both processed boundaries must be found finalized at their observed slots using `getSignatureStatuses`. Candidates are restricted to the validated slot interval and pagination has a hard signature cap.

`getSignaturesForAddress` has no historical slot-range filter; `minContextSlot` constrains node context, not returned history. Therefore even a completed query is not a delivery receipt. Silent loss, provider retention, a dropped unbounded boundary, or a cap hit prevents a completeness claim.

## Feed-quality semantics

- Parse duration uses process-local monotonic timestamps.
- First-observed trade delay uses monotonic receive timestamps within the collector process.
- Receive time minus `blockTime` is reported only as a coarse descriptive distribution and is explicitly ineligible for execution modeling.
- Finalization-observation delay includes the delayed enrichment-job start and RPC service time; it is only an upper bound.
- Failed observed transactions are retained and their density is reported, but this is not a mempool or leader-ingress trace.
- Startup and periodic SNTP samples document local wall-clock offset/RTT. They do not provide provider ingress time or guarantee continuous synchronization.

## Validation evidence

The bounded 45-second validation session `phase2-validation-2026-09-05` captured 2,395 raw notifications and 1,220 normalized events (16 launches and 1,204 trades), with 1,087 observed failed transactions. Finalized full-block evidence successfully enriched all 2,395 signatures and established canonical indexes. The sample contained 82 pairwise inversions between observed and canonical event order.

Direct checks found:

- all 2,395 captured signatures in the exact `logsSubscribe` context slot used by the session;
- 4 transactions with CU price but no CU limit; runtime-default fee calculations matched the transaction fee delta in all 4;
- 101 transactions with direct transfers to documented Jito tip accounts, including 82 of 1,201 event-bearing transactions;
- inferred and message-correlated outer indexes agreed for all 1,229 decoded events in finalized logs, although correlation is retained as the safer authoritative method;
- standard non-Mayhem adjacent reserve reconstruction matched 633/633 comparable trades; Mayhem-mode quote reserves did not support the same single-event reconstruction.

Phase 1 replay remained byte-identical with SHA-256 `3b3be3b132f9b582367e2660dddb7a8c6fb5452ea26cd0b368e57fda64036537`.

## Historical Phase 3 decision gate

This section records the decision boundary as it stood after the Phase 2
validation session. It is historical context, not the current project status.
The subsequent execution-aware sweep is now published in
[`docs/research/NEGATIVE-RESULT.md`](../research/NEGATIVE-RESULT.md). That
study evaluated 15,467 token paths with explicit latency, cost, exit-freshness,
and capital-aware scenarios and found no production-ready edge under its
conservative assumptions.

The Phase 2 gate correctly identified the evidence still missing from the
standard feed: independent-feed loss measurement, provider/validator
first-arrival timestamps, competitive bundle-auction and separate-transaction
tip evidence, empirical fill/failure behavior, and exact executable quoting
across dynamic fees, Mayhem, and migration. The final result should be read
with those limitations; the gate should not be read as saying that the
simulator was never run.
