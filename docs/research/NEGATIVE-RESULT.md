# Negative result: short-horizon Pump launch strategies

**Experiment date:** 2026-09-17 UTC  
**Repository revision:** `7f3ea36726c910813d0718381f4dd3d5ded1ca21`  
**Status:** no production-ready edge found

## Question

Can a small, capital-aware paper portfolio reliably profit from entering Pump bonding-curve tokens when their native-SOL reserves cross a threshold, then exiting after a short holding period or a take-profit/stop-loss rule?

The experiment was designed to test the executable question, not whether token prices sometimes rise. Entry and exit quotes include constant-product curve price impact for the requested position size. Fees, latency, stale observations, and uncertain post-graduation exits are treated explicitly.

## Data and search

The run combined nine substantive cloud captures with the stopped local capture. It produced 15,467 token paths with at least two native-SOL trade states: 13,687 cloud paths and 1,780 local paths.

The sweep covered:

- 1,344 fixed-horizon combinations: seven entry thresholds, eight position budgets, four entry latencies, and six holding periods.
- 256 take-profit/stop-loss combinations on the strongest fixed-horizon candidates.
- Low, medium, and high fixed-cost audits, plus capital-aware portfolio ledgers at 0.5, 1, 2, and 5 SOL.

## Results

The strongest last-observation mark used a 5 SOL threshold, a 0.5 SOL position, zero simulated entry latency, and a 15-second hold. It showed +0.0582 SOL per attempt in the mark model, but only 37.9% of exits had a fresh observation. Under the conservative exit treatment it was −0.2915 SOL per attempt.

The best conservative fixed-horizon row was still negative: a 5 SOL threshold, 0.01 SOL position, zero latency, and a 15-second hold returned −0.00594 SOL per attempt. No tested conservative row had positive expected value.

Latency changed the conclusion even before the conservative exit treatment. For a 5 SOL threshold, 0.1 SOL position, and 15-second hold, the mark EV was +0.0139 SOL at 0 ms, then −0.0050 SOL at 500 ms, −0.0050 SOL at 1,000 ms, and −0.0044 SOL at 2,000 ms.

Take-profit/stop-loss rules did not rescue the result. The best observed mark row was +0.0346 SOL per attempt, while the strongest conservative TP/SL row remained −0.2034 SOL per attempt.

The cloud and local slices had the same direction: positive only under idealized marks and negative under the conservative exit treatment. This makes the result less consistent with a single bad capture, while the local slice is still too small to represent a market regime on its own.

## Interpretation

The data shows repeatable market mechanics: early price movement, short-lived liquidity, and a high rate of missing or stale exit observations. It does **not** show a repeatable, executable profit edge. The apparent mark profit is not deployable because it assumes a last observed curve state is a tradable exit and assumes zero-latency entry in the rows that rank highest.

The conservative model is intentionally a bound, not a claim that every stale observation would lose the entire position. It treats a missing fresh quote within five seconds, or an unresolved graduation/migration, as a full loss because the collector did not decode the alternate venue exit. A future study could tighten this bound only by measuring actual post-migration exit availability.

The appropriate conclusion is **NOT READY for real trading**. More parameter tuning on the same observations would mostly increase the risk of selecting noise. A new claim would require a different data boundary, reliable migration/exit telemetry, and a frozen prospective paper test.

## Reproduction and reuse

Raw captures are not committed to GitHub: they are large, contain third-party market data, and are not needed to audit the decision table. The repository contains the collector, schemas, replay tools, simulators, tests, and the sanitized result summary. When sharing a raw capture, publish its manifest and SHA-256 digest alongside it and verify the provider's redistribution terms.

This report is a research artifact, not financial advice. It does not recommend buying, selling, borrowing, or using leverage.
