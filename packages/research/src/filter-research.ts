import {
  simulateTrade,
  STANDARD_COST_SCENARIOS,
} from "./simulation.js";
import type {
  CostScenario,
  HistoricalLaunchData,
  HistoricalTradePoint,
} from "./simulation-types.js";
import type {
  CausalLaunchFeatures,
  PreFilterRule,
  FilterEvaluationResult,
  FeatureCorrelationRecord,
  CausalFeatureCutoff,
} from "./filter-research-types.js";

export function extractCausalFeatures(
  launch: HistoricalLaunchData,
  rawMetadata?: {
    name?: string;
    symbol?: string;
    uri?: string;
    tokenProgram?: string;
    submittingWallet?: string;
    creatorWallet?: string;
  },
): CausalLaunchFeatures {
  // Check creator buy in launch transaction
  let creatorBuySol = 0;
  let creatorTokenAllocPct = 0;

  for (const trade of launch.trades) {
    if (trade.isLaunchTx) {
      creatorBuySol = Number(trade.quoteBaseUnits) / 1e9;
      creatorTokenAllocPct = (Number(trade.tokenBaseUnits) / 1e15) * 100;
      break;
    }
  }

  const name = rawMetadata?.name ?? "";
  const symbol = rawMetadata?.symbol ?? "";
  const uri = rawMetadata?.uri ?? "";

  const extTrades: HistoricalTradePoint[] = launch.trades.filter((t: HistoricalTradePoint) => !t.isLaunchTx);

  const getBuysWithin = (ms: number) =>
    extTrades.filter((t: HistoricalTradePoint) => t.recvUnixMs - launch.launchTimeUnixMs <= ms && t.recvUnixMs >= launch.launchTimeUnixMs && t.side === "buy");

  const buys25 = getBuysWithin(25);
  const buys50 = getBuysWithin(50);
  const buys100 = getBuysWithin(100);
  const buys200 = getBuysWithin(200);

  const sumVol = (trades: HistoricalTradePoint[]) =>
    trades.reduce((sum: number, t: HistoricalTradePoint) => sum + Number(t.quoteBaseUnits) / 1e9, 0);

  return {
    mint: launch.mint,
    launchTimeUnixMs: launch.launchTimeUnixMs,
    launchSlot: launch.launchSlot,
    creatorBuySol,
    hasCreatorBuy: creatorBuySol > 0,
    creatorTokenAllocPct,
    nameLen: name.length,
    symbolLen: symbol.length,
    hasUri: uri.length > 0,
    isIpfsUri: uri.includes("ipfs"),
    isToken2022: rawMetadata?.tokenProgram?.includes("Tokenz") ?? true,
    creatorIsSubmitter:
      rawMetadata?.creatorWallet && rawMetadata?.submittingWallet
        ? rawMetadata.creatorWallet === rawMetadata.submittingWallet
        : true,
    buysCount_25ms: buys25.length,
    buyVolSol_25ms: sumVol(buys25),
    buysCount_50ms: buys50.length,
    buyVolSol_50ms: sumVol(buys50),
    buysCount_100ms: buys100.length,
    buyVolSol_100ms: sumVol(buys100),
    buysCount_200ms: buys200.length,
    buyVolSol_200ms: sumVol(buys200),
  };
}

export const PREDEFINED_FILTER_RULES: readonly PreFilterRule[] = [
  {
    name: "Unfiltered (Baseline)",
    allowedCutoff: "launch",
    predicate: () => true,
  },
  {
    name: "Has Creator Buy (>0 SOL)",
    allowedCutoff: "launch",
    predicate: (f) => f.hasCreatorBuy,
  },
  {
    name: "Creator Buy >= 0.5 SOL",
    allowedCutoff: "launch",
    predicate: (f) => f.creatorBuySol >= 0.5,
  },
  {
    name: "Creator Buy >= 1.0 SOL",
    allowedCutoff: "launch",
    predicate: (f) => f.creatorBuySol >= 1.0,
  },
  {
    name: "Creator Buy >= 2.0 SOL",
    allowedCutoff: "launch",
    predicate: (f) => f.creatorBuySol >= 2.0,
  },
  {
    name: "Early Buys >= 1 (25ms deadline)",
    allowedCutoff: "25ms",
    predicate: (f) => f.buysCount_25ms >= 1,
  },
  {
    name: "Early Buys >= 1 (50ms deadline)",
    allowedCutoff: "50ms",
    predicate: (f) => f.buysCount_50ms >= 1,
  },
  {
    name: "Early Buys >= 1 (100ms deadline)",
    allowedCutoff: "100ms",
    predicate: (f) => f.buysCount_100ms >= 1,
  },
  {
    name: "Creator >= 0.5 & Early Buys >= 1 (25ms)",
    allowedCutoff: "25ms",
    predicate: (f) => f.creatorBuySol >= 0.5 && f.buysCount_25ms >= 1,
  },
  {
    name: "Creator >= 0.5 & Early Buys >= 1 (50ms)",
    allowedCutoff: "50ms",
    predicate: (f) => f.creatorBuySol >= 0.5 && f.buysCount_50ms >= 1,
  },
  {
    name: "Creator >= 1.0 & Early Buys >= 1 (50ms)",
    allowedCutoff: "50ms",
    predicate: (f) => f.creatorBuySol >= 1.0 && f.buysCount_50ms >= 1,
  },
  {
    name: "Creator >= 0.5 & Early Buys >= 1 (100ms)",
    allowedCutoff: "100ms",
    predicate: (f) => f.creatorBuySol >= 0.5 && f.buysCount_100ms >= 1,
  },
];

export function validateRuleCutoffAgainstLatency(cutoff: CausalFeatureCutoff, latencyMs: number): boolean {
  switch (cutoff) {
    case "launch":
      return true;
    case "25ms":
      return latencyMs >= 25;
    case "50ms":
      return latencyMs >= 50;
    case "100ms":
      return latencyMs >= 100;
    case "200ms":
      return latencyMs >= 200;
    default:
      return false;
  }
}

export function evaluateFilterAcrossSplits(
  launches: readonly { launch: HistoricalLaunchData; features: CausalLaunchFeatures }[],
  rule: PreFilterRule,
  latencyMs: number,
  positionSizeSol = 0.05,
  holdDurationMs = 1_000,
  costScenario: CostScenario = STANDARD_COST_SCENARIOS.medium,
): FilterEvaluationResult[] {
  // Causal check: If rule cutoff exceeds latencyMs, rule is invalid for this latency
  if (!validateRuleCutoffAgainstLatency(rule.allowedCutoff, latencyMs)) {
    throw new Error(
      `Causal Violation: Rule "${rule.name}" requires feature cutoff "${rule.allowedCutoff}", which cannot be used at latency ${latencyMs}ms.`,
    );
  }

  // Chronological 60% / 20% / 20% split
  const n = launches.length;
  const nTrain = Math.floor(n * 0.6);
  const nVal = Math.floor(n * 0.2);

  const trainSet = launches.slice(0, nTrain);
  const valSet = launches.slice(nTrain, nTrain + nVal);
  const holdoutSet = launches.slice(nTrain + nVal);
  const combinedSet = launches;

  const splits = [
    { split: "train" as const, data: trainSet },
    { split: "validation" as const, data: valSet },
    { split: "holdout" as const, data: holdoutSet },
    { split: "combined" as const, data: combinedSet },
  ];

  return splits.map(({ split, data }) => {
    const totalLaunchesInSplit = data.length;
    const selected = data.filter((item) => rule.predicate(item.features));
    const selectedLaunches = selected.length;
    const selectionRatePct = totalLaunchesInSplit > 0 ? (selectedLaunches / totalLaunchesInSplit) * 100 : 0;

    const tradeResults = selected.map(({ launch }) =>
      simulateTrade(launch, {
        latencyMs,
        exitPolicy: { type: "time", holdDurationMs },
        positionSizeSol,
        fillModel: "executable-curve",
        costScenario,
      }),
    );

    const filledTrades = tradeResults.filter((r) => r.filled);
    const tradeCount = filledTrades.length;
    const wins = filledTrades.filter((r) => r.netPnlSol > 0).length;
    const losses = filledTrades.filter((r) => r.netPnlSol <= 0).length;
    const winRatePct = tradeCount > 0 ? (wins / tradeCount) * 100 : 0;

    const totalGrossPnlSol = filledTrades.reduce((sum, r) => sum + r.grossPnlSol, 0);
    const totalNetPnlSol = filledTrades.reduce((sum, r) => sum + r.netPnlSol, 0);

    const grossEvPerSelectedSol = selectedLaunches > 0 ? totalGrossPnlSol / selectedLaunches : 0;
    const netEvPerSelectedSol = selectedLaunches > 0 ? totalNetPnlSol / selectedLaunches : 0;
    const netEvPerAttemptedSol = totalLaunchesInSplit > 0 ? totalNetPnlSol / totalLaunchesInSplit : 0;

    // Outlier calculation: top 5% share
    const sortedDesc = [...filledTrades].sort((a, b) => b.netPnlSol - a.netPnlSol);
    const posTrades = sortedDesc.filter((r) => r.netPnlSol > 0);
    const totalPosProfit = posTrades.reduce((sum, r) => sum + r.netPnlSol, 0);
    const nTop5 = Math.max(1, Math.round(sortedDesc.length * 0.05));
    const top5Profit = sortedDesc.slice(0, nTop5).reduce((sum, r) => sum + (r.netPnlSol > 0 ? r.netPnlSol : 0), 0);
    const top5PctProfitShare = totalPosProfit > 0 ? (top5Profit / totalPosProfit) * 100 : 0;
    const netExTop5ProfitSol = totalNetPnlSol - top5Profit;

    const passedHoldoutGate = netEvPerSelectedSol > 0 && netExTop5ProfitSol > 0;

    return {
      ruleName: rule.name,
      latencyMs,
      split,
      totalLaunchesInSplit,
      selectedLaunches,
      selectionRatePct,
      tradeCount,
      wins,
      losses,
      winRatePct,
      totalGrossPnlSol,
      totalNetPnlSol,
      grossEvPerSelectedSol,
      netEvPerSelectedSol,
      netEvPerAttemptedSol,
      top5PctProfitShare,
      netExTop5ProfitSol,
      passedHoldoutGate,
    };
  });
}

export function computeUnivariateSignals(
  launches: readonly { launch: HistoricalLaunchData; features: CausalLaunchFeatures }[],
  latencyMs = 50,
  holdDurationMs = 1_000,
  positionSizeSol = 0.05,
  costScenario: CostScenario = STANDARD_COST_SCENARIOS.medium,
): FeatureCorrelationRecord[] {
  const tradeOutcomes = launches.map(({ launch, features }) => {
    const sim = simulateTrade(launch, {
      latencyMs,
      exitPolicy: { type: "time", holdDurationMs },
      positionSizeSol,
      fillModel: "executable-curve",
      costScenario,
    });
    return { features, netPnlSol: sim.netPnlSol, isWinner: sim.netPnlSol > 0 };
  });

  const winners = tradeOutcomes.filter((t) => t.isWinner);
  const losers = tradeOutcomes.filter((t) => !t.isWinner);

  const featureKeys: (keyof CausalLaunchFeatures)[] = [
    "creatorBuySol",
    "hasCreatorBuy",
    "creatorTokenAllocPct",
    "nameLen",
    "symbolLen",
    "hasUri",
    "isIpfsUri",
    "isToken2022",
    "creatorIsSubmitter",
    "buysCount_50ms",
    "buyVolSol_50ms",
  ];

  return featureKeys.map((key) => {
    const wVals = winners.map((w) => Number(w.features[key])).sort((a, b) => a - b);
    const lVals = losers.map((l) => Number(l.features[key])).sort((a, b) => a - b);

    const wMean = wVals.length > 0 ? wVals.reduce((a, b) => a + b, 0) / wVals.length : 0;
    const lMean = lVals.length > 0 ? lVals.reduce((a, b) => a + b, 0) / lVals.length : 0;

    const wMed = wVals.length > 0 ? wVals[Math.floor(wVals.length / 2)]! : 0;
    const lMed = lVals.length > 0 ? lVals[Math.floor(lVals.length / 2)]! : 0;

    return {
      featureName: String(key),
      coverage: tradeOutcomes.length,
      winnerMean: wMean,
      loserMean: lMean,
      winnerMedian: wMed,
      loserMedian: lMed,
      difference: wMean - lMean,
    };
  });
}
