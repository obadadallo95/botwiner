# Phase 1 technical research

Research date: 2026-09-05

This document separates what is verified from what is assumed. The Pump event parser is pinned to official `pump-fun/pump-public-docs` revision [`9c82f61`](https://github.com/pump-fun/pump-public-docs/tree/9c82f61cb711b044a17f770ab8ce9f9bdf78f333).

## Verified facts

### Pump program and events

- Pump's official documentation says its bonding-curve program is deployed at `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P` on mainnet and devnet. The program creates immediately tradeable coins and later migrates completed curves to PumpSwap. [Official Pump program documentation](https://github.com/pump-fun/pump-public-docs/blob/9c82f61cb711b044a17f770ab8ce9f9bdf78f333/docs/PUMP_PROGRAM_README.md)
- The official IDL defines `CreateEvent` discriminator `[27,114,169,77,222,235,99,118]` and `TradeEvent` discriminator `[189,219,127,211,78,230,97,238]`. Their current fields are the source of truth for the Phase 1 decoder. [Pinned official Pump IDL](https://github.com/pump-fun/pump-public-docs/blob/9c82f61cb711b044a17f770ab8ce9f9bdf78f333/idl/pump.json)
- `CreateEvent` directly supplies metadata, mint, bonding curve, submitting user, creator, a second-resolution program timestamp, reserve values, token program, mode flags, and quote mint.
- `TradeEvent` directly supplies mint, token/SOL/quote amounts, side, user, a second-resolution program timestamp, post-trade reserve values, fee fields, creator, instruction name, mode fields, shareholders, and quote mint. It does not contain the bonding-curve address; that value must be joined from a launch event by mint or derived and independently validated.
- The current official interface supports newer v2 trade forms and quote-mint fields. Existing legacy trade instructions remain valid. The parser therefore records its exact IDL revision and preserves trailing bytes rather than claiming timeless schema compatibility. [Pump public docs](https://github.com/pump-fun/pump-public-docs)

### Standard Solana RPC

- `logsSubscribe` can filter transactions mentioning exactly one public key and supports `processed`, `confirmed`, and `finalized` commitment. A notification contains slot, signature, error, and log strings. [Solana `logsSubscribe`](https://solana.com/docs/rpc/websocket/logssubscribe)
- A Pump-program mention filter is enough to receive transactions involving the Pump program. Known Anchor event discriminators in `Program data:` logs can then identify launches and trades.
- `logsSubscribe` does not provide block time, transaction index within the block, a provider-side receive timestamp, a resume cursor, or a completeness guarantee.
- `getTransaction` can later enrich a confirmed transaction with slot, block time, fee, and full transaction metadata, but it returns only confirmed transactions and is not the first-arrival signal. [Solana `getTransaction`](https://solana.com/docs/rpc/http/gettransaction)
- `blockSubscribe` can provide full transactions and block context, but Solana documents it as unstable and it is available only when the validator enables specific flags. It is not assumed available on the public endpoint. [Solana `blockSubscribe`](https://solana.com/docs/rpc/websocket/blocksubscribe)
- `programSubscribe` observes account changes owned by a program; it is not a complete transaction/event stream and is not selected for launch/trade sequencing.

### Higher-reliability and lower-latency paths

- Yellowstone is an open-source Geyser-based gRPC interface that streams filtered transactions, accounts, slots, and blocks from a validator. Operating it requires a Solana validator/RPC node with the plugin, or access to a hosted endpoint. [Yellowstone gRPC source](https://github.com/rpcpool/yellowstone-grpc)
- Managed Yellowstone-compatible products exist. Current primary documentation shows that QuickNode gRPC requires a Scale-or-higher plan and Helius LaserStream mainnet requires a paid Business-or-higher plan; Helius offers an application-based two-day trial. No account or trial was created. [QuickNode Solana gRPC](https://www.quicknode.com/docs/solana/solana-grpc/overview), [Helius plans](https://www.helius.dev/docs/billing/plans)
- Jito's official documentation states that ShredStream is being shut down on 2026-09-05 and directs users to migrate to DoubleZero Edge. It is therefore not an appropriate new Phase 1 dependency. [Jito ShredStream notice](https://docs.jito.wtf/lowlatencytxnfeed/)

## Assumptions to validate live

- The public mainnet WebSocket endpoint accepts a high-volume Pump program `logsSubscribe` request from the current network location.
- Current Pump executions emit the official IDL events in untruncated `Program data:` log entries.
- Notification delivery order from one connection is useful as observed arrival order. It is not treated as canonical cross-transaction order.
- The host wall clock is reasonably synchronized. No NTP offset measurement is currently captured, so wall-clock comparisons across hosts are not yet defensible.
- The official event's amount fields represent executed on-chain event amounts. The stored ratio is labeled an observed amount ratio, not an executable quote or fill prediction.

## Unknowns requiring measurement or infrastructure

- Public endpoint loss, load shedding, rate limits, geographic routing, queueing latency, and duplicate behavior.
- Completeness across disconnects. Standard PubSub offers no cursor or automatic historical replay.
- Provider ingress time. Only collector arrival time is observable through standard PubSub.
- Canonical ordering of different transactions in the same slot without later block enrichment.
- Whether event layouts will change again and whether every transition will remain append-only.
- How often `processed` observations roll back and how different providers compare at the 50–1000 ms horizons.
- Whether consumer-internet collection latency is stable enough to say anything about a colocated execution engine. It probably is not; this must be measured, not assumed.

## Reliability conclusion

The free public RPC is sufficient for a transparent functional baseline: capture raw messages, verify current parsing, build datasets, and discover obvious gaps. It is not sufficient to claim complete or production-grade low-latency launch coverage. A reliable next-stage comparison needs either:

1. a Yellowstone/Geyser transaction stream with reconnection/backfill support from a managed provider;
2. a self-operated validator/RPC node with Geyser, which has substantial hardware and operations cost; or
3. at minimum, two independent standard WebSocket providers plus confirmed block backfill to quantify loss.

No paid option is necessary to finish the baseline implemented here. No paid option should be selected until the live baseline establishes event rate, byte volume, disconnect frequency, and a concrete evaluation budget.
