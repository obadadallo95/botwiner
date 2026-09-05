export type PivotCandidate = "graduation" | "rebound" | "momentum";

export interface GraduationAudit {
  readonly totalTokensTracked: number;
  readonly tokensReaching80Sol: number;
  readonly instantBundleGraduations: number;
  readonly organicGraduations: number;
  readonly maxRealSolObserved: number;
  readonly dataSufficiency: "insufficient" | "partial" | "sufficient";
}

export interface ReboundAudit {
  readonly tokensWithEarlyPeak: number;
  readonly tokensWithMajorDrawdown: number;
  readonly rebound10Count: number;
  readonly rebound20Count: number;
  readonly rebound50Count: number;
  readonly dyingCount: number;
  readonly reboundRate20Pct: number;
  readonly medianTimeToTroughSec: number;
  readonly medianTimeToReboundSec: number;
  readonly dataSufficiency: "insufficient" | "partial" | "sufficient";
}

export interface MomentumAudit {
  readonly tokensAliveAt30s: number;
  readonly tokensAliveAt60s: number;
  readonly tokensAliveAt120s: number;
  readonly unconditionedPositiveFwd30to90: number;
  readonly unconditionedEvaluated30to90: number;
  readonly unconditionedWinRatePct: number;
  readonly conditionedPositiveFwd30to90: number;
  readonly conditionedEvaluated30to90: number;
  readonly conditionedWinRatePct: number;
  readonly dataSufficiency: "insufficient" | "partial" | "sufficient";
}

export interface PivotScoreDimension {
  readonly dimension: string;
  readonly graduationScore: number;
  readonly reboundScore: number;
  readonly momentumScore: number;
  readonly rationale: string;
}

export interface PivotRankingEntry {
  readonly pivot: PivotCandidate;
  readonly name: string;
  readonly economicPlausibilityScore: number;
  readonly latencyBurdenScore: number;
  readonly infraCostScore: number;
  readonly currentDataSupportScore: number;
  readonly overallScore: number;
  readonly rank: number;
  readonly keyStrengths: string;
  readonly keyRisks: string;
}

export interface PivotComparisonReport {
  readonly datasetPath: string;
  readonly evaluatedAt: string;
  readonly graduation: GraduationAudit;
  readonly rebound: ReboundAudit;
  readonly momentum: MomentumAudit;
  readonly dimensionScores: readonly PivotScoreDimension[];
  readonly ranking: readonly PivotRankingEntry[];
  readonly decisionGate:
    | "GRADUATION/MIGRATION FIRST"
    | "POST-DUMP REBOUND FIRST"
    | "SURVIVOR MOMENTUM FIRST"
    | "NONE LOOK PROMISING"
    | "MORE DATA NEEDED BEFORE CHOOSING";
  readonly rationale: string;
}
