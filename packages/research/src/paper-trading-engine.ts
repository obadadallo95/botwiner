import type { LaunchMarketEvent, TradeMarketEvent } from "@botwiner/market-data";
import { quotePumpBuy, quotePumpSell, type PumpBuyQuote, type PumpSellQuote } from "./rebound-research.js";

export const PAPER_STRATEGY_ID = "organic-50sol-continuation-v1" as const;
export const PAPER_COST_SCENARIO_ID = "paper-medium-v1" as const;

export const PAPER_CONFIG = {
  strategyId: PAPER_STRATEGY_ID,
  costScenarioId: PAPER_COST_SCENARIO_ID,
  positionCurveSolInputLamports: 100_000_000n, // 0.10 SOL
  pumpFeeBps: 100n, // 1%
  baseFeeLamportsPerTx: 5_000n, // 5,000 lamports = 0.000005 SOL
  priorityFeeLamportsPerTx: 50_000n, // 50,000 lamports = 0.00005 SOL
  jitoTipLamportsPerTx: 0n, // Explicitly 0: no Jito tip assumed
  tpNetReturnPct: 30.0, // +30% executable NET return
  slNetReturnPct: -20.0, // -20% executable NET return
  timeoutDurationMs: 300_000, // 5 minutes (300s)
  minTokenAgeMs: 5_000, // Token age >= 5s
  minTradeCount: 5, // Trades observed >= 5
  crossingSolThresholdLamports: 50_000_000_000n, // 50 SOL
  graduationSolThresholdLamports: 84_500_000_000n, // ~84.5 SOL
} as const;

export interface PaperStrategyDefinition {
  readonly id: string;
  readonly strategyId: string;
  readonly thesis: string;
  readonly name: string;
  readonly description: string;
  readonly entryRules: {
    readonly sessionLaunchRequired: boolean;
    readonly realSolThresholdSol: number;
    readonly firstCrossingOnly: boolean;
    readonly minTokenAgeMs: number;
    readonly minObservedTrades: number;
    readonly instantBundleFilter: string;
    readonly reboundCondition: "none";
    readonly sellVolumeFilter: "none";
    readonly higherLowFilter: "none";
  };
  readonly entryTrigger: {
    readonly launchObservedInSession: boolean;
    readonly minRealSolLamports: bigint;
    readonly minAgeMs: number;
    readonly minTradeCount: number;
    readonly disallowSameSlotBundle: boolean;
    readonly hasReboundFilter: boolean;
    readonly hasSellVolumeFilter: boolean;
    readonly hasHigherLowFilter: boolean;
  };
  readonly sizing: {
    readonly curveSolInputSol: number;
    readonly curveSolInputLamports: string;
  };
  readonly costModel: {
    readonly scenarioId: string;
    readonly pumpFeeBps: number;
    readonly baseTxFeeLamports: number;
    readonly priorityTxFeeLamports: number;
    readonly jitoTipLamports: number;
  };
  readonly exitRules: {
    readonly tpNetReturnPct: number;
    readonly slNetReturnPct: number;
    readonly timeoutSec: number;
    readonly migrationHandling: string;
    readonly sessionBoundaryHandling: string;
  };
}

export const PAPER_STRATEGY_DEFINITION: PaperStrategyDefinition = {
  id: PAPER_STRATEGY_ID,
  strategyId: PAPER_STRATEGY_ID,
  thesis: "Graduation / Curve-Progress Momentum",
  name: "Organic 50 SOL Continuation Strategy",
  description:
    "Causal curve-continuation strategy entering on the first organic crossing from <50 SOL to >=50 SOL real reserves for tokens launched in session. Sizing is fixed at 0.10 SOL with executable take-profit (+30% net), stop-loss (-20% net), and 5-minute timeout. No rebound condition, no sell-volume filter, and no higher-low condition.",
  entryRules: {
    sessionLaunchRequired: true,
    realSolThresholdSol: Number(PAPER_CONFIG.crossingSolThresholdLamports) / 1e9,
    firstCrossingOnly: true,
    minTokenAgeMs: PAPER_CONFIG.minTokenAgeMs,
    minObservedTrades: PAPER_CONFIG.minTradeCount,
    instantBundleFilter: "age < 1500ms or single-slot bundled trades",
    reboundCondition: "none",
    sellVolumeFilter: "none",
    higherLowFilter: "none",
  },
  entryTrigger: {
    launchObservedInSession: true,
    minRealSolLamports: PAPER_CONFIG.crossingSolThresholdLamports,
    minAgeMs: PAPER_CONFIG.minTokenAgeMs,
    minTradeCount: PAPER_CONFIG.minTradeCount,
    disallowSameSlotBundle: true,
    hasReboundFilter: false,
    hasSellVolumeFilter: false,
    hasHigherLowFilter: false,
  },
  sizing: {
    curveSolInputSol: Number(PAPER_CONFIG.positionCurveSolInputLamports) / 1e9,
    curveSolInputLamports: PAPER_CONFIG.positionCurveSolInputLamports.toString(),
  },
  costModel: {
    scenarioId: PAPER_COST_SCENARIO_ID,
    pumpFeeBps: Number(PAPER_CONFIG.pumpFeeBps),
    baseTxFeeLamports: Number(PAPER_CONFIG.baseFeeLamportsPerTx),
    priorityTxFeeLamports: Number(PAPER_CONFIG.priorityFeeLamportsPerTx),
    jitoTipLamports: Number(PAPER_CONFIG.jitoTipLamportsPerTx),
  },
  exitRules: {
    tpNetReturnPct: PAPER_CONFIG.tpNetReturnPct,
    slNetReturnPct: PAPER_CONFIG.slNetReturnPct,
    timeoutSec: Math.floor(PAPER_CONFIG.timeoutDurationMs / 1000),
    migrationHandling: "liquidate at final curve state or mark migration-exit-unresolved",
    sessionBoundaryHandling: "mark session-censored and exclude from closed PnL",
  },
} as const;


export type PaperPositionStatus =
  | "open"
  | "take-profit"
  | "stop-loss"
  | "timeout"
  | "migration-exit-unresolved"
  | "session-censored";

export interface PaperTriggerState {
  readonly timestampUnixMs: number;
  readonly mint: string;
  readonly launchTimestampUnixMs: number;
  readonly tokenAgeMs: number;
  readonly realSolLamports: string;
  readonly virtualSolLamports: string;
  readonly virtualTokenBaseUnits: string;
  readonly tradeCount: number;
  readonly buyCount: number;
  readonly sellCount: number;
  readonly creatorWallet: string;
  readonly classificationAtTrigger: string;
  readonly recentBuyVolumeSol?: number | undefined;
  readonly recentSellVolumeSol?: number | undefined;
}

export interface PaperPosition {
  readonly strategyId: typeof PAPER_STRATEGY_ID;
  readonly mint: string;
  readonly openedAtUnixMs: number;
  readonly triggerAtUnixMs: number;
  readonly triggerState: PaperTriggerState;
  readonly entryReserves: {
    readonly virtualSolLamports: bigint;
    readonly virtualTokenBaseUnits: bigint;
    readonly realSolLamports: bigint;
  };
  readonly curveSolInputLamports: bigint;
  readonly entryPumpFeeLamports: bigint;
  readonly entryTxCostLamports: bigint;
  readonly totalWalletOutflowLamports: bigint;
  readonly tokenQuantity: bigint;

  // Mark-to-market dynamic state
  currentExecutableGrossValueLamports: bigint;
  currentEstimatedNetLiquidationValueLamports: bigint;
  unrealizedGrossPnlLamports: bigint;
  unrealizedNetPnlLamports: bigint;
  unrealizedNetReturnPct: number;
  maxFavorableExcursionPct: number;
  maxAdverseExcursionPct: number;
  lastUpdatedUnixMs: number;
  status: PaperPositionStatus;

  // Closed details (populated on exit)
  closedAtUnixMs?: number | undefined;
  exitReason?: PaperPositionStatus | undefined;
  exitGrossCurveSolLamports?: bigint | undefined;
  exitPumpFeeLamports?: bigint | undefined;
  exitTxCostLamports?: bigint | undefined;
  totalPumpFeesLamports?: bigint | undefined;
  totalTxCostsLamports?: bigint | undefined;
  netPnlLamports?: bigint | undefined;
  grossPnlLamports?: bigint | undefined;
  netReturnPct?: number | undefined;
  holdDurationSec?: number | undefined;
}

export interface PaperTradingStats {
  readonly strategyId: string;
  readonly costScenarioId: string;
  strategyDefinition?: PaperStrategyDefinition | undefined;
  entriesTriggered: number;
  openPositions: number;
  closedPositions: number;
  censoredPositions: number;
  unresolvedMigrationPositions: number;
  winningClosedTrades: number;
  losingClosedTrades: number;
  winRatePct: number;
  grossPnlSol: number;
  totalPumpFeesSol: number;
  totalTxCostsSol: number;
  netPnlSol: number;
  averagePnlSol: number;
  medianPnlSol: number;
  profitFactor: number;
  averageWinSol: number;
  averageLossSol: number;
  maxWinSol: number;
  maxLossSol: number;
  averageHoldSec: number;

  pnlByExitReason: {
    takeProfit: { count: number; netPnlSol: number; winRatePct: number };
    stopLoss: { count: number; netPnlSol: number };
    timeout: { count: number; netPnlSol: number; winRatePct: number };
  };

  pnlByTokenAgeBucket: {
    age5to15s: { count: number; netPnlSol: number; winRatePct: number };
    age15to60s: { count: number; netPnlSol: number; winRatePct: number };
    age60sPlus: { count: number; netPnlSol: number; winRatePct: number };
  };

  pnlByOrganicSpeedBucket: {
    fastUnder10s: { count: number; netPnlSol: number; winRatePct: number };
    medium10to30s: { count: number; netPnlSol: number; winRatePct: number };
    steady30sPlus: { count: number; netPnlSol: number; winRatePct: number };
  };

  activePositionsSummary: Array<{
    mint: string;
    openedAtIso: string;
    tokenAgeSec: number;
    currentRealSol: number;
    unrealizedNetReturnPct: number;
    mfePct: number;
    maePct: number;
    status: PaperPositionStatus;
  }>;

  recentClosedTrades: Array<{
    mint: string;
    openedAtIso: string;
    closedAtIso: string;
    holdDurationSec: number;
    exitReason: PaperPositionStatus;
    grossPnlSol: number;
    feesSol: number;
    netPnlSol: number;
    netReturnPct: number;
  }>;
}

interface ObservedTokenState {
  readonly mint: string;
  readonly creatorWallet: string;
  readonly launchTimestampUnixMs: number;
  readonly firstSlot?: number | undefined;
  lastSlot?: number | undefined;
  tradeCount: number;
  buyCount: number;
  sellCount: number;
  currentRealSolLamports: bigint;
  crossed50AtUnixMs?: number | undefined;
  crossed84_5AtUnixMs?: number | undefined;
  recentBuyVolumeLamports: bigint;
  recentSellVolumeLamports: bigint;
  latestActivityUnixMs: number;
}

export class PaperTradingEngine {
  private readonly observedTokens = new Map<string, ObservedTokenState>();
  private readonly positions = new Map<string, PaperPosition>();
  private readonly closedTrades: PaperPosition[] = [];
  private readonly censoredTrades: PaperPosition[] = [];
  private readonly unresolvedMigrationTrades: PaperPosition[] = [];

  private readonly onPositionOpened?: ((pos: PaperPosition) => void) | undefined;
  private readonly onPositionClosed?: ((pos: PaperPosition) => void) | undefined;

  public constructor(options?: {
    onPositionOpened?: (pos: PaperPosition) => void;
    onPositionClosed?: (pos: PaperPosition) => void;
  }) {
    this.onPositionOpened = options?.onPositionOpened;
    this.onPositionClosed = options?.onPositionClosed;
  }

  public onLaunch(event: LaunchMarketEvent): void {
    const mint = event.tokenMint;
    const nowMs = event.timestamps.collectorReceivedAtUnixMs;
    const slot = event.ordering.slot;

    if (!this.observedTokens.has(mint)) {
      this.observedTokens.set(mint, {
        mint,
        creatorWallet: event.creatorWallet,
        launchTimestampUnixMs: nowMs,
        firstSlot: slot,
        lastSlot: slot,
        tradeCount: 0,
        buyCount: 0,
        sellCount: 0,
        currentRealSolLamports: 0n,
        recentBuyVolumeLamports: 0n,
        recentSellVolumeLamports: 0n,
        latestActivityUnixMs: nowMs,
      });
    }
  }

  public onTrade(event: TradeMarketEvent): void {
    const mint = event.tokenMint;
    const nowMs = event.timestamps.collectorReceivedAtUnixMs;
    const slot = event.ordering.slot;
    const realSolLamports = BigInt(event.reserves.realSolLamports || "0");
    const virtualSolLamports = BigInt(event.reserves.virtualSolLamports || "30000000000");
    const virtualTokenBaseUnits = BigInt(event.reserves.virtualTokenBaseUnits || "1073000000000000");
    const isBuy = event.side === "buy";
    const tradeSolLamports = BigInt(event.amounts?.nativeSolLamports || "0");

    let token = this.observedTokens.get(mint);
    const tokenWasLaunchedInSession = token !== undefined && token.launchTimestampUnixMs > 0;

    if (!token) {
      // Token observed mid-stream without a launch event in this session
      token = {
        mint,
        creatorWallet: event.creatorWallet || "unknown",
        launchTimestampUnixMs: 0, // indicates not launched in session
        firstSlot: slot,
        lastSlot: slot,
        tradeCount: 0,
        buyCount: 0,
        sellCount: 0,
        currentRealSolLamports: realSolLamports,
        recentBuyVolumeLamports: 0n,
        recentSellVolumeLamports: 0n,
        latestActivityUnixMs: nowMs,
      };
      this.observedTokens.set(mint, token);
    }

    const previousRealSol = token.currentRealSolLamports;
    token.currentRealSolLamports = realSolLamports;
    token.lastSlot = slot;
    token.latestActivityUnixMs = nowMs;
    token.tradeCount += 1;

    if (isBuy) {
      token.buyCount += 1;
      token.recentBuyVolumeLamports += tradeSolLamports;
    } else {
      token.sellCount += 1;
      token.recentSellVolumeLamports += tradeSolLamports;
    }

    // 1. Check exit conditions on any existing open paper position for this mint
    const openPos = this.positions.get(mint);
    if (openPos && openPos.status === "open") {
      this.evaluatePositionExit(openPos, nowMs, virtualSolLamports, virtualTokenBaseUnits, realSolLamports);
    }

    // 2. Check causal entry conditions
    // Rule:
    // - launched in session
    // - crosses >= 50 SOL for the FIRST time
    // - age >= 5s
    // - trade count >= 5
    // - NOT instant-bundle-like
    // - no existing position for this mint
    if (
      tokenWasLaunchedInSession &&
      token.crossed50AtUnixMs === undefined &&
      previousRealSol < PAPER_CONFIG.crossingSolThresholdLamports &&
      realSolLamports >= PAPER_CONFIG.crossingSolThresholdLamports
    ) {
      token.crossed50AtUnixMs = nowMs;
      const ageMs = nowMs - token.launchTimestampUnixMs;
      const isInstantBundle =
        ageMs < 1_500 ||
        (token.firstSlot !== undefined && token.lastSlot !== undefined && token.firstSlot === token.lastSlot);

      const meetsEntry =
        ageMs >= PAPER_CONFIG.minTokenAgeMs &&
        token.tradeCount >= PAPER_CONFIG.minTradeCount &&
        !isInstantBundle &&
        !this.positions.has(mint);

      if (meetsEntry) {
        this.openPaperPosition(token, nowMs, virtualSolLamports, virtualTokenBaseUnits, realSolLamports);
      }
    }
  }

  private openPaperPosition(
    token: ObservedTokenState,
    nowMs: number,
    vSol: bigint,
    vTok: bigint,
    rSol: bigint,
  ): void {
    const curveSolInput = PAPER_CONFIG.positionCurveSolInputLamports;
    const buyQuote: PumpBuyQuote = quotePumpBuy(curveSolInput, vSol, vTok, PAPER_CONFIG.pumpFeeBps);

    if (buyQuote.tokensReceived <= 0n) {
      return; // Curve depleted or invalid quote
    }

    const entryTxCost = PAPER_CONFIG.baseFeeLamportsPerTx + PAPER_CONFIG.priorityFeeLamportsPerTx;
    const totalOutflow = buyQuote.totalWalletOutflowLamports + entryTxCost;

    const triggerState: PaperTriggerState = {
      timestampUnixMs: nowMs,
      mint: token.mint,
      launchTimestampUnixMs: token.launchTimestampUnixMs,
      tokenAgeMs: nowMs - token.launchTimestampUnixMs,
      realSolLamports: rSol.toString(),
      virtualSolLamports: vSol.toString(),
      virtualTokenBaseUnits: vTok.toString(),
      tradeCount: token.tradeCount,
      buyCount: token.buyCount,
      sellCount: token.sellCount,
      creatorWallet: token.creatorWallet,
      classificationAtTrigger: "organic",
      recentBuyVolumeSol: Number(token.recentBuyVolumeLamports) / 1e9,
      recentSellVolumeSol: Number(token.recentSellVolumeLamports) / 1e9,
    };

    const position: PaperPosition = {
      strategyId: PAPER_STRATEGY_ID,
      mint: token.mint,
      openedAtUnixMs: nowMs,
      triggerAtUnixMs: nowMs,
      triggerState,
      entryReserves: {
        virtualSolLamports: vSol,
        virtualTokenBaseUnits: vTok,
        realSolLamports: rSol,
      },
      curveSolInputLamports: curveSolInput,
      entryPumpFeeLamports: buyQuote.feeLamports,
      entryTxCostLamports: entryTxCost,
      totalWalletOutflowLamports: totalOutflow,
      tokenQuantity: buyQuote.tokensReceived,

      currentExecutableGrossValueLamports: curveSolInput,
      currentEstimatedNetLiquidationValueLamports: totalOutflow,
      unrealizedGrossPnlLamports: 0n,
      unrealizedNetPnlLamports: 0n,
      unrealizedNetReturnPct: 0,
      maxFavorableExcursionPct: 0,
      maxAdverseExcursionPct: 0,
      lastUpdatedUnixMs: nowMs,
      status: "open",
    };

    this.positions.set(token.mint, position);
    if (this.onPositionOpened) {
      this.onPositionOpened({ ...position });
    }
  }

  private evaluatePositionExit(
    pos: PaperPosition,
    nowMs: number,
    vSol: bigint,
    vTok: bigint,
    rSol: bigint,
  ): void {
    const elapsedMs = nowMs - pos.openedAtUnixMs;

    // Check if curve has graduated / migration occurred
    const curveCompleted = rSol >= PAPER_CONFIG.graduationSolThresholdLamports;

    // Attempt executable quote
    let sellQuote: PumpSellQuote | null = null;
    try {
      if (vSol > 0n && vTok > 0n) {
        sellQuote = quotePumpSell(pos.tokenQuantity, vSol, vTok, PAPER_CONFIG.pumpFeeBps);
      }
    } catch {
      sellQuote = null;
    }

    // If curve completed and we cannot execute a valid sell quote, mark migration-exit-unresolved
    if (curveCompleted && (!sellQuote || sellQuote.grossCurveSolOutLamports <= 0n)) {
      pos.status = "migration-exit-unresolved";
      pos.closedAtUnixMs = nowMs;
      pos.exitReason = "migration-exit-unresolved";
      pos.holdDurationSec = Math.floor(elapsedMs / 1000);
      this.unresolvedMigrationTrades.push({ ...pos });
      if (this.onPositionClosed) {
        this.onPositionClosed({ ...pos });
      }
      return;
    }

    if (!sellQuote || sellQuote.grossCurveSolOutLamports <= 0n) {
      // Temporary quote failure; keep open if within timeout
      if (elapsedMs >= PAPER_CONFIG.timeoutDurationMs) {
        pos.status = "migration-exit-unresolved";
        pos.closedAtUnixMs = nowMs;
        pos.exitReason = "migration-exit-unresolved";
        pos.holdDurationSec = Math.floor(elapsedMs / 1000);
        this.unresolvedMigrationTrades.push({ ...pos });
        if (this.onPositionClosed) {
          this.onPositionClosed({ ...pos });
        }
      }
      return;
    }

    const exitTxCost = PAPER_CONFIG.baseFeeLamportsPerTx + PAPER_CONFIG.priorityFeeLamportsPerTx;
    const grossCurveSolOut = sellQuote.grossCurveSolOutLamports;
    const exitPumpFee = sellQuote.feeLamports;
    const netWalletInflow =
      sellQuote.netWalletInflowLamports > exitTxCost
        ? sellQuote.netWalletInflowLamports - exitTxCost
        : 0n;

    pos.currentExecutableGrossValueLamports = grossCurveSolOut;
    pos.currentEstimatedNetLiquidationValueLamports = netWalletInflow;
    pos.unrealizedGrossPnlLamports = grossCurveSolOut - pos.curveSolInputLamports;
    pos.unrealizedNetPnlLamports = netWalletInflow - pos.totalWalletOutflowLamports;

    const netReturnPct =
      (Number(netWalletInflow - pos.totalWalletOutflowLamports) /
        Number(pos.totalWalletOutflowLamports)) *
      100;
    pos.unrealizedNetReturnPct = netReturnPct;

    if (netReturnPct > pos.maxFavorableExcursionPct) {
      pos.maxFavorableExcursionPct = netReturnPct;
    }
    if (netReturnPct < pos.maxAdverseExcursionPct) {
      pos.maxAdverseExcursionPct = netReturnPct;
    }
    pos.lastUpdatedUnixMs = nowMs;

    // Check Frozen Exit Rules
    let exitTriggered: PaperPositionStatus | null = null;
    if (netReturnPct >= PAPER_CONFIG.tpNetReturnPct) {
      exitTriggered = "take-profit";
    } else if (netReturnPct <= PAPER_CONFIG.slNetReturnPct) {
      exitTriggered = "stop-loss";
    } else if (elapsedMs >= PAPER_CONFIG.timeoutDurationMs) {
      exitTriggered = "timeout";
    }

    if (exitTriggered) {
      pos.status = exitTriggered;
      pos.closedAtUnixMs = nowMs;
      pos.exitReason = exitTriggered;
      pos.exitGrossCurveSolLamports = grossCurveSolOut;
      pos.exitPumpFeeLamports = exitPumpFee;
      pos.exitTxCostLamports = exitTxCost;
      pos.totalPumpFeesLamports = pos.entryPumpFeeLamports + exitPumpFee;
      pos.totalTxCostsLamports = pos.entryTxCostLamports + exitTxCost;
      pos.grossPnlLamports = grossCurveSolOut - pos.curveSolInputLamports;
      pos.netPnlLamports = netWalletInflow - pos.totalWalletOutflowLamports;
      pos.netReturnPct = netReturnPct;
      pos.holdDurationSec = Math.floor(elapsedMs / 1000);

      this.closedTrades.push({ ...pos });
      if (this.onPositionClosed) {
        this.onPositionClosed({ ...pos });
      }
    }
  }

  public onSessionEnd(nowMs = Date.now()): void {
    for (const pos of this.positions.values()) {
      if (pos.status === "open") {
        pos.status = "session-censored";
        pos.closedAtUnixMs = nowMs;
        pos.exitReason = "session-censored";
        pos.holdDurationSec = Math.floor((nowMs - pos.openedAtUnixMs) / 1000);
        this.censoredTrades.push({ ...pos });
      }
    }
  }

  public getOpenPositions(): PaperPosition[] {
    return Array.from(this.positions.values()).filter((p) => p.status === "open");
  }

  public getClosedTrades(): PaperPosition[] {
    return [...this.closedTrades];
  }

  public getCensoredTrades(): PaperPosition[] {
    return [...this.censoredTrades];
  }

  public getUnresolvedMigrationTrades(): PaperPosition[] {
    return [...this.unresolvedMigrationTrades];
  }

  public getStats(): PaperTradingStats {
    const closed = this.closedTrades;
    const open = this.getOpenPositions();
    const censored = this.censoredTrades;
    const unresolved = this.unresolvedMigrationTrades;

    let grossPnlLamports = 0n;
    let totalPumpFeesLamports = 0n;
    let totalTxCostsLamports = 0n;
    let netPnlLamports = 0n;
    let totalWinsLamports = 0n;
    let totalLossesLamports = 0n;

    let winningClosedTrades = 0;
    let losingClosedTrades = 0;
    let maxWinLamports = 0n;
    let maxLossLamports = 0n;
    let totalHoldSec = 0;

    const pnlListLamports: bigint[] = [];

    // Breakdowns
    const exitReasonStats = {
      takeProfit: { count: 0, netPnlLamports: 0n, wins: 0 },
      stopLoss: { count: 0, netPnlLamports: 0n },
      timeout: { count: 0, netPnlLamports: 0n, wins: 0 },
    };

    const ageBucketStats = {
      age5to15s: { count: 0, netPnlLamports: 0n, wins: 0 },
      age15to60s: { count: 0, netPnlLamports: 0n, wins: 0 },
      age60sPlus: { count: 0, netPnlLamports: 0n, wins: 0 },
    };

    const speedBucketStats = {
      fastUnder10s: { count: 0, netPnlLamports: 0n, wins: 0 },
      medium10to30s: { count: 0, netPnlLamports: 0n, wins: 0 },
      steady30sPlus: { count: 0, netPnlLamports: 0n, wins: 0 },
    };

    for (const trade of closed) {
      const netPnl = trade.netPnlLamports ?? 0n;
      const grossPnl = trade.grossPnlLamports ?? 0n;
      const fees = trade.totalPumpFeesLamports ?? 0n;
      const tx = trade.totalTxCostsLamports ?? 0n;
      const hold = trade.holdDurationSec ?? 0;

      grossPnlLamports += grossPnl;
      totalPumpFeesLamports += fees;
      totalTxCostsLamports += tx;
      netPnlLamports += netPnl;
      totalHoldSec += hold;
      pnlListLamports.push(netPnl);

      if (netPnl > 0n) {
        winningClosedTrades += 1;
        totalWinsLamports += netPnl;
        if (netPnl > maxWinLamports) maxWinLamports = netPnl;
      } else {
        losingClosedTrades += 1;
        totalLossesLamports += netPnl < 0n ? -netPnl : 0n;
        if (netPnl < maxLossLamports) maxLossLamports = netPnl;
      }

      // Exit Reason breakdown
      if (trade.exitReason === "take-profit") {
        exitReasonStats.takeProfit.count += 1;
        exitReasonStats.takeProfit.netPnlLamports += netPnl;
        if (netPnl > 0n) exitReasonStats.takeProfit.wins += 1;
      } else if (trade.exitReason === "stop-loss") {
        exitReasonStats.stopLoss.count += 1;
        exitReasonStats.stopLoss.netPnlLamports += netPnl;
      } else if (trade.exitReason === "timeout") {
        exitReasonStats.timeout.count += 1;
        exitReasonStats.timeout.netPnlLamports += netPnl;
        if (netPnl > 0n) exitReasonStats.timeout.wins += 1;
      }

      // Age at trigger breakdown
      const ageMs = trade.triggerState.tokenAgeMs;
      if (ageMs <= 15_000) {
        ageBucketStats.age5to15s.count += 1;
        ageBucketStats.age5to15s.netPnlLamports += netPnl;
        if (netPnl > 0n) ageBucketStats.age5to15s.wins += 1;
      } else if (ageMs <= 60_000) {
        ageBucketStats.age15to60s.count += 1;
        ageBucketStats.age15to60s.netPnlLamports += netPnl;
        if (netPnl > 0n) ageBucketStats.age15to60s.wins += 1;
      } else {
        ageBucketStats.age60sPlus.count += 1;
        ageBucketStats.age60sPlus.netPnlLamports += netPnl;
        if (netPnl > 0n) ageBucketStats.age60sPlus.wins += 1;
      }

      // Organic speed to 50 SOL bucket
      if (ageMs < 10_000) {
        speedBucketStats.fastUnder10s.count += 1;
        speedBucketStats.fastUnder10s.netPnlLamports += netPnl;
        if (netPnl > 0n) speedBucketStats.fastUnder10s.wins += 1;
      } else if (ageMs <= 30_000) {
        speedBucketStats.medium10to30s.count += 1;
        speedBucketStats.medium10to30s.netPnlLamports += netPnl;
        if (netPnl > 0n) speedBucketStats.medium10to30s.wins += 1;
      } else {
        speedBucketStats.steady30sPlus.count += 1;
        speedBucketStats.steady30sPlus.netPnlLamports += netPnl;
        if (netPnl > 0n) speedBucketStats.steady30sPlus.wins += 1;
      }
    }

    const closedCount = closed.length;
    // CRITICAL: win rate strictly excludes open/censored/unresolved from denominator
    const winRatePct = closedCount > 0 ? (winningClosedTrades / closedCount) * 100 : 0;
    const averagePnlSol = closedCount > 0 ? Number(netPnlLamports) / 1e9 / closedCount : 0;

    // Median PnL
    pnlListLamports.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    let medianPnlSol = 0;
    if (closedCount > 0) {
      const mid = Math.floor(closedCount / 2);
      medianPnlSol =
        closedCount % 2 !== 0
          ? Number(pnlListLamports[mid]!) / 1e9
          : Number(pnlListLamports[mid - 1]! + pnlListLamports[mid]!) / (2 * 1e9);
    }

    const profitFactor =
      totalLossesLamports > 0n
        ? Number(totalWinsLamports) / Number(totalLossesLamports)
        : totalWinsLamports > 0n
          ? 999.0
          : 0;

    const averageWinSol =
      winningClosedTrades > 0 ? Number(totalWinsLamports) / 1e9 / winningClosedTrades : 0;
    const averageLossSol =
      losingClosedTrades > 0 ? -Number(totalLossesLamports) / 1e9 / losingClosedTrades : 0;

    const averageHoldSec = closedCount > 0 ? totalHoldSec / closedCount : 0;

    const activePositionsSummary = open.slice(0, 50).map((p) => ({
      mint: p.mint,
      openedAtIso: new Date(p.openedAtUnixMs).toISOString(),
      tokenAgeSec: Math.floor((p.lastUpdatedUnixMs - p.triggerState.launchTimestampUnixMs) / 1000),
      currentRealSol: Number(p.entryReserves.realSolLamports) / 1e9,
      unrealizedNetReturnPct: Number(p.unrealizedNetReturnPct.toFixed(2)),
      mfePct: Number(p.maxFavorableExcursionPct.toFixed(2)),
      maePct: Number(p.maxAdverseExcursionPct.toFixed(2)),
      status: p.status,
    }));

    const recentClosedTrades = closed
      .slice(-50)
      .reverse()
      .map((p) => ({
        mint: p.mint,
        openedAtIso: new Date(p.openedAtUnixMs).toISOString(),
        closedAtIso: new Date(p.closedAtUnixMs ?? p.lastUpdatedUnixMs).toISOString(),
        holdDurationSec: p.holdDurationSec ?? 0,
        exitReason: p.exitReason ?? p.status,
        grossPnlSol: Number(p.grossPnlLamports ?? 0n) / 1e9,
        feesSol: (Number(p.totalPumpFeesLamports ?? 0n) + Number(p.totalTxCostsLamports ?? 0n)) / 1e9,
        netPnlSol: Number(p.netPnlLamports ?? 0n) / 1e9,
        netReturnPct: Number((p.netReturnPct ?? 0).toFixed(2)),
      }));

    return {
      strategyId: PAPER_STRATEGY_ID,
      costScenarioId: PAPER_COST_SCENARIO_ID,
      entriesTriggered: this.positions.size,
      openPositions: open.length,
      closedPositions: closedCount,
      censoredPositions: censored.length,
      unresolvedMigrationPositions: unresolved.length,
      winningClosedTrades,
      losingClosedTrades,
      winRatePct: Number(winRatePct.toFixed(2)),
      grossPnlSol: Number((Number(grossPnlLamports) / 1e9).toFixed(6)),
      totalPumpFeesSol: Number((Number(totalPumpFeesLamports) / 1e9).toFixed(6)),
      totalTxCostsSol: Number((Number(totalTxCostsLamports) / 1e9).toFixed(6)),
      netPnlSol: Number((Number(netPnlLamports) / 1e9).toFixed(6)),
      averagePnlSol: Number(averagePnlSol.toFixed(6)),
      medianPnlSol: Number(medianPnlSol.toFixed(6)),
      profitFactor: Number(profitFactor.toFixed(2)),
      averageWinSol: Number(averageWinSol.toFixed(6)),
      averageLossSol: Number(averageLossSol.toFixed(6)),
      maxWinSol: Number((Number(maxWinLamports) / 1e9).toFixed(6)),
      maxLossSol: Number((Number(maxLossLamports) / 1e9).toFixed(6)),
      averageHoldSec: Math.round(averageHoldSec),

      pnlByExitReason: {
        takeProfit: {
          count: exitReasonStats.takeProfit.count,
          netPnlSol: Number((Number(exitReasonStats.takeProfit.netPnlLamports) / 1e9).toFixed(6)),
          winRatePct:
            exitReasonStats.takeProfit.count > 0
              ? Number(
                  (
                    (exitReasonStats.takeProfit.wins / exitReasonStats.takeProfit.count) *
                    100
                  ).toFixed(2),
                )
              : 0,
        },
        stopLoss: {
          count: exitReasonStats.stopLoss.count,
          netPnlSol: Number((Number(exitReasonStats.stopLoss.netPnlLamports) / 1e9).toFixed(6)),
        },
        timeout: {
          count: exitReasonStats.timeout.count,
          netPnlSol: Number((Number(exitReasonStats.timeout.netPnlLamports) / 1e9).toFixed(6)),
          winRatePct:
            exitReasonStats.timeout.count > 0
              ? Number(
                  ((exitReasonStats.timeout.wins / exitReasonStats.timeout.count) * 100).toFixed(2),
                )
              : 0,
        },
      },

      pnlByTokenAgeBucket: {
        age5to15s: {
          count: ageBucketStats.age5to15s.count,
          netPnlSol: Number((Number(ageBucketStats.age5to15s.netPnlLamports) / 1e9).toFixed(6)),
          winRatePct:
            ageBucketStats.age5to15s.count > 0
              ? Number(
                  ((ageBucketStats.age5to15s.wins / ageBucketStats.age5to15s.count) * 100).toFixed(2),
                )
              : 0,
        },
        age15to60s: {
          count: ageBucketStats.age15to60s.count,
          netPnlSol: Number((Number(ageBucketStats.age15to60s.netPnlLamports) / 1e9).toFixed(6)),
          winRatePct:
            ageBucketStats.age15to60s.count > 0
              ? Number(
                  ((ageBucketStats.age15to60s.wins / ageBucketStats.age15to60s.count) * 100).toFixed(
                    2,
                  ),
                )
              : 0,
        },
        age60sPlus: {
          count: ageBucketStats.age60sPlus.count,
          netPnlSol: Number((Number(ageBucketStats.age60sPlus.netPnlLamports) / 1e9).toFixed(6)),
          winRatePct:
            ageBucketStats.age60sPlus.count > 0
              ? Number(
                  ((ageBucketStats.age60sPlus.wins / ageBucketStats.age60sPlus.count) * 100).toFixed(
                    2,
                  ),
                )
              : 0,
        },
      },

      pnlByOrganicSpeedBucket: {
        fastUnder10s: {
          count: speedBucketStats.fastUnder10s.count,
          netPnlSol: Number((Number(speedBucketStats.fastUnder10s.netPnlLamports) / 1e9).toFixed(6)),
          winRatePct:
            speedBucketStats.fastUnder10s.count > 0
              ? Number(
                  (
                    (speedBucketStats.fastUnder10s.wins / speedBucketStats.fastUnder10s.count) *
                    100
                  ).toFixed(2),
                )
              : 0,
        },
        medium10to30s: {
          count: speedBucketStats.medium10to30s.count,
          netPnlSol: Number((Number(speedBucketStats.medium10to30s.netPnlLamports) / 1e9).toFixed(6)),
          winRatePct:
            speedBucketStats.medium10to30s.count > 0
              ? Number(
                  (
                    (speedBucketStats.medium10to30s.wins / speedBucketStats.medium10to30s.count) *
                    100
                  ).toFixed(2),
                )
              : 0,
        },
        steady30sPlus: {
          count: speedBucketStats.steady30sPlus.count,
          netPnlSol: Number((Number(speedBucketStats.steady30sPlus.netPnlLamports) / 1e9).toFixed(6)),
          winRatePct:
            speedBucketStats.steady30sPlus.count > 0
              ? Number(
                  (
                    (speedBucketStats.steady30sPlus.wins / speedBucketStats.steady30sPlus.count) *
                    100
                  ).toFixed(2),
                )
              : 0,
        },
      },

      strategyDefinition: PAPER_STRATEGY_DEFINITION,
      activePositionsSummary,
      recentClosedTrades,
    };
  }

  public exportSummary(): PaperTradingStats {
    return this.getStats();
  }
}
