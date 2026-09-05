import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import type {
  ChronologicalSplitEvaluation,
  CostScenario,
  FailureAttributionCategory,
  HistoricalLaunchData,
  HistoricalTradePoint,
  OutlierConcentration,
  ScenarioMetrics,
  SimulationScenario,
  TradeSimulationResult,
} from "./simulation-types.js";

export const PUMP_CURVE_INITIAL_VIRTUAL_TOKEN = 1_073_000_000_000_000n;
export const PUMP_CURVE_INITIAL_VIRTUAL_SOL = 30_000_000_000n;
export const LAMPORTS_PER_SOL = 1_000_000_000n;

export const STANDARD_COST_SCENARIOS: Record<CostScenario["name"], CostScenario> = {
  zero: {
    name: "zero",
    pumpFeeRateBps: 0,
    baseFeeLamports: 0,
    priorityFeeLamports: 0,
    jitoTipLamports: 0,
  },
  low: {
    name: "low",
    pumpFeeRateBps: 100, // 1%
    baseFeeLamports: 10_000, // 2 txs * 5,000 lamports
    priorityFeeLamports: 2_000, // 2 txs * 1,000 lamports
    jitoTipLamports: 0,
  },
  medium: {
    name: "medium",
    pumpFeeRateBps: 100, // 1%
    baseFeeLamports: 10_000,
    priorityFeeLamports: 20_000,
    jitoTipLamports: 200_000, // 0.0002 SOL
  },
  high: {
    name: "high",
    pumpFeeRateBps: 100, // 1%
    baseFeeLamports: 10_000,
    priorityFeeLamports: 200_000,
    jitoTipLamports: 2_000_000, // 0.002 SOL
  },
};

export async function loadHistoricalLaunches(eventsJsonlPath: string): Promise<HistoricalLaunchData[]> {
  const rl = createInterface({
    input: createReadStream(eventsJsonlPath),
    crlfDelay: Infinity,
  });

  const launchMap = new Map<string, {
    mint: string;
    launchTimeUnixMs: number;
    launchSlot: number;
    signature: string;
    initialVirtualToken: bigint;
    initialVirtualSol: bigint;
    trades: HistoricalTradePoint[];
  }>();

  for await (const line of rl) {
    if (!line.trim()) continue;
    const ev = JSON.parse(line) as {
      eventType?: string;
      tokenMint?: string;
      signature?: string;
      ordering?: { slot?: number };
      timestamps?: { collectorReceivedAtUnixMs?: number };
      reserves?: { virtualTokenBaseUnits?: string; virtualSolLamports?: string };
      side?: "buy" | "sell";
      amounts?: { quoteBaseUnits?: string; tokenBaseUnits?: string };
    };

    if (!ev.tokenMint || !ev.signature || !ev.timestamps?.collectorReceivedAtUnixMs || !ev.ordering?.slot) {
      continue;
    }

    if (ev.eventType === "launch") {
      const vToken = ev.reserves?.virtualTokenBaseUnits ? BigInt(ev.reserves.virtualTokenBaseUnits) : PUMP_CURVE_INITIAL_VIRTUAL_TOKEN;
      const vSol = ev.reserves?.virtualSolLamports ? BigInt(ev.reserves.virtualSolLamports) : PUMP_CURVE_INITIAL_VIRTUAL_SOL;

      launchMap.set(ev.tokenMint, {
        mint: ev.tokenMint,
        launchTimeUnixMs: ev.timestamps.collectorReceivedAtUnixMs,
        launchSlot: ev.ordering.slot,
        signature: ev.signature,
        initialVirtualToken: vToken,
        initialVirtualSol: vSol,
        trades: [],
      });
    } else if (ev.eventType === "trade") {
      const launch = launchMap.get(ev.tokenMint);
      if (launch !== undefined && ev.reserves?.virtualTokenBaseUnits && ev.reserves?.virtualSolLamports) {
        launch.trades.push({
          signature: ev.signature,
          isLaunchTx: ev.signature === launch.signature,
          recvUnixMs: ev.timestamps.collectorReceivedAtUnixMs,
          slot: ev.ordering.slot,
          side: ev.side ?? "buy",
          quoteBaseUnits: BigInt(ev.amounts?.quoteBaseUnits ?? "0"),
          tokenBaseUnits: BigInt(ev.amounts?.tokenBaseUnits ?? "0"),
          virtualToken: BigInt(ev.reserves.virtualTokenBaseUnits),
          virtualSol: BigInt(ev.reserves.virtualSolLamports),
        });
      }
    }
  }

  const launches = Array.from(launchMap.values()).map((l) => ({
    mint: l.mint,
    launchTimeUnixMs: l.launchTimeUnixMs,
    launchSlot: l.launchSlot,
    signature: l.signature,
    initialVirtualToken: l.initialVirtualToken,
    initialVirtualSol: l.initialVirtualSol,
    trades: l.trades,
  }));

  // Ensure chronological order
  launches.sort((a, b) => a.launchTimeUnixMs - b.launchTimeUnixMs);
  return launches;
}

export function simulateTrade(
  launch: HistoricalLaunchData,
  scenario: SimulationScenario,
): TradeSimulationResult {
  const sizeLamports = BigInt(Math.round(scenario.positionSizeSol * Number(LAMPORTS_PER_SOL)));
  const entryTargetUnixMs = launch.launchTimeUnixMs + scenario.latencyMs;

  // Causal filtering: Only trades observable before or at entry time can be seen at decision time
  const observableTradesAtEntry = launch.trades.filter((t) => t.recvUnixMs <= entryTargetUnixMs);

  let entryReserves: { vToken: bigint; vSol: bigint; slot: number };
  if (observableTradesAtEntry.length > 0) {
    const lastTrade = observableTradesAtEntry[observableTradesAtEntry.length - 1]!;
    entryReserves = {
      vToken: lastTrade.virtualToken,
      vSol: lastTrade.virtualSol,
      slot: lastTrade.slot,
    };
  } else {
    entryReserves = {
      vToken: launch.initialVirtualToken,
      vSol: launch.initialVirtualSol,
      slot: launch.launchSlot,
    };
  }

  if (entryReserves.vToken <= 0n || entryReserves.vSol <= 0n) {
    return makeUnfilledResult(launch, scenario, "invalid-initial-reserves");
  }

  // 1. ENTRY BUY
  let tokensAcquired: bigint;
  let postEntryReserves: { vToken: bigint; vSol: bigint };
  let entryPumpFeeLamports = 0n;

  if (scenario.fillModel === "executable-curve") {
    const feeRate = BigInt(scenario.costScenario.pumpFeeRateBps);
    const entrySolIn = (sizeLamports * (10_000n - feeRate)) / 10_000n;
    entryPumpFeeLamports = sizeLamports - entrySolIn;

    const k = entryReserves.vToken * entryReserves.vSol;
    const nextVSol = entryReserves.vSol + entrySolIn;
    const nextVToken = k / nextVSol;
    tokensAcquired = entryReserves.vToken - nextVToken;
    postEntryReserves = { vToken: nextVToken, vSol: nextVSol };
  } else {
    // Price-path proxy without size slippage
    const priceSolPerToken = Number(entryReserves.vSol) / Number(entryReserves.vToken);
    tokensAcquired = BigInt(Math.floor(Number(sizeLamports) / priceSolPerToken));
    postEntryReserves = entryReserves;
    entryPumpFeeLamports = (sizeLamports * BigInt(scenario.costScenario.pumpFeeRateBps)) / 10_000n;
  }

  if (tokensAcquired <= 0n) {
    return makeUnfilledResult(launch, scenario, "zero-tokens-acquired");
  }

  // 2. EXIT EVALUATION
  let exitTargetUnixMs: number;
  let exitTrigger: "time" | "take-profit" | "stop-loss" = "time";
  let chosenExitReserves: { vToken: bigint; vSol: bigint; slot: number };

  if (scenario.exitPolicy.type === "time") {
    exitTargetUnixMs = entryTargetUnixMs + scenario.exitPolicy.holdDurationMs;
    const observableAtExit = launch.trades.filter((t) => t.recvUnixMs <= exitTargetUnixMs);
    if (observableAtExit.length > 0) {
      const last = observableAtExit[observableAtExit.length - 1]!;
      chosenExitReserves = { vToken: last.virtualToken, vSol: last.virtualSol, slot: last.slot };
    } else {
      chosenExitReserves = { ...postEntryReserves, slot: entryReserves.slot };
    }
  } else {
    // TP / SL dynamic exit
    const policy = scenario.exitPolicy;
    const maxExitUnixMs = entryTargetUnixMs + policy.maxHoldDurationMs;
    exitTargetUnixMs = maxExitUnixMs;

    // Filter trades in the open holding window
    const windowTrades = launch.trades.filter(
      (t) => t.recvUnixMs >= entryTargetUnixMs && t.recvUnixMs <= maxExitUnixMs,
    );

    let triggered = false;
    chosenExitReserves = { ...postEntryReserves, slot: entryReserves.slot };

    for (const trade of windowTrades) {
      const currentGrossOut = computeGrossSolOut(tokensAcquired, trade.virtualToken, trade.virtualSol, scenario.fillModel);
      const grossPnl = Number(currentGrossOut - sizeLamports) / Number(LAMPORTS_PER_SOL);
      const returnPct = (grossPnl / scenario.positionSizeSol) * 100;

      if (returnPct >= policy.takeProfitPct) {
        chosenExitReserves = { vToken: trade.virtualToken, vSol: trade.virtualSol, slot: trade.slot };
        exitTargetUnixMs = trade.recvUnixMs;
        exitTrigger = "take-profit";
        triggered = true;
        break;
      }
      if (returnPct <= policy.stopLossPct) {
        chosenExitReserves = { vToken: trade.virtualToken, vSol: trade.virtualSol, slot: trade.slot };
        exitTargetUnixMs = trade.recvUnixMs;
        exitTrigger = "stop-loss";
        triggered = true;
        break;
      }
    }

    if (!triggered) {
      const allTradesUpToMax = launch.trades.filter((t) => t.recvUnixMs <= maxExitUnixMs);
      if (allTradesUpToMax.length > 0) {
        const last = allTradesUpToMax[allTradesUpToMax.length - 1]!;
        chosenExitReserves = { vToken: last.virtualToken, vSol: last.virtualSol, slot: last.slot };
      }
    }
  }

  // 3. EXECUTE EXIT SELL
  const grossSolOutLamports = computeGrossSolOut(
    tokensAcquired,
    chosenExitReserves.vToken,
    chosenExitReserves.vSol,
    scenario.fillModel,
  );

  const exitPumpFeeLamports = (grossSolOutLamports * BigInt(scenario.costScenario.pumpFeeRateBps)) / 10_000n;
  const totalPumpFeeSol = Number(entryPumpFeeLamports + exitPumpFeeLamports) / Number(LAMPORTS_PER_SOL);
  const baseFeeSol = scenario.costScenario.baseFeeLamports / Number(LAMPORTS_PER_SOL);
  const prioFeeSol = scenario.costScenario.priorityFeeLamports / Number(LAMPORTS_PER_SOL);
  const jitoTipSol = scenario.costScenario.jitoTipLamports / Number(LAMPORTS_PER_SOL);
  const totalFeesSol = totalPumpFeeSol + baseFeeSol + prioFeeSol + jitoTipSol;

  const grossSolOut = Number(grossSolOutLamports) / Number(LAMPORTS_PER_SOL);
  const grossPnlSol = grossSolOut - scenario.positionSizeSol;
  const netPnlSol = grossPnlSol - totalFeesSol;
  const returnPct = (netPnlSol / scenario.positionSizeSol) * 100;

  return {
    mint: launch.mint,
    launchTimeUnixMs: launch.launchTimeUnixMs,
    entryTimeUnixMs: entryTargetUnixMs,
    exitTimeUnixMs: exitTargetUnixMs,
    entrySlot: entryReserves.slot,
    exitSlot: chosenExitReserves.slot,
    filled: true,
    unfillableReason: null,
    positionSizeSol: scenario.positionSizeSol,
    tokensAcquired: tokensAcquired.toString(),
    grossSolOut,
    grossPnlSol,
    netPnlSol,
    returnPct,
    exitTrigger,
    fees: {
      pumpFeeSol: totalPumpFeeSol,
      baseFeeSol,
      priorityFeeSol: prioFeeSol,
      jitoTipSol,
      totalFeesSol,
    },
  };
}

function computeGrossSolOut(
  tokens: bigint,
  curveVToken: bigint,
  curveVSol: bigint,
  fillModel: "executable-curve" | "price-path-proxy",
): bigint {
  if (fillModel === "executable-curve") {
    const k = curveVToken * curveVSol;
    const nextVToken = curveVToken + tokens;
    const nextVSol = k / nextVToken;
    return curveVSol > nextVSol ? curveVSol - nextVSol : 0n;
  }
  const priceSolPerToken = Number(curveVSol) / Number(curveVToken);
  return BigInt(Math.max(0, Math.floor(Number(tokens) * priceSolPerToken)));
}

function makeUnfilledResult(
  launch: HistoricalLaunchData,
  scenario: SimulationScenario,
  reason: string,
): TradeSimulationResult {
  return {
    mint: launch.mint,
    launchTimeUnixMs: launch.launchTimeUnixMs,
    entryTimeUnixMs: launch.launchTimeUnixMs + scenario.latencyMs,
    exitTimeUnixMs: launch.launchTimeUnixMs + scenario.latencyMs,
    entrySlot: launch.launchSlot,
    exitSlot: launch.launchSlot,
    filled: false,
    unfillableReason: reason,
    positionSizeSol: scenario.positionSizeSol,
    tokensAcquired: "0",
    grossSolOut: 0,
    grossPnlSol: 0,
    netPnlSol: 0,
    returnPct: 0,
    exitTrigger: "unfilled",
    fees: {
      pumpFeeSol: 0,
      baseFeeSol: 0,
      priorityFeeSol: 0,
      jitoTipSol: 0,
      totalFeesSol: 0,
    },
  };
}

export function calculateScenarioMetrics(
  results: readonly TradeSimulationResult[],
  scenario: SimulationScenario,
): ScenarioMetrics {
  const launchCount = results.length;
  const eligibleResults = results.filter((r) => r.unfillableReason !== "invalid-initial-reserves");
  const filledResults = eligibleResults.filter((r) => r.filled);

  const eligibleLaunches = eligibleResults.length;
  const missedLaunches = eligibleLaunches - filledResults.length;
  const tradeCount = filledResults.length;
  const fillRatePct = eligibleLaunches > 0 ? (tradeCount / eligibleLaunches) * 100 : 0;

  const wins = filledResults.filter((r) => r.netPnlSol > 0).length;
  const losses = filledResults.filter((r) => r.netPnlSol <= 0).length;
  const winRatePct = tradeCount > 0 ? (wins / tradeCount) * 100 : 0;

  const grossPnlTotalSol = filledResults.reduce((sum, r) => sum + r.grossPnlSol, 0);
  const netPnlTotalSol = filledResults.reduce((sum, r) => sum + r.netPnlSol, 0);

  const averagePnlPerLaunchSol = eligibleLaunches > 0 ? netPnlTotalSol / eligibleLaunches : 0;
  const expectedValuePerAttemptedSol = averagePnlPerLaunchSol;
  const expectedValuePerFilledSol = tradeCount > 0 ? netPnlTotalSol / tradeCount : 0;

  const sortedNetPnl = filledResults.map((r) => r.netPnlSol).sort((a, b) => a - b);
  const medianPnlSol = calculateQuantile(sortedNetPnl, 0.5);

  const percentiles = {
    p5: calculateQuantile(sortedNetPnl, 0.05),
    p25: calculateQuantile(sortedNetPnl, 0.25),
    p50: medianPnlSol,
    p75: calculateQuantile(sortedNetPnl, 0.75),
    p95: calculateQuantile(sortedNetPnl, 0.95),
  };

  // Max Drawdown calculation over sequential launches
  let peak = 0;
  let running = 0;
  let maxDrawdownSol = 0;
  for (const r of filledResults) {
    running += r.netPnlSol;
    if (running > peak) peak = running;
    const drawdown = peak - running;
    if (drawdown > maxDrawdownSol) maxDrawdownSol = drawdown;
  }

  // Outlier concentration analysis
  const outliers = computeOutlierConcentration(filledResults);

  // Failure attribution classification
  const attribution = classifyFailureAttribution({
    eligibleLaunches,
    fillRatePct,
    grossPnlTotalSol,
    netPnlTotalSol,
    latencyMs: scenario.latencyMs,
    fillModel: scenario.fillModel,
    outliers,
  });

  return {
    scenario,
    launchCount,
    eligibleLaunches,
    missedLaunches,
    tradeCount,
    fillRatePct,
    wins,
    losses,
    winRatePct,
    grossPnlTotalSol,
    netPnlTotalSol,
    averagePnlPerLaunchSol,
    medianPnlSol,
    expectedValuePerAttemptedSol,
    expectedValuePerFilledSol,
    percentiles,
    maxDrawdownSol,
    outliers,
    attribution,
  };
}

function calculateQuantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  const position = (sorted.length - 1) * q;
  const base = Math.floor(position);
  const rest = position - base;
  if (sorted[base + 1] !== undefined) {
    return sorted[base]! + rest * (sorted[base + 1]! - sorted[base]!);
  }
  return sorted[base] ?? 0;
}

function computeOutlierConcentration(filled: readonly TradeSimulationResult[]): OutlierConcentration {
  if (filled.length === 0) {
    return {
      top1PctProfitShare: 0,
      top5PctProfitShare: 0,
      top10PctProfitShare: 0,
      netProfitExcludingTop5PctSol: 0,
    };
  }

  // Descending sort by net profit
  const sortedDesc = [...filled].sort((a, b) => b.netPnlSol - a.netPnlSol);
  const positiveTrades = sortedDesc.filter((r) => r.netPnlSol > 0);
  const totalPositiveProfit = positiveTrades.reduce((sum, r) => sum + r.netPnlSol, 0);

  const nTop1 = Math.max(1, Math.round(sortedDesc.length * 0.01));
  const nTop5 = Math.max(1, Math.round(sortedDesc.length * 0.05));
  const nTop10 = Math.max(1, Math.round(sortedDesc.length * 0.1));

  const top1Profit = sortedDesc.slice(0, nTop1).reduce((sum, r) => sum + r.netPnlSol, 0);
  const top5Profit = sortedDesc.slice(0, nTop5).reduce((sum, r) => sum + r.netPnlSol, 0);
  const top10Profit = sortedDesc.slice(0, nTop10).reduce((sum, r) => sum + r.netPnlSol, 0);

  const top1PctProfitShare = totalPositiveProfit > 0 ? (top1Profit / totalPositiveProfit) * 100 : 0;
  const top5PctProfitShare = totalPositiveProfit > 0 ? (top5Profit / totalPositiveProfit) * 100 : 0;
  const top10PctProfitShare = totalPositiveProfit > 0 ? (top10Profit / totalPositiveProfit) * 100 : 0;

  const totalNet = sortedDesc.reduce((sum, r) => sum + r.netPnlSol, 0);
  const netProfitExcludingTop5PctSol = totalNet - top5Profit;

  return {
    top1PctProfitShare,
    top5PctProfitShare,
    top10PctProfitShare,
    netProfitExcludingTop5PctSol,
  };
}

function classifyFailureAttribution(params: {
  eligibleLaunches: number;
  fillRatePct: number;
  grossPnlTotalSol: number;
  netPnlTotalSol: number;
  latencyMs: number;
  fillModel: "executable-curve" | "price-path-proxy";
  outliers: OutlierConcentration;
}): FailureAttributionCategory {
  if (params.eligibleLaunches < 20) {
    return "dataset-insufficient";
  }
  if (params.fillRatePct < 40) {
    return "fill-rate-too-low";
  }
  if (params.grossPnlTotalSol <= 0) {
    return "no-gross-edge";
  }
  if (params.grossPnlTotalSol > 0 && params.netPnlTotalSol <= 0) {
    if (params.latencyMs > 0) {
      return "latency-removes-edge";
    }
    return "fees-remove-edge";
  }
  if (params.netPnlTotalSol > 0 && params.outliers.netProfitExcludingTop5PctSol <= 0) {
    return "extreme-outliers-fake-profitability";
  }
  if (params.netPnlTotalSol > 0) {
    return "viable-edge";
  }
  return "no-gross-edge";
}

export function evaluateChronologicalSplit(
  launches: readonly HistoricalLaunchData[],
  scenario: SimulationScenario,
  splitRatio = 0.5,
): ChronologicalSplitEvaluation {
  const midpoint = Math.floor(launches.length * splitRatio);
  const exploratoryLaunches = launches.slice(0, midpoint);
  const validationLaunches = launches.slice(midpoint);

  const exploratoryResults = exploratoryLaunches.map((l) => simulateTrade(l, scenario));
  const validationResults = validationLaunches.map((l) => simulateTrade(l, scenario));
  const combinedResults = [...exploratoryResults, ...validationResults];

  return {
    exploratory: calculateScenarioMetrics(exploratoryResults, scenario),
    validation: calculateScenarioMetrics(validationResults, scenario),
    combined: calculateScenarioMetrics(combinedResults, scenario),
  };
}
