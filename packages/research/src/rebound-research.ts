import type { CostScenario } from "./simulation-types.js";
import { STANDARD_COST_SCENARIOS } from "./simulation.js";
import type { RawParsedMarketEvent } from "./pivot-research.js";
import type {
  CausalTrajectoryState,
  ReboundEntryRule,
  ReboundEvaluationSummary,
  ReboundExitPolicy,
  ReboundExitReason,
  ReboundPopulationAudit,
  ReboundTradeExecution,
} from "./rebound-research-types.js";

export function auditReboundPopulation(
  launchTimes: Map<string, number>,
  mintTrades: Map<string, RawParsedMarketEvent[]>,
  datasetEndMs: number,
): ReboundPopulationAudit {
  let launchesWithEarlyPeak = 0;
  let launchesWithDrawdown30Pct = 0;
  let rightCensoredLaunches120s = 0;
  let eligibleLaunches120s = 0;
  const exclusionReasons: Record<string, number> = {
    "insufficient-dataset-lifetime-under-120s": 0,
    "fewer-than-5-trades": 0,
    "no-early-peak-in-first-60s": 0,
    "no-30pct-drawdown-observed": 0,
  };

  for (const [mint, launchMs] of launchTimes) {
    const remainingMs = datasetEndMs - launchMs;
    if (remainingMs < 120_000) {
      rightCensoredLaunches120s++;
      exclusionReasons["insufficient-dataset-lifetime-under-120s"] =
        (exclusionReasons["insufficient-dataset-lifetime-under-120s"] || 0) + 1;
      continue;
    }

    const trades = mintTrades.get(mint) || [];
    if (trades.length < 5) {
      exclusionReasons["fewer-than-5-trades"] =
        (exclusionReasons["fewer-than-5-trades"] || 0) + 1;
      continue;
    }

    eligibleLaunches120s++;

    // Check early peak in first 60s
    let peakPrice = 0;
    for (const t of trades) {
      const ms = t.timestamps?.collectorReceivedAtUnixMs ?? launchMs;
      if (ms - launchMs > 60_000) break;
      const vSol = Number(t.reserves?.virtualSolLamports || 0);
      const vTok = Number(t.reserves?.virtualTokenBaseUnits || 0);
      const p = vTok > 0 ? vSol / vTok : 0;
      if (p > peakPrice) peakPrice = p;
    }

    if (peakPrice <= 0) {
      exclusionReasons["no-early-peak-in-first-60s"] =
        (exclusionReasons["no-early-peak-in-first-60s"] || 0) + 1;
      continue;
    }
    launchesWithEarlyPeak++;

    // Check for >= 30% drawdown
    let sawDd30 = false;
    for (const t of trades) {
      const vSol = Number(t.reserves?.virtualSolLamports || 0);
      const vTok = Number(t.reserves?.virtualTokenBaseUnits || 0);
      const p = vTok > 0 ? vSol / vTok : 0;
      if (p > 0 && peakPrice > 0 && (p - peakPrice) / peakPrice <= -0.3) {
        sawDd30 = true;
        break;
      }
    }

    if (sawDd30) {
      launchesWithDrawdown30Pct++;
    } else {
      exclusionReasons["no-30pct-drawdown-observed"] =
        (exclusionReasons["no-30pct-drawdown-observed"] || 0) + 1;
    }
  }

  let minTime = Infinity;
  for (const t of launchTimes.values()) {
    if (t < minTime) minTime = t;
  }
  const datasetDurationSec = minTime < Infinity ? (datasetEndMs - minTime) / 1000 : 900;

  return {
    totalLaunchesInDataset: launchTimes.size,
    datasetDurationSec,
    launchesWithEarlyPeak,
    launchesWithDrawdown30Pct,
    rightCensoredLaunches120s,
    eligibleLaunches120s,
    exclusionReasons,
  };
}

export function computeCausalTrajectoryStates(
  mint: string,
  launchMs: number,
  trades: RawParsedMarketEvent[],
  datasetEndMs: number,
): CausalTrajectoryState[] {
  const states: CausalTrajectoryState[] = [];

  let runningPeakPrice = 0;
  let runningPeakTimeMs = launchMs;
  let localLowPrice = Infinity;
  let localLowTimeMs = launchMs;
  let consecutiveBuys = 0;
  let lastCreatorTradeMs = launchMs;
  let creatorSoldTokens = 0;

  for (let i = 0; i < trades.length; i++) {
    const t = trades[i]!;
    const nowMs = t.timestamps?.collectorReceivedAtUnixMs ?? launchMs;
    const vSol = BigInt(t.reserves?.virtualSolLamports || "30000000000");
    const vTok = BigInt(t.reserves?.virtualTokenBaseUnits || "1073000000000000");
    const rSol = BigInt(t.reserves?.realSolLamports || "0");
    const rTok = BigInt(t.reserves?.realTokenBaseUnits || "0");

    const price = Number(vTok) > 0 ? Number(vSol) / Number(vTok) : 0;
    if (price <= 0) continue;

    // Track consecutive buy prints
    if (t.side === "buy") {
      consecutiveBuys++;
    } else {
      consecutiveBuys = 0;
    }

    // Track creator activity
    if (t.creatorWallet && t.traderWallet && t.creatorWallet === t.traderWallet) {
      lastCreatorTradeMs = nowMs;
      if (t.side === "sell") {
        creatorSoldTokens += Number(t.amounts?.tokenBaseUnits || 0);
      }
    }

    // Update running peak (peak window up to first 60s)
    const timeSinceLaunchSec = (nowMs - launchMs) / 1000;
    if (timeSinceLaunchSec <= 60 && price > runningPeakPrice) {
      runningPeakPrice = price;
      runningPeakTimeMs = nowMs;
      localLowPrice = price;
      localLowTimeMs = nowMs;
    }

    // Update local low after running peak
    if (nowMs >= runningPeakTimeMs && price < localLowPrice) {
      localLowPrice = price;
      localLowTimeMs = nowMs;
    }

    const currentDrawdownPct =
      runningPeakPrice > 0 ? ((price - runningPeakPrice) / runningPeakPrice) * 100 : 0;
    const noNewLowSec = (nowMs - localLowTimeMs) / 1000;
    const microRecoveryPct =
      localLowPrice > 0 && price >= localLowPrice
        ? ((price - localLowPrice) / localLowPrice) * 100
        : 0;

    // Trailing trade windows
    const trailingTrades = trades.slice(0, i + 1);

    const sellsLast10 = trailingTrades.filter((tr) => {
      const ms = tr.timestamps?.collectorReceivedAtUnixMs ?? 0;
      return ms >= nowMs - 10_000 && ms <= nowMs && tr.side === "sell";
    });
    const sellsPrior10 = trailingTrades.filter((tr) => {
      const ms = tr.timestamps?.collectorReceivedAtUnixMs ?? 0;
      return ms >= nowMs - 20_000 && ms < nowMs - 10_000 && tr.side === "sell";
    });

    const buysLast5 = trailingTrades.filter((tr) => {
      const ms = tr.timestamps?.collectorReceivedAtUnixMs ?? 0;
      return ms >= nowMs - 5_000 && ms <= nowMs && tr.side === "buy";
    });
    const buysLast10 = trailingTrades.filter((tr) => {
      const ms = tr.timestamps?.collectorReceivedAtUnixMs ?? 0;
      return ms >= nowMs - 10_000 && ms <= nowMs && tr.side === "buy";
    });

    const sellVolLast10 = sellsLast10.reduce(
      (sum, tr) => sum + Number(tr.amounts?.nativeSolLamports || 0) / 1e9,
      0,
    );
    const sellVolPrior10 = sellsPrior10.reduce(
      (sum, tr) => sum + Number(tr.amounts?.nativeSolLamports || 0) / 1e9,
      0,
    );
    const buyVolLast10 = buysLast10.reduce(
      (sum, tr) => sum + Number(tr.amounts?.nativeSolLamports || 0) / 1e9,
      0,
    );

    const sellRateDecayRatio =
      sellsPrior10.length > 0 ? sellsLast10.length / sellsPrior10.length : sellsLast10.length > 0 ? 1 : 0;

    const sellVolDecayPct =
      sellVolPrior10 > 0
        ? Math.max(0, ((sellVolPrior10 - sellVolLast10) / sellVolPrior10) * 100)
        : 0;

    const buySellVolRatio10s =
      sellVolLast10 > 0 ? buyVolLast10 / sellVolLast10 : buyVolLast10 > 0 ? 10 : 1;

    const creatorInactiveSec = (nowMs - lastCreatorTradeMs) / 1000;

    states.push({
      mint,
      launchTimeMs: launchMs,
      tradeIndex: i,
      timestampMs: nowMs,
      timeSinceLaunchSec,
      price,
      virtualSolLamports: vSol,
      virtualTokenBaseUnits: vTok,
      realSolLamports: rSol,
      realTokenBaseUnits: rTok,
      runningPeakPrice,
      runningPeakTimeMs,
      timeSincePeakSec: (nowMs - runningPeakTimeMs) / 1000,
      currentDrawdownPct,
      localLowPrice,
      localLowTimeMs,
      noNewLowSec,
      microRecoveryPct,
      sellsCountTrailing10s: sellsLast10.length,
      sellsCountPrior10s: sellsPrior10.length,
      sellRateDecayRatio,
      sellVolTrailing10sSol: sellVolLast10,
      sellVolPrior10sSol: sellVolPrior10,
      sellVolDecayPct,
      buysCountTrailing5s: buysLast5.length,
      buysCountTrailing10s: buysLast10.length,
      buyVolTrailing10sSol: buyVolLast10,
      buySellVolRatio10s,
      consecutiveBuysCount: consecutiveBuys,
      creatorInactiveSec,
      creatorSoldEstimatedTokens: creatorSoldTokens,
      isRightCensoredForHorizon: (horizonMs: number, dEndMs = datasetEndMs) =>
        nowMs + horizonMs > dEndMs,
    });
  }

  return states;
}

export const PREDEFINED_REBOUND_RULES: readonly ReboundEntryRule[] = [
  {
    name: "Baseline 1: Blind Buy at -30% Drawdown",
    description: "Enters immediately at first touch of -30% drawdown with no exhaustion filter.",
    predicate: (s) => s.currentDrawdownPct <= -30,
  },
  {
    name: "Baseline 2: Blind Buy at -30% + 5s Stabilization",
    description: "Enters when drawdown is <= -30% and no new low has occurred for 5 seconds.",
    predicate: (s) => s.currentDrawdownPct <= -30 && s.noNewLowSec >= 5,
  },
  {
    name: "Rule A: Sell Rate Decay + Trailing Buys",
    description:
      "Drawdown <= -30% AND trailing 10s sell count <= 50% of prior 10s AND >=2 buys in trailing 5s.",
    predicate: (s) =>
      s.currentDrawdownPct <= -30 &&
      s.sellRateDecayRatio <= 0.5 &&
      s.buysCountTrailing5s >= 2,
  },
  {
    name: "Rule B: Deeper Drawdown (-40%) + Buy Vol Domination",
    description:
      "Drawdown <= -40% AND no new low for >=5s AND trailing 10s buy volume > sell volume.",
    predicate: (s) =>
      s.currentDrawdownPct <= -40 &&
      s.noNewLowSec >= 5 &&
      s.buyVolTrailing10sSol > s.sellVolTrailing10sSol,
  },
  {
    name: "Rule C: Deep Washout (-50%) + Creator Inactive",
    description:
      "Drawdown <= -50% AND creator inactive for >=15s AND >=2 buys in trailing 5s.",
    predicate: (s) =>
      s.currentDrawdownPct <= -50 &&
      s.creatorInactiveSec >= 15 &&
      s.buysCountTrailing5s >= 2,
  },
  {
    name: "Rule D: Sell Volume Decay (>=80%) + Micro-Recovery (>=5%)",
    description:
      "Drawdown <= -30% AND sell volume dropped >=80% AND micro-recovery >= 5% from local low.",
    predicate: (s) =>
      s.currentDrawdownPct <= -30 &&
      s.sellVolDecayPct >= 80 &&
      s.microRecoveryPct >= 5,
  },
  {
    name: "Rule E: Consecutive Buy Absorption (>=3 Buys + Vol Ratio >=1.5)",
    description:
      "Drawdown <= -30% AND >=3 consecutive buys AND buy/sell volume ratio >= 1.5 in trailing 10s.",
    predicate: (s) =>
      s.currentDrawdownPct <= -30 &&
      s.consecutiveBuysCount >= 3 &&
      s.buySellVolRatio10s >= 1.5,
  },
];

export const PREDEFINED_EXIT_POLICIES: readonly ReboundExitPolicy[] = [
  { name: "Time Exit 10s", maxHoldDurationMs: 10_000 },
  { name: "Time Exit 30s", maxHoldDurationMs: 30_000 },
  { name: "Time Exit 60s", maxHoldDurationMs: 60_000 },
  {
    name: "TP +20% / SL -10% (Max 60s)",
    maxHoldDurationMs: 60_000,
    takeProfitPct: 0.2,
    stopLossPct: -0.1,
  },
  {
    name: "TP +30% / SL -15% (Max 60s)",
    maxHoldDurationMs: 60_000,
    takeProfitPct: 0.3,
    stopLossPct: -0.15,
  },
  {
    name: "TP +50% / SL -20% (Max 120s)",
    maxHoldDurationMs: 120_000,
    takeProfitPct: 0.5,
    stopLossPct: -0.2,
  },
];

export interface PumpBuyQuote {
  readonly curveSolInLamports: bigint;
  readonly tokensReceived: bigint;
  readonly feeLamports: bigint;
  readonly totalWalletOutflowLamports: bigint;
  readonly postVSol: bigint;
  readonly postVTok: bigint;
}

export function quotePumpBuy(
  curveSolInLamports: bigint,
  vSol: bigint,
  vTok: bigint,
  feeBps = 100n,
): PumpBuyQuote {
  if (curveSolInLamports <= 0n || vSol <= 0n || vTok <= 0n) {
    return {
      curveSolInLamports: 0n,
      tokensReceived: 0n,
      feeLamports: 0n,
      totalWalletOutflowLamports: 0n,
      postVSol: vSol,
      postVTok: vTok,
    };
  }
  const k = vSol * vTok;
  const postVSol = vSol + curveSolInLamports;
  const postVTok = k / postVSol;
  const tokensReceived = vTok > postVTok ? vTok - postVTok : 0n;
  const feeLamports = (curveSolInLamports * feeBps) / 10_000n;
  const totalWalletOutflowLamports = curveSolInLamports + feeLamports;
  return {
    curveSolInLamports,
    tokensReceived,
    feeLamports,
    totalWalletOutflowLamports,
    postVSol,
    postVTok,
  };
}

export interface PumpSellQuote {
  readonly tokensIn: bigint;
  readonly grossCurveSolOutLamports: bigint;
  readonly feeLamports: bigint;
  readonly netWalletInflowLamports: bigint;
  readonly postVSol: bigint;
  readonly postVTok: bigint;
}

export function quotePumpSell(
  tokensIn: bigint,
  vSol: bigint,
  vTok: bigint,
  feeBps = 100n,
): PumpSellQuote {
  if (tokensIn <= 0n || vSol <= 0n || vTok <= 0n) {
    return {
      tokensIn: 0n,
      grossCurveSolOutLamports: 0n,
      feeLamports: 0n,
      netWalletInflowLamports: 0n,
      postVSol: vSol,
      postVTok: vTok,
    };
  }
  const k = vSol * vTok;
  const postVTok = vTok + tokensIn;
  const postVSol = k / postVTok;
  const grossCurveSolOutLamports = vSol > postVSol ? vSol - postVSol : 0n;
  const feeLamports = (grossCurveSolOutLamports * feeBps) / 10_000n;
  const netWalletInflowLamports =
    grossCurveSolOutLamports > feeLamports ? grossCurveSolOutLamports - feeLamports : 0n;
  return {
    tokensIn,
    grossCurveSolOutLamports,
    feeLamports,
    netWalletInflowLamports,
    postVSol,
    postVTok,
  };
}

export function simulateReboundTrade(
  states: CausalTrajectoryState[],
  rule: ReboundEntryRule,
  exitPolicy: ReboundExitPolicy,
  positionSizeSol = 0.05,
  costScenario: CostScenario = STANDARD_COST_SCENARIOS.medium,
  extraLatencyDelayMs = 0,
  datasetEndMs = Infinity,
  split: "train" | "validation" | "holdout" = "train",
): ReboundTradeExecution | null {
  // Find first causal trigger
  let triggerIndex = -1;
  for (let i = 0; i < states.length; i++) {
    if (rule.predicate(states[i]!)) {
      triggerIndex = i;
      break;
    }
  }

  if (triggerIndex === -1) return null;

  const signalState = states[triggerIndex]!;
  const signalTimeMs = signalState.timestampMs;
  const targetEntryTimeMs = signalTimeMs + extraLatencyDelayMs;

  // Find the first trade state with timestamp >= targetEntryTimeMs
  let entryIndex = triggerIndex;
  while (entryIndex < states.length && states[entryIndex]!.timestampMs < targetEntryTimeMs) {
    entryIndex++;
  }

  if (entryIndex >= states.length) return null;

  const entryState = states[entryIndex]!;
  const entryTimeMs = entryState.timestampMs;

  const posLamports = BigInt(Math.round(positionSizeSol * 1e9));
  const pumpFeeBps = BigInt(costScenario.pumpFeeRateBps ?? 100);

  const buyQuote = quotePumpBuy(
    posLamports,
    entryState.virtualSolLamports,
    entryState.virtualTokenBaseUnits,
    pumpFeeBps,
  );

  if (buyQuote.tokensReceived <= 0n) return null;

  const tokensReceived = buyQuote.tokensReceived;
  const entryFillPrice = Number(posLamports) / Number(tokensReceived);

  // Search forward for exit
  let exitIndex = -1;
  let exitReason: ReboundExitReason = "time-exit";
  let exitTimeMs = entryTimeMs;
  let finalExecutableGrossReturnPct = 0;

  const targetExitTimeMs = entryTimeMs + exitPolicy.maxHoldDurationMs;

  for (let j = entryIndex + 1; j < states.length; j++) {
    const curr = states[j]!;
    const elapsedMs = curr.timestampMs - entryTimeMs;

    // Calculate executable sell quote if selling actual tokensReceived NOW against curr reserve state
    const sellQuote = quotePumpSell(
      tokensReceived,
      curr.virtualSolLamports,
      curr.virtualTokenBaseUnits,
      pumpFeeBps,
    );

    const grossSolOutLamports = sellQuote.grossCurveSolOutLamports;
    const executableGrossReturnPct =
      posLamports > 0n ? Number(grossSolOutLamports - posLamports) / Number(posLamports) : 0;

    // Check Take Profit using executable mark-to-exit value
    if (
      exitPolicy.takeProfitPct !== undefined &&
      executableGrossReturnPct >= exitPolicy.takeProfitPct
    ) {
      exitIndex = j;
      exitReason = "take-profit";
      exitTimeMs = curr.timestampMs;
      finalExecutableGrossReturnPct = executableGrossReturnPct;
      break;
    }

    // Check Stop Loss using executable mark-to-exit value
    if (
      exitPolicy.stopLossPct !== undefined &&
      executableGrossReturnPct <= exitPolicy.stopLossPct
    ) {
      exitIndex = j;
      exitReason = "stop-loss";
      exitTimeMs = curr.timestampMs;
      finalExecutableGrossReturnPct = executableGrossReturnPct;
      break;
    }

    // Check Max Hold Duration
    if (elapsedMs >= exitPolicy.maxHoldDurationMs) {
      exitIndex = j;
      exitReason = "time-exit";
      exitTimeMs = curr.timestampMs;
      finalExecutableGrossReturnPct = executableGrossReturnPct;
      break;
    }
  }

  let isRightCensored = false;

  if (exitIndex === -1) {
    if (targetExitTimeMs > datasetEndMs) {
      // Requested max hold could not be observed because the dataset capture ended
      isRightCensored = true;
      exitReason = "dataset-boundary-censored";
    } else {
      // Dataset continued running past max hold horizon, but token stopped producing trades
      isRightCensored = true;
      exitReason = "trajectory-ended-before-exit-horizon";
    }
    const lastState = states[states.length - 1]!;
    exitTimeMs = lastState.timestampMs;
  }

  // Final sell quote at exit state
  const exitState = exitIndex !== -1 ? states[exitIndex]! : states[states.length - 1]!;
  const exitSellQuote = quotePumpSell(
    tokensReceived,
    exitState.virtualSolLamports,
    exitState.virtualTokenBaseUnits,
    pumpFeeBps,
  );

  const grossSolReceivedLamports = exitSellQuote.grossCurveSolOutLamports;
  const grossSolReceived = Number(grossSolReceivedLamports) / 1e9;
  const grossPnlSol = grossSolReceived - positionSizeSol;

  if (exitIndex === -1) {
    finalExecutableGrossReturnPct =
      posLamports > 0n
        ? Number(grossSolReceivedLamports - posLamports) / Number(posLamports)
        : 0;
  }

  // Exact fee decomposition:
  // Buy pump fee + Sell pump fee
  const entryPumpFeeSol = Number(buyQuote.feeLamports) / 1e9;
  const exitPumpFeeSol = Number(exitSellQuote.feeLamports) / 1e9;
  const totalPumpFeeSol = entryPumpFeeSol + exitPumpFeeSol;

  // Solana base fee, priority fee, and Jito tip
  const baseFeeSol = Number(costScenario.baseFeeLamports ?? 0) / 1e9;
  const priorityFeeSol = Number(costScenario.priorityFeeLamports ?? 0) / 1e9;
  const jitoTipSol = Number(costScenario.jitoTipLamports ?? 0) / 1e9;

  const totalFeesSol =
    totalPumpFeeSol +
    baseFeeSol +
    priorityFeeSol +
    jitoTipSol;

  const netPnlSol = grossPnlSol - totalFeesSol;
  const returnPct = positionSizeSol > 0 ? (netPnlSol / positionSizeSol) * 100 : 0;
  const exitFillPrice =
    tokensReceived > 0n ? Number(grossSolReceivedLamports) / Number(tokensReceived) : entryFillPrice;

  return {
    mint: signalState.mint,
    ruleName: rule.name,
    exitPolicyName: exitPolicy.name,
    signalTimestampMs: signalTimeMs,
    entryTimestampMs: entryTimeMs,
    exitTimestampMs: exitTimeMs,
    holdDurationMs: exitTimeMs - entryTimeMs,
    positionSizeSol,
    entryVirtualSol: entryState.virtualSolLamports,
    entryVirtualToken: entryState.virtualTokenBaseUnits,
    tokensReceived,
    entryFillPrice,
    exitFillPrice,
    exitReason,
    executableGrossReturnPct: finalExecutableGrossReturnPct * 100,
    grossPnlSol,
    netPnlSol,
    returnPct,
    totalFeesSol,
    isRightCensored,
    split,
  };
}

export function evaluateReboundAcrossSplits(
  tokenTrajectories: { mint: string; states: CausalTrajectoryState[]; launchMs: number }[],
  rule: ReboundEntryRule,
  exitPolicy: ReboundExitPolicy,
  positionSizeSol = 0.05,
  costScenario: CostScenario = STANDARD_COST_SCENARIOS.medium,
  extraLatencyDelayMs = 0,
  datasetEndMs = Infinity,
): ReboundEvaluationSummary[] {
  const n = tokenTrajectories.length;
  const nTrain = Math.floor(n * 0.6);
  const nVal = Math.floor(n * 0.2);

  const trainSet = tokenTrajectories.slice(0, nTrain);
  const valSet = tokenTrajectories.slice(nTrain, nTrain + nVal);
  const holdoutSet = tokenTrajectories.slice(nTrain + nVal);
  const combinedSet = tokenTrajectories;

  const splits = [
    { split: "train" as const, data: trainSet },
    { split: "validation" as const, data: valSet },
    { split: "holdout" as const, data: holdoutSet },
    { split: "combined" as const, data: combinedSet },
  ];

  return splits.map(({ split, data }) => {
    const eligibleTokens = data.length;
    const executions: ReboundTradeExecution[] = [];

    for (const item of data) {
      const exec = simulateReboundTrade(
        item.states,
        rule,
        exitPolicy,
        positionSizeSol,
        costScenario,
        extraLatencyDelayMs,
        datasetEndMs,
        split === "combined" ? "train" : split,
      );
      if (exec) executions.push(exec);
    }

    const selectedTrades = executions.length;
    const selectionRatePct = eligibleTokens > 0 ? (selectedTrades / eligibleTokens) * 100 : 0;

    // Granular right-censoring distinction:
    // A: dataset boundary censored
    // B: trajectory ended before exit horizon
    const datasetBoundaryCensoredTrades = executions.filter(
      (e) => e.exitReason === "dataset-boundary-censored",
    ).length;
    const trajectoryEndedCensoredTrades = executions.filter(
      (e) => e.exitReason === "trajectory-ended-before-exit-horizon",
    ).length;
    const censoredTrades = datasetBoundaryCensoredTrades + trajectoryEndedCensoredTrades;

    // Primary completed PnL metrics strictly exclude all right-censored trades
    const completedTradesList = executions.filter((e) => !e.isRightCensored);
    const completedTrades = completedTradesList.length;

    const wins = completedTradesList.filter((e) => e.netPnlSol > 0).length;
    const losses = completedTradesList.filter((e) => e.netPnlSol <= 0).length;
    const winRatePct = completedTrades > 0 ? (wins / completedTrades) * 100 : 0;

    const totalGrossPnlSol = completedTradesList.reduce((sum, e) => sum + e.grossPnlSol, 0);
    const totalNetPnlSol = completedTradesList.reduce((sum, e) => sum + e.netPnlSol, 0);

    const evPerEligibleTokenSol = eligibleTokens > 0 ? totalNetPnlSol / eligibleTokens : 0;
    const evPerSelectedTradeSol = completedTrades > 0 ? totalNetPnlSol / completedTrades : 0;

    // Percentiles and median
    const sortedNet = [...completedTradesList.map((e) => e.netPnlSol)].sort((a, b) => a - b);
    const medianTradePnlSol =
      sortedNet.length > 0 ? sortedNet[Math.floor(sortedNet.length * 0.5)]! : 0;
    const p5PnlSol = sortedNet.length > 0 ? sortedNet[Math.floor(sortedNet.length * 0.05)]! : 0;
    const p25PnlSol = sortedNet.length > 0 ? sortedNet[Math.floor(sortedNet.length * 0.25)]! : 0;
    const p75PnlSol = sortedNet.length > 0 ? sortedNet[Math.floor(sortedNet.length * 0.75)]! : 0;
    const p95PnlSol = sortedNet.length > 0 ? sortedNet[Math.floor(sortedNet.length * 0.95)]! : 0;

    // Drawdown and holding time
    let peakCumulative = 0;
    let runningCumulative = 0;
    let maxDrawdownSol = 0;
    for (const e of completedTradesList) {
      runningCumulative += e.netPnlSol;
      if (runningCumulative > peakCumulative) peakCumulative = runningCumulative;
      const dd = peakCumulative - runningCumulative;
      if (dd > maxDrawdownSol) maxDrawdownSol = dd;
    }

    const averageHoldingTimeSec =
      completedTrades > 0
        ? completedTradesList.reduce((sum, e) => sum + e.holdDurationMs / 1000, 0) /
          completedTrades
        : 0;

    const winTrades = completedTradesList.filter((e) => e.netPnlSol > 0);
    const lossTrades = completedTradesList.filter((e) => e.netPnlSol < 0);
    const grossWinsTotal = winTrades.reduce((sum, e) => sum + e.netPnlSol, 0);
    const grossLossTotal = Math.abs(lossTrades.reduce((sum, e) => sum + e.netPnlSol, 0));

    const profitFactor =
      grossLossTotal > 0 ? grossWinsTotal / grossLossTotal : grossWinsTotal > 0 ? 10 : 0;
    const averageWinSol = winTrades.length > 0 ? grossWinsTotal / winTrades.length : 0;
    const averageLossSol = lossTrades.length > 0 ? grossLossTotal / lossTrades.length : 0;

    // Outlier calculation: top 1% and 5%
    const sortedDesc = [...completedTradesList].sort((a, b) => b.netPnlSol - a.netPnlSol);
    const totalPosProfit = sortedDesc
      .filter((e) => e.netPnlSol > 0)
      .reduce((sum, e) => sum + e.netPnlSol, 0);

    const nTop1 = Math.max(1, Math.round(sortedDesc.length * 0.01));
    const nTop5 = Math.max(1, Math.round(sortedDesc.length * 0.05));

    const top1Profit = sortedDesc
      .slice(0, nTop1)
      .reduce((sum, e) => sum + (e.netPnlSol > 0 ? e.netPnlSol : 0), 0);
    const top5Profit = sortedDesc
      .slice(0, nTop5)
      .reduce((sum, e) => sum + (e.netPnlSol > 0 ? e.netPnlSol : 0), 0);

    const top1PctProfitShare = totalPosProfit > 0 ? (top1Profit / totalPosProfit) * 100 : 0;
    const top5PctProfitShare = totalPosProfit > 0 ? (top5Profit / totalPosProfit) * 100 : 0;

    const netExTop1ProfitSol = totalNetPnlSol - top1Profit;
    const netExTop5ProfitSol = totalNetPnlSol - top5Profit;

    const passedHoldoutGate = evPerSelectedTradeSol > 0 && netExTop5ProfitSol > 0;

    return {
      ruleName: rule.name,
      exitPolicyName: exitPolicy.name,
      positionSizeSol,
      costTier: costScenario.name,
      extraLatencyDelayMs,
      split,
      eligibleTokens,
      selectedTrades,
      censoredTrades,
      datasetBoundaryCensoredTrades,
      trajectoryEndedCensoredTrades,
      completedTrades,
      selectionRatePct,
      wins,
      losses,
      winRatePct,
      totalGrossPnlSol,
      totalNetPnlSol,
      evPerEligibleTokenSol,
      evPerSelectedTradeSol,
      medianTradePnlSol,
      p5PnlSol,
      p25PnlSol,
      p75PnlSol,
      p95PnlSol,
      maxDrawdownSol,
      averageHoldingTimeSec,
      profitFactor,
      averageWinSol,
      averageLossSol,
      top1PctProfitShare,
      top5PctProfitShare,
      netExTop1ProfitSol,
      netExTop5ProfitSol,
      passedHoldoutGate,
    };
  });
}

/**
 * Deterministically selects the best candidate rule using ONLY training (60%) and validation (20%) data.
 * Holdout data is NEVER accessed or used in this decision.
 *
 * Selection hierarchy:
 * 1. Highest combined train+validation Net EV
 * 2. Break ties by validation Net EV
 * 3. Break remaining ties by larger completed trade count
 * 4. Deterministic lexical tie-breaker by rule name
 */
export function selectBestTrainValRule(
  candidateRules: readonly ReboundEntryRule[],
  evaluations: readonly ReboundEvaluationSummary[],
): {
  selectedRule: ReboundEntryRule;
  trainEv: number;
  valEv: number;
  trainValEv: number;
  trainValCompletedTrades: number;
  rankedCandidates: readonly {
    rule: ReboundEntryRule;
    trainEv: number;
    valEv: number;
    trainValEv: number;
    trainValCompletedTrades: number;
  }[];
} {
  const candidatesStats = candidateRules.map((rule) => {
    const trainEval = evaluations.find(
      (e) => e.ruleName === rule.name && e.split === "train",
    );
    const valEval = evaluations.find(
      (e) => e.ruleName === rule.name && e.split === "validation",
    );

    const trainCompleted = trainEval?.completedTrades ?? 0;
    const valCompleted = valEval?.completedTrades ?? 0;
    const trainValCompletedTrades = trainCompleted + valCompleted;

    const trainNetPnl = trainEval?.totalNetPnlSol ?? 0;
    const valNetPnl = valEval?.totalNetPnlSol ?? 0;
    const trainValTotalNetPnl = trainNetPnl + valNetPnl;

    const trainEv = trainCompleted > 0 ? trainNetPnl / trainCompleted : 0;
    const valEv = valCompleted > 0 ? valNetPnl / valCompleted : 0;
    const trainValEv =
      trainValCompletedTrades > 0 ? trainValTotalNetPnl / trainValCompletedTrades : -Infinity;

    return {
      rule,
      trainEv,
      valEv,
      trainValEv,
      trainValCompletedTrades,
    };
  });

  const sorted = [...candidatesStats].sort((a, b) => {
    if (Math.abs(b.trainValEv - a.trainValEv) > 1e-9) {
      return b.trainValEv - a.trainValEv;
    }
    if (Math.abs(b.valEv - a.valEv) > 1e-9) {
      return b.valEv - a.valEv;
    }
    if (b.trainValCompletedTrades !== a.trainValCompletedTrades) {
      return b.trainValCompletedTrades - a.trainValCompletedTrades;
    }
    return a.rule.name.localeCompare(b.rule.name);
  });

  const best = sorted[0]!;
  return {
    selectedRule: best.rule,
    trainEv: best.trainEv,
    valEv: best.valEv,
    trainValEv: best.trainValEv,
    trainValCompletedTrades: best.trainValCompletedTrades,
    rankedCandidates: sorted,
  };
}
