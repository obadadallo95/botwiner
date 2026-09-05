export interface ReboundPopulationAudit {
  readonly totalLaunchesInDataset: number;
  readonly datasetDurationSec: number;
  readonly launchesWithEarlyPeak: number;
  readonly launchesWithDrawdown30Pct: number;
  readonly rightCensoredLaunches120s: number;
  readonly eligibleLaunches120s: number;
  readonly exclusionReasons: Record<string, number>;
}

export interface CausalTrajectoryState {
  readonly mint: string;
  readonly launchTimeMs: number;
  readonly tradeIndex: number;
  readonly timestampMs: number;
  readonly timeSinceLaunchSec: number;
  readonly price: number;
  readonly virtualSolLamports: bigint;
  readonly virtualTokenBaseUnits: bigint;
  readonly realSolLamports: bigint;
  readonly realTokenBaseUnits: bigint;
  readonly runningPeakPrice: number;
  readonly runningPeakTimeMs: number;
  readonly timeSincePeakSec: number;
  readonly currentDrawdownPct: number;
  readonly localLowPrice: number;
  readonly localLowTimeMs: number;
  readonly noNewLowSec: number;
  readonly microRecoveryPct: number;
  readonly sellsCountTrailing10s: number;
  readonly sellsCountPrior10s: number;
  readonly sellRateDecayRatio: number; // sellsLast10 / sellsPrior10
  readonly sellVolTrailing10sSol: number;
  readonly sellVolPrior10sSol: number;
  readonly sellVolDecayPct: number;
  readonly buysCountTrailing5s: number;
  readonly buysCountTrailing10s: number;
  readonly buyVolTrailing10sSol: number;
  readonly buySellVolRatio10s: number;
  readonly consecutiveBuysCount: number;
  readonly creatorInactiveSec: number;
  readonly creatorSoldEstimatedTokens: number;
  readonly isRightCensoredForHorizon: (horizonMs: number, datasetEndMs: number) => boolean;
}

export interface ReboundEntryRule {
  readonly name: string;
  readonly description: string;
  readonly predicate: (state: CausalTrajectoryState) => boolean;
}

export interface ReboundExitPolicy {
  readonly name: string;
  readonly maxHoldDurationMs: number;
  readonly takeProfitPct?: number; // e.g. 0.20 for +20%
  readonly stopLossPct?: number;   // e.g. -0.10 for -10%
}

export interface ReboundTradeExecution {
  readonly mint: string;
  readonly ruleName: string;
  readonly exitPolicyName: string;
  readonly signalTimestampMs: number;
  readonly entryTimestampMs: number;
  readonly exitTimestampMs: number;
  readonly holdDurationMs: number;
  readonly positionSizeSol: number;
  readonly entryVirtualSol: bigint;
  readonly entryVirtualToken: bigint;
  readonly tokensReceived: bigint;
  readonly entryFillPrice: number;
  readonly exitFillPrice: number;
  readonly exitReason: "take-profit" | "stop-loss" | "time-exit" | "right-censored";
  readonly grossPnlSol: number;
  readonly netPnlSol: number;
  readonly returnPct: number;
  readonly totalFeesSol: number;
  readonly isRightCensored: boolean;
  readonly split: "train" | "validation" | "holdout";
}

export interface ReboundEvaluationSummary {
  readonly ruleName: string;
  readonly exitPolicyName: string;
  readonly positionSizeSol: number;
  readonly costTier: string;
  readonly extraLatencyDelayMs: number;
  readonly split: "train" | "validation" | "holdout" | "combined";
  readonly eligibleTokens: number;
  readonly selectedTrades: number;
  readonly censoredTrades: number;
  readonly completedTrades: number;
  readonly selectionRatePct: number;
  readonly wins: number;
  readonly losses: number;
  readonly winRatePct: number;
  readonly totalGrossPnlSol: number;
  readonly totalNetPnlSol: number;
  readonly evPerEligibleTokenSol: number;
  readonly evPerSelectedTradeSol: number;
  readonly medianTradePnlSol: number;
  readonly p5PnlSol: number;
  readonly p25PnlSol: number;
  readonly p75PnlSol: number;
  readonly p95PnlSol: number;
  readonly maxDrawdownSol: number;
  readonly averageHoldingTimeSec: number;
  readonly profitFactor: number;
  readonly averageWinSol: number;
  readonly averageLossSol: number;
  readonly top1PctProfitShare: number;
  readonly top5PctProfitShare: number;
  readonly netExTop1ProfitSol: number;
  readonly netExTop5ProfitSol: number;
  readonly passedHoldoutGate: boolean;
}

export interface ReboundResearchReport {
  readonly datasetPath: string;
  readonly evaluatedAt: string;
  readonly populationAudit: ReboundPopulationAudit;
  readonly splitSizes: {
    readonly train: number;
    readonly validation: number;
    readonly holdout: number;
  };
  readonly baselineEvaluations: readonly ReboundEvaluationSummary[];
  readonly ruleEvaluations: readonly ReboundEvaluationSummary[];
  readonly costSensitivity: readonly ReboundEvaluationSummary[];
  readonly positionSizeSensitivity: readonly ReboundEvaluationSummary[];
  readonly latencyDelaySensitivity: readonly ReboundEvaluationSummary[];
  readonly exitPolicySensitivity: readonly ReboundEvaluationSummary[];
  readonly outlierRobustness: readonly ReboundEvaluationSummary[];
  readonly failureAttribution: {
    readonly category: string;
    readonly rationale: string;
  };
  readonly decisionGate:
    | "ROBUST REBOUND EDGE FOUND"
    | "PROMISING BUT MORE DATA NEEDED"
    | "EDGE EXISTS BUT REQUIRES FAST EXECUTION"
    | "NO CAUSAL REBOUND EDGE"
    | "DATA INSUFFICIENT";
  readonly rationale: string;
}
