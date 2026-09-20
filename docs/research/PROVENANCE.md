# Experiment provenance

This document records what is available in the sanitized repository for the
published negative result. It intentionally distinguishes known facts from
metadata that was not preserved in the public summary.

## Final sweep

| Field | Value |
| --- | --- |
| Experiment date | 2026-09-17 UTC |
| Original capture/research revision | `7f3ea36726c910813d0718381f4dd3d5ded1ca21` |
| Token paths | 15,467 total; 13,687 cloud; 1,780 local |
| Cloud capture IDs | Unavailable in the sanitized summary |
| Local capture ID | Unavailable in the sanitized summary; described as the stopped local capture |
| Raw data | Not committed; provider terms and size prevent automatic redistribution |
| Real trades | False |

The final scenario summary is
[`SCENARIO-SWEEP-2026-09-17.json`](SCENARIO-SWEEP-2026-09-17.json). Its SHA-256
in this repository is:

```text
e3e2e6273ad5013653d9d3d5b35c3305a4bb80b7916d7b5abb70e0b38d53bbda  docs/research/SCENARIO-SWEEP-2026-09-17.json
```

The summary records the search dimensions, best mark row, best conservative
row, latency sensitivity, cost assumption, freshness bound, and the fact that
the model did not execute real trades. It does not contain raw event IDs or
cloud object paths, so those fields remain unavailable here.

## Existing evidence references

These hashes belong to earlier engineering validation artifacts and are listed
for traceability, not as additional profitability evidence:

- Phase 1 replay digest: `3b3be3b132f9b582367e2660dddb7a8c6fb5452ea26cd0b368e57fda64036537`
  (documented in `docs/phase-2/ARCHITECTURE.md`).
- Portfolio smoke audit digest: `db4a161715c145e2dfcaa5c2b91f1a58e086ed5efb3d0961f714da2dcce3ce8c`
  (documented in `docs/portfolio/VALIDATION.md`).

Those sessions are not the final 15,467-path sweep and should not be used to
restate its result.

## Sanitized demo fixture

The repository includes a tiny synthetic fixture that is safe to redistribute:

```text
a50de48525a88c82bcb0713b8187190f514332b9a8c3326d779689d50990fbcb  examples/sample-session/raw.jsonl
eb30e6e5558664380bc9dafeec55f54c3a59b7218f8c45e93b2cad96c51e3e94  examples/sample-session/events.jsonl
e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855  examples/sample-session/diagnostics.jsonl
```

The fixture uses synthetic test accounts and is a parser/replay check, not a
market observation. Run it with `pnpm research:demo`.

## Capture sharing requirements

A future raw capture should be shared only when its provider terms allow it and
when the accompanying package includes:

1. capture/session IDs and collection window;
2. repository revision and parser/IDL revisions;
3. raw, normalized, and derived file hashes;
4. the feed, commitment, endpoint label, and known reconnect gaps;
5. a statement of which fields are causal observations versus post-hoc evidence;
6. a redistribution and credential-sanitization review.

If any item is unavailable, record it as unavailable. Do not infer a capture ID,
cloud path, provider timestamp, or completeness guarantee from a derived summary.
