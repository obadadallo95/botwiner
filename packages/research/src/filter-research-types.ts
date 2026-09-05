export type CausalFeatureCutoff = "launch" | "25ms" | "50ms" | "100ms" | "200ms";

export interface CausalLaunchFeatures {
  readonly mint: string;
  readonly launchTimeUnixMs: number;
  readonly launchSlot: number;
  // A. Available at Launch (0ms)
  readonly creatorBuySol: number;
  readonly hasCreatorBuy: boolean;
  readonly creatorTokenAllocPct: number;
  readonly nameLen: number;
  readonly symbolLen: number;
  readonly hasUri: boolean;
  readonly isIpfsUri: boolean;
  readonly isToken2022: boolean;
  readonly creatorIsSubmitter: boolean;
  // B. Available within <=25ms
  readonly buysCount_25ms: number;
  readonly buyVolSol_25ms: number;
  // C. Available within <=50ms
  readonly buysCount_50ms: number;
  readonly buyVolSol_50ms: number;
  // D. Available within <=100ms
  readonly buysCount_100ms: number;
  readonly buyVolSol_100ms: number;
  // E. Available within <=200ms
  readonly buysCount_200ms: number;
  readonly buyVolSol_200ms: number;
}

export interface PreFilterRule {
  readonly name: string;
  readonly allowedCutoff: CausalFeatureCutoff;
  readonly predicate: (features: CausalLaunchFeatures) => boolean;
}

export interface FilterEvaluationResult {
  readonly ruleName: string;
  readonly latencyMs: number;
  readonly split: "train" | "validation" | "holdout" | "combined";
  readonly totalLaunchesInSplit: number;
  readonly selectedLaunches: number;
  readonly selectionRatePct: number;
  readonly tradeCount: number;
  readonly wins: number;
  readonly losses: number;
  readonly winRatePct: number;
  readonly totalGrossPnlSol: number;
  readonly totalNetPnlSol: number;
  readonly grossEvPerSelectedSol: number;
  readonly netEvPerSelectedSol: number;
  readonly netEvPerAttemptedSol: number;
  readonly top5PctProfitShare: number;
  readonly netExTop5ProfitSol: number;
  readonly passedHoldoutGate: boolean;
}

export interface FeatureCorrelationRecord {
  readonly featureName: string;
  readonly coverage: number;
  readonly winnerMean: number;
  readonly loserMean: number;
  readonly winnerMedian: number;
  readonly loserMedian: number;
  readonly difference: number;
}

export interface FilterResearchReport {
  readonly datasetPath: string;
  readonly totalLaunches: number;
  readonly splitSizes: {
    readonly train: number;
    readonly validation: number;
    readonly holdout: number;
  };
  readonly univariateSignals: readonly FeatureCorrelationRecord[];
  readonly evaluations: readonly FilterEvaluationResult[];
  readonly decisionGate:
    | "SELECTIVE EDGE FOUND"
    | "WEAK EDGE / MORE DATA NEEDED"
    | "EDGE ONLY BELOW 25ms"
    | "NO USEFUL PRE-FILTER"
    | "DATA/MODEL INSUFFICIENT";
  readonly rationale: string;
}
