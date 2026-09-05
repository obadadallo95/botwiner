import test from "node:test";
import assert from "node:assert/strict";
import { TraderPnlTracker } from "../packages/research/src/trader-pnl-tracker.js";
import type { LaunchMarketEvent, TradeMarketEvent } from "@botwiner/market-data";

function createMockLaunch(mint: string, creator = "creator123", timeMs = 1000): LaunchMarketEvent {
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

function createMockTrade(options: {
  mint: string;
  side: "buy" | "sell";
  realSolLamports: bigint;
  virtualSolLamports?: bigint;
  virtualTokenBaseUnits?: bigint;
  solAmountLamports: bigint;
  tokenAmountUnits: bigint;
  trader: string;
  creator?: string;
  timeMs: number;
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
    traderWallet: options.trader,
    creatorWallet: options.creator ?? "creator123",
    bondingCurve: null,
    instructionName: options.side === "buy" ? "buy" : "sell",
    quoteMint: "So11111111111111111111111111111111111111112",
    amounts: {
      tokenBaseUnits: options.tokenAmountUnits.toString(),
      nativeSolLamports: options.solAmountLamports.toString(),
      quoteBaseUnits: options.solAmountLamports.toString(),
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
    ordering: { slot: 100, collectorSequence: 2, transactionLogIndex: 1 },
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

test("TraderPnlTracker - Clean buy -> sell realized profit", () => {
  const tracker = new TraderPnlTracker();
  const mint = "mintCleanProfit";
  const trader = "traderAlpha";
  tracker.onLaunch(createMockLaunch(mint, "creator1", 1000));

  // Buy 10,000 tokens for 1 SOL at t=2000
  tracker.onTrade(
    createMockTrade({
      mint,
      side: "buy",
      realSolLamports: 1_000_000_000n,
      solAmountLamports: 1_000_000_000n,
      tokenAmountUnits: 10_000n,
      trader,
      timeMs: 2000,
    }),
  );

  let pos = tracker.getPosition(trader, mint)!;
  assert.equal(pos.dataQuality, "CLEAN");
  assert.equal(pos.inventoryUnits, 10_000n);
  assert.equal(pos.solSpentLamports, 1_000_000_000n);

  // Price rises on bonding curve; sell all 10,000 tokens for 1.5 SOL at t=5000
  tracker.onTrade(
    createMockTrade({
      mint,
      side: "sell",
      realSolLamports: 10_000_000_000n,
      solAmountLamports: 1_500_000_000n,
      tokenAmountUnits: 10_000n,
      trader,
      timeMs: 5000,
    }),
  );

  pos = tracker.getPosition(trader, mint)!;
  assert.equal(pos.inventoryUnits, 0n);
  assert.equal(pos.realizedPnlLamports, 500_000_000n); // +0.5 SOL
  assert.equal(pos.classification, "realized-profitable");

  const stats = tracker.getStats();
  assert.equal(stats.cleanEligibleWallets, 1);
  assert.equal(stats.cleanClosedWalletCount, 1);
  assert.equal(stats.cleanClosedWinningWalletCount, 1);
  assert.equal(stats.cleanClosedTraderWinRatePct, 100);
});

test("TraderPnlTracker - Clean buy -> sell realized loss", () => {
  const tracker = new TraderPnlTracker();
  const mint = "mintCleanLoss";
  const trader = "traderBeta";
  tracker.onLaunch(createMockLaunch(mint, "creator1", 1000));

  // Buy 10,000 tokens for 2 SOL
  tracker.onTrade(
    createMockTrade({
      mint,
      side: "buy",
      realSolLamports: 20_000_000_000n,
      solAmountLamports: 2_000_000_000n,
      tokenAmountUnits: 10_000n,
      trader,
      timeMs: 2000,
    }),
  );

  // Price drops; sell 10,000 tokens for 1 SOL
  tracker.onTrade(
    createMockTrade({
      mint,
      side: "sell",
      realSolLamports: 5_000_000_000n,
      solAmountLamports: 1_000_000_000n,
      tokenAmountUnits: 10_000n,
      trader,
      timeMs: 5000,
    }),
  );

  const pos = tracker.getPosition(trader, mint)!;
  assert.equal(pos.inventoryUnits, 0n);
  assert.equal(pos.realizedPnlLamports, -1_000_000_000n); // -1.0 SOL
  assert.equal(pos.classification, "realized-loss");

  const stats = tracker.getStats();
  assert.equal(stats.cleanEligibleWallets, 1);
  assert.equal(stats.cleanClosedWinningWalletCount, 0);
  assert.equal(stats.cleanClosedTraderWinRatePct, 0);
});

test("TraderPnlTracker - First observed event is a sell: marked PARTIAL (inventory-origin-unknown) and excluded from clean win rate", () => {
  const tracker = new TraderPnlTracker();
  const mint = "mintUnknownOrigin";
  const trader = "traderUnknown";
  tracker.onLaunch(createMockLaunch(mint, "creator1", 1000));

  // First action observed is a SELL of 5,000 tokens for 2 SOL
  tracker.onTrade(
    createMockTrade({
      mint,
      side: "sell",
      realSolLamports: 10_000_000_000n,
      solAmountLamports: 2_000_000_000n,
      tokenAmountUnits: 5_000n,
      trader,
      timeMs: 2000,
    }),
  );

  const pos = tracker.getPosition(trader, mint)!;
  assert.equal(pos.dataQuality, "PARTIAL");
  assert.ok(pos.qualityReason?.includes("inventory-origin-unknown"));
  assert.equal(pos.classification, "unknown-partial");

  const stats = tracker.getStats();
  assert.equal(stats.cleanEligibleWallets, 0, "Wallet must NOT be considered clean");
  assert.equal(stats.partialWallets, 1);
  assert.equal(stats.cleanClosedTraderWinRatePct, 0);
});

test("TraderPnlTracker - Multiple buys weighted-average cost basis and partial sell", () => {
  const tracker = new TraderPnlTracker();
  const mint = "mintWAC";
  const trader = "traderWac";
  tracker.onLaunch(createMockLaunch(mint, "creator1", 1000));

  // Buy 1: 10,000 tokens for 1,000,000,000 lamports (100,000 lamports / token)
  tracker.onTrade(
    createMockTrade({
      mint,
      side: "buy",
      realSolLamports: 5_000_000_000n,
      solAmountLamports: 1_000_000_000n,
      tokenAmountUnits: 10_000n,
      trader,
      timeMs: 2000,
    }),
  );

  // Buy 2: 10,000 tokens for 3,000,000,000 lamports (300,000 lamports / token)
  // Total tokens: 20,000. Total spent: 4,000,000,000 lamports. WAC: 200,000 lamports / token.
  tracker.onTrade(
    createMockTrade({
      mint,
      side: "buy",
      realSolLamports: 8_000_000_000n,
      solAmountLamports: 3_000_000_000n,
      tokenAmountUnits: 10_000n,
      trader,
      timeMs: 3000,
    }),
  );

  let pos = tracker.getPosition(trader, mint)!;
  assert.equal(pos.inventoryUnits, 20_000n);
  assert.equal(pos.costBasisLamportsPerToken, 200_000);

  // Sell 10,000 tokens (half inventory) for 2,500,000,000 lamports (cost was 10,000 * 200,000 = 2,000,000,000)
  // Realized gain: 500,000,000 lamports
  // Remaining inventory: 10,000 tokens with cost basis still 200,000 lamports / token
  tracker.onTrade(
    createMockTrade({
      mint,
      side: "sell",
      realSolLamports: 10_000_000_000n,
      solAmountLamports: 2_500_000_000n,
      tokenAmountUnits: 10_000n,
      trader,
      timeMs: 4000,
    }),
  );

  pos = tracker.getPosition(trader, mint)!;
  assert.equal(pos.inventoryUnits, 10_000n);
  assert.equal(pos.realizedPnlLamports, 500_000_000n);
  assert.equal(pos.costBasisLamportsPerToken, 200_000);
});

test("TraderPnlTracker - Executable unrealized marking and open profitable/underwater classification", () => {
  const tracker = new TraderPnlTracker();
  const mint = "mintMarking";
  const trader = "traderMark";
  tracker.onLaunch(createMockLaunch(mint, "creator1", 1000));

  // Buy 5,000 tokens for 0.5 SOL
  tracker.onTrade(
    createMockTrade({
      mint,
      side: "buy",
      realSolLamports: 10_000_000_000n,
      solAmountLamports: 500_000_000n,
      tokenAmountUnits: 5_000n,
      trader,
      timeMs: 2000,
    }),
  );

  const pos = tracker.getPosition(trader, mint)!;
  assert.ok(pos.latestExecutableGrossSolLamports > 0n);
  assert.ok(pos.unrealizedPnlLamports !== 0n);

  if (pos.totalMarkedPnlLamports > 0n) {
    assert.equal(pos.classification, "open-profitable");
  } else {
    assert.equal(pos.classification, "open-underwater");
  }
});

test("TraderPnlTracker - Creator extraction tracking per token", () => {
  const tracker = new TraderPnlTracker();
  const mint = "mintCreatorTest";
  const creator = "creatorKing";
  tracker.onLaunch(createMockLaunch(mint, creator, 1000));

  // Creator buys 50,000 tokens for 2 SOL at launch (t=1000)
  tracker.onTrade(
    createMockTrade({
      mint,
      side: "buy",
      realSolLamports: 2_000_000_000n,
      solAmountLamports: 2_000_000_000n,
      tokenAmountUnits: 50_000n,
      trader: creator,
      creator,
      timeMs: 1000,
    }),
  );

  let creatorAnalytics = tracker.getCreatorAnalytics(mint)!;
  assert.equal(creatorAnalytics.creatorTokensBought, 50_000n);
  assert.equal(creatorAnalytics.holdingStatus, "holding");
  assert.equal(creatorAnalytics.firstSellTimestampUnixMs, undefined);

  // Creator dumps all 50,000 tokens at t=15,000 (14s delay) for 8 SOL
  tracker.onTrade(
    createMockTrade({
      mint,
      side: "sell",
      realSolLamports: 10_000_000_000n,
      solAmountLamports: 8_000_000_000n,
      tokenAmountUnits: 50_000n,
      trader: creator,
      creator,
      timeMs: 15_000,
    }),
  );

  creatorAnalytics = tracker.getCreatorAnalytics(mint)!;
  assert.equal(creatorAnalytics.creatorTokensSold, 50_000n);
  assert.equal(creatorAnalytics.creatorInventoryUnits, 0n);
  assert.equal(creatorAnalytics.holdingStatus, "fully-exited");
  assert.equal(creatorAnalytics.firstSellDelaySec, 14);
  assert.equal(creatorAnalytics.observedNetSolExtractionLamports, 6_000_000_000n);

  const stats = tracker.getStats();
  assert.equal(stats.creatorAnalytics.creatorsObserved, 1);
  assert.equal(stats.creatorAnalytics.creatorsSelling, 1);
  assert.equal(stats.creatorAnalytics.creatorsFullyExited, 1);
  assert.equal(stats.creatorAnalytics.medianFirstSellDelaySec, 14);
  assert.equal(stats.creatorAnalytics.totalObservedCreatorExtractionSol, 6.0);
  assert.equal(stats.creatorAnalytics.largestObservedExtractionSol, 6.0);
});

test("TraderPnlTracker - Deterministic replay gives identical results", () => {
  const run = () => {
    const tracker = new TraderPnlTracker();
    const mint = "mintReplay";
    tracker.onLaunch(createMockLaunch(mint, "creatorX", 1000));

    tracker.onTrade(
      createMockTrade({
        mint,
        side: "buy",
        realSolLamports: 10_000_000_000n,
        solAmountLamports: 1_000_000_000n,
        tokenAmountUnits: 10_000n,
        trader: "trader1",
        timeMs: 2000,
      }),
    );
    tracker.onTrade(
      createMockTrade({
        mint,
        side: "sell",
        realSolLamports: 15_000_000_000n,
        solAmountLamports: 1_500_000_000n,
        tokenAmountUnits: 10_000n,
        trader: "trader1",
        timeMs: 4000,
      }),
    );
    return tracker.getStats();
  };

  const r1 = run();
  const r2 = run();
  assert.deepEqual(r1, r2);
});
