# Botwiner short-horizon strategy evaluation

**Experiment date:** 2026-09-17 UTC
**Capture revision:** `7f3ea36726c910813d0718381f4dd3d5ded1ca21`
**Report status:** no production-ready edge found

## Abstract

This study tested whether a small, capital-aware paper portfolio could enter
new Pump.fun bonding-curve tokens at native-SOL reserve thresholds and exit on
short fixed horizons or take-profit/stop-loss rules. The evaluation used 15,467
token paths, 1,344 fixed-horizon combinations, 256 TP/SL combinations, and 72
cost audits across nine substantive cloud captures and one stopped local
capture. The best last-observation mark was positive, but only 37.9% of its
exits had a fresh observation; the same row was negative under the conservative
exit treatment. No tested conservative fixed-horizon row had positive expected
value. This is a negative result for the tested data boundary and execution
model, not a claim that every crypto strategy is impossible.

## Research question

Can a small, capital-aware paper portfolio reliably profit from entering Pump
bonding-curve tokens when their native-SOL reserves cross a threshold, then
exiting after a short holding period or an executable take-profit/stop-loss
rule?

The question is deliberately about executable paper outcomes. It does not ask
whether a chart sometimes rises after launch.

## Hypothesis

The pre-registered research hypothesis was that early reserve progression and
short-horizon continuation might create a positive expected value after curve
price impact, fees, latency, and capital constraints. The experiment was
allowed to return a negative result; no rule was selected after viewing the
holdout outcome.

## Dataset

The run combined nine substantive cloud captures with the stopped local
capture. It produced 15,467 token paths with at least two native-SOL trade
states: 13,687 cloud paths and 1,780 local paths. Raw captures are not
redistributed in this repository because they are large, contain third-party
market data, and remain subject to provider terms.

The machine-readable result and its exact search dimensions are in
[`SCENARIO-SWEEP-2026-09-17.json`](SCENARIO-SWEEP-2026-09-17.json).

## Causal observation boundary

The causal input is the collector-ordered stream available at observation time.
Raw notifications are normalized without finalized metadata that arrived later.
Finalized transaction evidence is stored in a separate post-hoc view and is not
fed back into entry or exit decisions. Duplicate event IDs are removed using
the same rule as the storage sink. The simulator processes collector sequence
and transaction-log order; novel out-of-order evidence fails closed.

This boundary matters because a later canonical block view can explain what
happened without being available to a strategy at the moment it would have
needed to act.

## Execution model

Entry and exit quotes include constant-product curve price impact for the
requested position size. The cost audit includes low, medium, and high fixed
cost assumptions. The medium scenario uses 0.00023 SOL of fixed cost per
attempt. Latency is injected before entry, and an exit must have a fresh quote
within five seconds of the deadline.

The last-observation mark uses the latest curve state at or before the deadline
when no fresh state exists. The conservative treatment records a full loss when
no fresh state is available by the deadline or migration/exit availability is
unresolved. That treatment is a bound chosen to avoid silently converting an
unobserved exit into a profitable mark; it is not a claim that every such token
would lose its entire position in a live venue.

## Experimental design

The fixed-horizon sweep covered:

- seven entry thresholds: 0.5, 0.75, 1, 1.5, 2, 3, and 5 SOL;
- eight position budgets: 0.01, 0.025, 0.05, 0.075, 0.1, 0.2, 0.35, and 0.5 SOL;
- four entry latencies: 0, 500, 1,000, and 2,000 ms;
- six holds: 15, 30, 60, 120, 180, and 300 seconds.

The strongest fixed-horizon candidates then received 256 TP/SL combinations.
Capital-aware ledgers were evaluated at 0.5, 1, 2, and 5 SOL starting capital.
Position sizing and exposure were bounded by available equity; open positions
were not given unlimited capital or post-session fabricated quotes.

## Fixed-horizon results

The strongest last-observation mark used a 5 SOL threshold, a 0.5 SOL position,
zero simulated entry latency, and a 15-second hold. It showed **+0.0582 SOL per
attempt** in the mark model, but only **37.9%** of exits had a fresh observation.
Under the conservative exit treatment the same row was **−0.2915 SOL per
attempt**.

The best conservative fixed-horizon row used a 5 SOL threshold, a 0.01 SOL
position, zero latency, and a 15-second hold. It returned **−0.00594 SOL per
attempt**. No tested conservative fixed-horizon row had positive expected value.

## Latency sensitivity

For a 5 SOL threshold, 0.1 SOL position, and 15-second hold, mark EV was
**+0.0139 SOL** at 0 ms, then **−0.0050 SOL** at 500 ms, **−0.0050 SOL** at
1,000 ms, and **−0.0044 SOL** at 2,000 ms. The conservative values for those
latencies were −0.0576, −0.0628, −0.0631, and −0.0628 SOL per attempt.

![Latency sensitivity](../assets/latency-sensitivity.svg)

## TP/SL results

Take-profit/stop-loss rules did not rescue the result. The best observed mark
row was **+0.0346 SOL per attempt**, while the strongest conservative TP/SL row
remained **−0.2034 SOL per attempt**. These are paper results under the stated
quote and observation assumptions; they are not fills or executed trades.

## Capital constraints

The capital-aware ledger changes usable equity after each modeled result and
limits position size, cash reserve, and concurrent exposure. The published
scenario summary includes starting ledgers at 0.5, 1, 2, and 5 SOL. Capital
constraints can change how often a rule enters, but they do not turn the
negative conservative expected values into a production claim.

## Robustness

The cloud and local slices had the same direction: positive only under
idealized marks and negative under conservative exit treatment. This is less
consistent with a single bad capture, while the local slice remains too small
to represent a market regime on its own. Cost audits, latency rows, fixed
horizons, and TP/SL rows all preserve the same core limitation: an observed
curve state is not automatically an executable exit.

## Threats to validity

- Public RPC is a functional baseline, not a completeness or provider-ingress
  latency SLA.
- `processed` events can roll back, and standard PubSub has no resume cursor for
  proving that a reconnect gap contained no missed event.
- The collector cannot observe every bundle tip, bundle membership, landing
  probability, or alternate-venue migration exit from the same boundary.
- The conservative unresolved-exit treatment is intentionally strict and can
  overstate losses for tokens whose later exit would have been available.
- The local slice and the captured calendar window do not cover all market
  regimes.
- The paper engine models venue quotes and costs; it does not submit real
  transactions or establish wallet-level fill probability.

## Interpretation

The data shows repeatable market mechanics: early price movement, short-lived
liquidity, and a high rate of missing or stale exit observations. It does not
show a repeatable, executable profit edge. The apparent mark profit depends on
treating a last observed curve state as a tradable exit and on rows with zero
simulated entry latency.

The appropriate decision for this hypothesis is **NOT READY for real trading**.
Further tuning on the same observations would increase the risk of selecting
noise rather than improve evidence.

## What this result does not establish

It does not establish that every Solana or crypto strategy is unprofitable, that
every Pump.fun token is untradeable, or that a different venue, data boundary,
holding period, or execution path cannot produce a different result. It also
does not estimate a live trader's realized loss distribution.

## Evidence that could change the conclusion

A materially different conclusion would require a new, prospective data
boundary with reliable migration and exit telemetry, measured feed coverage and
arrival latency, frozen rules selected before evaluation, and a fresh holdout
capture. The missing evidence must be recorded as evidence, not replaced with a
favorable mark.

## Reproduction

The repository contains the parser, replay tools, simulator, tests, sanitized
scenario summary, and a tiny fixture that runs without live traffic:

```bash
pnpm install --frozen-lockfile
pnpm research:demo
pnpm check
```

The [research artifact index](README.md) links the machine-readable summary,
figure source, fixture hashes, and provenance notes. Raw captures can be
replayed only when their manifest, SHA-256 digest, and redistribution terms are
available.

## Citation

Use the repository citation metadata in [`CITATION.cff`](../../CITATION.cff).
The canonical code repository is
<https://github.com/obadadallo95/botwiner>. No DOI is claimed.
