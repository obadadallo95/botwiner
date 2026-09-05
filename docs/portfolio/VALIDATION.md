# Multi-portfolio deployment validation

## Implemented scope

1. Strategies: aggressive-30sol-v1 (30 SOL, 3s, 3 trades), balanced-40sol-v1 (40 SOL, 4s, 4 trades), baseline-50sol-v1 (50 SOL, 5s, 5 trades), conservative-60sol-v1 (60 SOL, 7s, 7 trades). The existing organic-50sol-continuation-v1 fixed 0.10 SOL reference is unchanged.
2. Risk modes: aggressive (10% equity, 0.20 SOL cap, 60% exposure), balanced (5%, 0.10 SOL, 40%), conservative (2.5%, 0.05 SOL, 25%). These are independent of strategy.
3. Bankrolls: 2, 5, 10, 15, 20 SOL, for all strategy/risk combinations: 60 accounts.
4. Sizing: min(floor(current equity × risk basis points / 10000), hard cap), in integer lamports. Profits/losses affect subsequent entries.
5. Exposure: acquisition cost plus entry costs must fit the equity-based allowance; cash remaining must cover its unused fraction. Skip with INSUFFICIENT_CAPITAL on failure; first crossing stays consumed.
6. Costs: existing Pump quote math, 100bps protocol fee, 5000 lamport base + 50000 priority per side, zero Jito. Gross realized, realized net, marked net and paid costs are distinguished.
7. Concurrency: one causal, event-ID-deduplicated collector stream; stable collector sequence/log order; independent cash/inventory per account; no future evidence or unlimited capital.
8. Dashboard: independent dimension selectors, portfolio/strategy/capital comparison, selected equity curve, locked inventory and freshness, outlier sensitivity, gross/net/costs. Curves and inventory previews are bounded; full evidence remains in GCS.
9. Replay: verify GCS manifest and compressed chunk checksums, regenerate every audit record, compare the entire portfolio summary and streaming digest; mismatch fails. Decimal serialization preserves baseline BigInts at output boundaries.
10. Tests: all 128 tests passed. pnpm typecheck, pnpm test, pnpm lint, pnpm check, dashboard production build and git diff --check passed. Added capital, sizing, concurrency, independence, costs, drawdown, ordering, replay, timeout/migration, outlier and nested-BigInt serialization regressions.

## Operational smoke and deployment

The first smoke, session-portfolio-smoke-1788640609488, ran for 90 seconds. It captured 4,258 normalized events (47 launches, 4,211 trades). All 60 portfolio states published; 15 account entries and 15 exits occurred. Its 1,875 audit records and full portfolio summaries match GCS replay exactly (SHA-256 db4a161715c145e2dfcaa5c2b91f1a58e086ed5efb3d0961f714da2dcce3ce8c).

That first session ended as failed because the existing baseline summary's nested BigInt could not be serialized to JSON. The failure was surfaced, the lock released, and decimal-string serialization was added at GCS/Firestore/replay output boundaries without altering baseline strategy behavior. A second smoke is required before acceptance.

The dashboard component rendered actual smoke telemetry locally. Bankroll selection changed 5 to 20 SOL; independent risk and strategy selectors changed to conservative and aggressive-30sol-v1. The deployed API health endpoint returned OK. An authenticated production browser data-flow check remains separate from the local rendering check; no authentication settings were weakened.

API deployment: botwiner-api-00009-vgv, serving 100% traffic. API image digest: sha256:b218f5307a6ca787396aa42d09fbcd0cdd7f4717d4fd53fb43797133d9a87ac9.

Dashboard deployed to the existing Firebase Hosting site. No new infrastructure, billing plan, scheduled capture, live trading, or six-hour experiment was created. Only short operational smoke evidence was used, without tuning any frozen parameter.

Final collector digest, successful smoke, readiness, commit and push status are recorded after acceptance.
