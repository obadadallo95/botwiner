import type { LaunchMarketEvent, TradeMarketEvent } from "@botwiner/market-data";

export interface GraduationCrossingTimes {
  t50AtUnixMs?: number;
  t60AtUnixMs?: number;
  t70AtUnixMs?: number;
  t80AtUnixMs?: number;
}

export interface GraduationCrossingDurationsMs {
  to50Ms?: number;
  to60Ms?: number;
  to70Ms?: number;
  to80Ms?: number;
}

export interface TokenGraduationState {
  readonly mint: string;
  readonly creatorWallet: string;
  readonly firstSeenAtUnixMs: number;
  readonly launchSeenAtUnixMs?: number | undefined;
  currentRealSolLamports: bigint;
  maxRealSolLamports: bigint;
  curveProgressPct: number;
  crossings: GraduationCrossingTimes;
  crossingDurationsMs: GraduationCrossingDurationsMs;
  tradeCount: number;
  buyCount: number;
  sellCount: number;
  recentActivityAtUnixMs: number;
  classification: "unknown" | "organic" | "instant-bundle";
  graduated: boolean;
  migrated: boolean;
  firstSlot?: number | undefined;
  lastSlot?: number | undefined;
}

export interface GraduationSummaryCounters {
  tokensTracked: number;
  curve50PlusCount: number;
  curve60PlusCount: number;
  curve70PlusCount: number;
  curve80PlusCount: number;
  nearGraduationCount: number;
  graduationsDetected: number;
  organicGraduationsDetected: number;
  instantBundleGraduationsDetected: number;
  migrationsDetected: number;
  limitations: readonly string[];
}

export interface GraduationTrackerOptions {
  readonly onCandidateUpdated?: ((token: TokenGraduationState) => void) | undefined;
}

export class GraduationTracker {
  private readonly tokens = new Map<string, TokenGraduationState>();
  private readonly onCandidateUpdated?: ((token: TokenGraduationState) => void) | undefined;

  private curve50PlusCount = 0;
  private curve60PlusCount = 0;
  private curve70PlusCount = 0;
  private curve80PlusCount = 0;
  private nearGraduationCount = 0;
  private graduationsDetected = 0;
  private organicGraduationsDetected = 0;
  private instantBundleGraduationsDetected = 0;
  private migrationsDetected = 0;

  public constructor(options?: GraduationTrackerOptions) {
    this.onCandidateUpdated = options?.onCandidateUpdated;
  }

  public onLaunch(event: LaunchMarketEvent): void {
    const mint = event.tokenMint;
    const nowMs = event.timestamps.collectorReceivedAtUnixMs;
    const slot = event.ordering.slot;

    if (!this.tokens.has(mint)) {
      const state: TokenGraduationState = {
        mint,
        creatorWallet: event.creatorWallet,
        firstSeenAtUnixMs: nowMs,
        launchSeenAtUnixMs: nowMs,
        currentRealSolLamports: 0n,
        maxRealSolLamports: 0n,
        curveProgressPct: 0,
        crossings: {},
        crossingDurationsMs: {},
        tradeCount: 0,
        buyCount: 0,
        sellCount: 0,
        recentActivityAtUnixMs: nowMs,
        classification: "unknown",
        graduated: false,
        migrated: false,
        firstSlot: slot,
        lastSlot: slot,
      };
      this.tokens.set(mint, state);
    } else {
      const existing = this.tokens.get(mint)!;
      if (!existing.launchSeenAtUnixMs) {
        (existing as { launchSeenAtUnixMs?: number }).launchSeenAtUnixMs = nowMs;
      }
    }
  }

  public onTrade(event: TradeMarketEvent): void {
    const mint = event.tokenMint;
    const nowMs = event.timestamps.collectorReceivedAtUnixMs;
    const slot = event.ordering.slot;
    const realSolLamports = BigInt(event.reserves.realSolLamports || "0");
    const isBuy = event.side === "buy";

    let token = this.tokens.get(mint);
    if (!token) {
      token = {
        mint,
        creatorWallet: event.creatorWallet || "unknown",
        firstSeenAtUnixMs: nowMs,
        currentRealSolLamports: realSolLamports,
        maxRealSolLamports: realSolLamports,
        curveProgressPct: 0,
        crossings: {},
        crossingDurationsMs: {},
        tradeCount: 0,
        buyCount: 0,
        sellCount: 0,
        recentActivityAtUnixMs: nowMs,
        classification: "unknown",
        graduated: false,
        migrated: false,
        firstSlot: slot,
        lastSlot: slot,
      };
      this.tokens.set(mint, token);
    }

    token.currentRealSolLamports = realSolLamports;
    if (realSolLamports > token.maxRealSolLamports) {
      token.maxRealSolLamports = realSolLamports;
    }

    token.tradeCount += 1;
    if (isBuy) {
      token.buyCount += 1;
    } else {
      token.sellCount += 1;
    }
    token.recentActivityAtUnixMs = nowMs;
    token.lastSlot = slot;

    const realSol = Number(realSolLamports) / 1e9;
    // Approximate curve progress relative to ~85 SOL graduation target
    token.curveProgressPct = Math.min(100, Math.max(0, (realSol / 85.0) * 100));

    let candidateNeedsUpdate = false;

    // Threshold 50 SOL
    if (realSol >= 50 && !token.crossings.t50AtUnixMs) {
      token.crossings.t50AtUnixMs = nowMs;
      if (token.launchSeenAtUnixMs) {
        token.crossingDurationsMs.to50Ms = nowMs - token.launchSeenAtUnixMs;
      }
      this.curve50PlusCount += 1;
      candidateNeedsUpdate = true;
    }

    // Threshold 60 SOL
    if (realSol >= 60 && !token.crossings.t60AtUnixMs) {
      token.crossings.t60AtUnixMs = nowMs;
      if (token.launchSeenAtUnixMs) {
        token.crossingDurationsMs.to60Ms = nowMs - token.launchSeenAtUnixMs;
      }
      this.curve60PlusCount += 1;
      candidateNeedsUpdate = true;
    }

    // Threshold 70 SOL
    if (realSol >= 70 && !token.crossings.t70AtUnixMs) {
      token.crossings.t70AtUnixMs = nowMs;
      if (token.launchSeenAtUnixMs) {
        token.crossingDurationsMs.to70Ms = nowMs - token.launchSeenAtUnixMs;
      }
      this.curve70PlusCount += 1;
      candidateNeedsUpdate = true;
    }

    // Threshold 80 SOL (Near graduation)
    if (realSol >= 80 && !token.crossings.t80AtUnixMs) {
      token.crossings.t80AtUnixMs = nowMs;
      if (token.launchSeenAtUnixMs) {
        token.crossingDurationsMs.to80Ms = nowMs - token.launchSeenAtUnixMs;
      }
      this.curve80PlusCount += 1;
      this.nearGraduationCount += 1;
      candidateNeedsUpdate = true;
    }

    // Full graduation target: ~84.5+ SOL
    if (realSol >= 84.5 && !token.graduated) {
      token.graduated = true;
      this.graduationsDetected += 1;

      // Classification: instant bundle vs organic
      const totalDurSec = (nowMs - token.firstSeenAtUnixMs) / 1000;
      const sameSlot = token.firstSlot !== undefined && token.lastSlot !== undefined && token.firstSlot === token.lastSlot;

      if ((totalDurSec <= 1.5 && token.tradeCount <= 10) || sameSlot) {
        token.classification = "instant-bundle";
        this.instantBundleGraduationsDetected += 1;
      } else {
        token.classification = "organic";
        this.organicGraduationsDetected += 1;
      }

      candidateNeedsUpdate = true;
    }

    if (candidateNeedsUpdate && this.onCandidateUpdated) {
      this.onCandidateUpdated({ ...token });
    }
  }

  public getSummaryCounters(): GraduationSummaryCounters {
    return {
      tokensTracked: this.tokens.size,
      curve50PlusCount: this.curve50PlusCount,
      curve60PlusCount: this.curve60PlusCount,
      curve70PlusCount: this.curve70PlusCount,
      curve80PlusCount: this.curve80PlusCount,
      nearGraduationCount: this.nearGraduationCount,
      graduationsDetected: this.graduationsDetected,
      organicGraduationsDetected: this.organicGraduationsDetected,
      instantBundleGraduationsDetected: this.instantBundleGraduationsDetected,
      migrationsDetected: this.migrationsDetected,
      limitations: [
        "PumpSwap / Raydium migration event decoding is not yet available in current IDL revision. Migrations count is recorded as 0 without faking.",
      ],
    };
  }

  public getTokenState(mint: string): TokenGraduationState | undefined {
    return this.tokens.get(mint);
  }

  public getAllCandidates(): TokenGraduationState[] {
    return Array.from(this.tokens.values()).filter(
      (t) => t.maxRealSolLamports >= 50_000_000_000n || t.graduated,
    );
  }
}
