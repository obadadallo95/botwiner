import test from "node:test";
import assert from "node:assert/strict";
import {
  auditGraduationFlow,
  auditPostLaunchDumpRebound,
  auditSurvivorMomentum,
  computePivotComparisonReport,
  PIVOT_SCORE_DIMENSIONS,
} from "@botwiner/research";
import type { RawParsedMarketEvent } from "@botwiner/research";

function createMockTrade(options: {
  mint: string;
  unixMs: number;
  side: "buy" | "sell";
  realSolLamports?: string;
  virtualSolLamports?: string;
  virtualTokenBaseUnits?: string;
  traderWallet?: string;
}): RawParsedMarketEvent {
  return {
    eventType: "trade",
    tokenMint: options.mint,
    side: options.side,
    traderWallet: options.traderWallet ?? "mock-trader-wallet",
    timestamps: { collectorReceivedAtUnixMs: options.unixMs },
    reserves: {
      realSolLamports: options.realSolLamports ?? "1000000000",
      virtualSolLamports: options.virtualSolLamports ?? "31000000000",
      virtualTokenBaseUnits: options.virtualTokenBaseUnits ?? "1000000000000000",
    },
  };
}

test("Graduation audit classifies instant bundle vs organic progression and reports sufficiency", () => {
  const mintTrades = new Map<string, RawParsedMarketEvent[]>();
  const launchTimes = new Map<string, number>();

  // Token 1: Instant bundle graduation (hits 85 SOL in 1 trade at t=0)
  mintTrades.set("mint-instant", [
    createMockTrade({
      mint: "mint-instant",
      unixMs: 1_000_000,
      side: "buy",
      realSolLamports: "85000000000", // 85 SOL
    }),
  ]);
  launchTimes.set("mint-instant", 1_000_000);

  // Token 2: Low reserves (< 5 SOL)
  mintTrades.set("mint-low", [
    createMockTrade({
      mint: "mint-low",
      unixMs: 1_000_000,
      side: "buy",
      realSolLamports: "2000000000", // 2 SOL
    }),
  ]);
  launchTimes.set("mint-low", 1_000_000);

  const audit = auditGraduationFlow(mintTrades, launchTimes);

  assert.equal(audit.totalTokensTracked, 2);
  assert.equal(audit.tokensReaching80Sol, 1);
  assert.equal(audit.instantBundleGraduations, 1);
  assert.equal(audit.organicGraduations, 0);
  assert.equal(audit.maxRealSolObserved, 85);
  assert.equal(audit.dataSufficiency, "insufficient");
});

test("Post-Launch Dump Rebound audit identifies drawdowns, rebounds, and timing", () => {
  const mintTrades = new Map<string, RawParsedMarketEvent[]>();
  const launchTimes = new Map<string, number>();
  const baseTime = 1_000_000;

  // Token: Launches at baseTime
  // Peak at 10s: vSol=60, vToken=1e15 (price = 6e-14)
  // Dump at 40s: vSol=35, vToken=1e15 (price = 3.5e-14) -> -41.7% drawdown (>= -30%)
  // Rebound at 50s: vSol=45, vToken=1e15 (price = 4.5e-14) -> +28.6% rebound from trough
  const trades: RawParsedMarketEvent[] = [
    createMockTrade({ mint: "m-rebound", unixMs: baseTime + 1_000, side: "buy", virtualSolLamports: "30000000000" }),
    createMockTrade({ mint: "m-rebound", unixMs: baseTime + 5_000, side: "buy", virtualSolLamports: "45000000000" }),
    createMockTrade({ mint: "m-rebound", unixMs: baseTime + 10_000, side: "buy", virtualSolLamports: "60000000000" }),
    createMockTrade({ mint: "m-rebound", unixMs: baseTime + 25_000, side: "sell", virtualSolLamports: "45000000000" }),
    createMockTrade({ mint: "m-rebound", unixMs: baseTime + 40_000, side: "sell", virtualSolLamports: "35000000000" }), // trough
    createMockTrade({ mint: "m-rebound", unixMs: baseTime + 50_000, side: "buy", virtualSolLamports: "45000000000" }),  // rebound (+28.6%)
  ];

  mintTrades.set("m-rebound", trades);
  launchTimes.set("m-rebound", baseTime);

  const audit = auditPostLaunchDumpRebound(launchTimes, mintTrades);

  assert.equal(audit.tokensWithEarlyPeak, 1);
  assert.equal(audit.tokensWithMajorDrawdown, 1);
  assert.equal(audit.rebound10Count, 1);
  assert.equal(audit.rebound20Count, 1);
  assert.equal(audit.reboundRate20Pct, 100);
  assert.equal(audit.dyingCount, 0);
  assert.equal(audit.medianTimeToTroughSec, 40);
  assert.equal(audit.medianTimeToReboundSec, 10);
});

test("Survivor Momentum audit evaluates survival and forward returns", () => {
  const mintTrades = new Map<string, RawParsedMarketEvent[]>();
  const launchTimes = new Map<string, number>();
  const baseTime = 1_000_000;

  // Token 1: Momentum winner (30s price 40 SOL, 90s price 60 SOL)
  const tradesWinner: RawParsedMarketEvent[] = [
    createMockTrade({ mint: "m-win", unixMs: baseTime + 10_000, side: "buy", traderWallet: "w1" }),
    createMockTrade({ mint: "m-win", unixMs: baseTime + 15_000, side: "buy", traderWallet: "w2" }),
    createMockTrade({ mint: "m-win", unixMs: baseTime + 20_000, side: "buy", traderWallet: "w3" }),
    createMockTrade({ mint: "m-win", unixMs: baseTime + 25_000, side: "buy", traderWallet: "w4" }),
    createMockTrade({ mint: "m-win", unixMs: baseTime + 30_000, side: "buy", traderWallet: "w5", virtualSolLamports: "40000000000" }),
    createMockTrade({ mint: "m-win", unixMs: baseTime + 90_000, side: "buy", traderWallet: "w6", virtualSolLamports: "60000000000" }),
    createMockTrade({ mint: "m-win", unixMs: baseTime + 130_000, side: "buy", traderWallet: "w7" }),
  ];
  mintTrades.set("m-win", tradesWinner);
  launchTimes.set("m-win", baseTime);

  // Token 2: Momentum bleeder (30s price 50 SOL, 90s price 32 SOL)
  const tradesLoser: RawParsedMarketEvent[] = [
    createMockTrade({ mint: "m-lose", unixMs: baseTime + 10_000, side: "buy", traderWallet: "w1" }),
    createMockTrade({ mint: "m-lose", unixMs: baseTime + 30_000, side: "buy", traderWallet: "w2", virtualSolLamports: "50000000000" }),
    createMockTrade({ mint: "m-lose", unixMs: baseTime + 90_000, side: "sell", traderWallet: "w3", virtualSolLamports: "32000000000" }),
  ];
  mintTrades.set("m-lose", tradesLoser);
  launchTimes.set("m-lose", baseTime);

  const audit = auditSurvivorMomentum(launchTimes, mintTrades);

  assert.equal(audit.tokensAliveAt30s, 2);
  assert.equal(audit.tokensAliveAt60s, 2);
  assert.equal(audit.tokensAliveAt120s, 1);
  assert.equal(audit.unconditionedEvaluated30to90, 2);
  assert.equal(audit.unconditionedPositiveFwd30to90, 1);
  assert.equal(audit.unconditionedWinRatePct, 50);

  // Token 1 meets conditioned requirements (>= 5 unique buyers, buys > sells)
  assert.equal(audit.conditionedEvaluated30to90, 1);
  assert.equal(audit.conditionedPositiveFwd30to90, 1);
  assert.equal(audit.conditionedWinRatePct, 100);
});

test("Pivot comparison report aggregates dimension scores and ranks pivots correctly", () => {
  assert.equal(PIVOT_SCORE_DIMENSIONS.length, 10);

  const mockGraduation = {
    totalTokensTracked: 100,
    tokensReaching80Sol: 1,
    instantBundleGraduations: 1,
    organicGraduations: 0,
    maxRealSolObserved: 85,
    dataSufficiency: "insufficient" as const,
  };

  const mockRebound = {
    tokensWithEarlyPeak: 100,
    tokensWithMajorDrawdown: 50,
    rebound10Count: 25,
    rebound20Count: 20,
    rebound50Count: 15,
    dyingCount: 25,
    reboundRate20Pct: 40,
    medianTimeToTroughSec: 60,
    medianTimeToReboundSec: 5,
    dataSufficiency: "sufficient" as const,
  };

  const mockMomentum = {
    tokensAliveAt30s: 80,
    tokensAliveAt60s: 60,
    tokensAliveAt120s: 40,
    unconditionedPositiveFwd30to90: 10,
    unconditionedEvaluated30to90: 40,
    unconditionedWinRatePct: 25,
    conditionedPositiveFwd30to90: 5,
    conditionedEvaluated30to90: 20,
    conditionedWinRatePct: 25,
    dataSufficiency: "sufficient" as const,
  };

  const report = computePivotComparisonReport("dummy-path", mockGraduation, mockRebound, mockMomentum);

  assert.equal(report.decisionGate, "POST-DUMP REBOUND FIRST");
  assert.equal(report.ranking[0]?.pivot, "rebound");
  assert.equal(report.ranking[1]?.pivot, "graduation");
  assert.equal(report.ranking[2]?.pivot, "momentum");
  assert.ok(report.ranking[0].overallScore > report.ranking[1].overallScore);
  assert.ok(report.ranking[1].overallScore > report.ranking[2].overallScore);
});
