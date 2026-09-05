import test from "node:test";
import assert from "node:assert/strict";
import {
  extractCausalFeatures,
  validateRuleCutoffAgainstLatency,
  evaluateFilterAcrossSplits,
  computeUnivariateSignals,
  PREDEFINED_FILTER_RULES,
  STANDARD_COST_SCENARIOS,
  PUMP_CURVE_INITIAL_VIRTUAL_TOKEN,
  PUMP_CURVE_INITIAL_VIRTUAL_SOL,
} from "@botwiner/research";
import type {
  HistoricalLaunchData,
  HistoricalTradePoint,
  PreFilterRule,
  CausalLaunchFeatures,
} from "@botwiner/research";

function createSyntheticLaunchWithTrades(options: {
  mint: string;
  launchTimeUnixMs: number;
  trades?: HistoricalTradePoint[];
  creatorBuySol?: number;
}): HistoricalLaunchData {
  const trades: HistoricalTradePoint[] = [];

  if (options.creatorBuySol !== undefined && options.creatorBuySol > 0) {
    trades.push({
      signature: `launch-tx-${options.mint}`,
      isLaunchTx: true,
      recvUnixMs: options.launchTimeUnixMs,
      slot: 100_000,
      side: "buy",
      quoteBaseUnits: BigInt(Math.round(options.creatorBuySol * 1e9)),
      tokenBaseUnits: 100_000_000_000_000n,
      virtualSol: PUMP_CURVE_INITIAL_VIRTUAL_SOL + BigInt(Math.round(options.creatorBuySol * 1e9)),
      virtualToken: PUMP_CURVE_INITIAL_VIRTUAL_TOKEN - 100_000_000_000_000n,
    });
  }

  if (options.trades) {
    trades.push(...options.trades);
  }

  return {
    mint: options.mint,
    launchTimeUnixMs: options.launchTimeUnixMs,
    launchSlot: 100_000,
    signature: `sig-${options.mint}`,
    initialVirtualToken: PUMP_CURVE_INITIAL_VIRTUAL_TOKEN,
    initialVirtualSol: PUMP_CURVE_INITIAL_VIRTUAL_SOL,
    trades,
  };
}

test("Causal feature cutoff enforcement throws on look-ahead violation", () => {
  // Test validation function
  assert.equal(validateRuleCutoffAgainstLatency("launch", 0), true);
  assert.equal(validateRuleCutoffAgainstLatency("launch", 25), true);
  assert.equal(validateRuleCutoffAgainstLatency("25ms", 0), false);
  assert.equal(validateRuleCutoffAgainstLatency("25ms", 25), true);
  assert.equal(validateRuleCutoffAgainstLatency("50ms", 25), false);
  assert.equal(validateRuleCutoffAgainstLatency("50ms", 50), true);
  assert.equal(validateRuleCutoffAgainstLatency("100ms", 50), false);
  assert.equal(validateRuleCutoffAgainstLatency("100ms", 100), true);
  assert.equal(validateRuleCutoffAgainstLatency("200ms", 100), false);
  assert.equal(validateRuleCutoffAgainstLatency("200ms", 200), true);

  // Test evaluator throws when evaluating 50ms rule at 25ms latency
  const rule50ms: PreFilterRule = {
    name: "Requires 50ms Flow",
    allowedCutoff: "50ms",
    predicate: (f) => f.buysCount_50ms > 0,
  };

  const syntheticLaunch = createSyntheticLaunchWithTrades({
    mint: "mint-1",
    launchTimeUnixMs: 1_000_000,
  });
  const features = extractCausalFeatures(syntheticLaunch);

  assert.throws(
    () => {
      evaluateFilterAcrossSplits(
        [{ launch: syntheticLaunch, features }],
        rule50ms,
        25, // Requested latency 25ms is LESS than allowedCutoff 50ms
      );
    },
    {
      name: "Error",
      message: /Causal Violation/,
    },
  );
});

test("Future feature leakage prevention: time-windowed trade flow strictly cuts off", () => {
  const baseTime = 1_000_000;
  const launch = createSyntheticLaunchWithTrades({
    mint: "mint-future-leak",
    launchTimeUnixMs: baseTime,
    trades: [
      {
        signature: "tx-10ms",
        isLaunchTx: false,
        recvUnixMs: baseTime + 10,
        slot: 100_001,
        side: "buy",
        quoteBaseUnits: 500_000_000n, // 0.5 SOL
        tokenBaseUnits: 10_000_000_000n,
        virtualSol: 30_500_000_000n,
        virtualToken: 1_000_000_000_000_000n,
      },
      {
        signature: "tx-30ms",
        isLaunchTx: false,
        recvUnixMs: baseTime + 30,
        slot: 100_002,
        side: "buy",
        quoteBaseUnits: 1_000_000_000n, // 1.0 SOL
        tokenBaseUnits: 20_000_000_000n,
        virtualSol: 31_500_000_000n,
        virtualToken: 980_000_000_000_000n,
      },
      {
        signature: "tx-80ms",
        isLaunchTx: false,
        recvUnixMs: baseTime + 80,
        slot: 100_003,
        side: "buy",
        quoteBaseUnits: 2_000_000_000n, // 2.0 SOL
        tokenBaseUnits: 40_000_000_000n,
        virtualSol: 33_500_000_000n,
        virtualToken: 940_000_000_000_000n,
      },
      {
        signature: "tx-150ms",
        isLaunchTx: false,
        recvUnixMs: baseTime + 150,
        slot: 100_004,
        side: "buy",
        quoteBaseUnits: 5_000_000_000n, // 5.0 SOL
        tokenBaseUnits: 100_000_000_000n,
        virtualSol: 38_500_000_000n,
        virtualToken: 840_000_000_000_000n,
      },
    ],
  });

  const features = extractCausalFeatures(launch);

  // 25ms cutoff: only tx at +10ms
  assert.equal(features.buysCount_25ms, 1);
  assert.equal(features.buyVolSol_25ms, 0.5);

  // 50ms cutoff: tx at +10ms and +30ms
  assert.equal(features.buysCount_50ms, 2);
  assert.equal(features.buyVolSol_50ms, 1.5);

  // 100ms cutoff: tx at +10ms, +30ms, and +80ms
  assert.equal(features.buysCount_100ms, 3);
  assert.equal(features.buyVolSol_100ms, 3.5);

  // 200ms cutoff: all 4 txs
  assert.equal(features.buysCount_200ms, 4);
  assert.equal(features.buyVolSol_200ms, 8.5);
});

test("Chronological 60/20/20 split preserves chronological order without leakage", () => {
  const items: { launch: HistoricalLaunchData; features: CausalLaunchFeatures }[] = [];
  const total = 100;
  for (let i = 0; i < total; i++) {
    const launch = createSyntheticLaunchWithTrades({
      mint: `mint-${String(i).padStart(3, "0")}`,
      launchTimeUnixMs: 1_000_000 + i * 1_000,
      creatorBuySol: i % 2 === 0 ? 1.0 : 0.0,
    });
    items.push({
      launch,
      features: extractCausalFeatures(launch),
    });
  }

  const baselineRule = PREDEFINED_FILTER_RULES[0]!; // Unfiltered
  const results = evaluateFilterAcrossSplits(items, baselineRule, 50);

  const trainRes = results.find((r) => r.split === "train")!;
  const valRes = results.find((r) => r.split === "validation")!;
  const holdoutRes = results.find((r) => r.split === "holdout")!;
  const combinedRes = results.find((r) => r.split === "combined")!;

  // 60% of 100 = 60
  assert.equal(trainRes.totalLaunchesInSplit, 60);
  // 20% of 100 = 20
  assert.equal(valRes.totalLaunchesInSplit, 20);
  // Remainder = 20
  assert.equal(holdoutRes.totalLaunchesInSplit, 20);
  // Total = 100
  assert.equal(combinedRes.totalLaunchesInSplit, 100);
});

test("Rule application is completely deterministic", () => {
  const launch = createSyntheticLaunchWithTrades({
    mint: "mint-deterministic",
    launchTimeUnixMs: 1_000_000,
    creatorBuySol: 1.5,
  });
  const features = extractCausalFeatures(launch, {
    name: "Test Token",
    symbol: "TEST",
    uri: "https://arweave.net/123",
  });

  const rule = PREDEFINED_FILTER_RULES.find((r) => r.name === "Creator Buy >= 1.0 SOL")!;
  assert.equal(rule.predicate(features), true);
  assert.equal(rule.predicate(features), true);

  const ruleFail = PREDEFINED_FILTER_RULES.find((r) => r.name === "Creator Buy >= 2.0 SOL")!;
  assert.equal(ruleFail.predicate(features), false);
  assert.equal(ruleFail.predicate(features), false);
});

test("Outlier robustness and profit concentration math", () => {
  // Create 10 synthetic launches: 1 huge winner (+10 SOL), 9 small losers (-0.01 SOL)
  const items: { launch: HistoricalLaunchData; features: CausalLaunchFeatures }[] = [];
  const baseTime = 1_000_000;

  for (let i = 0; i < 10; i++) {
    const isBigWinner = i === 0;
    const trades: HistoricalTradePoint[] = [];

    if (isBigWinner) {
      // Big buy at +100ms that pumps virtual sol from 30 to 100 SOL
      trades.push({
        signature: `winner-pump-${i}`,
        isLaunchTx: false,
        recvUnixMs: baseTime + 100,
        slot: 100_001,
        side: "buy",
        quoteBaseUnits: 70_000_000_000n, // +70 SOL
        tokenBaseUnits: 500_000_000_000_000n,
        virtualSol: 100_000_000_000n,
        virtualToken: 321_000_000_000_000n,
      });
    }

    const launch = createSyntheticLaunchWithTrades({
      mint: `mint-${i}`,
      launchTimeUnixMs: baseTime,
      creatorBuySol: 0.1,
      trades,
    });
    items.push({ launch, features: extractCausalFeatures(launch) });
  }

  const baselineRule = PREDEFINED_FILTER_RULES[0]!;
  // Evaluate at 50ms with 1s hold
  const results = evaluateFilterAcrossSplits(items, baselineRule, 50);
  const combined = results.find((r) => r.split === "combined")!;

  // Top 5% profit share should be 100% since only 1 trade won
  assert.ok(combined.top5PctProfitShare > 90);
  // Net profit excluding top 5% should be strictly negative
  assert.ok(combined.netExTop5ProfitSol < 0);
  // passedHoldoutGate should be false because removing top 5% kills profitability
  assert.equal(combined.passedHoldoutGate, false);
});

test("Cost tier sensitivity monotonically degrades net EV", () => {
  const launch = createSyntheticLaunchWithTrades({
    mint: "mint-cost-test",
    launchTimeUnixMs: 1_000_000,
    creatorBuySol: 0.5,
  });
  const features = extractCausalFeatures(launch);
  const items = [{ launch, features }];

  const baselineRule = PREDEFINED_FILTER_RULES[0]!;

  const resLow = evaluateFilterAcrossSplits(items, baselineRule, 50, 0.05, 1_000, STANDARD_COST_SCENARIOS.low)[0]!;
  const resMed = evaluateFilterAcrossSplits(items, baselineRule, 50, 0.05, 1_000, STANDARD_COST_SCENARIOS.medium)[0]!;
  const resHigh = evaluateFilterAcrossSplits(items, baselineRule, 50, 0.05, 1_000, STANDARD_COST_SCENARIOS.high)[0]!;

  assert.ok(resLow.totalNetPnlSol >= resMed.totalNetPnlSol, "Low cost net PnL >= Medium cost net PnL");
  assert.ok(resMed.totalNetPnlSol >= resHigh.totalNetPnlSol, "Medium cost net PnL >= High cost net PnL");
});

test("Univariate signal extraction calculates feature distributions between winners and losers", () => {
  const baseTime = 1_000_000;
  const items: { launch: HistoricalLaunchData; features: CausalLaunchFeatures }[] = [];

  // Launch 0: Winner (creator buy 2.0 SOL, early flow)
  const winnerLaunch = createSyntheticLaunchWithTrades({
    mint: "winner",
    launchTimeUnixMs: baseTime,
    creatorBuySol: 2.0,
    trades: [
      {
        signature: "big-pump",
        isLaunchTx: false,
        recvUnixMs: baseTime + 100,
        slot: 100_001,
        side: "buy",
        quoteBaseUnits: 50_000_000_000n,
        tokenBaseUnits: 400_000_000_000_000n,
        virtualSol: 80_000_000_000n,
        virtualToken: 400_000_000_000_000n,
      },
    ],
  });
  items.push({ launch: winnerLaunch, features: extractCausalFeatures(winnerLaunch) });

  // Launch 1: Loser (creator buy 0 SOL, no trades)
  const loserLaunch = createSyntheticLaunchWithTrades({
    mint: "loser",
    launchTimeUnixMs: baseTime,
    creatorBuySol: 0,
  });
  items.push({ launch: loserLaunch, features: extractCausalFeatures(loserLaunch) });

  const signals = computeUnivariateSignals(items, 50);
  const creatorBuySignal = signals.find((s) => s.featureName === "creatorBuySol");

  assert.ok(creatorBuySignal !== undefined);
  assert.equal(creatorBuySignal.winnerMean, 2.0);
  assert.equal(creatorBuySignal.loserMean, 0.0);
  assert.equal(creatorBuySignal.difference, 2.0);
});
