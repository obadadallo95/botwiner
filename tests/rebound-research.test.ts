import test from "node:test";
import assert from "node:assert/strict";
import {
  auditReboundPopulation,
  computeCausalTrajectoryStates,
  simulateReboundTrade,
  evaluateReboundAcrossSplits,
  quotePumpBuy,
  quotePumpSell,
  selectBestTrainValRule,
  PREDEFINED_REBOUND_RULES,
  PREDEFINED_EXIT_POLICIES,
  STANDARD_COST_SCENARIOS,
} from "@botwiner/research";
import type {
  RawParsedMarketEvent,
  CausalTrajectoryState,
  ReboundEvaluationSummary,
} from "@botwiner/research";

function createMockEvent(options: {
  mint: string;
  unixMs: number;
  side: "buy" | "sell";
  realSolLamports?: string;
  virtualSolLamports?: string;
  virtualTokenBaseUnits?: string;
  traderWallet?: string;
  creatorWallet?: string;
  solAmount?: number;
}): RawParsedMarketEvent {
  const solLamports = options.solAmount !== undefined ? String(Math.round(options.solAmount * 1e9)) : "100000000";
  return {
    eventType: "trade",
    tokenMint: options.mint,
    side: options.side,
    traderWallet: options.traderWallet ?? "trader-1",
    creatorWallet: options.creatorWallet ?? "creator-wallet",
    timestamps: { collectorReceivedAtUnixMs: options.unixMs },
    amounts: {
      nativeSolLamports: solLamports,
      quoteBaseUnits: solLamports,
      tokenBaseUnits: "1000000000000",
    },
    reserves: {
      realSolLamports: options.realSolLamports ?? "1000000000",
      virtualSolLamports: options.virtualSolLamports ?? "31000000000",
      virtualTokenBaseUnits: options.virtualTokenBaseUnits ?? "1000000000000000",
    },
  };
}

test("Running-peak, causal drawdown, and no-future-trough leakage prevention", () => {
  const baseTime = 1_000_000;
  const mint = "m-peak-test";

  // Trades progression:
  // t=0: Price = 30 / 1000 = 0.030
  // t=10s: Price = 60 / 1000 = 0.060 (Peak)
  // t=20s: Price = 45 / 1000 = 0.045 (Drawdown: -25%)
  // t=30s: Price = 36 / 1000 = 0.036 (Drawdown: -40%)
  // t=40s: Price = 30 / 1000 = 0.030 (Future Trough: -50%)
  // t=50s: Price = 45 / 1000 = 0.045 (Future Rebound)
  const trades: RawParsedMarketEvent[] = [
    createMockEvent({ mint, unixMs: baseTime, side: "buy", virtualSolLamports: "30000000000" }),
    createMockEvent({ mint, unixMs: baseTime + 10_000, side: "buy", virtualSolLamports: "60000000000" }),
    createMockEvent({ mint, unixMs: baseTime + 20_000, side: "sell", virtualSolLamports: "45000000000" }),
    createMockEvent({ mint, unixMs: baseTime + 30_000, side: "sell", virtualSolLamports: "36000000000" }),
    createMockEvent({ mint, unixMs: baseTime + 40_000, side: "sell", virtualSolLamports: "30000000000" }),
    createMockEvent({ mint, unixMs: baseTime + 50_000, side: "buy", virtualSolLamports: "45000000000" }),
  ];

  const states = computeCausalTrajectoryStates(mint, baseTime, trades, baseTime + 120_000);

  // At t=30s, running peak must be 60e9 / 1e15, NOT future prices
  const state30s = states[3]!;
  assert.equal(state30s.timeSinceLaunchSec, 30);
  assert.equal(state30s.runningPeakPrice, 60_000_000_000 / 1_000_000_000_000_000);
  assert.equal(state30s.currentDrawdownPct, -40);

  // Causal local low at t=30s must be 36e9 / 1e15, NOT the future t=40s trough (30e9 / 1e15)
  assert.equal(state30s.localLowPrice, 36_000_000_000 / 1_000_000_000_000_000);
});

test("No-new-low window, sell-rate decay, and buy absorption calculation", () => {
  const baseTime = 1_000_000;
  const mint = "m-decay-test";

  // Trades:
  // t=0 to 10s: 5 sells (1 SOL each)
  // t=11 to 20s: 1 sell (0.2 SOL) -> sell rate decayed from 5 to 1 (0.2 ratio), vol decayed by 80%
  // t=21s, 22s: 2 buys -> buy absorption
  const trades: RawParsedMarketEvent[] = [
    createMockEvent({ mint, unixMs: baseTime + 10_000, side: "buy", virtualSolLamports: "60000000000" }), // peak
    // prior 10s window (t=15s to 25s): 4 sells
    createMockEvent({ mint, unixMs: baseTime + 16_000, side: "sell", solAmount: 1.0, virtualSolLamports: "55000000000" }),
    createMockEvent({ mint, unixMs: baseTime + 18_000, side: "sell", solAmount: 1.0, virtualSolLamports: "50000000000" }),
    createMockEvent({ mint, unixMs: baseTime + 20_000, side: "sell", solAmount: 1.0, virtualSolLamports: "45000000000" }),
    createMockEvent({ mint, unixMs: baseTime + 22_000, side: "sell", solAmount: 1.0, virtualSolLamports: "40000000000" }),
    // latest 10s window (t=26s to 35s): 1 small sell at t=28s, then 2 buys at t=33s and t=34s
    createMockEvent({ mint, unixMs: baseTime + 28_000, side: "sell", solAmount: 0.2, virtualSolLamports: "38000000000" }),
    createMockEvent({ mint, unixMs: baseTime + 33_000, side: "buy", solAmount: 0.5, virtualSolLamports: "39000000000" }),
    createMockEvent({ mint, unixMs: baseTime + 34_000, side: "buy", solAmount: 0.5, virtualSolLamports: "40000000000" }),
  ];

  const states = computeCausalTrajectoryStates(mint, baseTime, trades, baseTime + 120_000);
  const lastState = states[states.length - 1]!;

  assert.equal(lastState.sellsCountPrior10s, 4);
  assert.equal(lastState.sellsCountTrailing10s, 1);
  assert.equal(lastState.sellRateDecayRatio, 0.25);
  assert.ok(lastState.sellVolDecayPct >= 80);
  assert.equal(lastState.buysCountTrailing5s, 2);
  assert.equal(lastState.consecutiveBuysCount, 2);
});

test("Entry timestamp first-trigger semantics and bonding-curve fill execution", () => {
  const baseTime = 1_000_000;
  const mint = "m-entry-test";

  const trades: RawParsedMarketEvent[] = [
    createMockEvent({ mint, unixMs: baseTime, side: "buy", virtualSolLamports: "30000000000" }),
    createMockEvent({ mint, unixMs: baseTime + 10_000, side: "buy", virtualSolLamports: "60000000000" }), // Peak
    createMockEvent({ mint, unixMs: baseTime + 20_000, side: "sell", virtualSolLamports: "40000000000" }), // -33.3% dd (Rule baseline 1 trigger)
    createMockEvent({ mint, unixMs: baseTime + 25_000, side: "sell", virtualSolLamports: "35000000000" }), // Deeper
    createMockEvent({ mint, unixMs: baseTime + 30_000, side: "buy", virtualSolLamports: "45000000000" }),  // Rebound
  ];

  const states = computeCausalTrajectoryStates(mint, baseTime, trades, baseTime + 120_000);
  const ruleBaseline1 = PREDEFINED_REBOUND_RULES[0]!; // Blind buy at -30%
  const exitPolicy = PREDEFINED_EXIT_POLICIES[0]!;    // Time exit 10s

  const exec = simulateReboundTrade(states, ruleBaseline1, exitPolicy, 0.05, STANDARD_COST_SCENARIOS.zero);

  assert.ok(exec !== null);
  // Must trigger at t=20s (first time dd <= -30%)
  assert.equal(exec.signalTimestampMs, baseTime + 20_000);
  assert.equal(exec.entryTimestampMs, baseTime + 20_000);
  // Entry reserves must match state at t=20s
  assert.equal(exec.entryVirtualSol, 40000000000n);
  assert.ok(exec.tokensReceived > 0n);
});

test("Latency delay injection shifts execution timestamp and entry reserves", () => {
  const baseTime = 1_000_000;
  const mint = "m-delay-test";

  const trades: RawParsedMarketEvent[] = [
    createMockEvent({ mint, unixMs: baseTime, side: "buy", virtualSolLamports: "30000000000" }),
    createMockEvent({ mint, unixMs: baseTime + 10_000, side: "buy", virtualSolLamports: "60000000000" }), // Peak
    createMockEvent({ mint, unixMs: baseTime + 20_000, side: "sell", virtualSolLamports: "40000000000" }), // Trigger at 20s
    createMockEvent({ mint, unixMs: baseTime + 21_000, side: "sell", virtualSolLamports: "38000000000" }), // +1s trade
    createMockEvent({ mint, unixMs: baseTime + 22_000, side: "buy", virtualSolLamports: "44000000000" }),  // +2s trade
  ];

  const states = computeCausalTrajectoryStates(mint, baseTime, trades, baseTime + 120_000);
  const rule = PREDEFINED_REBOUND_RULES[0]!;
  const exitPolicy = PREDEFINED_EXIT_POLICIES[0]!;

  // With 0ms delay: enters at t=20s (vSol = 40)
  const exec0ms = simulateReboundTrade(states, rule, exitPolicy, 0.05, STANDARD_COST_SCENARIOS.zero, 0);
  assert.equal(exec0ms?.entryTimestampMs, baseTime + 20_000);
  assert.equal(exec0ms?.entryVirtualSol, 40000000000n);

  // With 1000ms delay: enters at t=21s (vSol = 38)
  const exec1000ms = simulateReboundTrade(states, rule, exitPolicy, 0.05, STANDARD_COST_SCENARIOS.zero, 1_000);
  assert.equal(exec1000ms?.entryTimestampMs, baseTime + 21_000);
  assert.equal(exec1000ms?.entryVirtualSol, 38000000000n);

  // With 2000ms delay: enters at t=22s (vSol = 44)
  const exec2000ms = simulateReboundTrade(states, rule, exitPolicy, 0.05, STANDARD_COST_SCENARIOS.zero, 2_000);
  assert.equal(exec2000ms?.entryTimestampMs, baseTime + 22_000);
  assert.equal(exec2000ms?.entryVirtualSol, 44000000000n);
});

test("Right-censoring audit: trades reaching dataset boundary without exit are excluded from completed PnL", () => {
  const baseTime = 1_000_000;
  const mint = "m-censored";
  const datasetEndMs = baseTime + 30_000; // Dataset ends 30s after launch

  const trades: RawParsedMarketEvent[] = [
    createMockEvent({ mint, unixMs: baseTime, side: "buy", virtualSolLamports: "30000000000" }),
    createMockEvent({ mint, unixMs: baseTime + 10_000, side: "buy", virtualSolLamports: "60000000000" }),
    createMockEvent({ mint, unixMs: baseTime + 20_000, side: "sell", virtualSolLamports: "40000000000" }), // Trigger at 20s
    createMockEvent({ mint, unixMs: baseTime + 25_000, side: "sell", virtualSolLamports: "38000000000" }),
  ];

  const states = computeCausalTrajectoryStates(mint, baseTime, trades, datasetEndMs);
  const rule = PREDEFINED_REBOUND_RULES[0]!;
  // Policy requires 60s hold, but only 10s remain in dataset (t=20s to t=30s)
  const exitPolicy60s: (typeof PREDEFINED_EXIT_POLICIES)[0] = {
    name: "Time Exit 60s",
    maxHoldDurationMs: 60_000,
  };

  const exec = simulateReboundTrade(
    states,
    rule,
    exitPolicy60s,
    0.05,
    STANDARD_COST_SCENARIOS.medium,
    0,
    datasetEndMs,
  );

  assert.ok(exec !== null);
  assert.equal(exec.isRightCensored, true);
  assert.equal(exec.exitReason, "dataset-boundary-censored");

  // In split evaluation, censored trades must be accounted in censoredTrades and excluded from completedTrades
  const summaries = evaluateReboundAcrossSplits(
    [{ mint, states, launchMs: baseTime }],
    rule,
    exitPolicy60s,
    0.05,
    STANDARD_COST_SCENARIOS.medium,
    0,
    datasetEndMs,
  );
  const comb = summaries.find((s) => s.split === "combined")!;
  assert.equal(comb.selectedTrades, 1);
  assert.equal(comb.censoredTrades, 1);
  assert.equal(comb.datasetBoundaryCensoredTrades, 1);
  assert.equal(comb.trajectoryEndedCensoredTrades, 0);
  assert.equal(comb.completedTrades, 0);
});

test("Cost scenario monotonicity: higher costs strictly decrease net EV", () => {
  const baseTime = 1_000_000;
  const mint = "m-cost-mono";

  const trades: RawParsedMarketEvent[] = [
    createMockEvent({ mint, unixMs: baseTime, side: "buy", virtualSolLamports: "30000000000" }),
    createMockEvent({ mint, unixMs: baseTime + 10_000, side: "buy", virtualSolLamports: "60000000000" }),
    createMockEvent({ mint, unixMs: baseTime + 20_000, side: "sell", virtualSolLamports: "40000000000" }),
    createMockEvent({ mint, unixMs: baseTime + 30_000, side: "buy", virtualSolLamports: "50000000000" }), // Rebound win
  ];

  const states = computeCausalTrajectoryStates(mint, baseTime, trades, baseTime + 120_000);
  const rule = PREDEFINED_REBOUND_RULES[0]!;
  const exitPolicy = PREDEFINED_EXIT_POLICIES[0]!;

  const execZero = simulateReboundTrade(states, rule, exitPolicy, 0.05, STANDARD_COST_SCENARIOS.zero);
  const execLow = simulateReboundTrade(states, rule, exitPolicy, 0.05, STANDARD_COST_SCENARIOS.low);
  const execMed = simulateReboundTrade(states, rule, exitPolicy, 0.05, STANDARD_COST_SCENARIOS.medium);
  const execHigh = simulateReboundTrade(states, rule, exitPolicy, 0.05, STANDARD_COST_SCENARIOS.high);

  assert.ok(execZero!.netPnlSol >= execLow!.netPnlSol);
  assert.ok(execLow!.netPnlSol >= execMed!.netPnlSol);
  assert.ok(execMed!.netPnlSol >= execHigh!.netPnlSol);
});

test("Chronological 60/20/20 split partitions trajectories without look-ahead leakage", () => {
  const baseTime = 1_000_000;
  const trajectories: { mint: string; states: CausalTrajectoryState[]; launchMs: number }[] = [];

  for (let i = 0; i < 100; i++) {
    const mint = `mint-split-${i}`;
    const trades = [
      createMockEvent({ mint, unixMs: baseTime + i * 1000, side: "buy", virtualSolLamports: "30000000000" }),
      createMockEvent({ mint, unixMs: baseTime + i * 1000 + 10_000, side: "buy", virtualSolLamports: "60000000000" }),
      createMockEvent({ mint, unixMs: baseTime + i * 1000 + 20_000, side: "sell", virtualSolLamports: "40000000000" }),
    ];
    trajectories.push({
      mint,
      states: computeCausalTrajectoryStates(mint, baseTime + i * 1000, trades, baseTime + 200_000),
      launchMs: baseTime + i * 1000,
    });
  }

  const rule = PREDEFINED_REBOUND_RULES[0]!;
  const exitPolicy = PREDEFINED_EXIT_POLICIES[0]!;

  const res = evaluateReboundAcrossSplits(trajectories, rule, exitPolicy, 0.05);

  const train = res.find((s) => s.split === "train")!;
  const val = res.find((s) => s.split === "validation")!;
  const hold = res.find((s) => s.split === "holdout")!;

  assert.equal(train.eligibleTokens, 60);
  assert.equal(val.eligibleTokens, 20);
  assert.equal(hold.eligibleTokens, 20);
});

test("Audit population accurately tracks eligibility and right-censoring counts", () => {
  const launchTimes = new Map<string, number>();
  const mintTrades = new Map<string, RawParsedMarketEvent[]>();
  const datasetEndMs = 1_000_000;

  // Token 1: Eligible (>120s remaining, 5 trades, peak, dd30)
  launchTimes.set("t1", datasetEndMs - 200_000);
  mintTrades.set("t1", [
    createMockEvent({ mint: "t1", unixMs: datasetEndMs - 200_000, side: "buy", virtualSolLamports: "30000000000" }),
    createMockEvent({ mint: "t1", unixMs: datasetEndMs - 190_000, side: "buy", virtualSolLamports: "60000000000" }),
    createMockEvent({ mint: "t1", unixMs: datasetEndMs - 180_000, side: "sell", virtualSolLamports: "40000000000" }),
    createMockEvent({ mint: "t1", unixMs: datasetEndMs - 170_000, side: "sell", virtualSolLamports: "38000000000" }),
    createMockEvent({ mint: "t1", unixMs: datasetEndMs - 160_000, side: "buy", virtualSolLamports: "45000000000" }),
  ]);

  // Token 2: Right-censored (<120s remaining: only 50s remaining)
  launchTimes.set("t2", datasetEndMs - 50_000);
  mintTrades.set("t2", [createMockEvent({ mint: "t2", unixMs: datasetEndMs - 50_000, side: "buy" })]);

  const audit = auditReboundPopulation(launchTimes, mintTrades, datasetEndMs);

  assert.equal(audit.totalLaunchesInDataset, 2);
  assert.equal(audit.eligibleLaunches120s, 1);
  assert.equal(audit.rightCensoredLaunches120s, 1);
  assert.equal(audit.launchesWithDrawdown30Pct, 1);
});

test("quotePumpBuy and quotePumpSell exact integer curve execution and round-trip fee consistency", () => {
  const vSol = 30_000_000_000n; // 30 SOL
  const vTok = 1_073_000_000_000_000n; // 1,073M tokens
  const spendSolLamports = 50_000_000n; // 0.05 SOL

  // 1. Buy quote
  const buyQuote = quotePumpBuy(spendSolLamports, vSol, vTok, 100n);
  assert.equal(buyQuote.curveSolInLamports, spendSolLamports);
  assert.equal(buyQuote.feeLamports, 500_000n); // 1% of 0.05 SOL = 0.0005 SOL
  assert.equal(buyQuote.totalWalletOutflowLamports, 50_500_000n);
  assert.ok(buyQuote.tokensReceived > 0n);

  // 2. Sell quote against post-buy reserves
  const sellQuote = quotePumpSell(
    buyQuote.tokensReceived,
    buyQuote.postVSol,
    buyQuote.postVTok,
    100n,
  );
  // Selling back exact tokens received on unchanged curve must output within 1 lamport of curve SOL input due to integer floor division
  assert.ok(Math.abs(Number(sellQuote.grossCurveSolOutLamports - spendSolLamports)) <= 1);
  assert.equal(sellQuote.feeLamports, 500_000n);
  assert.ok(Math.abs(Number(sellQuote.netWalletInflowLamports - 49_500_000n)) <= 1);

  // Total wallet cashflow = netInflow - totalOutflow
  // ~49,500,000 - 50,500,000 = -1,000,000 lamports (exactly the 2% round-trip Pump fee within 1 lamport)
  const netRoundTripPnl = sellQuote.netWalletInflowLamports - buyQuote.totalWalletOutflowLamports;
  assert.ok(Math.abs(Number(netRoundTripPnl - (-1_000_000n))) <= 1);
});

test("Executable TP trigger prevents early exit when marginal price spikes but executable sell value does not reach TP", () => {
  const baseTime = 1_000_000;
  const mint = "m-tp-executable";

  // Curve starts at 30 SOL, 1,000M tokens
  // Entry at t=20s with 0.25 SOL (250,000,000 lamports)
  // At t=30s, token price rises such that marginal price (vSol/vTok) is +20.5% higher than entry fill price,
  // BUT selling 0.25 SOL worth of tokens has price impact, so executable return is only ~19.4% (below 20% TP).
  // At t=40s, price rises further so executable return reaches >= 20%.
  const entryVSol = 30_000_000_000n;
  const entryVTok = 1_000_000_000_000_000n;
  const posSizeSol = 0.25;

  const buyQuote = quotePumpBuy(BigInt(Math.round(posSizeSol * 1e9)), entryVSol, entryVTok, 100n);
  const entryFillPrice = (posSizeSol * 1e9) / Number(buyQuote.tokensReceived);

  // Pick a target marginal price at t=30s: 20.5% higher
  const targetMarginalPrice = entryFillPrice * 1.205;
  // Let's set vSol30 and vTok30 matching targetMarginalPrice with invariant k = 3e25
  const k = entryVSol * entryVTok;
  const vSol30 = BigInt(Math.round(Math.sqrt(Number(k) * targetMarginalPrice)));
  const vTok30 = k / vSol30;

  // Check what executable return would be at t=30s
  const sellQuote30 = quotePumpSell(buyQuote.tokensReceived, vSol30, vTok30, 100n);
  const execReturn30 =
    Number(sellQuote30.grossCurveSolOutLamports - BigInt(Math.round(posSizeSol * 1e9))) /
    (posSizeSol * 1e9);

  // Marginal price change is +20.5% >= 20%, but executable return is lower due to price impact (~19.4% < 20%)
  const marginalChangePct30 = (Number(vSol30) / Number(vTok30) - entryFillPrice) / entryFillPrice;
  assert.ok(marginalChangePct30 >= 0.20, "Marginal price change should exceed 20%");
  assert.ok(execReturn30 < 0.20, "Executable return must NOT reach 20% due to curve impact");

  // At t=40s, price rises enough to cross 20% executable return
  const vSol40 = vSol30 + 5_000_000_000n;
  const vTok40 = k / vSol40;

  const trades: RawParsedMarketEvent[] = [
    createMockEvent({ mint, unixMs: baseTime, side: "buy", virtualSolLamports: "30000000000" }),
    createMockEvent({ mint, unixMs: baseTime + 10_000, side: "buy", virtualSolLamports: "50000000000" }), // Peak
    createMockEvent({
      mint,
      unixMs: baseTime + 20_000,
      side: "sell",
      virtualSolLamports: entryVSol.toString(),
      virtualTokenBaseUnits: entryVTok.toString(),
    }), // Entry trigger at -40% dd
    createMockEvent({
      mint,
      unixMs: baseTime + 30_000,
      side: "buy",
      virtualSolLamports: vSol30.toString(),
      virtualTokenBaseUnits: vTok30.toString(),
    }), // Marginal price > 20%, but executable return < 20%
    createMockEvent({
      mint,
      unixMs: baseTime + 40_000,
      side: "buy",
      virtualSolLamports: vSol40.toString(),
      virtualTokenBaseUnits: vTok40.toString(),
    }), // Executable return >= 20%
  ];

  const states = computeCausalTrajectoryStates(mint, baseTime, trades, baseTime + 120_000);
  const rule = PREDEFINED_REBOUND_RULES[0]!; // Blind buy at -30%
  const exitPolicyTP20: (typeof PREDEFINED_EXIT_POLICIES)[0] = {
    name: "TP +20% / SL -10%",
    maxHoldDurationMs: 60_000,
    takeProfitPct: 0.20,
    stopLossPct: -0.10,
  };

  const exec = simulateReboundTrade(states, rule, exitPolicyTP20, posSizeSol, STANDARD_COST_SCENARIOS.medium);
  assert.ok(exec !== null);
  // It must NOT exit at t=30s (where marginal price was > 20% but executable return was < 20%)
  // It MUST exit at t=40s!
  assert.equal(exec.exitTimestampMs, baseTime + 40_000);
  assert.equal(exec.exitReason, "take-profit");
});

test("Trajectory ended before exit horizon is marked trajectory-ended-before-exit-horizon and excluded from completed PnL", () => {
  const baseTime = 1_000_000;
  const mint = "m-dormant-token";
  const datasetEndMs = baseTime + 300_000; // Dataset has 300s of lifetime

  // Token has trades only up to t=25s, then ceases trading completely
  const trades: RawParsedMarketEvent[] = [
    createMockEvent({ mint, unixMs: baseTime, side: "buy", virtualSolLamports: "30000000000" }),
    createMockEvent({ mint, unixMs: baseTime + 10_000, side: "buy", virtualSolLamports: "60000000000" }),
    createMockEvent({ mint, unixMs: baseTime + 20_000, side: "sell", virtualSolLamports: "40000000000" }), // Trigger at 20s
    createMockEvent({ mint, unixMs: baseTime + 25_000, side: "sell", virtualSolLamports: "39000000000" }),
  ];

  const states = computeCausalTrajectoryStates(mint, baseTime, trades, datasetEndMs);
  const rule = PREDEFINED_REBOUND_RULES[0]!;
  // Policy requires 60s hold (exit horizon: t=20s + 60s = t=80s <= datasetEndMs)
  const exitPolicy60s: (typeof PREDEFINED_EXIT_POLICIES)[0] = {
    name: "Time Exit 60s",
    maxHoldDurationMs: 60_000,
  };

  const exec = simulateReboundTrade(states, rule, exitPolicy60s, 0.05, STANDARD_COST_SCENARIOS.medium, 0, datasetEndMs);
  assert.ok(exec !== null);
  assert.equal(exec.isRightCensored, true);
  assert.equal(exec.exitReason, "trajectory-ended-before-exit-horizon");

  // Split evaluation must account this in trajectoryEndedCensoredTrades and exclude from completedTrades
  const summaries = evaluateReboundAcrossSplits(
    [{ mint, states, launchMs: baseTime }],
    rule,
    exitPolicy60s,
    0.05,
    STANDARD_COST_SCENARIOS.medium,
    0,
    datasetEndMs,
  );
  const comb = summaries.find((s) => s.split === "combined")!;
  assert.equal(comb.selectedTrades, 1);
  assert.equal(comb.censoredTrades, 1);
  assert.equal(comb.datasetBoundaryCensoredTrades, 0);
  assert.equal(comb.trajectoryEndedCensoredTrades, 1);
  assert.equal(comb.completedTrades, 0);
});

test("selectBestTrainValRule deterministically selects best candidate using train and validation only (holdout never accessed)", () => {
  const candidateRules = [
    { name: "Rule Alpha", description: "Rule Alpha", predicate: () => true },
    { name: "Rule Beta", description: "Rule Beta", predicate: () => true },
  ];

  // Synthetic evaluation results:
  // Rule Alpha: Train Net PnL = +0.02 (N=10), Val Net PnL = +0.01 (N=5) -> Train+Val EV = +0.002, Holdout EV = -0.010
  // Rule Beta:  Train Net PnL = -0.01 (N=10), Val Net PnL = -0.01 (N=5) -> Train+Val EV = -0.00133, Holdout EV = +0.050 (Huge holdout win!)
  const dummySummary = (
    ruleName: string,
    split: "train" | "validation" | "holdout",
    netPnl: number,
    count: number,
  ): ReboundEvaluationSummary => ({
    ruleName,
    exitPolicyName: "default",
    positionSizeSol: 0.05,
    costTier: "medium",
    extraLatencyDelayMs: 0,
    split,
    eligibleTokens: 50,
    selectedTrades: count,
    censoredTrades: 0,
    datasetBoundaryCensoredTrades: 0,
    trajectoryEndedCensoredTrades: 0,
    completedTrades: count,
    selectionRatePct: 100,
    wins: netPnl > 0 ? count : 0,
    losses: netPnl <= 0 ? count : 0,
    winRatePct: netPnl > 0 ? 100 : 0,
    totalGrossPnlSol: netPnl,
    totalNetPnlSol: netPnl,
    evPerEligibleTokenSol: count > 0 ? netPnl / 50 : 0,
    evPerSelectedTradeSol: count > 0 ? netPnl / count : 0,
    medianTradePnlSol: count > 0 ? netPnl / count : 0,
    p5PnlSol: 0,
    p25PnlSol: 0,
    p75PnlSol: 0,
    p95PnlSol: 0,
    maxDrawdownSol: 0,
    averageHoldingTimeSec: 10,
    profitFactor: 1,
    averageWinSol: 0,
    averageLossSol: 0,
    top1PctProfitShare: 0,
    top5PctProfitShare: 0,
    netExTop1ProfitSol: netPnl,
    netExTop5ProfitSol: netPnl,
    passedHoldoutGate: false,
  });

  const evaluations: readonly ReboundEvaluationSummary[] = [
    dummySummary("Rule Alpha", "train", 0.02, 10),
    dummySummary("Rule Alpha", "validation", 0.01, 5),
    dummySummary("Rule Alpha", "holdout", -0.01, 5),

    dummySummary("Rule Beta", "train", -0.01, 10),
    dummySummary("Rule Beta", "validation", -0.01, 5),
    dummySummary("Rule Beta", "holdout", 0.05, 5), // High holdout EV
  ];

  const selection = selectBestTrainValRule(candidateRules, evaluations);

  // Even though Rule Beta has high holdout EV, selection must choose Rule Alpha because Rule Alpha has higher Train+Val EV (+0.002 vs -0.00133)
  assert.equal(selection.selectedRule.name, "Rule Alpha");
  assert.ok(selection.trainValEv > 0);
  assert.equal(selection.trainValCompletedTrades, 15);
});
