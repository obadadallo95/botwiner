# Phase 2.5B five-minute smoke test

Comparison ID: `phase-2-5b-smoke-20260905`

The public Solana and Helius standard `logsSubscribe` collectors ran in separate Node.js processes on the same host for one shared 300-second window. Both completed cleanly with no disconnect, reconnect, malformed frame, duplicate, or parser-error diagnostic. The local data artifact is under `data/comparisons/phase-2-5b-smoke-20260905/` and is intentionally Git-ignored.

## Timing validity

The public calibration used a 0.067709 ms IPC round trip with 0.033854 ms half-RTT uncertainty and 0.535645 ms wall residual. Helius used a 0.090625 ms round trip with 0.045312 ms uncertainty and 0.586914 ms wall residual. Both passed the configured 10 ms uncertainty and 100 ms wall-residual bounds.

No raw monotonic timestamps from different child processes were subtracted directly.

## Sanitized results

| Metric | Public | Helius |
| --- | ---: | ---: |
| Raw / unique signatures | 11,057 | 11,048 |
| Successful transactions | 8,165 | 8,159 |
| Failed transactions | 2,892 | 2,889 |
| Normalized Pump events | 7,737 | 7,724 |
| Launches | 48 | 48 |
| Trades | 7,689 | 7,676 |
| Disconnects / reconnects | 0 / 0 | 0 / 0 |

There were 11,048 matched signatures, 9 public-only signatures, and no Helius-only signatures in the unguarded whole run. All nine raw exclusives occurred at the experiment boundaries: five within roughly 250 ms of startup and four within 33 ms of shutdown. With a one-second boundary guard, there were no globally exclusive signatures and 10,986 fully interior matches. The smoke test therefore supplies no meaningful evidence that either feed was less complete.

For all 11,048 clean matched signatures, `delta_ms = public - Helius`:

- p50: +24.378 ms;
- p95: +181.944 ms;
- p99: +235.444 ms;
- min: -256.359 ms;
- max: +480.430 ms;
- mean: +31.280 ms;
- standard deviation: 93.295 ms;
- Helius/public/tie wins at ±1 ms: 6,932 / 3,361 / 755;
- Helius led by more than 100 ms for 2,686 matches; public led by more than 100 ms for 1,008.

This is evidence of a relative Helius callback-arrival advantage in this run, especially in the positive tail. It is not provider-ingress timing or evidence of an executable trading advantage.

## Payload methodology issue

Slots and success/failure status matched for every common signature. However, 35 Helius payloads ended with `Log truncated` while the public payload retained more log lines. All 35 payload mismatches were explained by this candidate-side truncation. Seven changed parser output:

- two transactions changed from one public trade event to no Helius event;
- three changed from three public trade events to two;
- two launch-plus-trade transactions retained the launch but lost the trade on Helius.

The raw payloads remain in each child `raw.jsonl`. This means the datasets are technically comparable for signature arrival but are not interchangeable for Pump event-count completeness without explicitly accounting for Helius log truncation.

## Decision gate

A. Both feeds ran for the full five minutes: **yes**.

B. Technically comparable: **yes for signature arrival and transaction status; partially for event payloads because of Helius truncation**.

C–E. Unique public/Helius: **11,057 / 11,048**; matched: **11,048**; raw exclusive: **9 / 0**, but guarded globally exclusive: **0 / 0**.

F. Helius relative delta p50/p95/p99: **+24.378 / +181.944 / +235.444 ms**. Largest clean observed Helius lead: **480.430 ms**.

G. Disconnects: **none**.

H. Parser/payload differences: **35 Helius truncations, including 7 parser-output differences**.

I. Longer benchmark methodology: **trustworthy for relative signature arrival**, provided the next analyzer adds time-segment stability and continues to report truncation separately.

J. Recommended next duration: **15 minutes**, not two hours. The smoke already produced over 11,000 matched signatures; 15 minutes should provide roughly 33,000 at comparable volume and three five-minute stability windows.

K. Smoke-only conclusion: **public RPC was materially slower at the median and positive tail in this run; there is no meaningful clean-window signature-completeness difference; Helius was less complete at the log-payload/event layer because it truncated 35 payloads**.

No profitability conclusion is made.
