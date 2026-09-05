import type { LaunchMarketEvent, TradeMarketEvent } from "@botwiner/market-data";
export function createMockLaunch(mint: string, creator = "creator123", timeMs = 1000): LaunchMarketEvent {
  return {
    schemaVersion: 1,
    kind: "market-event",
    eventType: "launch",
    eventId: `launch-${mint}`,
    parsingVersion: "pump-v1",
    rawRef: "raw-1",
    tokenMint: mint,
    bondingCurve: `curve-${mint}`,
    creatorWallet: creator,
    submittingWallet: creator,
    metadata: { name: "Test", symbol: "TST", uri: "https://test.com" },
    tokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    quoteMint: "So11111111111111111111111111111111111111112",
    reserves: {
      virtualTokenBaseUnits: "1073000000000000",
      virtualSolLamports: "30000000000",
      virtualQuoteBaseUnits: "30000000000",
      realTokenBaseUnits: "793100000000000",
      tokenTotalSupplyBaseUnits: "1000000000000000",
    },
    flags: { mayhemMode: false, cashbackEnabled: false },
    source: {
      transport: "solana-rpc-websocket",
      programId: "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
      commitment: "processed",
      endpointLabel: "helius-mainnet-wss",
    },
    signature: `sig-launch-${mint}`,
    ordering: { slot: 100, collectorSequence: 1, transactionLogIndex: 1 },
    timestamps: {
      chainEventUnixSeconds: String(Math.floor(timeMs / 1000)),
      blockTimeUnixSeconds: null,
      collectorReceivedAtUnixMs: timeMs,
      collectorReceivedAtIso: new Date(timeMs).toISOString(),
      collectorReceivedMonotonicNs: "1000000",
      collectorParseCompletedAtUnixMs: timeMs + 1,
      collectorParseDurationNs: "1000",
      rpcProviderReceivedAtUnixMs: null,
    },
    unparsedTrailingBytes: 0,
  };
}

export function createMockTrade(options: {
  mint: string;
  side: "buy" | "sell";
  realSolLamports: bigint;
  virtualSolLamports?: bigint;
  virtualTokenBaseUnits?: bigint;
  solAmountLamports?: bigint;
  tokenAmountUnits?: bigint;
  trader?: string;
  creator?: string;
  timeMs: number;
  slot?: number;
}): TradeMarketEvent {
  const vSol = options.virtualSolLamports ?? 30_000_000_000n + options.realSolLamports;
  const k = 30_000_000_000n * 1_073_000_000_000_000n;
  const vTok = options.virtualTokenBaseUnits ?? (vSol > 0n ? k / vSol : 0n);

  return {
    schemaVersion: 1,
    kind: "market-event",
    eventType: "trade",
    eventId: `trade-${options.mint}-${options.timeMs}`,
    parsingVersion: "pump-v1",
    rawRef: "raw-2",
    tokenMint: options.mint,
    side: options.side,
    traderWallet: options.trader ?? "trader123",
    creatorWallet: options.creator ?? "creator123",
    bondingCurve: null,
    instructionName: options.side === "buy" ? "buy" : "sell",
    quoteMint: "So11111111111111111111111111111111111111112",
    amounts: {
      tokenBaseUnits: (options.tokenAmountUnits ?? 10_000_000_000n).toString(),
      nativeSolLamports: (options.solAmountLamports ?? 1_000_000_000n).toString(),
      quoteBaseUnits: (options.solAmountLamports ?? 1_000_000_000n).toString(),
    },
    observedPriceRatio: { quoteBaseUnits: "1", tokenBaseUnits: "1" },
    reserves: {
      virtualTokenBaseUnits: vTok.toString(),
      virtualSolLamports: vSol.toString(),
      virtualQuoteBaseUnits: vSol.toString(),
      realTokenBaseUnits: "0",
      realSolLamports: options.realSolLamports.toString(),
      realQuoteBaseUnits: options.realSolLamports.toString(),
    },
    fees: {
      protocolRecipient: "feeRecipient",
      protocolBasisPoints: "100",
      protocolQuoteBaseUnits: "10000000",
      creatorBasisPoints: "0",
      creatorQuoteBaseUnits: "0",
      cashbackBasisPoints: "0",
      cashbackQuoteBaseUnits: "0",
      buybackBasisPoints: "0",
      buybackQuoteBaseUnits: "0",
    },
    volumeTracking: {
      enabled: false,
      totalUnclaimedTokens: "0",
      totalClaimedTokens: "0",
      currentSolVolumeLamports: "0",
      lastUpdateUnixSeconds: "0",
    },
    flags: { mayhemMode: false },
    shareholders: [],
    source: {
      transport: "solana-rpc-websocket",
      programId: "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
      commitment: "processed",
      endpointLabel: "helius-mainnet-wss",
    },
    signature: `sig-trade-${options.mint}-${options.timeMs}`,
    ordering: { slot: options.slot ?? 100, collectorSequence: 2, transactionLogIndex: 1 },
    timestamps: {
      chainEventUnixSeconds: String(Math.floor(options.timeMs / 1000)),
      blockTimeUnixSeconds: null,
      collectorReceivedAtUnixMs: options.timeMs,
      collectorReceivedAtIso: new Date(options.timeMs).toISOString(),
      collectorReceivedMonotonicNs: "2000000",
      collectorParseCompletedAtUnixMs: options.timeMs + 1,
      collectorParseDurationNs: "1000",
      rpcProviderReceivedAtUnixMs: null,
    },
    unparsedTrailingBytes: 0,
  };
}

