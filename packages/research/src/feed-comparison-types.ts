import type { Commitment } from "@botwiner/market-data";

export type ComparisonFeedId = "public" | "candidate";

export interface CollectorStartupTuple {
  readonly feedId: ComparisonFeedId;
  readonly processId: number;
  readonly hostFingerprint: string;
  readonly wallUnixMs: number;
  readonly monotonicNs: string;
  readonly commitment: Commitment;
  readonly programId: string;
  readonly parserVersion: string;
  readonly idlRevision: string;
  readonly endpointLabel: string;
}

export interface CalibrationExchange {
  readonly parentSentMonotonicNs: string;
  readonly parentReceivedMonotonicNs: string;
  readonly childMonotonicNs: string;
  readonly childWallUnixMs: number;
}

export interface TimingCalibration {
  readonly calibrationId: string;
  readonly feedId: ComparisonFeedId;
  readonly processId: number;
  readonly startup: CollectorStartupTuple;
  readonly anchor: {
    readonly childMonotonicNs: string;
    readonly parentMonotonicNs: string;
    readonly childWallUnixMs: number;
    readonly parentTimelineWallUnixMs: number;
  };
  readonly minimumRoundTripNs: string;
  readonly uncertaintyNs: string;
  readonly wallResidualMs: number;
  readonly valid: boolean;
  readonly validation: string;
}

export interface FeedComparisonManifest {
  readonly schemaVersion: 1;
  readonly kind: "feed-comparison-manifest";
  readonly comparisonId: string;
  readonly status: "starting" | "collecting" | "complete" | "aborted";
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly window: {
    readonly requestedStartUnixMs: number | null;
    readonly requestedEndUnixMs: number | null;
    readonly durationSeconds: number;
    readonly windowDurationSeconds?: number;
  };
  readonly orchestrator: {
    readonly processId: number;
    readonly hostFingerprint: string;
    readonly wallBaselineUnixMs: number;
    readonly monotonicBaselineNs: string;
  };
  readonly controls: {
    readonly commitment: Commitment;
    readonly programId: string;
    readonly parserVersion: string;
    readonly idlRevision: string;
    readonly tieToleranceMs: number;
    readonly calibrationMaximumUncertaintyMs: number;
    readonly calibrationMaximumWallResidualMs: number;
  };
  readonly feeds: {
    readonly public: {
      readonly dataset: "public";
      readonly endpointLabel: "solana-public-mainnet-wss";
      readonly processId: number | null;
    };
    readonly candidate: {
      readonly dataset: "candidate";
      readonly endpointLabel: "helius-mainnet-wss";
      readonly processId: number | null;
    };
  };
  readonly calibrations: {
    readonly public: TimingCalibration | null;
    readonly candidate: TimingCalibration | null;
  };
  readonly runtimeChecks: {
    readonly bothCollectorsReady: boolean;
    readonly bothCollectorsCompleted: boolean;
    readonly apiKeyWasPresent: boolean;
    readonly apiKeyPersisted: boolean;
  };
  readonly failure: string | null;
  readonly limitations: readonly string[];
}

export interface FeedTotals {
  readonly rawNotifications: number;
  readonly uniqueSignatures: number;
  readonly successfulTransactions: number;
  readonly failedTransactions: number;
  readonly normalizedPumpEvents: number;
  readonly launches: number;
  readonly trades: number;
  readonly duplicateNotifications: number;
  readonly duplicateNotificationRate: number;
  readonly duplicateEvents: number;
  readonly parserErrors: number;
  readonly parserErrorRatePerRawNotification: number;
  readonly malformedFrames: number;
  readonly malformedFrameRatePerRawNotification: number;
  readonly unexpectedRpcMessages: number;
  readonly disconnects: number;
  readonly reconnects: number;
  readonly totalDisconnectedDurationMs: number;
  readonly longestObservedInterMessageGapMs: number | null;
}

export type SignatureClassification = "launch" | "trade" | "launch-and-trade" | "none";

export interface MatchedSignatureComparison {
  readonly signature: string;
  readonly publicArrivalUnixMs: number;
  readonly candidateArrivalUnixMs: number;
  readonly publicArrivalMonotonicNs: string;
  readonly candidateArrivalMonotonicNs: string;
  readonly publicNormalizedTimelineNs: string;
  readonly candidateNormalizedTimelineNs: string;
  /** public - candidate: positive means Helius arrived first. */
  readonly deltaMs: number;
  readonly absoluteDeltaMs: number;
  readonly first: "public" | "candidate" | "tie";
  readonly publicSlot: number;
  readonly candidateSlot: number;
  readonly slotsMatch: boolean;
  readonly publicSucceeded: boolean;
  readonly candidateSucceeded: boolean;
  readonly successStatusMatches: boolean;
  readonly publicPumpEvents: number;
  readonly candidatePumpEvents: number;
  readonly publicClassification: SignatureClassification;
  readonly candidateClassification: SignatureClassification;
  readonly payloadMatches: boolean;
  readonly parserOutputMatches: boolean;
  readonly publicConnectionEpoch: number;
  readonly candidateConnectionEpoch: number;
  readonly publicLogsTruncated: boolean;
  readonly candidateLogsTruncated: boolean;
  readonly includedInCleanLatency: boolean;
  readonly exclusionReason: string | null;
}

export interface DistributionSummary {
  readonly count: number;
  readonly min: number | null;
  readonly p25: number | null;
  readonly p50: number | null;
  readonly p75: number | null;
  readonly p90: number | null;
  readonly p95: number | null;
  readonly p99: number | null;
  readonly max: number | null;
  readonly mean: number | null;
  readonly standardDeviation: number | null;
  readonly iqr: number | null;
}

export interface ComparisonWindowMetrics {
  readonly windowIndex: number;
  readonly label: string;
  readonly startUnixMs: number;
  readonly endUnixMs: number;
  readonly durationSeconds: number;
  readonly matchedSignatures: number;
  readonly publicOnlySignatures: number;
  readonly candidateOnlySignatures: number;
  readonly unionSignatures: number;
  readonly jaccard: number;
  readonly cleanLatency: {
    readonly count: number;
    readonly p50: number | null;
    readonly p95: number | null;
    readonly p99: number | null;
    readonly min: number | null;
    readonly max: number | null;
    readonly mean: number | null;
    readonly standardDeviation: number | null;
    readonly winner: {
      readonly candidateFaster: number;
      readonly publicFaster: number;
      readonly ties: number;
      readonly candidateFasterPercentage: number;
      readonly publicFasterPercentage: number;
      readonly tiePercentage: number;
    };
    readonly tails: {
      readonly thresholdsMs: readonly number[];
      readonly candidateLeadCounts: readonly number[];
      readonly publicLeadCounts: readonly number[];
    };
  };
  readonly disconnects: {
    readonly public: number;
    readonly candidate: number;
  };
  readonly reconnects: {
    readonly public: number;
    readonly candidate: number;
  };
  readonly duplicateNotificationRate: {
    readonly public: number;
    readonly candidate: number;
  };
  readonly parserErrors: {
    readonly public: number;
    readonly candidate: number;
  };
  readonly candidateLogTruncations: number;
  readonly parserMismatchesWithLogTruncation: number;
}

export interface WindowStabilitySummary {
  readonly windowCount: number;
  readonly windowDurationSeconds: number;
  readonly p50DeltasMs: readonly (number | null)[];
  readonly p95DeltasMs: readonly (number | null)[];
  readonly p99DeltasMs: readonly (number | null)[];
  readonly candidateWinPercentages: readonly number[];
  readonly publicWinPercentages: readonly number[];
  readonly tiePercentages: readonly number[];
  readonly directionalConsistency: boolean;
  readonly p50SpreadMs: number | null;
  readonly p95SpreadMs: number | null;
  readonly truncationCounts: readonly number[];
  readonly stabilityAssessment:
    | "stable-candidate-lead"
    | "variable-candidate-lead"
    | "inconsistent-lead"
    | "public-lead"
    | "single-window-baseline";
  readonly summary: string;
}

export interface TruncationAwareCoverageSection {
  readonly signatureCompleteness: {
    readonly matchedSignatures: number;
    readonly publicOnlySignatures: number;
    readonly candidateOnlySignatures: number;
    readonly unionSignatures: number;
    readonly jaccard: number;
    readonly candidateSignatureLossRate: number;
    readonly publicSignatureLossRate: number;
    readonly interpretation: string;
  };
  readonly rawPayloadCompleteness: {
    readonly matchedSignatures: number;
    readonly identicalPayloadSignatures: number;
    readonly payloadMismatchSignatures: number;
    readonly candidateLogTruncations: number;
    readonly publicLogTruncations: number;
    readonly payloadMismatchesWithLogTruncation: number;
    readonly unexplainedPayloadMismatches: number;
    readonly candidatePayloadTruncationRate: number;
    readonly interpretation: string;
  };
  readonly parsedPumpEventCompleteness: {
    readonly publicNormalizedPumpEvents: number;
    readonly candidateNormalizedPumpEvents: number;
    readonly eventCountDelta: number;
    readonly matchedSignaturesWithIdenticalPumpEvents: number;
    readonly matchedSignaturesWithPumpEventMismatches: number;
    readonly pumpEventMismatchesWithLogTruncation: number;
    readonly unexplainedPumpEventMismatches: number;
    readonly interpretation: string;
  };
}

export interface ProviderLimitAudit {
  readonly feedId: ComparisonFeedId;
  readonly endpointLabel: string;
  readonly subscriptionErrors: number;
  readonly connectionErrors: number;
  readonly disconnects: number;
  readonly reconnects: number;
  readonly rateLimitOrThrottleCount: number;
  readonly abnormalGapsCount: number;
  readonly longestObservedInterMessageGapMs: number | null;
  readonly observedThrottleDiagnostics: readonly string[];
  readonly freePlanCreditTrackingNotice: string;
}

export interface StorageAccountingSummary {
  readonly publicDatasetBytes: number;
  readonly candidateDatasetBytes: number;
  readonly comparisonOutputBytes: number;
  readonly totalBytes: number;
  readonly totalMegabytes: number;
  readonly elapsedMinutes: number;
  readonly megabytesPerMinute: number;
  readonly projections: {
    readonly estimated15MinMegabytes: number;
    readonly estimated30MinMegabytes: number;
    readonly estimated120MinMegabytes: number;
  };
  readonly assessment: string;
}

export interface FeedComparisonReport {
  readonly schemaVersion: 1;
  readonly kind: "feed-comparison-report";
  readonly comparisonId: string;
  readonly feeds: { readonly public: FeedTotals; readonly candidate: FeedTotals };
  readonly coverage: {
    readonly matchedSignatures: number;
    readonly publicOnlySignatures: number;
    readonly candidateOnlySignatures: number;
    readonly unionSignatures: number;
    readonly jaccard: number;
    readonly percentageRelativeToUnion: number;
    readonly launch: { readonly matched: number; readonly union: number; readonly percentage: number };
    readonly trade: { readonly matched: number; readonly union: number; readonly percentage: number };
    readonly uninterruptedGuardedWindow: {
      readonly boundaryGuardMs: number;
      readonly matchedSignatures: number;
      readonly publicOnlySignatures: number;
      readonly candidateOnlySignatures: number;
      readonly unionSignatures: number;
      readonly jaccard: number;
      readonly percentageRelativeToUnion: number;
    };
  };
  readonly cleanLatency: {
    readonly definition: string;
    readonly excludedMatchedSignatures: number;
    readonly deltaMs: DistributionSummary;
    readonly winner: {
      readonly tieToleranceMs: number;
      readonly candidateFaster: number;
      readonly publicFaster: number;
      readonly ties: number;
      readonly candidateFasterPercentage: number;
      readonly publicFasterPercentage: number;
      readonly tiePercentage: number;
    };
    readonly tails: {
      readonly thresholdsMs: readonly number[];
      readonly candidateLeadCounts: readonly number[];
      readonly publicLeadCounts: readonly number[];
    };
    readonly maximumMeaningfulLead: {
      readonly feed: ComparisonFeedId | "tie";
      readonly milliseconds: number;
      readonly definition: string;
    };
  };
  readonly ordering: {
    readonly method: "within-observed-slot-pairs";
    readonly comparablePairs: number;
    readonly disagreements: number;
    readonly disagreementRate: number;
  };
  readonly compatibility: {
    readonly slotMismatches: number;
    readonly successStatusMismatches: number;
    readonly payloadMismatches: number;
    readonly parserOutputMismatches: number;
    readonly publicLogTruncations: number;
    readonly candidateLogTruncations: number;
    readonly payloadMismatchesWithLogTruncation: number;
    readonly parserMismatchesWithLogTruncation: number;
  };
  readonly windows: readonly ComparisonWindowMetrics[];
  readonly windowStability: WindowStabilitySummary;
  readonly truncationAwareCoverage: TruncationAwareCoverageSection;
  readonly providerLimits: {
    readonly public: ProviderLimitAudit;
    readonly candidate: ProviderLimitAudit;
  };
  readonly storage: StorageAccountingSummary;
  readonly methodology: {
    readonly sameCommitment: boolean;
    readonly sameProgramFilter: boolean;
    readonly sameParserVersion: boolean;
    readonly sameIdlRevision: boolean;
    readonly sameHost: boolean;
    readonly differentProcesses: boolean;
    readonly sameRequestedWindow: boolean;
    readonly timingCalibrationValid: boolean;
    readonly noCanonicalDataUsed: true;
    readonly apiKeyNeverPersisted: boolean;
    readonly reconnectAffectedRecordsExcluded: boolean;
    readonly standardLogsSubscribeReplayBehavior: string;
  };
  readonly matches: readonly MatchedSignatureComparison[];
  readonly limitations: readonly string[];
}
