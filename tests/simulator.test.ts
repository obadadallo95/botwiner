import test from "node:test";
import assert from "node:assert/strict";
import {
  simulateTrade,
  calculateScenarioMetrics,
  evaluateChronologicalSplit,
  STANDARD_COST_SCENARIOS,
  PUMP_CURVE_INITIAL_VIRTUAL_TOKEN,
  PUMP_CURVE_INITIAL_VIRTUAL_SOL,
} from "@botwiner/research";
import type {
  HistoricalLaunchData,
  HistoricalTradePoint,
  SimulationScenario,
} from "@botwiner/research";

function createSyntheticLaunch(options: {
  mint?: string;
  launchTimeMs?: number;
  trades?: HistoricalTradePoint[];
}): HistoricalLaunchData {
  const mint = options.mint ?? "test-mint-1111111111111111111111111111111111";
  const launchTimeUnixMs = options.launchTimeMs ?? 1_700_000_000_000;
  return {
    mint,
    launchTimeUnixMs,
    launchSlot: 100_000,
    signature: "launch-sig-000",
    initialVirtualToken: PUMP_CURVE_INITIAL_VIRTUAL_TOKEN,
    initialVirtualSol: PUMP_CURVE_INITIAL_VIRTUAL_SOL,
    trades: options.trades ?? [],
  };
}

test("Causal model strictly prevents look-ahead bias", () => {
  const baseTime = 1_700_000_000_000;

  // Launch at baseTime
  // Trade 1 at +10ms: pushes price UP
  // Trade 2 at +50ms: pushes price EVEN HIGHER
  // Trade 3 at +100ms: pushes price HIGHER STILL
  const k = PUMP_CURVE_INITIAL_VIRTUAL_TOKEN * PUMP_CURVE_INITIAL_VIRTUAL_SOL;

  const t1Sol = PUMP_CURVE_INITIAL_VIRTUAL_SOL + 1_000_000_000n; // +1 SOL
  const t1Token = k / t1Sol;

  const t2Sol = t1Sol + 2_000_000_000n; // +2 SOL
  const t2Token = k / t2Sol;

  const trades: HistoricalTradePoint[] = [
    {
      signature: "sig-1",
      isLaunchTx: false,
      recvUnixMs: baseTime + 10,
      slot: 100_001,
      side: "buy",
      quoteBaseUnits: 1_000_000_000n,
      tokenBaseUnits: PUMP_CURVE_INITIAL_VIRTUAL_TOKEN - t1Token,
      virtualSol: t1Sol,
      virtualToken: t1Token,
    },
    {
      signature: "sig-2",
      isLaunchTx: false,
      recvUnixMs: baseTime + 50,
      slot: 100_002,
      side: "buy",
      quoteBaseUnits: 2_000_000_000n,
      tokenBaseUnits: t1Token - t2Token,
      virtualSol: t2Sol,
      virtualToken: t2Token,
    },
  ];

  const launch = createSyntheticLaunch({ launchTimeMs: baseTime, trades });

  // Scenario with latency = 0ms: entry at baseTime (before Trade 1 and Trade 2)
  const scenario0ms: SimulationScenario = {
    latencyMs: 0,
    exitPolicy: { type: "time", holdDurationMs: 100 },
    positionSizeSol: 0.05,
    fillModel: "executable-curve",
    costScenario: STANDARD_COST_SCENARIOS.zero,
  };

  const result0ms = simulateTrade(launch, scenario0ms);
  assert.equal(result0ms.filled, true);
  assert.equal(result0ms.entryTimeUnixMs, baseTime);
  assert.equal(result0ms.entrySlot, 100_000);

  // Scenario with latency = 25ms: entry at baseTime + 25ms (after Trade 1, before Trade 2)
  const scenario25ms: SimulationScenario = {
    ...scenario0ms,
    latencyMs: 25,
  };

  const result25ms = simulateTrade(launch, scenario25ms);
  assert.equal(result25ms.filled, true);
  assert.equal(result25ms.entryTimeUnixMs, baseTime + 25);
  assert.equal(result25ms.entrySlot, 100_001); // Observable slot at entry is 100_001

  // The 0ms entry bought before Trade 1 pushed price up, so it acquired strictly more tokens than 25ms entry
  assert.ok(BigInt(result0ms.tokensAcquired) > BigInt(result25ms.tokensAcquired));
});

test("Latency threshold selection changes entry reserves and fill prices", () => {
  const baseTime = 1_700_000_000_000;
  const k = PUMP_CURVE_INITIAL_VIRTUAL_TOKEN * PUMP_CURVE_INITIAL_VIRTUAL_SOL;
  const sol1 = PUMP_CURVE_INITIAL_VIRTUAL_SOL + 500_000_000n;
  const token1 = k / sol1;

  const trades: HistoricalTradePoint[] = [
    {
      signature: "tx-fast-sniper",
      isLaunchTx: false,
      recvUnixMs: baseTime + 15, // arrives at +15ms
      slot: 100_001,
      side: "buy",
      quoteBaseUnits: 500_000_000n,
      tokenBaseUnits: PUMP_CURVE_INITIAL_VIRTUAL_TOKEN - token1,
      virtualSol: sol1,
      virtualToken: token1,
    },
  ];

  const launch = createSyntheticLaunch({ launchTimeMs: baseTime, trades });

  const scenarioEarly: SimulationScenario = {
    latencyMs: 10, // before sniper
    exitPolicy: { type: "time", holdDurationMs: 500 },
    positionSizeSol: 0.05,
    fillModel: "executable-curve",
    costScenario: STANDARD_COST_SCENARIOS.zero,
  };

  const scenarioLate: SimulationScenario = {
    ...scenarioEarly,
    latencyMs: 20, // after sniper
  };

  const earlyRes = simulateTrade(launch, scenarioEarly);
  const lateRes = simulateTrade(launch, scenarioLate);

  assert.ok(BigInt(earlyRes.tokensAcquired) > BigInt(lateRes.tokensAcquired));
  // Early entry profits from sniper, late entry does not
  assert.ok(earlyRes.grossPnlSol > lateRes.grossPnlSol);
});

test("Missed fill handling correctly reports invalid reserves and zero tokens", () => {
  const launch = createSyntheticLaunch({
    trades: [],
  });

  // Corrupt initial reserves to test defense
  const corruptLaunch: HistoricalLaunchData = {
    ...launch,
    initialVirtualSol: 0n,
  };

  const scenario: SimulationScenario = {
    latencyMs: 0,
    exitPolicy: { type: "time", holdDurationMs: 1_000 },
    positionSizeSol: 0.05,
    fillModel: "executable-curve",
    costScenario: STANDARD_COST_SCENARIOS.low,
  };

  const result = simulateTrade(corruptLaunch, scenario);
  assert.equal(result.filled, false);
  assert.equal(result.unfillableReason, "invalid-initial-reserves");
  assert.equal(result.grossPnlSol, 0);
  assert.equal(result.netPnlSol, 0);
});

test("Exit selection respects time exit and triggers TP/SL appropriately", () => {
  const baseTime = 1_700_000_000_000;
  const k = PUMP_CURVE_INITIAL_VIRTUAL_TOKEN * PUMP_CURVE_INITIAL_VIRTUAL_SOL;

  // Huge pump at +200ms (+50% price)
  const pumpSol = (PUMP_CURVE_INITIAL_VIRTUAL_SOL * 15n) / 10n;
  const pumpToken = k / pumpSol;

  // Dump at +400ms (-30% price)
  const dumpSol = (PUMP_CURVE_INITIAL_VIRTUAL_SOL * 7n) / 10n;
  const dumpToken = k / dumpSol;

  const trades: HistoricalTradePoint[] = [
    {
      signature: "pump-tx",
      isLaunchTx: false,
      recvUnixMs: baseTime + 200,
      slot: 100_001,
      side: "buy",
      quoteBaseUnits: pumpSol - PUMP_CURVE_INITIAL_VIRTUAL_SOL,
      tokenBaseUnits: PUMP_CURVE_INITIAL_VIRTUAL_TOKEN - pumpToken,
      virtualSol: pumpSol,
      virtualToken: pumpToken,
    },
    {
      signature: "dump-tx",
      isLaunchTx: false,
      recvUnixMs: baseTime + 400,
      slot: 100_002,
      side: "sell",
      quoteBaseUnits: pumpSol - dumpSol,
      tokenBaseUnits: dumpToken - pumpToken,
      virtualSol: dumpSol,
      virtualToken: dumpToken,
    },
  ];

  const launch = createSyntheticLaunch({ launchTimeMs: baseTime, trades });

  // 1. Time exit at 300ms exits at the pump peak
  const timeScenario300: SimulationScenario = {
    latencyMs: 0,
    exitPolicy: { type: "time", holdDurationMs: 300 },
    positionSizeSol: 0.05,
    fillModel: "executable-curve",
    costScenario: STANDARD_COST_SCENARIOS.zero,
  };
  const res300 = simulateTrade(launch, timeScenario300);
  assert.equal(res300.exitTrigger, "time");
  assert.ok(res300.grossPnlSol > 0);

  // 2. TP +10% / SL -5% with 1000ms max hold triggers TP at +200ms trade
  const tpScenario: SimulationScenario = {
    latencyMs: 0,
    exitPolicy: { type: "tp-sl", takeProfitPct: 10, stopLossPct: -5, maxHoldDurationMs: 1_000 },
    positionSizeSol: 0.05,
    fillModel: "executable-curve",
    costScenario: STANDARD_COST_SCENARIOS.zero,
  };
  const resTp = simulateTrade(launch, tpScenario);
  assert.equal(resTp.exitTrigger, "take-profit");
  assert.equal(resTp.exitTimeUnixMs, baseTime + 200);
  assert.ok(resTp.grossPnlSol > 0);
});

test("Fee decomposition correctly calculates pump fees, base fee, priority fee, and tips", () => {
  const baseTime = 1_700_000_000_000;
  const launch = createSyntheticLaunch({ launchTimeMs: baseTime, trades: [] });

  const scenario: SimulationScenario = {
    latencyMs: 0,
    exitPolicy: { type: "time", holdDurationMs: 500 },
    positionSizeSol: 0.1, // 0.1 SOL
    fillModel: "executable-curve",
    costScenario: {
      name: "medium",
      pumpFeeRateBps: 100, // 1%
      baseFeeLamports: 10_000, // 0.000010 SOL
      priorityFeeLamports: 50_000, // 0.000050 SOL
      jitoTipLamports: 500_000, // 0.000500 SOL
    },
  };

  const result = simulateTrade(launch, scenario);
  assert.equal(result.filled, true);

  const f = result.fees;
  assert.equal(f.baseFeeSol, 0.00001);
  assert.equal(f.priorityFeeSol, 0.00005);
  assert.equal(f.jitoTipSol, 0.0005);
  assert.ok(f.pumpFeeSol > 0); // 1% of entry + 1% of exit
  assert.equal(f.totalFeesSol, f.pumpFeeSol + f.baseFeeSol + f.priorityFeeSol + f.jitoTipSol);

  assert.equal(
    Math.round((result.grossPnlSol - f.totalFeesSol) * 1e9),
    Math.round(result.netPnlSol * 1e9),
  );
});

test("Slippage impact calculations: executable curve yields lower returns than zero-impact price-path proxy", () => {
  const baseTime = 1_700_000_000_000;
  const k = PUMP_CURVE_INITIAL_VIRTUAL_TOKEN * PUMP_CURVE_INITIAL_VIRTUAL_SOL;
  const nextSol = PUMP_CURVE_INITIAL_VIRTUAL_SOL + 2_000_000_000n;
  const nextToken = k / nextSol;

  const trades: HistoricalTradePoint[] = [
    {
      signature: "tx-up",
      isLaunchTx: false,
      recvUnixMs: baseTime + 100,
      slot: 100_001,
      side: "buy",
      quoteBaseUnits: 2_000_000_000n,
      tokenBaseUnits: PUMP_CURVE_INITIAL_VIRTUAL_TOKEN - nextToken,
      virtualSol: nextSol,
      virtualToken: nextToken,
    },
  ];

  const launch = createSyntheticLaunch({ launchTimeMs: baseTime, trades });

  const scenarioCurve: SimulationScenario = {
    latencyMs: 0,
    exitPolicy: { type: "time", holdDurationMs: 500 },
    positionSizeSol: 1.0, // Large size: 1 SOL to induce visible slippage
    fillModel: "executable-curve",
    costScenario: STANDARD_COST_SCENARIOS.zero,
  };

  const scenarioProxy: SimulationScenario = {
    ...scenarioCurve,
    fillModel: "price-path-proxy",
  };

  const resCurve = simulateTrade(launch, scenarioCurve);
  const resProxy = simulateTrade(launch, scenarioProxy);

  // Executable-curve must incur bonding curve price impact on both buy and sell, giving lower return
  assert.ok(resProxy.grossPnlSol > resCurve.grossPnlSol);
});

test("Outlier concentration and profit contribution correctly calculates top 1%, 5%, and 10% shares", () => {
  const scenario: SimulationScenario = {
    latencyMs: 0,
    exitPolicy: { type: "time", holdDurationMs: 500 },
    positionSizeSol: 0.05,
    fillModel: "executable-curve",
    costScenario: STANDARD_COST_SCENARIOS.low,
  };

  // 100 synthetic trades: 5 trades make +1 SOL each (+5 SOL), 95 trades make -0.01 SOL each (-0.95 SOL)
  const results = [];
  for (let i = 0; i < 100; i++) {
    const isBigWinner = i < 5;
    const netPnlSol = isBigWinner ? 1.0 : -0.01;
    results.push({
      mint: `mint-${i}`,
      launchTimeUnixMs: 1_700_000_000_000 + i * 1000,
      entryTimeUnixMs: 1_700_000_000_000 + i * 1000,
      exitTimeUnixMs: 1_700_000_000_500 + i * 1000,
      entrySlot: 100 + i,
      exitSlot: 101 + i,
      filled: true,
      unfillableReason: null,
      positionSizeSol: 0.05,
      tokensAcquired: "1000",
      grossSolOut: 0.05 + netPnlSol,
      grossPnlSol: netPnlSol,
      netPnlSol,
      returnPct: (netPnlSol / 0.05) * 100,
      exitTrigger: "time" as const,
      fees: { pumpFeeSol: 0, baseFeeSol: 0, priorityFeeSol: 0, jitoTipSol: 0, totalFeesSol: 0 },
    });
  }

  const metrics = calculateScenarioMetrics(results, scenario);
  assert.equal(metrics.launchCount, 100);
  assert.equal(metrics.wins, 5);
  assert.equal(metrics.losses, 95);
  assert.equal(metrics.winRatePct, 5);

  // Top 5% (5 trades) made 5.0 SOL out of 5.0 SOL positive profit -> 100% share!
  assert.ok(Math.abs(metrics.outliers.top5PctProfitShare - 100.0) < 0.1);
  // Excluding top 5%, profit is negative (-0.95 SOL)
  assert.ok(metrics.outliers.netProfitExcludingTop5PctSol < 0);
  assert.equal(metrics.attribution, "extreme-outliers-fake-profitability");
});

test("Deterministic simulation yields identical metrics across runs", () => {
  const baseTime = 1_700_000_000_000;
  const launch = createSyntheticLaunch({ launchTimeMs: baseTime, trades: [] });
  const scenario: SimulationScenario = {
    latencyMs: 0,
    exitPolicy: { type: "time", holdDurationMs: 1_000 },
    positionSizeSol: 0.05,
    fillModel: "executable-curve",
    costScenario: STANDARD_COST_SCENARIOS.medium,
  };

  const run1 = calculateScenarioMetrics([simulateTrade(launch, scenario)], scenario);
  const run2 = calculateScenarioMetrics([simulateTrade(launch, scenario)], scenario);

  assert.deepEqual(run1, run2);
});

test("Chronological train / validation split partitions launches in chronological order", () => {
  const launches: HistoricalLaunchData[] = [];
  for (let i = 0; i < 20; i++) {
    launches.push(createSyntheticLaunch({
      mint: `mint-${i}`,
      launchTimeMs: 1_700_000_000_000 + i * 60_000, // 1 minute apart
    }));
  }

  const scenario: SimulationScenario = {
    latencyMs: 0,
    exitPolicy: { type: "time", holdDurationMs: 500 },
    positionSizeSol: 0.05,
    fillModel: "executable-curve",
    costScenario: STANDARD_COST_SCENARIOS.low,
  };

  const split = evaluateChronologicalSplit(launches, scenario, 0.5);
  assert.equal(split.exploratory.launchCount, 10);
  assert.equal(split.validation.launchCount, 10);
  assert.equal(split.combined.launchCount, 20);
});

test("Failure attribution correctly classifies negative EV and latency degradation", () => {
  const scenarioZeroGross: SimulationScenario = {
    latencyMs: 0,
    exitPolicy: { type: "time", holdDurationMs: 500 },
    positionSizeSol: 0.05,
    fillModel: "executable-curve",
    costScenario: STANDARD_COST_SCENARIOS.zero,
  };

  // 25 losses (no profit at all)
  const lossResults = Array.from({ length: 25 }, (_, i) => ({
    mint: `mint-${i}`,
    launchTimeUnixMs: 1_700_000_000_000 + i * 1000,
    entryTimeUnixMs: 1_700_000_000_000 + i * 1000,
    exitTimeUnixMs: 1_700_000_000_500 + i * 1000,
    entrySlot: 100,
    exitSlot: 101,
    filled: true,
    unfillableReason: null,
    positionSizeSol: 0.05,
    tokensAcquired: "1000",
    grossSolOut: 0.04,
    grossPnlSol: -0.01,
    netPnlSol: -0.01,
    returnPct: -20,
    exitTrigger: "time" as const,
    fees: { pumpFeeSol: 0, baseFeeSol: 0, priorityFeeSol: 0, jitoTipSol: 0, totalFeesSol: 0 },
  }));

  const metricsLoss = calculateScenarioMetrics(lossResults, scenarioZeroGross);
  assert.equal(metricsLoss.attribution, "no-gross-edge");
});
