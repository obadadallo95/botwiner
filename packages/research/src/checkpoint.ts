import {
  bigintSafeJsonStringify,
} from "@botwiner/market-data";
import type { DatasetCounts, CloudChunkMetadata, CloudDiagnosticsChunkMetadata } from "@botwiner/storage";
import type {
  MultiPortfolioEngine,
  SerializedPortfolioEngineState,
} from "./portfolio-engine.js";
import type {
  PaperTradingEngine,
  SerializedPaperTradingState,
} from "./paper-trading-engine.js";
import type {
  TraderPnlTracker,
  SerializedTraderPnlState,
} from "./trader-pnl-tracker.js";

export const CHECKPOINT_SCHEMA_VERSION = 1;

export interface CheckpointCursor {
  readonly collectorSequence: number;
  readonly transactionLogIndex: number;
  readonly slot?: number | undefined;
  readonly lastEventId?: string | null | undefined;
  readonly lastEventTimestampMs: number;
}

export interface SessionCheckpoint {
  readonly schemaVersion: typeof CHECKPOINT_SCHEMA_VERSION;
  readonly sessionId: string;
  readonly segmentId: string;
  readonly segmentIndex: number;
  readonly timestampUnixMs: number;
  readonly cursor: CheckpointCursor;
  readonly recentEventIds: readonly string[];
  readonly datasetCounts: DatasetCounts;
  readonly lastCommittedChunkIndex: number;
  readonly totalCompressedBytes: number;
  readonly completedChunks?: readonly CloudChunkMetadata[] | undefined;
  readonly completedDiagnosticChunks?: readonly CloudDiagnosticsChunkMetadata[] | undefined;
  readonly portfolios: SerializedPortfolioEngineState;
  readonly paperTrading: SerializedPaperTradingState;
  readonly traderPnl: SerializedTraderPnlState;
}

export function serializeCheckpoint(checkpoint: SessionCheckpoint): string {
  return bigintSafeJsonStringify(checkpoint, 2);
}

export function deserializeCheckpoint(rawJson: string): SessionCheckpoint {
  const parsed = JSON.parse(rawJson) as SessionCheckpoint;
  if (!parsed || parsed.schemaVersion !== CHECKPOINT_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported checkpoint schema version: ${parsed?.schemaVersion ?? "undefined"}, expected ${CHECKPOINT_SCHEMA_VERSION}`
    );
  }
  if (!parsed.sessionId || !parsed.segmentId || typeof parsed.segmentIndex !== "number") {
    throw new Error("Invalid checkpoint: missing required session or segment identifiers");
  }
  return parsed;
}

export interface CreateCheckpointOptions {
  readonly sessionId: string;
  readonly segmentId: string;
  readonly segmentIndex: number;
  readonly timestampUnixMs?: number | undefined;
  readonly cursor: CheckpointCursor;
  readonly recentEventIds: readonly string[];
  readonly datasetCounts: DatasetCounts;
  readonly lastCommittedChunkIndex: number;
  readonly totalCompressedBytes: number;
  readonly completedChunks?: readonly CloudChunkMetadata[] | undefined;
  readonly completedDiagnosticChunks?: readonly CloudDiagnosticsChunkMetadata[] | undefined;
  readonly portfolios: MultiPortfolioEngine;
  readonly paperTrading: PaperTradingEngine;
  readonly traderPnl: TraderPnlTracker;
}

export function createCheckpointFromEngines(options: CreateCheckpointOptions): SessionCheckpoint {
  return {
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    sessionId: options.sessionId,
    segmentId: options.segmentId,
    segmentIndex: options.segmentIndex,
    timestampUnixMs: options.timestampUnixMs ?? Date.now(),
    cursor: options.cursor,
    recentEventIds: options.recentEventIds.slice(-10_000), // Bounded recent dedup window
    datasetCounts: { ...options.datasetCounts },
    lastCommittedChunkIndex: options.lastCommittedChunkIndex,
    totalCompressedBytes: options.totalCompressedBytes,
    completedChunks: options.completedChunks ? [...options.completedChunks] : undefined,
    completedDiagnosticChunks: options.completedDiagnosticChunks ? [...options.completedDiagnosticChunks] : undefined,
    portfolios: options.portfolios.exportState(),
    paperTrading: options.paperTrading.exportState(),
    traderPnl: options.traderPnl.exportState(),
  };
}

export function restoreEnginesFromCheckpoint(
  checkpoint: SessionCheckpoint,
  engines: {
    portfolios: MultiPortfolioEngine;
    paperTrading: PaperTradingEngine;
    traderPnl: TraderPnlTracker;
  }
): void {
  engines.portfolios.importState(checkpoint.portfolios, checkpoint.recentEventIds);
  engines.paperTrading.importState(checkpoint.paperTrading);
  engines.traderPnl.importState(checkpoint.traderPnl);
}
