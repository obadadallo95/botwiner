# Pump price and execution-cost evidence

Research date: 2026-09-05

## What the event proves

The pinned official Pump IDL defines the decoded `TradeEvent` fields. The official Pump documentation states that buys increase virtual/real quote reserves and decrease virtual/real token reserves; sells do the reverse. The emitted reserve values are post-trade state. [Pinned Pump IDL](https://github.com/pump-fun/pump-public-docs/blob/9c82f61cb711b044a17f770ab8ce9f9bdf78f333/idl/pump.json), [official Pump program documentation](https://github.com/pump-fun/pump-public-docs/blob/main/docs/PUMP_PROGRAM_README.md)

`observedPriceRatio = quoteAmount / tokenAmount` is the exact average fill ratio reported for that event. It is not the pre-trade marginal ratio, post-trade marginal ratio, a sell-back price, or the quote available to the next transaction.

For a standard non-Mayhem event, `pumpTradeReserveSemantics` reconstructs the immediately preceding state by directional reserve deltas:

- buy: pre-token = post-token + token amount; pre-quote = post-quote − quote amount;
- sell: pre-token = post-token − token amount; pre-quote = post-quote + quote amount.

The helper exposes reserve ratios as exact integer numerator/denominator pairs. It does not call them executable prices. In the validation sample, adjacent standard events agreed with this reconstruction in 633/633 comparable cases.

Mayhem mode is deliberately unsupported for one-event pre-state reconstruction. The sample showed independent quote-reserve changes between comparable Mayhem events, so the helper returns `preTrade: null` rather than inventing state.

## Exact quote requirements still missing

Current official Pump instruction documentation includes direction-specific integer rounding and fee rules. For example, buy maximum cost includes protocol/creator fees, while sell minimum output is net of fees; newer exact-quote instructions define floor/ceiling operations. [official buy documentation](https://github.com/pump-fun/pump-public-docs/blob/main/docs/instructions/BUY.md), [official current Pump IDL](https://github.com/pump-fun/pump-public-docs/blob/main/idl/pump.json)

A credible simulator must pin an official program/SDK revision and implement each supported instruction's exact integer formula, dynamic fee tier, buy/sell rounding, token program/decimals, slippage bound, and account-creation/rent effects. It must validate those quotes against transactions before use. Phase 2 does not substitute a generic constant-product formula.

Migration is a venue boundary. Completed bonding curves move to PumpSwap, whose official model uses a canonical migrated pool index of 0 and effective quote reserves equal to vault quote reserves plus `virtual_quote_reserves`. PumpSwap events and execution math require a separate concrete venue implementation. [official PumpSwap documentation](https://github.com/pump-fun/pump-public-docs/blob/main/docs/PUMP_SWAP_README.md)

## Solana and Jito costs

Solana transaction fee evidence records `meta.fee`, compute units consumed, compute-budget instructions, the explicit or runtime-default effective CU limit, and the calculated priority fee. Current Solana runtime behavior charges `ceil(CU limit × micro-lamports per CU / 1,000,000)` and computes a type-dependent default limit when no explicit limit exists. [Solana fee structure](https://solana.com/docs/core/fees/fee-structure), [Agave compute-budget implementation](https://github.com/anza-xyz/agave/blob/master/compute-budget-instruction/src/compute_budget_instruction_details.rs)

`meta.fee` does not turn ordinary SOL transfers into fees. Phase 2 therefore scans top-level and CPI System Program transfers to the eight tip accounts documented by Jito and records same-transaction evidence separately. Jito documents a 1,000-lamport bundle minimum, but the competitive winning tip is auction-dependent. [Jito low-latency transaction documentation](https://docs.jito.wtf/lowlatencytxnsend/)

The evidence has a strict boundary: a tip may be paid in another transaction in the same bundle. Standard finalized RPC does not expose bundle membership, the losing bundle population, or the tip needed to win a target position. `no-transfer-observed` therefore means only that no direct transfer to a documented tip account was decoded in that transaction.

## Phase 3 contract

Phase 3 must attribute at least gross curve movement, Pump fees, Solana base and priority fees, observable/assumed Jito tips, slippage, latency, failed or missed fills, adverse ordering, and timeouts. Unknown tip/landing evidence must remain a scenario parameter or explicit unknown—not zero.
