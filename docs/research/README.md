# Research artifact index

This directory is the navigational entry point for the completed Botwiner
research. The published result is negative and remains bounded by its causal
data and execution assumptions.

## Primary result

- [Negative-result paper](NEGATIVE-RESULT.md) — question, design, results,
  limitations, and interpretation.
- [Scenario sweep](SCENARIO-SWEEP-2026-09-17.json) — sanitized machine-readable
  counts, search dimensions, latency rows, and assumptions.
- [Provenance notes](PROVENANCE.md) — available capture metadata, hashes, and
  redistribution boundaries.
- [Prepared research-v1 release notes](../releases/research-v1.md) — release
  scope and reproduction instructions; no release is published yet.

## Methodology and architecture

- [Phase 1 architecture](../phase-1/ARCHITECTURE.md) — raw capture, parser
  boundary, and deterministic replay contract.
- [Phase 2 architecture](../phase-2/ARCHITECTURE.md) — finalized evidence,
  canonical ordering, gaps, and feed-quality reporting.
- [Phase 2.5 feed comparison](../phase-2.5/ARCHITECTURE.md) — controlled
  public-versus-candidate feed comparison and its limits.
- [Portfolio experiment contract](../portfolio/EXPERIMENT.md) — capital-aware
  accounting, sizing, costs, and replay audit rules.

## Figures and reproducibility artifacts

- [`docs/assets/`](../assets/) — four SVG figures generated only from the
  published scenario JSON and a structural pipeline diagram.
- [`scripts/generate-research-figures.py`](../../scripts/generate-research-figures.py)
  — deterministic figure source.
- [`examples/sample-session/`](../../examples/sample-session/) — tiny sanitized
  raw fixture, normalized events, manifest, and SHA-256 sums.
- [`scripts/research-demo.ts`](../../scripts/research-demo.ts) — parser,
  deterministic replay, digest verification, and paper-simulation smoke.

Run the fixture and figure checks with:

```bash
pnpm research:demo
pnpm research:figures
pnpm check
```

## Feed comparison work

The [Phase 2.5 smoke report](../phase-2.5/SMOKE-TEST-2026-09-05.md) records a
same-host public WebSocket and Helius standard-WebSocket comparison. It found a
relative callback-arrival difference in that run, but no meaningful clean-window
signature-completeness difference and several Helius log truncations. It is
evidence about that smoke window, not proof of an executable trading advantage.

## Hashes and manifests

Raw captures and cloud manifests are not committed automatically. A shareable
capture should include its manifest, SHA-256 digest, repository revision, and
provider redistribution permission. The committed sample's exact file hashes
are in `examples/sample-session/SHA256SUMS`; the final sweep's sanitized
scenario JSON is the reproducibility boundary for the published numbers.
