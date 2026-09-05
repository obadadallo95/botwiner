import test from "node:test";
import assert from "node:assert/strict";
import {
  PaperTradingEngine,
  PAPER_STRATEGY_DEFINITION,
} from "../packages/research/src/paper-trading-engine.js";
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

test("PaperTradingEngine - No entry below 50 SOL", () => {
  const engine = new PaperTradingEngine();
  const mint = "mintBelow50";
  engine.onLaunch(createMockLaunch(mint, "creator1", 1000));

  for (let i = 1; i <= 6; i++) {
    engine.onTrade(
      createMockTrade({
        mint,
        side: "buy",
        realSolLamports: BigInt(i * 5_000_000_000), // up to 30 SOL
        timeMs: 1000 + i * 2000,
      }),
    );
  }

  assert.equal(engine.getOpenPositions().length, 0);
  assert.equal(engine.getStats().entriesTriggered, 0);
});

test("PaperTradingEngine - Rejects entry if token age < 5s at 50 SOL crossing", () => {
  const engine = new PaperTradingEngine();
  const mint = "mintYoung";
  engine.onLaunch(createMockLaunch(mint, "creator1", 1000));

  // 5 trades in only 3 seconds
  for (let i = 1; i <= 4; i++) {
    engine.onTrade(
      createMockTrade({
        mint,
        side: "buy",
        realSolLamports: BigInt(i * 10_000_000_000),
        timeMs: 1000 + i * 500,
      }),
    );
  }
  // Crosses 50 SOL at t=3500 (age = 2.5s < 5s)
  engine.onTrade(
    createMockTrade({
      mint,
      side: "buy",
      realSolLamports: 51_000_000_000n,
      timeMs: 3500,
    }),
  );

  assert.equal(engine.getOpenPositions().length, 0);
});

test("PaperTradingEngine - Rejects entry if trade count < 5 at 50 SOL crossing", () => {
  const engine = new PaperTradingEngine();
  const mint = "mintFewTrades";
  engine.onLaunch(createMockLaunch(mint, "creator1", 1000));

  // Only 2 trades, large buy crossing 50 SOL at t=7000 (age = 6s)
  engine.onTrade(
    createMockTrade({
      mint,
      side: "buy",
      realSolLamports: 20_000_000_000n,
      timeMs: 4000,
    }),
  );
  engine.onTrade(
    createMockTrade({
      mint,
      side: "buy",
      realSolLamports: 52_000_000_000n,
      timeMs: 7000,
    }),
  );

  assert.equal(engine.getOpenPositions().length, 0);
});

test("PaperTradingEngine - First causal >= 50 SOL crossing triggers entry with exact size and cost model", () => {
  const engine = new PaperTradingEngine();
  const mint = "mintOrganic50";
  engine.onLaunch(createMockLaunch(mint, "creator1", 1000));

  // 4 pre-trades building volume across slots
  for (let i = 1; i <= 4; i++) {
    engine.onTrade(
      createMockTrade({
        mint,
        side: "buy",
        realSolLamports: BigInt(i * 10_000_000_000),
        timeMs: 1000 + i * 1500,
        slot: 100 + i,
      }),
    );
  }

  // 5th trade crosses 50 SOL at t=8000 (age = 7s >= 5s, trades = 5 >= 5)
  engine.onTrade(
    createMockTrade({
      mint,
      side: "buy",
      realSolLamports: 50_500_000_000n,
      timeMs: 8000,
      slot: 106,
    }),
  );

  const openPositions = engine.getOpenPositions();
  assert.equal(openPositions.length, 1);
  const pos = openPositions[0]!;
  assert.equal(pos.mint, mint);
  assert.equal(pos.status, "open");
  assert.equal(pos.curveSolInputLamports, 100_000_000n); // 0.10 SOL
  assert.equal(pos.entryPumpFeeLamports, 1_000_000n); // 1%
  assert.equal(pos.entryTxCostLamports, 55_000n); // 5k base + 50k priority
  assert.equal(pos.totalWalletOutflowLamports, 101_055_000n);
  assert.ok(pos.tokenQuantity > 0n);

  // Subsequent trades above 50 SOL must NOT open duplicate position
  engine.onTrade(
    createMockTrade({
      mint,
      side: "buy",
      realSolLamports: 52_000_000_000n,
      timeMs: 9000,
      slot: 107,
    }),
  );
  assert.equal(engine.getOpenPositions().length, 1);
});

test("PaperTradingEngine - Executable Take-Profit (+30% net) trigger", () => {
  const engine = new PaperTradingEngine();
  const mint = "mintTP";
  engine.onLaunch(createMockLaunch(mint, "creator1", 1000));

  for (let i = 1; i <= 5; i++) {
    engine.onTrade(
      createMockTrade({
        mint,
        side: "buy",
        realSolLamports: BigInt(i * 10_000_000_000),
        timeMs: 1000 + i * 1500,
        slot: 100 + i,
      }),
    );
  }

  assert.equal(engine.getOpenPositions().length, 1);

  // Subsequent heavy buying drives reserves up significantly (from 50 to 75 SOL)
  engine.onTrade(
    createMockTrade({
      mint,
      side: "buy",
      realSolLamports: 75_000_000_000n,
      timeMs: 12_000,
      slot: 110,
    }),
  );

  // Position should have triggered TP
  const closed = engine.getClosedTrades();
  assert.equal(closed.length, 1);
  const closedTrade = closed[0]!;
  assert.equal(closedTrade.exitReason, "take-profit");
  assert.equal(closedTrade.status, "take-profit");
  assert.ok(closedTrade.netReturnPct! >= 30.0);
  assert.ok(closedTrade.netPnlLamports! > 0n);
  assert.equal(engine.getOpenPositions().length, 0);
});

test("PaperTradingEngine - Executable Stop-Loss (-20% net) trigger", () => {
  const engine = new PaperTradingEngine();
  const mint = "mintSL";
  engine.onLaunch(createMockLaunch(mint, "creator1", 1000));

  for (let i = 1; i <= 5; i++) {
    engine.onTrade(
      createMockTrade({
        mint,
        side: "buy",
        realSolLamports: BigInt(i * 10_000_000_000),
        timeMs: 1000 + i * 1500,
        slot: 100 + i,
      }),
    );
  }

  assert.equal(engine.getOpenPositions().length, 1);

  // Heavy dump collapses reserves from 50 SOL to 35 SOL
  engine.onTrade(
    createMockTrade({
      mint,
      side: "sell",
      realSolLamports: 35_000_000_000n,
      timeMs: 12_000,
      slot: 110,
    }),
  );

  const closed = engine.getClosedTrades();
  assert.equal(closed.length, 1);
  const closedTrade = closed[0]!;
  assert.equal(closedTrade.exitReason, "stop-loss");
  assert.equal(closedTrade.status, "stop-loss");
  assert.ok(closedTrade.netReturnPct! <= -20.0);
  assert.ok(closedTrade.netPnlLamports! < 0n);
});

test("PaperTradingEngine - Timeout (5 minutes) exit", () => {
  const engine = new PaperTradingEngine();
  const mint = "mintTimeout";
  engine.onLaunch(createMockLaunch(mint, "creator1", 1000));

  for (let i = 1; i <= 5; i++) {
    engine.onTrade(
      createMockTrade({
        mint,
        side: "buy",
        realSolLamports: BigInt(i * 10_000_000_000),
        timeMs: 1000 + i * 1500,
        slot: 100 + i,
      }),
    );
  }

  assert.equal(engine.getOpenPositions().length, 1);

  // Next trade occurs 305 seconds later with flat price
  engine.onTrade(
    createMockTrade({
      mint,
      side: "buy",
      realSolLamports: 50_200_000_000n,
      timeMs: 8500 + 305_000,
      slot: 200,
    }),
  );

  const closed = engine.getClosedTrades();
  assert.equal(closed.length, 1);
  const closedTrade = closed[0]!;
  assert.equal(closedTrade.exitReason, "timeout");
  assert.equal(closedTrade.status, "timeout");
  assert.ok(closedTrade.holdDurationSec! >= 300);
});

test("PaperTradingEngine - Curve completion migration-exit-unresolved handling", () => {
  const engine = new PaperTradingEngine();
  const mint = "mintMigration";
  engine.onLaunch(createMockLaunch(mint, "creator1", 1000));

  for (let i = 1; i <= 5; i++) {
    engine.onTrade(
      createMockTrade({
        mint,
        side: "buy",
        realSolLamports: 85_000_000_000n,
        timeMs: 1000 + i * 1500,
        slot: 100 + i,
      }),
    );
  }

  assert.equal(engine.getOpenPositions().length, 0);
});

test("PaperTradingEngine - Session end censors open positions and excludes from closed win rate", () => {
  const engine = new PaperTradingEngine();
  const mint = "mintCensored";
  engine.onLaunch(createMockLaunch(mint, "creator1", 1000));

  for (let i = 1; i <= 5; i++) {
    engine.onTrade(
      createMockTrade({
        mint,
        side: "buy",
        realSolLamports: BigInt(i * 10_000_000_000),
        timeMs: 1000 + i * 1500,
        slot: 100 + i,
      }),
    );
  }

  assert.equal(engine.getOpenPositions().length, 1);

  engine.onSessionEnd(20_000);

  const censored = engine.getCensoredTrades();
  assert.equal(censored.length, 1);
  assert.equal(censored[0]!.status, "session-censored");
  assert.equal(engine.getOpenPositions().length, 0);
  assert.equal(engine.getClosedTrades().length, 0);

  const stats = engine.getStats();
  assert.equal(stats.censoredPositions, 1);
  assert.equal(stats.closedPositions, 0);
  assert.equal(stats.winRatePct, 0);
});

test("PaperTradingEngine - Deterministic replay gives identical results", () => {
  const runSimulation = () => {
    const engine = new PaperTradingEngine();
    const mint = "mintDeterministic";
    engine.onLaunch(createMockLaunch(mint, "creator1", 1000));

    for (let i = 1; i <= 5; i++) {
      engine.onTrade(
        createMockTrade({
          mint,
          side: "buy",
          realSolLamports: BigInt(i * 10_000_000_000),
          timeMs: 1000 + i * 1500,
          slot: 100 + i,
        }),
      );
    }
    // TP exit
    engine.onTrade(
      createMockTrade({
        mint,
        side: "buy",
        realSolLamports: 75_000_000_000n,
        timeMs: 12_000,
        slot: 110,
      }),
    );
    return engine.getStats();
  };

  const run1 = runSimulation();
  const run2 = runSimulation();

  assert.deepEqual(run1, run2);
});

test("PaperTradingEngine - Canonical PAPER_STRATEGY_DEFINITION matches frozen rule", () => {
  assert.equal(PAPER_STRATEGY_DEFINITION.strategyId, "organic-50sol-continuation-v1");
  assert.equal(PAPER_STRATEGY_DEFINITION.thesis, "Graduation / Curve-Progress Momentum");
  assert.equal(PAPER_STRATEGY_DEFINITION.entryTrigger.launchObservedInSession, true);
  assert.equal(PAPER_STRATEGY_DEFINITION.entryTrigger.minRealSolLamports, 50_000_000_000n);
  assert.equal(PAPER_STRATEGY_DEFINITION.entryTrigger.minAgeMs, 5000);
  assert.equal(PAPER_STRATEGY_DEFINITION.entryTrigger.minTradeCount, 5);
  assert.equal(PAPER_STRATEGY_DEFINITION.entryTrigger.disallowSameSlotBundle, true);
  assert.equal(PAPER_STRATEGY_DEFINITION.entryTrigger.hasReboundFilter, false);
  assert.equal(PAPER_STRATEGY_DEFINITION.entryTrigger.hasSellVolumeFilter, false);
  assert.equal(PAPER_STRATEGY_DEFINITION.entryTrigger.hasHigherLowFilter, false);

  const engine = new PaperTradingEngine();
  const stats = engine.getStats();
  assert.equal(stats.strategyId, "organic-50sol-continuation-v1");
  assert.equal(stats.strategyDefinition?.strategyId, "organic-50sol-continuation-v1");
});

test("PaperTradingEngine - Boundary test: 4999ms age rejects entry, 5000ms age triggers entry", () => {
  // Case A: 4999ms age -> Reject
  const engineA = new PaperTradingEngine();
  const mintA = "mint4999ms";
  engineA.onLaunch(createMockLaunch(mintA, "creatorA", 1000));
  for (let i = 1; i <= 4; i++) {
    engineA.onTrade(
      createMockTrade({
        mint: mintA,
        side: "buy",
        realSolLamports: BigInt(i * 10_000_000_000),
        timeMs: 1000 + i * 1000, // 2000, 3000, 4000, 5000
        slot: 100 + i,
      }),
    );
  }
  // 5th trade crosses 50 SOL at t=5999 (age = 4999ms)
  engineA.onTrade(
    createMockTrade({
      mint: mintA,
      side: "buy",
      realSolLamports: 50_100_000_000n,
      timeMs: 5999,
      slot: 105,
    }),
  );
  assert.equal(engineA.getOpenPositions().length, 0);

  // Case B: 5000ms age -> Trigger
  const engineB = new PaperTradingEngine();
  const mintB = "mint5000ms";
  engineB.onLaunch(createMockLaunch(mintB, "creatorB", 1000));
  for (let i = 1; i <= 4; i++) {
    engineB.onTrade(
      createMockTrade({
        mint: mintB,
        side: "buy",
        realSolLamports: BigInt(i * 10_000_000_000),
        timeMs: 1000 + i * 1000,
        slot: 100 + i,
      }),
    );
  }
  // 5th trade crosses 50 SOL at t=6000 (age = 5000ms)
  engineB.onTrade(
    createMockTrade({
      mint: mintB,
      side: "buy",
      realSolLamports: 50_100_000_000n,
      timeMs: 6000,
      slot: 105,
    }),
  );
  assert.equal(engineB.getOpenPositions().length, 1);
  assert.equal(engineB.getOpenPositions()[0]?.mint, mintB);
});

test("PaperTradingEngine - Boundary test: 4 trades rejects entry, 5 trades triggers entry", () => {
  // Case A: 4 trades at t=7000 (age 6s >= 5s) -> Reject
  const engineA = new PaperTradingEngine();
  const mintA = "mint4Trades";
  engineA.onLaunch(createMockLaunch(mintA, "creatorA", 1000));
  for (let i = 1; i <= 3; i++) {
    engineA.onTrade(
      createMockTrade({
        mint: mintA,
        side: "buy",
        realSolLamports: BigInt(i * 15_000_000_000),
        timeMs: 1000 + i * 1500,
        slot: 100 + i,
      }),
    );
  }
  // 4th trade crosses 50 SOL at t=7000
  engineA.onTrade(
    createMockTrade({
      mint: mintA,
      side: "buy",
      realSolLamports: 50_500_000_000n,
      timeMs: 7000,
      slot: 104,
    }),
  );
  assert.equal(engineA.getOpenPositions().length, 0);

  // Case B: 5th trade crosses 50 SOL at t=7500 -> Trigger
  const engineB = new PaperTradingEngine();
  const mintB = "mint5Trades";
  engineB.onLaunch(createMockLaunch(mintB, "creatorB", 1000));
  for (let i = 1; i <= 4; i++) {
    engineB.onTrade(
      createMockTrade({
        mint: mintB,
        side: "buy",
        realSolLamports: BigInt(i * 10_000_000_000),
        timeMs: 1000 + i * 1500,
        slot: 100 + i,
      }),
    );
  }
  // 5th trade crosses 50 SOL at t=7500
  engineB.onTrade(
    createMockTrade({
      mint: mintB,
      side: "buy",
      realSolLamports: 50_500_000_000n,
      timeMs: 7500,
      slot: 105,
    }),
  );
  assert.equal(engineB.getOpenPositions().length, 1);
});

test("PaperTradingEngine - Verified absence of rebound or sell volume filters", () => {
  // Heavy selling (sell volume > 80% of buy volume) does NOT prevent entry
  const engine = new PaperTradingEngine();
  const mint = "mintHighSellVol";
  engine.onLaunch(createMockLaunch(mint, "creator1", 1000));

  // Trade 1: Buy to 30 SOL
  engine.onTrade(
    createMockTrade({
      mint,
      side: "buy",
      realSolLamports: 30_000_000_000n,
      solAmountLamports: 30_000_000_000n,
      timeMs: 2000,
      slot: 101,
    }),
  );
  // Trade 2: Heavy sell down to 10 SOL (20 SOL sell volume)
  engine.onTrade(
    createMockTrade({
      mint,
      side: "sell",
      realSolLamports: 10_000_000_000n,
      solAmountLamports: 20_000_000_000n,
      timeMs: 3000,
      slot: 102,
    }),
  );
  // Trade 3: Buy to 25 SOL
  engine.onTrade(
    createMockTrade({
      mint,
      side: "buy",
      realSolLamports: 25_000_000_000n,
      solAmountLamports: 15_000_000_000n,
      timeMs: 4000,
      slot: 103,
    }),
  );
  // Trade 4: Sell to 15 SOL
  engine.onTrade(
    createMockTrade({
      mint,
      side: "sell",
      realSolLamports: 15_000_000_000n,
      solAmountLamports: 10_000_000_000n,
      timeMs: 5000,
      slot: 104,
    }),
  );
  // Trade 5: Buy crossing 50 SOL (age = 7000ms >= 5000ms, trade count = 5)
  // Total sell volume is 30 SOL vs 85 SOL buy (35% > 30%)
  engine.onTrade(
    createMockTrade({
      mint,
      side: "buy",
      realSolLamports: 51_000_000_000n,
      solAmountLamports: 36_000_000_000n,
      timeMs: 8000,
      slot: 105,
    }),
  );

  // Position MUST open because organic-50sol-continuation-v1 has NO sell volume or rebound filter
  assert.equal(engine.getOpenPositions().length, 1);
  assert.equal(engine.getOpenPositions()[0]?.mint, mint);
});
