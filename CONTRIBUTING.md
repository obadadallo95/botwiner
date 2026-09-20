# Contributing to Botwiner

Botwiner is a reproducible research project. Contributions should make the
evidence boundary clearer, the replay more deterministic, or the engineering
more auditable. The project does not accept changes that turn the repository
into a live trading system.

## Before opening a pull request

- State the hypothesis and intended evaluation boundary before tuning where
  practical. Do not tune on evaluation data and call it validation.
- Keep causal observations separate from finalized or post-hoc evidence.
- State execution assumptions explicitly: latency, fees, slippage, quote
  freshness, fill uncertainty, migration, and capital constraints.
- Preserve negative or null results. Do not strengthen a claim beyond the
  evidence or present a mark as an executable exit.
- Never commit API keys, service-account JSON, OAuth secrets, provider URLs
  containing credentials, wallet keys, or private keys.
- Do not add live trading, wallet signing, or transaction submission to a
  research pull request without an explicit project-scope decision.

## Local checks

Use Node.js >=22.13 and pnpm 11:

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm --dir apps/dashboard build
pnpm research:demo
```

Generated data under `data/`, local `.env` files, and provider credentials are
not review artifacts. A small sanitized fixture belongs under
`examples/sample-session/` only when it contains no secrets and its hashes are
documented.

## Research changes

New experiments should include a frozen manifest or machine-readable summary,
the repository revision, file hashes where available, and a limitations note.
Prospective evaluation rules should be selected before the holdout is opened.
If capture IDs or raw evidence are unavailable, write **unavailable** rather
than inferring them from a derived report.

## Pull requests

Explain the user-visible or research-visible result first, then describe the
validation. Keep unrelated refactors out of evidence changes. Reviewers should
be able to reproduce the claim from the changed files and the cited artifacts.
