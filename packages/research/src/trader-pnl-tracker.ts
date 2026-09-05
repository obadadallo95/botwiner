import type { LaunchMarketEvent, TradeMarketEvent } from "@botwiner/market-data";
import { quotePumpSell, type PumpSellQuote } from "./rebound-research.js";

export type DataQualityState = "CLEAN" | "PARTIAL" | "UNRESOLVED";

export type TraderPositionClassification =
  | "realized-profitable"
  | "realized-loss"
  | "open-profitable"
  | "open-underwater"
  | "flat"
  | "unknown-partial";

export interface WalletMintAccounting {
  readonly wallet: string;
  readonly mint: string;
  dataQuality: DataQualityState;
  qualityReason?: string | undefined;

  tokenUnitsBought: bigint;
  tokenUnitsSold: bigint;
  inventoryUnits: bigint;
  peakInventoryUnits: bigint;

  solSpentLamports: bigint;
  solReceivedLamports: bigint;
  realizedTradingCashFlowLamports: bigint; // solReceived - solSpent

  remainingCostBasisLamports: bigint; // Exact integer remaining cost basis
  costBasisLamportsPerToken?: number | undefined; // Informational / display only
  realizedPnlLamports: bigint;

  // Mark to market
  latestExecutableGrossSolLamports: bigint;
  latestExecutableNetSolLamports: bigint;
  unrealizedPnlLamports: bigint;
  totalMarkedPnlLamports: bigint;
  marginalPriceSolPerToken: number;
  priceImpactPct: number;

  classification: TraderPositionClassification;
  firstSeenAtUnixMs: number;
  lastSeenAtUnixMs: number;
  tradeCount: number;
  isCreator: boolean;
}

export interface CreatorTokenAnalytics {
  readonly mint: string;
  readonly creatorWallet: string;
  readonly launchTimestampUnixMs: number;
  creatorInventoryQuality: DataQualityState;
  dataQuality?: DataQualityState | undefined;

  tokenBuys: number;
  tokenSells: number;
  creatorTokensBought: bigint;
  creatorTokensSold: bigint;
  creatorInventoryUnits: bigint;
  solSpentLamports: bigint;
  solReceivedLamports: bigint;
  observedNetSolExtractionLamports: bigint; // solReceived - solSpent

  firstSellTimestampUnixMs?: number | undefined;
  firstSellDelaySec?: number | undefined;
  pctObservedInventorySold?: number | undefined;
  holdingStatus: "holding" | "partially-exited" | "fully-exited" | "unknown-partial";
  lastActivityUnixMs: number;
}

export interface CreatorAggregateAnalytics {
  creatorsObserved: number;
  cleanCreatorsCount: number;
  partialCreatorsCount: number;
  creatorsSelling: number;
  cleanCreatorsFullyExited: number;
  creatorsFullyExited: number; // Headline points to cleanCreatorsFullyExited
  medianCleanFirstSellDelaySec: number;
  medianFirstSellDelaySec: number;
  totalObservedCreatorExtractionSol: number;
  medianObservedCreatorExtractionSol: number;
  largestObservedExtractionSol: number;
  p50Sol: number;
  p75Sol: number;
  p90Sol: number;
  p95Sol: number;

  topCreatorExtractions: Array<{
    creatorWallet: string;
    mint: string;
    netExtractionSol: number;
    firstSellDelaySec: number;
    pctSold?: number | undefined;
    inventoryQuality: DataQualityState;
  }>;
}

export interface MarketParticipantStats {
  disclaimer: string;
  feeCoverageDisclaimer: string;

  totalObservedWallets: number;
  cleanEligibleWallets: number;
  partialWallets: number;
  unresolvedWallets: number;

  // Headline win rates
  cleanClosedWalletCount: number;
  cleanClosedWinningWalletCount: number;
  cleanClosedTraderWinRatePct: number; // Fully closed clean wallets win rate

  cleanMarkedWalletCount: number;
  cleanMarkedPositivePnlCount: number;
  cleanMarkedPositivePnlRatePct: number; // All clean marked wallets with total PnL > 0

  // Realized vs Unrealized Distributions
  realizedProfitableCount: number;
  realizedLossCount: number;
  openProfitableCount: number;
  openUnderwaterCount: number;
  flatCount: number;

  // PnL Totals for Clean Wallets
  totalCleanRealizedPnlSol: number;
  totalCleanUnrealizedPnlSol: number;
  totalCleanMarkedPnlSol: number;

  // Whale / Concentration Intelligence
  top1PctWalletsSolVolumeSharePct: number;
  top5WalletsBuyVolumeSol: number;
  top5WalletsBuyVolumeSharePct: number;

  topCleanWinners: Array<{
    wallet: string;
    markedPnlSol: number;
    realizedPnlSol: number;
    tradeCount: number;
    mintsTraded: number;
  }>;

  topCleanLosers: Array<{
    wallet: string;
    markedPnlSol: number;
    realizedPnlSol: number;
    tradeCount: number;
    mintsTraded: number;
  }>;

  creatorAnalytics: CreatorAggregateAnalytics;
}

interface MintReserveState {
  virtualSolLamports: bigint;
  virtualTokenBaseUnits: bigint;
  realSolLamports: bigint;
  lastUpdatedUnixMs: number;
}

export class TraderPnlTracker {
  // Key: `${wallet}:${mint}`
  private readonly positions = new Map<string, WalletMintAccounting>();
  // Key: mint
  private readonly creatorPerMint = new Map<string, CreatorTokenAnalytics>();
  // Key: mint
  private readonly tokenReserves = new Map<string, MintReserveState>();
  // Key: mint -> launch event timestamp
  private readonly sessionLaunches = new Map<string, number>();

  // Wallet-level aggregates
  private readonly walletBuyVolumes = new Map<string, bigint>();
  private readonly walletTotalTrades = new Map<string, number>();
  private readonly walletMints = new Map<string, Set<string>>();

  public onLaunch(event: LaunchMarketEvent): void {
    const mint = event.tokenMint;
    const nowMs = event.timestamps.collectorReceivedAtUnixMs;
    this.sessionLaunches.set(mint, nowMs);

    if (event.creatorWallet) {
      this.creatorPerMint.set(mint, {
        mint,
        creatorWallet: event.creatorWallet,
        launchTimestampUnixMs: nowMs,
        creatorInventoryQuality: "CLEAN",
        dataQuality: "CLEAN",
        tokenBuys: 0,
        tokenSells: 0,
        creatorTokensBought: 0n,
        creatorTokensSold: 0n,
        creatorInventoryUnits: 0n,
        solSpentLamports: 0n,
        solReceivedLamports: 0n,
        observedNetSolExtractionLamports: 0n,
        pctObservedInventorySold: undefined,
        holdingStatus: "holding",
        lastActivityUnixMs: nowMs,
      });
    }
  }

  public onTrade(event: TradeMarketEvent): void {
    const mint = event.tokenMint;
    const wallet = event.traderWallet;
    if (!wallet || wallet === "unknown") return;

    const nowMs = event.timestamps.collectorReceivedAtUnixMs;
    const isBuy = event.side === "buy";
    const solAmountLamports = BigInt(event.amounts?.nativeSolLamports || "0");
    const tokenAmountUnits = BigInt(event.amounts?.tokenBaseUnits || "0");
    const vSol = BigInt(event.reserves.virtualSolLamports || "30000000000");
    const vTok = BigInt(event.reserves.virtualTokenBaseUnits || "1073000000000000");
    const rSol = BigInt(event.reserves.realSolLamports || "0");

    this.tokenReserves.set(mint, {
      virtualSolLamports: vSol,
      virtualTokenBaseUnits: vTok,
      realSolLamports: rSol,
      lastUpdatedUnixMs: nowMs,
    });

    // Track wallet activity
    this.walletTotalTrades.set(wallet, (this.walletTotalTrades.get(wallet) || 0) + 1);
    if (isBuy) {
      this.walletBuyVolumes.set(
        wallet,
        (this.walletBuyVolumes.get(wallet) || 0n) + solAmountLamports,
      );
    }
    let mintSet = this.walletMints.get(wallet);
    if (!mintSet) {
      mintSet = new Set<string>();
      this.walletMints.set(wallet, mintSet);
    }
    mintSet.add(mint);

    // Track Creator Extraction if applicable
    const creatorState = this.creatorPerMint.get(mint);
    const isCreator =
      Boolean(creatorState && creatorState.creatorWallet === wallet) ||
      Boolean(event.creatorWallet && event.creatorWallet === wallet);

    if (isCreator && creatorState) {
      this.updateCreatorTrade(creatorState, isBuy, solAmountLamports, tokenAmountUnits, nowMs);
    }

    // Update Wallet + Mint accounting
    const positionKey = `${wallet}:${mint}`;
    let pos = this.positions.get(positionKey);

    if (!pos) {
      // First time we observe this wallet on this mint
      const tokenLaunchedInSession = this.sessionLaunches.has(mint);

      let initialQuality: DataQualityState = "CLEAN";
      let qualityReason: string | undefined;

      if (!isBuy) {
        // A wallet's first observed action is a SELL: inventory-origin-unknown!
        initialQuality = "PARTIAL";
        qualityReason = "inventory-origin-unknown (first observed action is sell)";
      } else if (!tokenLaunchedInSession) {
        // Token launched before session: mid-session start
        initialQuality = "PARTIAL";
        qualityReason = "token-launched-before-session";
      }

      pos = {
        wallet,
        mint,
        dataQuality: initialQuality,
        qualityReason,
        tokenUnitsBought: 0n,
        tokenUnitsSold: 0n,
        inventoryUnits: 0n,
        peakInventoryUnits: 0n,
        solSpentLamports: 0n,
        solReceivedLamports: 0n,
        realizedTradingCashFlowLamports: 0n,
        remainingCostBasisLamports: 0n,
        costBasisLamportsPerToken: 0,
        realizedPnlLamports: 0n,
        latestExecutableGrossSolLamports: 0n,
        latestExecutableNetSolLamports: 0n,
        unrealizedPnlLamports: 0n,
        totalMarkedPnlLamports: 0n,
        marginalPriceSolPerToken: 0,
        priceImpactPct: 0,
        classification: initialQuality === "CLEAN" ? "flat" : "unknown-partial",
        firstSeenAtUnixMs: nowMs,
        lastSeenAtUnixMs: nowMs,
        tradeCount: 0,
        isCreator,
      };
      this.positions.set(positionKey, pos);
    }

    this.applyTradeToPosition(pos, isBuy, solAmountLamports, tokenAmountUnits, vSol, vTok, nowMs);
  }

  private applyTradeToPosition(
    pos: WalletMintAccounting,
    isBuy: boolean,
    solLamports: bigint,
    tokenUnits: bigint,
    vSol: bigint,
    vTok: bigint,
    nowMs: number,
  ): void {
    pos.tradeCount += 1;
    pos.lastSeenAtUnixMs = nowMs;

    if (isBuy) {
      pos.tokenUnitsBought += tokenUnits;
      pos.solSpentLamports += solLamports;

      // Exact integer Weighted-Average Cost basis (WAC)
      pos.inventoryUnits += tokenUnits;
      pos.remainingCostBasisLamports += solLamports;
      pos.costBasisLamportsPerToken =
        pos.inventoryUnits > 0n
          ? Number(pos.remainingCostBasisLamports) / Number(pos.inventoryUnits)
          : 0;

      if (pos.inventoryUnits > pos.peakInventoryUnits) {
        pos.peakInventoryUnits = pos.inventoryUnits;
      }
    } else {
      // Sell
      pos.tokenUnitsSold += tokenUnits;
      pos.solReceivedLamports += solLamports;

      if (pos.dataQuality === "CLEAN") {
        if (tokenUnits > pos.inventoryUnits) {
          // Inconsistent inventory: sold more than bought
          pos.dataQuality = "UNRESOLVED";
          pos.qualityReason = "sold-more-tokens-than-observed-inventory";
          pos.classification = "unknown-partial";
        } else {
          const prevInventory = pos.inventoryUnits;
          let realizedCostLamports = 0n;

          if (tokenUnits === prevInventory) {
            // Full close: all remaining cost basis is realized, remaining clears to exactly 0n
            realizedCostLamports = pos.remainingCostBasisLamports;
            pos.remainingCostBasisLamports = 0n;
            pos.inventoryUnits = 0n;
          } else {
            // Partial sell: proportional basis with deterministic half-up integer rounding
            realizedCostLamports =
              ((pos.remainingCostBasisLamports * tokenUnits) + (prevInventory / 2n)) / prevInventory;
            if (realizedCostLamports > pos.remainingCostBasisLamports) {
              realizedCostLamports = pos.remainingCostBasisLamports;
            }
            pos.remainingCostBasisLamports -= realizedCostLamports;
            pos.inventoryUnits -= tokenUnits;
          }

          const gainOnSaleLamports = solLamports - realizedCostLamports;
          pos.realizedPnlLamports += gainOnSaleLamports;
          pos.costBasisLamportsPerToken =
            pos.inventoryUnits > 0n
              ? Number(pos.remainingCostBasisLamports) / Number(pos.inventoryUnits)
              : 0;
        }
      } else {
        // Partial: track inventory change cautiously
        pos.inventoryUnits =
          pos.inventoryUnits >= tokenUnits ? pos.inventoryUnits - tokenUnits : 0n;
      }
    }

    // Invariants assertion
    if (pos.inventoryUnits === 0n) {
      pos.remainingCostBasisLamports = 0n;
      pos.costBasisLamportsPerToken = 0;
    }

    pos.realizedTradingCashFlowLamports = pos.solReceivedLamports - pos.solSpentLamports;

    // Executable Mark-to-Market Valuation on remaining inventory
    this.markPositionExecutable(pos, vSol, vTok);
  }

  private markPositionExecutable(
    pos: WalletMintAccounting,
    vSol: bigint,
    vTok: bigint,
  ): void {
    if (vSol <= 0n || vTok <= 0n) {
      pos.dataQuality = "UNRESOLVED";
      pos.classification = "unknown-partial";
      return;
    }

    const marginalPrice = Number(vSol) / Number(vTok);
    pos.marginalPriceSolPerToken = marginalPrice;

    if (pos.inventoryUnits <= 0n) {
      pos.latestExecutableGrossSolLamports = 0n;
      pos.latestExecutableNetSolLamports = 0n;
      pos.unrealizedPnlLamports = 0n;
      pos.totalMarkedPnlLamports = pos.realizedPnlLamports;
      pos.priceImpactPct = 0;

      if (pos.dataQuality === "CLEAN") {
        if (pos.realizedPnlLamports > 0n) {
          pos.classification = "realized-profitable";
        } else if (pos.realizedPnlLamports < 0n) {
          pos.classification = "realized-loss";
        } else {
          pos.classification = "flat";
        }
      } else {
        pos.classification = "unknown-partial";
      }
      return;
    }

    // Executable liquidation quote via quotePumpSell
    let sellQuote: PumpSellQuote | null = null;
    try {
      sellQuote = quotePumpSell(pos.inventoryUnits, vSol, vTok, 100n);
    } catch {
      sellQuote = null;
    }

    if (!sellQuote || sellQuote.grossCurveSolOutLamports <= 0n) {
      // Exceeds curve capacity or curve depleted
      if (pos.dataQuality === "CLEAN") {
        pos.dataQuality = "UNRESOLVED";
        pos.qualityReason = "inventory-exceeds-curve-capacity";
      }
      pos.classification = "unknown-partial";
      return;
    }

    pos.latestExecutableGrossSolLamports = sellQuote.grossCurveSolOutLamports;
    pos.latestExecutableNetSolLamports = sellQuote.netWalletInflowLamports;

    // Price impact relative to marginal price
    const marginalGrossSol = Number(pos.inventoryUnits) * marginalPrice;
    const executableGrossSol = Number(sellQuote.grossCurveSolOutLamports);
    pos.priceImpactPct =
      marginalGrossSol > 0
        ? Math.max(0, ((marginalGrossSol - executableGrossSol) / marginalGrossSol) * 100)
        : 0;

    if (pos.dataQuality === "CLEAN") {
      // Pure integer calculation using exact remainingCostBasisLamports
      const remainingCostLamports = pos.remainingCostBasisLamports;
      pos.unrealizedPnlLamports = sellQuote.netWalletInflowLamports - remainingCostLamports;
      pos.totalMarkedPnlLamports = pos.realizedPnlLamports + pos.unrealizedPnlLamports;

      if (pos.totalMarkedPnlLamports > 0n) {
        pos.classification = "open-profitable";
      } else if (pos.totalMarkedPnlLamports < 0n) {
        pos.classification = "open-underwater";
      } else {
        pos.classification = "flat";
      }
    } else {
      pos.classification = "unknown-partial";
    }
  }

  private updateCreatorTrade(
    c: CreatorTokenAnalytics,
    isBuy: boolean,
    solLamports: bigint,
    tokenUnits: bigint,
    nowMs: number,
  ): void {
    c.lastActivityUnixMs = nowMs;
    if (isBuy) {
      c.tokenBuys += 1;
      c.creatorTokensBought += tokenUnits;
      c.creatorInventoryUnits += tokenUnits;
      c.solSpentLamports += solLamports;
    } else {
      c.tokenSells += 1;
      c.creatorTokensSold += tokenUnits;

      // Creator quality audit: if selling before any observed buy or selling more than bought, mark PARTIAL
      if (c.creatorTokensBought === 0n || tokenUnits > c.creatorInventoryUnits) {
        c.creatorInventoryQuality = "PARTIAL";
        c.dataQuality = "PARTIAL";
      }

      c.creatorInventoryUnits =
        c.creatorInventoryUnits >= tokenUnits ? c.creatorInventoryUnits - tokenUnits : 0n;
      c.solReceivedLamports += solLamports;

      if (!c.firstSellTimestampUnixMs) {
        c.firstSellTimestampUnixMs = nowMs;
        c.firstSellDelaySec = Math.max(0, Math.floor((nowMs - c.launchTimestampUnixMs) / 1000));
      }
    }

    c.observedNetSolExtractionLamports = c.solReceivedLamports - c.solSpentLamports;

    if (c.creatorTokensBought > 0n) {
      const pct = (Number(c.creatorTokensSold) / Number(c.creatorTokensBought)) * 100;
      c.pctObservedInventorySold = Number(Math.min(100, Math.max(0, pct)).toFixed(2));
    }

    // Only mark fully-exited if creator inventory quality is CLEAN
    if (c.creatorInventoryQuality === "CLEAN" && c.creatorTokensSold > 0n && c.creatorInventoryUnits === 0n) {
      c.holdingStatus = "fully-exited";
    } else if (c.creatorTokensSold > 0n) {
      c.holdingStatus = "partially-exited";
    } else {
      c.holdingStatus = "holding";
    }
  }

  public getStats(): MarketParticipantStats {
    // 1. Group wallet-level data qualities and PnL
    const walletPnlSummary = new Map<
      string,
      {
        quality: DataQualityState;
        totalMarkedPnlLamports: bigint;
        totalRealizedPnlLamports: bigint;
        totalUnrealizedPnlLamports: bigint;
        isFullyClosed: boolean;
        allPositionsCount: number;
      }
    >();

    for (const pos of this.positions.values()) {
      let w = walletPnlSummary.get(pos.wallet);
      if (!w) {
        w = {
          quality: pos.dataQuality,
          totalMarkedPnlLamports: 0n,
          totalRealizedPnlLamports: 0n,
          totalUnrealizedPnlLamports: 0n,
          isFullyClosed: true,
          allPositionsCount: 0,
        };
        walletPnlSummary.set(pos.wallet, w);
      }

      // Demote wallet quality if any position is partial or unresolved
      if (pos.dataQuality === "UNRESOLVED") {
        w.quality = "UNRESOLVED";
      } else if (pos.dataQuality === "PARTIAL" && w.quality === "CLEAN") {
        w.quality = "PARTIAL";
      }

      if (pos.inventoryUnits > 0n) {
        w.isFullyClosed = false;
      }

      w.allPositionsCount += 1;
      w.totalMarkedPnlLamports += pos.totalMarkedPnlLamports;
      w.totalRealizedPnlLamports += pos.realizedPnlLamports;
      w.totalUnrealizedPnlLamports += pos.unrealizedPnlLamports;
    }

    let cleanEligibleWallets = 0;
    let partialWallets = 0;
    let unresolvedWallets = 0;

    let cleanClosedWalletCount = 0;
    let cleanClosedWinningWalletCount = 0;

    let cleanMarkedWalletCount = 0;
    let cleanMarkedPositivePnlCount = 0;

    let realizedProfitableCount = 0;
    let realizedLossCount = 0;
    let openProfitableCount = 0;
    let openUnderwaterCount = 0;
    let flatCount = 0;

    let totalCleanRealizedPnlLamports = 0n;
    let totalCleanUnrealizedPnlLamports = 0n;
    let totalCleanMarkedPnlLamports = 0n;

    const cleanWinnersList: Array<{
      wallet: string;
      markedPnlSol: number;
      realizedPnlSol: number;
      tradeCount: number;
      mintsTraded: number;
    }> = [];

    const cleanLosersList: Array<{
      wallet: string;
      markedPnlSol: number;
      realizedPnlSol: number;
      tradeCount: number;
      mintsTraded: number;
    }> = [];

    for (const [wallet, w] of walletPnlSummary.entries()) {
      if (w.quality === "CLEAN") {
        cleanEligibleWallets += 1;
        cleanMarkedWalletCount += 1;

        totalCleanRealizedPnlLamports += w.totalRealizedPnlLamports;
        totalCleanUnrealizedPnlLamports += w.totalUnrealizedPnlLamports;
        totalCleanMarkedPnlLamports += w.totalMarkedPnlLamports;

        if (w.totalMarkedPnlLamports > 0n) {
          cleanMarkedPositivePnlCount += 1;
        }

        if (w.isFullyClosed) {
          cleanClosedWalletCount += 1;
          if (w.totalRealizedPnlLamports > 0n) {
            cleanClosedWinningWalletCount += 1;
            realizedProfitableCount += 1;
          } else if (w.totalRealizedPnlLamports < 0n) {
            realizedLossCount += 1;
          } else {
            flatCount += 1;
          }
        } else {
          if (w.totalMarkedPnlLamports > 0n) {
            openProfitableCount += 1;
          } else if (w.totalMarkedPnlLamports < 0n) {
            openUnderwaterCount += 1;
          } else {
            flatCount += 1;
          }
        }

        const trades = this.walletTotalTrades.get(wallet) || 0;
        const mints = this.walletMints.get(wallet)?.size || 1;
        const markedSol = Number((Number(w.totalMarkedPnlLamports) / 1e9).toFixed(6));
        const realizedSol = Number((Number(w.totalRealizedPnlLamports) / 1e9).toFixed(6));

        if (w.totalMarkedPnlLamports > 0n) {
          cleanWinnersList.push({
            wallet,
            markedPnlSol: markedSol,
            realizedPnlSol: realizedSol,
            tradeCount: trades,
            mintsTraded: mints,
          });
        } else if (w.totalMarkedPnlLamports < 0n) {
          cleanLosersList.push({
            wallet,
            markedPnlSol: markedSol,
            realizedPnlSol: realizedSol,
            tradeCount: trades,
            mintsTraded: mints,
          });
        }
      } else if (w.quality === "PARTIAL") {
        partialWallets += 1;
      } else {
        unresolvedWallets += 1;
      }
    }

    const cleanClosedTraderWinRatePct =
      cleanClosedWalletCount > 0
        ? Number(((cleanClosedWinningWalletCount / cleanClosedWalletCount) * 100).toFixed(2))
        : 0;

    const cleanMarkedPositivePnlRatePct =
      cleanMarkedWalletCount > 0
        ? Number(((cleanMarkedPositivePnlCount / cleanMarkedWalletCount) * 100).toFixed(2))
        : 0;

    // Sort winners and losers
    cleanWinnersList.sort((a, b) => b.markedPnlSol - a.markedPnlSol);
    cleanLosersList.sort((a, b) => a.markedPnlSol - b.markedPnlSol);

    // Whale Volume Concentration
    const buyVolumes = Array.from(this.walletBuyVolumes.values()).sort((a, b) =>
      a < b ? 1 : a > b ? -1 : 0,
    );
    let totalObservedBuyVolumeLamports = 0n;
    for (const v of buyVolumes) {
      totalObservedBuyVolumeLamports += v;
    }

    let top5WalletsBuyVolumeLamports = 0n;
    for (let i = 0; i < Math.min(5, buyVolumes.length); i++) {
      top5WalletsBuyVolumeLamports += buyVolumes[i]!;
    }

    const top1PctCount = Math.max(1, Math.floor(buyVolumes.length * 0.01));
    let top1PctVolumeLamports = 0n;
    for (let i = 0; i < Math.min(top1PctCount, buyVolumes.length); i++) {
      top1PctVolumeLamports += buyVolumes[i]!;
    }

    const top5SharePct =
      totalObservedBuyVolumeLamports > 0n
        ? Number(
            (
              (Number(top5WalletsBuyVolumeLamports) / Number(totalObservedBuyVolumeLamports)) *
              100
            ).toFixed(2),
          )
        : 0;

    const top1PctSharePct =
      totalObservedBuyVolumeLamports > 0n
        ? Number(
            (
              (Number(top1PctVolumeLamports) / Number(totalObservedBuyVolumeLamports)) *
              100
            ).toFixed(2),
          )
        : 0;

    // Creator Extraction Aggregates
    const creatorStats = this.computeCreatorAggregates();

    return {
      disclaimer:
        "Session-scoped estimate. External transaction costs may be incomplete. Mid-session inventory is excluded from clean profitability metrics. Estimated curve trading PnL before Pump protocol fees and unobserved external transaction costs.",
      feeCoverageDisclaimer:
        "Estimated curve trading PnL before Pump protocol fees and unobserved external transaction costs.",

      totalObservedWallets: walletPnlSummary.size,
      cleanEligibleWallets,
      partialWallets,
      unresolvedWallets,

      cleanClosedWalletCount,
      cleanClosedWinningWalletCount,
      cleanClosedTraderWinRatePct,

      cleanMarkedWalletCount,
      cleanMarkedPositivePnlCount,
      cleanMarkedPositivePnlRatePct,

      realizedProfitableCount,
      realizedLossCount,
      openProfitableCount,
      openUnderwaterCount,
      flatCount,

      totalCleanRealizedPnlSol: Number(
        (Number(totalCleanRealizedPnlLamports) / 1e9).toFixed(6),
      ),
      totalCleanUnrealizedPnlSol: Number(
        (Number(totalCleanUnrealizedPnlLamports) / 1e9).toFixed(6),
      ),
      totalCleanMarkedPnlSol: Number(
        (Number(totalCleanMarkedPnlLamports) / 1e9).toFixed(6),
      ),

      top1PctWalletsSolVolumeSharePct: top1PctSharePct,
      top5WalletsBuyVolumeSol: Number(
        (Number(top5WalletsBuyVolumeLamports) / 1e9).toFixed(4),
      ),
      top5WalletsBuyVolumeSharePct: top5SharePct,

      topCleanWinners: cleanWinnersList.slice(0, 5),
      topCleanLosers: cleanLosersList.slice(0, 5),
      creatorAnalytics: creatorStats,
    };
  }

  private computeCreatorAggregates(): CreatorAggregateAnalytics {
    const creators = Array.from(this.creatorPerMint.values());
    const creatorsObserved = creators.length;

    let cleanCreatorsCount = 0;
    let partialCreatorsCount = 0;
    let creatorsSelling = 0;
    let cleanCreatorsFullyExited = 0;
    let totalExtractionLamports = 0n;
    let maxExtractionLamports = 0n;

    const extractionsLamports: bigint[] = [];
    const sellDelaysSec: number[] = [];
    const cleanSellDelaysSec: number[] = [];
    const topExtractions: Array<{
      creatorWallet: string;
      mint: string;
      netExtractionSol: number;
      firstSellDelaySec: number;
      pctSold?: number | undefined;
      inventoryQuality: DataQualityState;
    }> = [];

    for (const c of creators) {
      if (c.creatorInventoryQuality === "CLEAN") {
        cleanCreatorsCount += 1;
      } else {
        partialCreatorsCount += 1;
      }

      const netSol = c.observedNetSolExtractionLamports;
      extractionsLamports.push(netSol);

      if (netSol > 0n) {
        totalExtractionLamports += netSol;
      }
      if (netSol > maxExtractionLamports) {
        maxExtractionLamports = netSol;
      }

      if (c.creatorTokensSold > 0n) {
        creatorsSelling += 1;
        if (c.firstSellDelaySec !== undefined) {
          sellDelaysSec.push(c.firstSellDelaySec);
          if (c.creatorInventoryQuality === "CLEAN") {
            cleanSellDelaysSec.push(c.firstSellDelaySec);
          }
        }
      }
      if (c.creatorInventoryQuality === "CLEAN" && c.holdingStatus === "fully-exited") {
        cleanCreatorsFullyExited += 1;
      }

      if (netSol > 0n) {
        topExtractions.push({
          creatorWallet: c.creatorWallet,
          mint: c.mint,
          netExtractionSol: Number((Number(netSol) / 1e9).toFixed(4)),
          firstSellDelaySec: c.firstSellDelaySec ?? 0,
          pctSold: c.pctObservedInventorySold,
          inventoryQuality: c.creatorInventoryQuality,
        });
      }
    }

    const calcMedian = (arr: number[]): number => {
      if (arr.length === 0) return 0;
      const sorted = [...arr].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      return sorted.length % 2 !== 0
        ? sorted[mid]!
        : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
    };

    const medianFirstSellDelaySec = calcMedian(sellDelaysSec);
    const medianCleanFirstSellDelaySec = calcMedian(cleanSellDelaysSec);

    extractionsLamports.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const count = extractionsLamports.length;

    const getPercentileSol = (pct: number): number => {
      if (count === 0) return 0;
      const idx = Math.min(count - 1, Math.max(0, Math.floor((pct / 100) * count)));
      return Number((Number(extractionsLamports[idx]!) / 1e9).toFixed(4));
    };

    topExtractions.sort((a, b) => b.netExtractionSol - a.netExtractionSol);

    return {
      creatorsObserved,
      cleanCreatorsCount,
      partialCreatorsCount,
      creatorsSelling,
      cleanCreatorsFullyExited,
      creatorsFullyExited: cleanCreatorsFullyExited,
      medianCleanFirstSellDelaySec,
      medianFirstSellDelaySec,
      totalObservedCreatorExtractionSol: Number(
        (Number(totalExtractionLamports) / 1e9).toFixed(4),
      ),
      medianObservedCreatorExtractionSol: getPercentileSol(50),
      largestObservedExtractionSol: Number((Number(maxExtractionLamports) / 1e9).toFixed(4)),
      p50Sol: getPercentileSol(50),
      p75Sol: getPercentileSol(75),
      p90Sol: getPercentileSol(90),
      p95Sol: getPercentileSol(95),
      topCreatorExtractions: topExtractions.slice(0, 10),
    };
  }

  public exportSummary(): MarketParticipantStats {
    return this.getStats();
  }

  public getPosition(wallet: string, mint: string): WalletMintAccounting | undefined {
    return this.positions.get(`${wallet}:${mint}`);
  }

  public getCreatorAnalytics(mint: string): CreatorTokenAnalytics | undefined {
    return this.creatorPerMint.get(mint);
  }
}

