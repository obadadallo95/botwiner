# Frozen multi-portfolio experiment v1

Evaluation must use one future six-hour Helius capture. Deployment and a short operational smoke test do not start that evaluation. No real trades, wallet signing, paid services, or parameter optimization are introduced. Existing Cloud Run/Firebase/GCS resources are reused; no new resources or billing plans are provisioned.

The prerequisite base is a1dbd24c385814cc0d9c5a88b1de50bb91adc2ba, fetched and verified before implementation.

## Frozen dimensions

| Strategy | First real SOL crossing | Minimum age | Observed trades |
| --- | --- | --- | --- |
| aggressive-30sol-v1 | <30 to >=30 | 3 seconds | 3 |
| balanced-40sol-v1 | <40 to >=40 | 4 seconds | 4 |
| baseline-50sol-v1 | <50 to >=50 | 5 seconds | 5 |
| conservative-60sol-v1 | <60 to >=60 | 7 seconds | 7 |

All require a launch observed in this session, exclude age <1500ms or launch-slot crossings, consume the first crossing even when rejected, and permit at most one entry per token. Names are research labels, not safety ratings. The existing organic-50sol-continuation-v1 engine and fixed 0.10 SOL baseline remain unchanged as a separate reference. baseline-50sol-v1 uses its exact entry rules within the capital-aware matrix; its size depends on risk mode.

Each entry strategy runs with **all three** risk modes and **all five** bankrolls (2, 5, 10, 15, 20 SOL): 60 independently funded accounts.

| Risk mode | Current equity sizing | Maximum curve input | Exposure ceiling |
| --- | --- | --- | --- |
| aggressive | 10% | 0.20 SOL | 60% |
| balanced | 5% | 0.10 SOL | 40% |
| conservative | 2.5% | 0.05 SOL | 25% |

## Accounting and admission

All balances, quantities, fees and sizing use bigint integer lamports. Display ratios use floating point. For equity E, rate b in basis points and hard cap H:

`input = max(0, min(floor(E * b / 10000), H))`

`entry debit = curve input + rounded Pump fee + 55000 lamports`

`equity = cash + sum(last executable net liquidation marks)`

`exposure allowance = floor(E * exposureBps / 10000)`

`minimum reserve = E - exposure allowance`

Entry requires positive size, valid quote, cash >= debit, cash - debit >= minimum reserve, and deployed acquisition cost + debit <= exposure allowance. Acquisition cost includes entry fees. If constraints fail, record INSUFFICIENT_CAPITAL with the binding category; no partial size or later retry. Exposure is an admission constraint: market changes can subsequently breach it; there is no unrequested forced deleveraging. Risk sizing refers to curve input; modeled fees are additional wallet debit.

Profits and losses change future sizing subject to the hard cap. Funds cannot cross between accounts. Entry immediately receives a liquidation mark so fees and price impact affect subsequent equity. Unrealized exit costs reduce equity but are not reported as paid costs until exit. Gross realized PnL less paid costs equals realized net PnL when inventory is fully closed.

## Costs and exits

Reuse paper-medium-v1 and quotePumpBuy/quotePumpSell: 100 bps Pump fee with existing quote rounding; 5000 lamport base fee plus 50000 lamport priority fee per side; zero Jito tip. Exit net inflow has the same zero floor as the original baseline. Quotes remain hypothetical and do not establish real execution accuracy, latency, fill probability or completeness.

Every strategy uses +30% net TP, -20% net SL, then 300000ms timeout, with return measured against total entry wallet outflow. Exits use the first fresh token quote satisfying a rule. Inactive tokens can remain open past timeout; no fabricated wall-clock quote is used. Session end censors remaining inventory without selling it or recycling its capital. Marked equity uses its last observed liquidation quote; final cash is separately reported. Unresolved migration/timeout quote failure marks inventory to zero and keeps its acquisition exposure locked. Quote timestamps and timeout status are displayed.

## Causality and evidence

Deduplicate event IDs identically to the storage sink. Process (collectorSequence, transactionLogIndex) order; novel out-of-order events fail closed. All 60 accounts consume the same accepted event sequence; exits/marks for an event occur before its entries. Timestamp ties never determine allocation order. Portfolio time is a non-decreasing maximum of observed receive timestamps. Launch age still uses the token's causal receive timestamps.

A streaming SHA-256 audit covers first crossings, eligibility, entries, skips, marks, exits, censorship, balance changes and session end. Its record count and digest accompany the full portfolio summary in GCS `sessions/<session>/summary/portfolio-summary.json`. Exact integer balances are included. No wall-clock call enters the portfolio engine, including session closure.

`pnpm research:replay-cloud --session <id> --bucket <bucket> --output <report.json>` verifies manifest membership/count and SHA-256 of saved compressed chunks (including cache), feeds the same engine, writes every audit record to `<cache>/<session>/portfolio-audit.jsonl`, and compares the complete final summary. A mismatch fails the command. Legacy sessions return null for portfolio comparison because no original portfolio summary exists. An active capture cannot be replayed as final evidence.

The dashboard uses a compact Firestore summary, refreshed through the existing telemetry cadence. It displays bankroll and risk selectors, all four strategies, return/drawdown/EV/fees/capital use/skips, capital comparisons, outlier-removal metrics, and a selected equity curve and inventory. Curves are sampled for display; drawdown updates at every mark. Full 30-second curve points and complete inventory are in GCS; live inventory previews explicitly indicate when only the first ten positions are shown.

Outlier metrics use closed net PnL. Removing best/top-five removes the highest values even when all values are negative. Contribution divides by total closed net PnL, may be negative or exceed 100%, and is null at zero. Whole-portfolio return includes marked inventory and is labeled separately.

Thresholds, risk budgets, costs and exits must not be modified after evaluation begins. A favorable result is a candidate for validation on a new capture, never proof of profitability.
