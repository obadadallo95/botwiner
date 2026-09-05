export type FillModel = "executable-curve" | "price-path-proxy";

export type ExitPolicy =
  | { readonly type: "time"; readonly holdDurationMs: number }
  | {
      readonly type: "tp-sl";
      readonly takeProfitPct: number;
      readonly stopLossPct: number;
      readonly maxHoldDurationMs: number;
    };

export interface CostScenario {
  readonly name: "zero" | "low" | "medium" | "high";
  readonly pumpFeeRateBps: number; // e.g. 100 bps = 1%
  readonly baseFeeLamports: number; // e.g. 10,000 for 2 txs
  readonly priorityFeeLamports: number; // e.g. 20,000 for 2 txs
  readonly jitoTipLamports: number; // e.g. 0 to 10,000,000
}

export interface SimulationScenario {
  readonly latencyMs: number;
  readonly exitPolicy: ExitPolicy;
  readonly positionSizeSol: number;
  readonly fillModel: FillModel;
  readonly costScenario: CostScenario;
}

export interface FeeDecomposition {
  readonly pumpFeeSol: number;
  readonly baseFeeSol: number;
  readonly priorityFeeSol: number;
  readonly jitoTipSol: number;
  readonly totalFeesSol: number;
}

export interface TradeSimulationResult {
  readonly mint: string;
  readonly launchTimeUnixMs: number;
  readonly entryTimeUnixMs: number;
  readonly exitTimeUnixMs: number;
  readonly entrySlot: number;
  readonly exitSlot: number;
  readonly filled: boolean;
  readonly unfillableReason: string | null;
  readonly positionSizeSol: number;
  readonly tokensAcquired: string; // Base units BigInt string
  readonly grossSolOut: number;
  readonly grossPnlSol: number;
  readonly netPnlSol: number;
  readonly returnPct: number;
  readonly exitTrigger: "time" | "take-profit" | "stop-loss" | "unfilled";
  readonly fees: FeeDecomposition;
}

export interface DistributionPercentiles {
  readonly p5: number;
  readonly p25: number;
  readonly p50: number;
  readonly p75: number;
  readonly p95: number;
}

export interface OutlierConcentration {
  readonly top1PctProfitShare: number;
  readonly top5PctProfitShare: number;
  readonly top10PctProfitShare: number;
  readonly netProfitExcludingTop5PctSol: number;
}

export type FailureAttributionCategory =
  | "no-gross-edge"
  | "fees-remove-edge"
  | "slippage-removes-edge"
  | "latency-removes-edge"
  | "fill-rate-too-low"
  | "extreme-outliers-fake-profitability"
  | "dataset-insufficient"
  | "viable-edge";

export interface ScenarioMetrics {
  readonly scenario: SimulationScenario;
  readonly launchCount: number;
  readonly eligibleLaunches: number;
  readonly missedLaunches: number;
  readonly tradeCount: number;
  readonly fillRatePct: number;
  readonly wins: number;
  readonly losses: number;
  readonly winRatePct: number;
  readonly grossPnlTotalSol: number;
  readonly netPnlTotalSol: number;
  readonly averagePnlPerLaunchSol: number;
  readonly medianPnlSol: number;
  readonly expectedValuePerAttemptedSol: number;
  readonly expectedValuePerFilledSol: number;
  readonly percentiles: DistributionPercentiles;
  readonly maxDrawdownSol: number;
  readonly outliers: OutlierConcentration;
  readonly attribution: FailureAttributionCategory;
}

export interface ChronologicalSplitEvaluation {
  readonly exploratory: ScenarioMetrics;
  readonly validation: ScenarioMetrics;
  readonly combined: ScenarioMetrics;
}

export interface HistoricalLaunchData {
  readonly mint: string;
  readonly launchTimeUnixMs: number;
  readonly launchSlot: number;
  readonly signature: string;
  readonly initialVirtualToken: bigint;
  readonly initialVirtualSol: bigint;
  readonly trades: readonly HistoricalTradePoint[];
}

export interface HistoricalTradePoint {
  readonly signature: string;
  readonly isLaunchTx: boolean;
  readonly recvUnixMs: number;
  readonly slot: number;
  readonly side: "buy" | "sell";
  readonly quoteBaseUnits: bigint;
  readonly tokenBaseUnits: bigint;
  readonly virtualToken: bigint;
  readonly virtualSol: bigint;
}
