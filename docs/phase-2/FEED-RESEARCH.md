# Public RPC versus stronger Solana feeds

Research date: 2026-09-05. Prices and product terms can change; re-check before any purchase.

| Option | Feed/protocol | Replay/backfill | Timestamp evidence | Mainnet/Europe | Public price/trial | Material value |
| --- | --- | --- | --- | --- | --- | --- |
| Solana public RPC | `logsSubscribe` WebSocket + HTTP finalization | no PubSub cursor; bounded address/block queries only | collector time; second-resolution block time; no provider ingress time | mainnet public endpoint; routing not controlled | free | functional baseline only |
| Self-hosted Yellowstone | validator Geyser gRPC/Protobuf | `from_slot` exists in the protocol; retention depends on deployment | update `created_at` and transaction index fields exist, but semantics must be validated against the deployment | wherever the validator is operated | open source; validator hardware/operations are substantial | maximum control, highest cost/ops burden |
| Helius LaserStream | Yellowstone-compatible enhanced gRPC/WSS | automatic replay up to ~216,000 slots / 24 hours | processed update timing plus client receipt; provider timestamp semantics require a trial measurement | mainnet with Frankfurt, Amsterdam, London | mainnet Business $499/month or Professional $999/month; application-based 2-day trial | strongest short controlled comparison: replay, multi-node delivery, FRA |
| QuickNode Solana gRPC | Yellowstone-compatible Geyser gRPC | `fromSlot`, up to 3,000 recent slots (~20 minutes) | no provider-ingress guarantee identified in public docs | mainnet; Frankfurt listed | Scale $499/month; generic platform trial terms do not prove mainnet gRPC trial access | useful alternative, shorter replay and no cheaper documented access |
| Triton Dragon's Mouth / Fumarole | Geyser gRPC; reliable-stream product for persistence | Dragon's Mouth prioritizes latency; Fumarole backfills missed data | intra-slot lifecycle signals; no general provider-ingress timestamp guarantee identified | mainnet; recent Triton material lists Frankfurt for low-latency streaming | public pricing/trial terms not found; contact sales | technically relevant, commercial uncertainty |

Sources: [Solana logsSubscribe](https://solana.com/docs/rpc/websocket/logssubscribe), [Yellowstone source/protocol](https://github.com/rpcpool/yellowstone-grpc), [Helius LaserStream](https://www.helius.dev/docs/laserstream), [Helius pricing](https://www.helius.dev/pricing), [QuickNode gRPC](https://www.quicknode.com/docs/solana/solana-grpc/overview), [QuickNode replay/regions/pricing announcement](https://www.quicknode.com/blog/solana-grpc-is-now-included-with-scale-and-business-plans), [Triton streaming](https://docs.triton.one/chains/solana/streaming).

## Recommendation

Do not activate a monthly paid provider yet. The existing public feed cannot quantify silent loss or establish a millisecond execution window, so one controlled independent comparison is required before profitability simulation. The cheapest documented route is to apply for Helius's two-day mainnet LaserStream trial and run the public WebSocket and FRA LaserStream simultaneously with identical filters.

The user would need:

1. a Helius account;
2. approval for the two-day LaserStream mainnet trial;
3. one scoped Helius API key supplied locally as an environment variable;
4. permission to add the open-source compatible client dependency and run the comparison.

No account, key, trial, or paid infrastructure was created in Phase 2.
