import type { VenueEventEnvelope } from "@botwiner/market-data";

export const PHASE2_SCHEMA_VERSION = 1 as const;
export const PHASE2_DIRECTORY = "phase2-v1";

export type RpcMethod = "getTransaction" | "getBlock" | "getSignaturesForAddress";

export interface RawRpcRecord {
  readonly schemaVersion: typeof PHASE2_SCHEMA_VERSION;
  readonly kind: "solana-rpc-response";
  readonly request: {
    readonly method: RpcMethod;
    readonly subject: string;
    readonly params: readonly unknown[];
    readonly commitment: "finalized";
  };
  readonly provenance: "live" | "backfilled" | "canonical-order" | "gap-recovery";
  readonly endpointLabel: string;
  readonly capture: {
    readonly requestedAtUnixMs: number;
    readonly completedAtUnixMs: number;
    readonly durationNs: string;
    readonly attempts: number;
  };
  /** Full JSON-RPC response or a local transport-error envelope. */
  readonly response: unknown;
}

export interface GapBoundary {
  readonly signature: string;
  readonly slot: number;
  readonly receivedAtUnixMs: number;
}

export interface GapRecoveryRecord {
  readonly schemaVersion: typeof PHASE2_SCHEMA_VERSION;
  readonly kind: "gap-recovery";
  readonly gapId: string;
  readonly closedAtUnixMs: number;
  readonly reopenedAtUnixMs: number;
  readonly estimatedDurationMs: number;
  readonly beforeGap: GapBoundary | null;
  readonly afterGap: GapBoundary | null;
  readonly queryCompleted: boolean;
  readonly queryTruncatedByBound: boolean;
  readonly candidateSignatures: readonly {
    readonly signature: string;
    readonly slot: number;
    readonly blockTimeUnixSeconds: number | null;
    readonly error: unknown;
    readonly confirmationStatus: string | null;
  }[];
  readonly newlyDiscoveredSignatures: readonly string[];
  readonly limitation: string;
  readonly error: string | null;
}

export interface ComputeBudgetEvidence {
  readonly instructions: readonly {
    readonly outerInstructionIndex: number;
    readonly type:
      | "request-units-deprecated"
      | "request-heap-frame"
      | "set-compute-unit-limit"
      | "set-compute-unit-price"
      | "set-loaded-accounts-data-size-limit"
      | "unknown";
    readonly units: string | null;
    readonly additionalFeeLamports: string | null;
    readonly bytes: string | null;
    readonly microLamports: string | null;
    readonly rawDataBase58: string;
  }[];
  readonly requestedComputeUnitLimit: string | null;
  readonly requestedComputeUnitPriceMicroLamports: string | null;
  readonly requestedPriorityFeeLamports: string | null;
  readonly priorityFeeFormula: string | null;
}

export interface TokenBalanceRecord {
  readonly accountIndex: number;
  readonly mint: string;
  readonly owner: string | null;
  readonly programId: string | null;
  readonly amountBaseUnits: string;
  readonly decimals: number;
}

export interface InstructionRecord {
  readonly outerInstructionIndex: number;
  readonly innerInstructionIndex: number | null;
  readonly parentOuterInstructionIndex: number | null;
  readonly stackHeight: number | null;
  readonly programId: string | null;
  readonly accountIndexes: readonly number[];
  readonly accountKeys: readonly (string | null)[];
  readonly dataBase58: string | null;
  readonly parsed: unknown;
}

export interface TransactionEnrichment {
  readonly schemaVersion: typeof PHASE2_SCHEMA_VERSION;
  readonly kind: "solana-transaction-enrichment";
  readonly signature: string;
  readonly provenance: "live" | "backfilled";
  readonly endpointLabel: string;
  readonly requestedCommitment: "finalized";
  readonly confirmationStatus: "finalized" | null;
  readonly enrichmentStatus: "success" | "unavailable" | "malformed" | "rpc-error";
  readonly enrichmentError: string | null;
  readonly fetchedAtUnixMs: number;
  readonly fetchDurationNs: string;
  readonly slot: number | null;
  readonly blockTimeUnixSeconds: number | null;
  readonly canonicalTransactionIndex: number | null;
  readonly transactionVersion: "legacy" | number | null;
  readonly transactionStatus: "success" | "failed" | null;
  readonly transactionError: unknown;
  readonly feeLamports: string | null;
  readonly computeUnitsConsumed: string | null;
  readonly computeBudget: ComputeBudgetEvidence;
  readonly signatures: readonly string[];
  readonly recentBlockhash: string | null;
  readonly accountKeys: readonly string[];
  readonly loadedAddresses: {
    readonly writable: readonly string[];
    readonly readonly: readonly string[];
  };
  readonly preSolBalancesLamports: readonly string[] | null;
  readonly postSolBalancesLamports: readonly string[] | null;
  readonly preTokenBalances: readonly TokenBalanceRecord[] | null;
  readonly postTokenBalances: readonly TokenBalanceRecord[] | null;
  readonly instructions: readonly InstructionRecord[];
  readonly logMessages: readonly string[] | null;
  readonly returnData: unknown;
  readonly rewards: unknown;
}

export interface Distribution {
  readonly count: number;
  readonly min: number | null;
  readonly p50: number | null;
  readonly p95: number | null;
  readonly p99: number | null;
  readonly max: number | null;
}

export interface FeedQualityReport {
  readonly schemaVersion: typeof PHASE2_SCHEMA_VERSION;
  readonly kind: "feed-quality-report";
  readonly sessionId: string;
  readonly inputDigests: {
    readonly rawSha256: string;
    readonly eventsSha256: string;
    readonly diagnosticsSha256: string;
    readonly rpcTransactionsSha256: string;
    readonly rpcBlocksSha256: string;
    readonly gapRecoverySha256: string;
  };
  readonly counts: {
    readonly liveRawNotifications: number;
    readonly successfulNormalizedEvents: number;
    readonly failedTransactionsObserved: number;
    readonly duplicateEvents: number;
    readonly parserFailures: number;
    readonly disconnectsWithReconnect: number;
    readonly detectedGaps: number;
    readonly backfilledEvents: number;
    readonly knownUnrecoveredSignatures: number;
    readonly eventsUnrecovered: null;
    readonly launches: number;
    readonly trades: number;
  };
  readonly rates: {
    readonly duplicateRate: number | null;
    readonly parserFailureRatePerRawNotification: number | null;
    readonly enrichmentSuccessRate: number | null;
    readonly enrichmentFailureRate: number | null;
  };
  readonly gaps: {
    readonly estimatedTotalDurationMs: number;
    readonly fullyBoundedQueriesCompleted: number;
    readonly truncatedQueries: number;
    readonly unrecoverableGaps: number;
    readonly completenessClaim: false;
    readonly caveat: string;
  };
  readonly ordering: {
    readonly comparableLiveEvents: number;
    readonly pairwiseObservedVsCanonicalInversions: number;
    readonly eventsWithoutCanonicalOrder: number;
  };
  readonly latency: {
    readonly collectorReceiveMinusBlockTimeMs: Distribution;
    readonly collectorReceiveMinusBlockTimeCaveat: string;
    readonly collectorParseDurationMicroseconds: Distribution;
    readonly confirmationObservationDelayMs: Distribution;
    readonly confirmationObservationDelayCaveat: string;
    readonly firstObservedTradeDelayMs: Distribution;
    readonly firstObservedTradeDelayByToken: readonly {
      readonly tokenMint: string;
      readonly delayMs: number;
    }[];
  };
  readonly enrichment: {
    readonly requestedSignatures: number;
    readonly successful: number;
    readonly unavailable: number;
    readonly malformed: number;
    readonly rpcErrors: number;
    readonly withCanonicalTransactionIndex: number;
    readonly withComputeUnitsConsumed: number;
    readonly withExplicitComputeUnitPrice: number;
  };
  readonly eventCountBySlot: readonly { readonly slot: number; readonly count: number }[];
}

export interface Phase2Manifest {
  readonly schemaVersion: typeof PHASE2_SCHEMA_VERSION;
  readonly kind: "phase2-derived-manifest";
  readonly sourceSessionId: string;
  readonly format: "rebuildable-jsonl";
  readonly files: {
    readonly rawTransactions: string;
    readonly rawBlocks: string;
    readonly rawGapQueries: string;
    readonly transactions: string;
    readonly venueEvents: string;
    readonly gaps: string;
    readonly feedQuality: string;
  };
  readonly counts: {
    readonly transactionEnrichments: number;
    readonly venueEvents: number;
    readonly gaps: number;
  };
  readonly outputDigests: {
    readonly transactionsSha256: string;
    readonly venueEventsSha256: string;
    readonly gapsSha256: string;
    readonly feedQualitySha256: string;
  };
  readonly limitations: readonly string[];
}

export interface DerivedResearchData {
  readonly transactions: readonly TransactionEnrichment[];
  readonly venueEvents: readonly VenueEventEnvelope[];
  readonly gaps: readonly GapRecoveryRecord[];
  readonly report: FeedQualityReport;
  readonly manifest: Phase2Manifest;
}
