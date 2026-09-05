import { Firestore } from "@google-cloud/firestore";
import type { DatasetCounts } from "@botwiner/storage";
import type { GraduationSummaryCounters, TokenGraduationState } from "./graduation-tracker.js";

export type ResearchSessionStatus =
  | "queued"
  | "starting"
  | "running"
  | "reconnecting"
  | "completed"
  | "failed"
  | "cancelled";

export interface ResearchSessionDocument {
  readonly sessionId: string;
  readonly mode: string;
  status: ResearchSessionStatus;
  readonly createdAt: string;
  readonly startedAt: string;
  lastHeartbeatAt: string;
  completedAt: string | null;
  readonly requestedDurationSec: number | null;
  elapsedSec: number;
  readonly provider: string;
  readonly region: string;
  currentChunk: number;
  totalEvents: number;
  launchesDetected: number;
  tradesDetected: number;
  failedTxObserved: number;
  parserErrors: number;
  disconnectCount: number;
  reconnectCount: number;
  bytesPersisted: number;
  latestEventAt: string | null;
  latestError: string | null;
}

export interface FirestoreBackend {
  setSessionDoc(sessionId: string, data: Partial<ResearchSessionDocument>): Promise<void>;
  updateStatsDoc(sessionId: string, stats: GraduationSummaryCounters): Promise<void>;
  setGraduationCandidate(sessionId: string, mint: string, candidate: Record<string, unknown>): Promise<void>;
  updatePaperStatsDoc?(sessionId: string, stats: Record<string, unknown>): Promise<void>;
  updateMarketPnlDoc?(sessionId: string, stats: Record<string, unknown>): Promise<void>;
  updateCreatorAnalyticsDoc?(sessionId: string, stats: Record<string, unknown>): Promise<void>;
  savePaperTradeDoc?(sessionId: string, tradeId: string, trade: Record<string, unknown>): Promise<void>;
  updateActiveLock?(sessionId: string, data: { heartbeatAt: string; status?: string }): Promise<void>;
  releaseActiveLock?(sessionId: string): Promise<void>;
}

export class GoogleFirestoreBackend implements FirestoreBackend {
  private readonly db: Firestore;

  public constructor(projectId?: string, databaseId = "(default)") {
    const options: ConstructorParameters<typeof Firestore>[0] = { databaseId };
    if (projectId !== undefined) {
      options.projectId = projectId;
    }
    this.db = new Firestore(options);
  }

  public async setSessionDoc(sessionId: string, data: Partial<ResearchSessionDocument>): Promise<void> {
    const docRef = this.db.collection("researchSessions").doc(sessionId);
    await docRef.set(data, { merge: true });
  }

  public async updateStatsDoc(sessionId: string, stats: GraduationSummaryCounters): Promise<void> {
    const docRef = this.db.collection("researchSessions").doc(sessionId).collection("stats").doc("current");
    await docRef.set(stats, { merge: true });
  }

  public async updatePaperStatsDoc(sessionId: string, stats: Record<string, unknown>): Promise<void> {
    const docRef = this.db.collection("researchSessions").doc(sessionId).collection("stats").doc("paperTrading");
    await docRef.set(stats, { merge: true });
  }

  public async updateMarketPnlDoc(sessionId: string, stats: Record<string, unknown>): Promise<void> {
    const docRef = this.db.collection("researchSessions").doc(sessionId).collection("stats").doc("marketPnl");
    await docRef.set(stats, { merge: true });
  }

  public async updateCreatorAnalyticsDoc(sessionId: string, stats: Record<string, unknown>): Promise<void> {
    const docRef = this.db.collection("researchSessions").doc(sessionId).collection("stats").doc("creatorAnalytics");
    await docRef.set(stats, { merge: true });
  }

  public async savePaperTradeDoc(sessionId: string, tradeId: string, trade: Record<string, unknown>): Promise<void> {
    const docRef = this.db.collection("researchSessions").doc(sessionId).collection("paperTrades").doc(tradeId);
    await docRef.set(trade, { merge: true });
  }

  public async setGraduationCandidate(sessionId: string, mint: string, candidate: Record<string, unknown>): Promise<void> {
    const docRef = this.db.collection("researchSessions").doc(sessionId).collection("graduations").doc(mint);
    await docRef.set(candidate, { merge: true });
  }

  public async updateActiveLock(sessionId: string, data: { heartbeatAt: string; status?: string }): Promise<void> {
    const lockRef = this.db.collection("researchControl").doc("activeSession");
    await lockRef.set({ sessionId, ...data }, { merge: true });
  }

  public async releaseActiveLock(sessionId: string): Promise<void> {
    const lockRef = this.db.collection("researchControl").doc("activeSession");
    const doc = await lockRef.get();
    if (doc.exists && doc.data()?.sessionId === sessionId) {
      await lockRef.set({ status: "released", releasedAt: new Date().toISOString() }, { merge: true });
    }
  }
}

import type { PaperTradingStats, PaperPosition } from "./paper-trading-engine.js";
import type { MarketParticipantStats } from "./trader-pnl-tracker.js";

export interface FirestoreTelemetryReporterOptions {
  readonly sessionId: string;
  readonly mode: string;
  readonly provider: string;
  readonly region: string;
  readonly requestedDurationSec: number | null;
  readonly gcpProjectId?: string | undefined;
  readonly firestoreDatabase?: string | undefined;
  readonly backend?: FirestoreBackend | undefined;
  readonly heartbeatIntervalMs?: number | undefined;
  readonly statsIntervalMs?: number | undefined;
}

export class FirestoreTelemetryReporter {
  private readonly sessionId: string;
  private readonly mode: string;
  private readonly provider: string;
  private readonly region: string;
  private readonly requestedDurationSec: number | null;
  private readonly backend: FirestoreBackend;
  private readonly heartbeatIntervalMs: number;
  private readonly statsIntervalMs: number;
  private readonly startedAtUnixMs: number;

  private status: ResearchSessionStatus = "starting";
  private latestError: string | null = null;
  private latestEventAtIso: string | null = null;
  private currentChunk = 1;
  private bytesPersisted = 0;
  private reconnectCount = 0;

  private heartbeatTimer?: NodeJS.Timeout | undefined;
  private statsTimer?: NodeJS.Timeout | undefined;
  private closed = false;

  private latestCounts?: DatasetCounts | undefined;
  private latestGraduationCounters?: GraduationSummaryCounters | undefined;
  private latestPaperStats?: PaperTradingStats | undefined;
  private latestMarketParticipantStats?: MarketParticipantStats | undefined;
  private pendingCandidates = new Map<string, TokenGraduationState>();
  private pendingPaperTrades = new Map<string, PaperPosition>();

  public constructor(options: FirestoreTelemetryReporterOptions) {
    this.sessionId = options.sessionId;
    this.mode = options.mode;
    this.provider = options.provider;
    this.region = options.region;
    this.requestedDurationSec = options.requestedDurationSec;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 15_000;
    this.statsIntervalMs = options.statsIntervalMs ?? 5_000;
    this.startedAtUnixMs = Date.now();

    if (options.backend) {
      this.backend = options.backend;
    } else {
      this.backend = new GoogleFirestoreBackend(options.gcpProjectId, options.firestoreDatabase);
    }
  }

  public async initialize(): Promise<void> {
    const nowIso = new Date().toISOString();
    const doc: ResearchSessionDocument = {
      sessionId: this.sessionId,
      mode: this.mode,
      status: "starting",
      createdAt: nowIso,
      startedAt: nowIso,
      lastHeartbeatAt: nowIso,
      completedAt: null,
      requestedDurationSec: this.requestedDurationSec,
      elapsedSec: 0,
      provider: this.provider,
      region: this.region,
      currentChunk: 1,
      totalEvents: 0,
      launchesDetected: 0,
      tradesDetected: 0,
      failedTxObserved: 0,
      parserErrors: 0,
      disconnectCount: 0,
      reconnectCount: 0,
      bytesPersisted: 0,
      latestEventAt: null,
      latestError: null,
    };

    try {
      await this.backend.setSessionDoc(this.sessionId, doc);
    } catch (error) {
      console.warn("[FirestoreTelemetryReporter] failed to write initial session doc:", error);
    }

    this.startHeartbeat();
    this.startStatsLoop();
  }

  public markRunning(): void {
    this.status = "running";
    this.flushHeartbeatNow().catch((err) => {
      console.warn("[FirestoreTelemetryReporter] failed to mark running:", err);
    });
  }

  public markReconnecting(): void {
    this.status = "reconnecting";
    this.reconnectCount += 1;
    this.flushHeartbeatNow().catch((err) => {
      console.warn("[FirestoreTelemetryReporter] failed to mark reconnecting:", err);
    });
  }

  public updateChunkAndBytes(chunk: number, bytes: number): void {
    this.currentChunk = chunk;
    this.bytesPersisted = bytes;
  }

  public updateTelemetry(
    counts: DatasetCounts,
    graduationCounters: GraduationSummaryCounters,
    latestEventIso?: string,
  ): void {
    this.latestCounts = counts;
    this.latestGraduationCounters = graduationCounters;
    if (latestEventIso) {
      this.latestEventAtIso = latestEventIso;
    }
  }

  public queueCandidateUpdate(candidate: TokenGraduationState): void {
    this.pendingCandidates.set(candidate.mint, candidate);
  }

  public updatePaperStats(stats: PaperTradingStats): void {
    this.latestPaperStats = stats;
  }

  public updateMarketParticipantStats(stats: MarketParticipantStats): void {
    this.latestMarketParticipantStats = stats;
  }

  public queuePaperTrade(trade: PaperPosition): void {
    this.pendingPaperTrades.set(`${trade.mint}-${trade.openedAtUnixMs}`, trade);
  }

  public recordError(error: Error | string): void {
    this.latestError = error instanceof Error ? error.message : String(error);
  }

  public reportError(error: Error | string): void {
    this.recordError(error);
  }

  public async close(finalStatus: "completed" | "failed" | "cancelled" = "completed"): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    if (this.statsTimer) {
      clearInterval(this.statsTimer);
      this.statsTimer = undefined;
    }

    this.status = finalStatus;
    const nowIso = new Date().toISOString();
    const elapsedSec = Math.floor((Date.now() - this.startedAtUnixMs) / 1000);

    // Final flush of stats and candidates
    await this.flushStatsNow();

    const finalDoc: Partial<ResearchSessionDocument> = {
      status: finalStatus,
      completedAt: nowIso,
      lastHeartbeatAt: nowIso,
      elapsedSec,
      currentChunk: this.currentChunk,
      bytesPersisted: this.bytesPersisted,
      totalEvents: this.latestCounts?.normalizedEvents ?? 0,
      launchesDetected: this.latestCounts?.launches ?? 0,
      tradesDetected: this.latestCounts?.trades ?? 0,
      failedTxObserved: this.latestCounts?.failedTransactions ?? 0,
      parserErrors: this.latestCounts?.malformedPumpEvents ?? 0,
      disconnectCount: this.latestCounts?.disconnects ?? 0,
      reconnectCount: this.reconnectCount,
      latestEventAt: this.latestEventAtIso,
      latestError: this.latestError,
    };

    try {
      await this.backend.setSessionDoc(this.sessionId, finalDoc);
      if (this.backend.releaseActiveLock) {
        await this.backend.releaseActiveLock(this.sessionId);
      }
    } catch (err) {
      console.warn("[FirestoreTelemetryReporter] failed to write final session doc:", err);
    }
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      this.flushHeartbeatNow().catch((err) => {
        console.warn("[FirestoreTelemetryReporter] heartbeat write failed:", err);
      });
    }, this.heartbeatIntervalMs);
  }

  private startStatsLoop(): void {
    this.statsTimer = setInterval(() => {
      this.flushStatsNow().catch((err) => {
        console.warn("[FirestoreTelemetryReporter] stats write failed:", err);
      });
    }, this.statsIntervalMs);
  }

  private async flushHeartbeatNow(): Promise<void> {
    if (this.closed) return;
    const nowIso = new Date().toISOString();
    const elapsedSec = Math.floor((Date.now() - this.startedAtUnixMs) / 1000);

    const partial: Partial<ResearchSessionDocument> = {
      status: this.status,
      lastHeartbeatAt: nowIso,
      elapsedSec,
      currentChunk: this.currentChunk,
      bytesPersisted: this.bytesPersisted,
      reconnectCount: this.reconnectCount,
      latestError: this.latestError,
    };

    if (this.latestCounts) {
      partial.totalEvents = this.latestCounts.normalizedEvents;
      partial.launchesDetected = this.latestCounts.launches;
      partial.tradesDetected = this.latestCounts.trades;
      partial.failedTxObserved = this.latestCounts.failedTransactions;
      partial.parserErrors = this.latestCounts.malformedPumpEvents;
      partial.disconnectCount = this.latestCounts.disconnects;
    }
    if (this.latestEventAtIso) {
      partial.latestEventAt = this.latestEventAtIso;
    }

    try {
      await this.backend.setSessionDoc(this.sessionId, partial);
      if (this.backend.updateActiveLock) {
        await this.backend.updateActiveLock(this.sessionId, { heartbeatAt: nowIso, status: this.status });
      }
    } catch (err) {
      console.warn("[FirestoreTelemetryReporter] failed to update heartbeat:", err);
    }
  }

  private async flushStatsNow(): Promise<void> {
    if (this.latestGraduationCounters) {
      try {
        await this.backend.updateStatsDoc(this.sessionId, this.latestGraduationCounters);
      } catch (err) {
        console.warn("[FirestoreTelemetryReporter] failed to update graduation stats:", err);
      }
    }

    if (this.pendingCandidates.size > 0) {
      const candidatesToFlush = Array.from(this.pendingCandidates.values());
      this.pendingCandidates.clear();

      for (const candidate of candidatesToFlush) {
        try {
          const serializable = {
            mint: candidate.mint,
            creatorWallet: candidate.creatorWallet,
            firstSeenAtUnixMs: candidate.firstSeenAtUnixMs,
            launchSeenAtUnixMs: candidate.launchSeenAtUnixMs ?? null,
            currentRealSolLamports: candidate.currentRealSolLamports.toString(),
            maxRealSolLamports: candidate.maxRealSolLamports.toString(),
            curveProgressPct: Number(candidate.curveProgressPct.toFixed(2)),
            crossings: candidate.crossings,
            crossingDurationsMs: candidate.crossingDurationsMs,
            tradeCount: candidate.tradeCount,
            buyCount: candidate.buyCount,
            sellCount: candidate.sellCount,
            recentActivityAtUnixMs: candidate.recentActivityAtUnixMs,
            classification: candidate.classification,
            graduated: candidate.graduated,
            migrated: candidate.migrated,
            updatedAt: new Date().toISOString(),
          };
          await this.backend.setGraduationCandidate(this.sessionId, candidate.mint, serializable);
        } catch (err) {
          console.warn(`[FirestoreTelemetryReporter] failed to update candidate ${candidate.mint}:`, err);
        }
      }
    }

    if (this.latestPaperStats && this.backend.updatePaperStatsDoc) {
      try {
        await this.backend.updatePaperStatsDoc(
          this.sessionId,
          this.latestPaperStats as unknown as Record<string, unknown>,
        );
      } catch (err) {
        console.warn("[FirestoreTelemetryReporter] failed to update paper stats:", err);
      }
    }

    if (this.latestMarketParticipantStats) {
      if (this.backend.updateMarketPnlDoc) {
        try {
          const marketPnlSummary: Record<string, unknown> = { ...this.latestMarketParticipantStats };
          delete marketPnlSummary["creatorAnalytics"];
          await this.backend.updateMarketPnlDoc(
            this.sessionId,
            marketPnlSummary,
          );
        } catch (err) {
          console.warn("[FirestoreTelemetryReporter] failed to update market pnl:", err);
        }
      }
      if (this.backend.updateCreatorAnalyticsDoc) {
        try {
          await this.backend.updateCreatorAnalyticsDoc(
            this.sessionId,
            this.latestMarketParticipantStats.creatorAnalytics as unknown as Record<string, unknown>,
          );
        } catch (err) {
          console.warn("[FirestoreTelemetryReporter] failed to update creator analytics:", err);
        }
      }
    }

    if (this.pendingPaperTrades.size > 0 && this.backend.savePaperTradeDoc) {
      const tradesToFlush = Array.from(this.pendingPaperTrades.values());
      this.pendingPaperTrades.clear();

      for (const trade of tradesToFlush) {
        try {
          const tradeId = `${trade.mint}-${trade.openedAtUnixMs}`;
          const serializable = {
            strategyId: trade.strategyId,
            mint: trade.mint,
            openedAtUnixMs: trade.openedAtUnixMs,
            openedAtIso: new Date(trade.openedAtUnixMs).toISOString(),
            closedAtUnixMs: trade.closedAtUnixMs ?? null,
            closedAtIso: trade.closedAtUnixMs ? new Date(trade.closedAtUnixMs).toISOString() : null,
            status: trade.status,
            exitReason: trade.exitReason ?? null,
            holdDurationSec: trade.holdDurationSec ?? null,
            curveSolInputLamports: trade.curveSolInputLamports.toString(),
            totalWalletOutflowLamports: trade.totalWalletOutflowLamports.toString(),
            tokenQuantity: trade.tokenQuantity.toString(),
            grossPnlLamports: trade.grossPnlLamports?.toString() ?? null,
            netPnlLamports: trade.netPnlLamports?.toString() ?? null,
            netReturnPct: trade.netReturnPct ?? null,
            maxFavorableExcursionPct: trade.maxFavorableExcursionPct,
            maxAdverseExcursionPct: trade.maxAdverseExcursionPct,
            entryPumpFeeLamports: trade.entryPumpFeeLamports.toString(),
            entryTxCostLamports: trade.entryTxCostLamports.toString(),
            totalPumpFeesLamports: trade.totalPumpFeesLamports?.toString() ?? null,
            totalTxCostsLamports: trade.totalTxCostsLamports?.toString() ?? null,
            triggerState: trade.triggerState,
            updatedAt: new Date().toISOString(),
          };
          await this.backend.savePaperTradeDoc(this.sessionId, tradeId, serializable);
        } catch (err) {
          console.warn("[FirestoreTelemetryReporter] failed to save paper trade:", err);
        }
      }
    }
  }
}
