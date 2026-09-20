# Botwiner Research v1 — Negative Result

**Release preparation:** ready for a maintainer to tag as `research-v1`. No
GitHub release or tag has been published by this change.

## Research question

Can short-horizon Pump.fun bonding-curve entries produce a repeatable,
capital-aware paper-trading edge after latency, costs, price impact, stale
observations, and migration uncertainty?

## Methodology and scale

- 15,467 token paths with at least two native-SOL trade states;
- 1,344 fixed-horizon combinations;
- 256 take-profit/stop-loss combinations;
- 72 cost audits;
- cloud and local slices evaluated under causal observation boundaries;
- deterministic replay and capital-aware paper ledgers.

## Result

**No production-ready edge found.** Positive expected value appeared in some
idealized last-observation marks, but the strongest row had only 37.9% fresh
exit observations and became negative under conservative exit treatment.
Latency alone moved a representative mark row from +0.0139 SOL at 0 ms to
−0.0050 SOL at 500 ms.

## Limitations

The study does not measure every provider's completeness, validator-ingress
latency, bundle membership, landing probability, or alternate-venue migration
exit. The conservative unresolved-exit treatment is a bound, not a claim that
every stale observation would lose the entire position. Raw captures are not
redistributed by default.

## Reproduction

```bash
pnpm install --frozen-lockfile
pnpm research:demo
pnpm check
```

Read the [negative-result paper](../research/NEGATIVE-RESULT.md),
[scenario summary](../research/SCENARIO-SWEEP-2026-09-17.json), and
[provenance notes](../research/PROVENANCE.md). The exact commit for the
prepared release is reported with the final repository state; no DOI is claimed.
