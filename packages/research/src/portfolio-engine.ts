import { createHash } from "node:crypto";
import { bigintSafeJsonStringify, type NormalizedMarketEvent, type TradeMarketEvent } from "@botwiner/market-data";
import { PAPER_CONFIG } from "./paper-trading-engine.js";
import { quotePumpBuy, quotePumpSell } from "./rebound-research.js";

export const PORTFOLIO_VERSION = "multi-portfolio-v1";
export const PORTFOLIO_STRATEGIES = Object.freeze([
  Object.freeze({ id: "aggressive-30sol-v1", thresholdSol: 30, ageMs: 3000, trades: 3 }),
  Object.freeze({ id: "balanced-40sol-v1", thresholdSol: 40, ageMs: 4000, trades: 4 }),
  Object.freeze({ id: "baseline-50sol-v1", thresholdSol: 50, ageMs: 5000, trades: 5 }),
  Object.freeze({ id: "conservative-60sol-v1", thresholdSol: 60, ageMs: 7000, trades: 7 }),
]);
export const PORTFOLIO_RISKS = Object.freeze([
  Object.freeze({ id: "aggressive", positionBps: 1000, maxLamports: 200_000_000n, exposureBps: 6000 }),
  Object.freeze({ id: "balanced", positionBps: 500, maxLamports: 100_000_000n, exposureBps: 4000 }),
  Object.freeze({ id: "conservative", positionBps: 250, maxLamports: 50_000_000n, exposureBps: 2500 }),
]);
export const PORTFOLIO_BANKROLLS = Object.freeze([2, 5, 10, 15, 20]);
type Strategy = (typeof PORTFOLIO_STRATEGIES)[number];
type Risk = (typeof PORTFOLIO_RISKS)[number];
const SOL = 1_000_000_000n;
const TX = PAPER_CONFIG.baseFeeLamportsPerTx + PAPER_CONFIG.priorityFeeLamportsPerTx + PAPER_CONFIG.jitoTipLamportsPerTx;
const sol = (value: bigint): number => Number(value) / 1e9;
const min = (a: bigint, b: bigint): bigint => a < b ? a : b;
const max = (a: bigint, b: bigint): bigint => a > b ? a : b;
export function portfolioPositionSize(equity: bigint, risk: Risk): bigint {
  return max(0n, min(equity * BigInt(risk.positionBps) / 10000n, risk.maxLamports));
}
export function outlierMetrics(pnls: readonly bigint[]) {
  const sorted = [...pnls].sort((a, b) => a > b ? -1 : a < b ? 1 : 0);
  const total = pnls.reduce((a, b) => a + b, 0n);
  // Remove best trades even if all trades lost; contribution is undefined at zero net PnL.
  const top1 = sorted[0] ?? 0n;
  const top5 = sorted.slice(0, 5).reduce((a, b) => a + b, 0n);
  return { excludingBestSol: sol(total - top1), excludingTop5Sol: sol(total - top5),
    top1ContributionPct: total === 0n ? null : Number(top1) / Number(total) * 100,
    top5ContributionPct: total === 0n ? null : Number(top5) / Number(total) * 100,
    largestWinnerSol: sol(max(0n, top1)), largestLoserSol: sol(min(0n, sorted.at(-1) ?? 0n)) };
}
interface Token {
  launchMs: number | null; firstSlot: number | undefined; trades: number; real: bigint;
  crossed: Set<string>;
}
interface Position {
  mint: string; entryMs: number; input: bigint; outflow: bigint; quantity: bigint;
  mark: bigint; grossMark: bigint; exitFee: bigint; entryLevel: number;
  lastMarkMs: number; status: "open" | "session-censored" | "migration-exit-unresolved";
}
interface Account {
  id: string; strategy: Strategy; risk: Risk; starting: bigint; cash: bigint;
  positions: Map<string, Position>; realized: bigint; gross: bigint; costs: bigint;
  peak: bigint; drawdownPct: number; closed: bigint[]; signals: number; skips: number;
  invalidQuotes: number; curve: Array<{ timeMs: number; equitySol: number }>;
}
export interface PortfolioAuditRecord {
  sequence: number; eventOrdinal: number; timeMs: number; accountId: string;
  action: string; mint: string | null; cashLamports: string; equityLamports: string;
  detail: Record<string, string | number>;
}

export interface SerializedPosition {
  mint: string;
  entryMs: number;
  inputLamports: string;
  outflowLamports: string;
  quantityUnits: string;
  markLamports: string;
  grossMarkLamports: string;
  exitFeeLamports: string;
  entryLevel: number;
  lastMarkMs: number;
  status: "open" | "session-censored" | "migration-exit-unresolved";
}

export interface SerializedAccount {
  id: string;
  strategyId: string;
  riskId: string;
  bankroll: number;
  startingLamports: string;
  cashLamports: string;
  realizedLamports: string;
  grossLamports: string;
  costsLamports: string;
  peakLamports: string;
  drawdownPct: number;
  closedLamports: string[];
  signals: number;
  skips: number;
  invalidQuotes: number;
  curve: Array<{ timeMs: number; equitySol: number }>;
  positions: SerializedPosition[];
}

export interface SerializedTokenState {
  mint: string;
  launchMs: number | null;
  firstSlot?: number | undefined;
  trades: number;
  realSolLamports: string;
  crossed: string[];
}

export interface SerializedPortfolioEngineState {
  ended: boolean;
  eventCount: number;
  lastOrder: [number, number] | null;
  timeMs: number;
  auditCount: number;
  auditSha256: string;
  tokens: SerializedTokenState[];
  accounts: SerializedAccount[];
}

export class MultiPortfolioEngine {
  private readonly eventIds = new Set<string>();
  private readonly tokens = new Map<string, Token>();
  private readonly accounts: Account[] = [];
  private audit = createHash("sha256");
  private auditCount = 0;
  private eventCount = 0;
  private lastOrder: [number, number] | null = null;
  private timeMs = 0;
  private ended = false;
  public constructor(private readonly onAudit?: (record: PortfolioAuditRecord) => void) {
    for (const strategy of PORTFOLIO_STRATEGIES) for (const risk of PORTFOLIO_RISKS) for (const bankroll of PORTFOLIO_BANKROLLS) {
      const starting = BigInt(bankroll) * SOL;
      this.accounts.push({ id: `${strategy.id}/${risk.id}/${bankroll}`, strategy, risk, starting, cash: starting,
        positions: new Map(), realized: 0n, gross: 0n, costs: 0n, peak: starting, drawdownPct: 0,
        closed: [], signals: 0, skips: 0, invalidQuotes: 0, curve: [] });
    }
  }
  private equity(a: Account): bigint {
    return a.cash + [...a.positions.values()].reduce((sum, p) => sum + p.mark, 0n);
  }
  private deployed(a: Account): bigint {
    return [...a.positions.values()].reduce((sum, p) => sum + p.outflow, 0n);
  }
  private record(a: Account, action: string, mint: string | null, detail: Record<string, string | number> = {}): void {
    const record = { sequence: ++this.auditCount, eventOrdinal: this.eventCount, timeMs: this.timeMs,
      accountId: a.id, action, mint, cashLamports: a.cash.toString(), equityLamports: this.equity(a).toString(), detail };
    this.audit.update(bigintSafeJsonStringify(record) + "\n");
    this.onAudit?.(record);
  }
  private updatePeakAndDrawdown(a: Account): void {
    const eq = this.equity(a);
    a.peak = max(a.peak, eq);
    a.drawdownPct = Math.max(a.drawdownPct, a.peak > 0n ? Number(a.peak - eq) / Number(a.peak) * 100 : 0);
  }
  private recordEquityPoint(a: Account): void {
    this.updatePeakAndDrawdown(a);
    const eq = this.equity(a);
    const eqSol = sol(eq);
    const last = a.curve.at(-1);
    if (last && Math.abs(last.equitySol - eqSol) < 1e-9) return;
    a.curve.push({ timeMs: this.timeMs, equitySol: eqSol });
  }
  public onEvent(event: NormalizedMarketEvent): void {
    if (this.ended) throw new Error("Portfolio experiment already ended");
    if (this.eventIds.has(event.eventId)) return; // Same deduplication as the evidence sink.
    const order: [number, number] = [event.ordering.collectorSequence, event.ordering.transactionLogIndex];
    if (this.lastOrder && (order[0] < this.lastOrder[0] || (order[0] === this.lastOrder[0] && order[1] <= this.lastOrder[1]))) {
      throw new Error("Non-causal or duplicate collector order");
    }
    this.eventIds.add(event.eventId);
    this.lastOrder = order;
    this.eventCount++;
    this.timeMs = Math.max(this.timeMs, event.timestamps.collectorReceivedAtUnixMs);
    for (const a of this.accounts) if (!a.curve.length) a.curve.push({ timeMs: this.timeMs, equitySol: sol(a.starting) });
    if (event.eventType === "launch") {
      if (!this.tokens.has(event.tokenMint)) this.tokens.set(event.tokenMint, {
        launchMs: event.timestamps.collectorReceivedAtUnixMs, firstSlot: event.ordering.slot,
        trades: 0, real: 0n, crossed: new Set(),
      });
    } else if (event.eventType === "trade") this.trade(event);
  }
  private quote(p: Position, event: TradeMarketEvent): boolean {
    const vSol = BigInt(event.reserves.virtualSolLamports ?? "0");
    const vTok = BigInt(event.reserves.virtualTokenBaseUnits ?? "0");
    if (vSol <= 0n || vTok <= 0n) return false;
    const q = quotePumpSell(p.quantity, vSol, vTok, PAPER_CONFIG.pumpFeeBps);
    if (q.grossCurveSolOutLamports <= 0n) return false;
    p.grossMark = q.grossCurveSolOutLamports;
    p.mark = max(0n, q.netWalletInflowLamports - TX);
    p.exitFee = q.feeLamports;
    p.lastMarkMs = this.timeMs;
    return true;
  }
  private trade(event: TradeMarketEvent): void {
    const mint = event.tokenMint;
    const real = BigInt(event.reserves.realSolLamports ?? "0");
    let token = this.tokens.get(mint);
    if (!token) {
      token = { launchMs: null, firstSlot: event.ordering.slot, trades: 0, real, crossed: new Set() };
      this.tokens.set(mint, token);
    }
    const previous = token.real;
    token.real = real;
    token.trades++;
    for (const a of this.accounts) {
      const p = a.positions.get(mint);
      if (!p || p.status !== "open") continue;
      if (!this.quote(p, event)) {
        if (real >= PAPER_CONFIG.graduationSolThresholdLamports || this.timeMs - p.entryMs >= PAPER_CONFIG.timeoutDurationMs) {
          p.status = "migration-exit-unresolved";
          p.mark = 0n;
          this.record(a, p.status, mint);
          this.recordEquityPoint(a);
        }
        continue;
      }
      this.updatePeakAndDrawdown(a);
      const ret = Number(p.mark - p.outflow) / Number(p.outflow) * 100;
      const reason = ret >= PAPER_CONFIG.tpNetReturnPct ? "take-profit" : ret <= PAPER_CONFIG.slNetReturnPct ? "stop-loss" :
        this.timeMs - p.entryMs >= PAPER_CONFIG.timeoutDurationMs ? "timeout" : null;
      if (reason) {
        a.cash += p.mark;
        const pnl = p.mark - p.outflow;
        a.realized += pnl;
        a.gross += p.grossMark - p.input;
        // Clamped exit costs match the baseline's zero-floor net liquidation semantics.
        a.costs += p.grossMark - p.mark;
        a.closed.push(pnl);
        a.positions.delete(mint);
        this.record(a, reason, mint, { netPnlLamports: pnl.toString(), grossPnlLamports: (p.grossMark - p.input).toString(),
          exitCostsLamports: (p.grossMark - p.mark).toString() });
        this.recordEquityPoint(a);
      }
    }
    for (const strategy of PORTFOLIO_STRATEGIES) {
      const threshold = BigInt(strategy.thresholdSol) * SOL;
      if (token.launchMs === null || token.crossed.has(strategy.id) || previous >= threshold || real < threshold) continue;
      token.crossed.add(strategy.id); // consume first crossing even when ineligible or cash-constrained
      const age = event.timestamps.collectorReceivedAtUnixMs - token.launchMs;
      const eligible = age >= strategy.ageMs && token.trades >= strategy.trades && age >= 1500 &&
        !(token.firstSlot !== undefined && token.firstSlot === event.ordering.slot);
      if (eligible) {
        for (const a of this.accounts.filter(a => a.strategy.id === strategy.id)) {
          this.enter(a, event);
        }
      }
    }
  }
  private enter(a: Account, event: TradeMarketEvent): void {
    a.signals++;
    const equity = this.equity(a);
    const input = portfolioPositionSize(equity, a.risk);
    const vSol = BigInt(event.reserves.virtualSolLamports ?? "0");
    const vTok = BigInt(event.reserves.virtualTokenBaseUnits ?? "0");
    if (vSol <= 0n || vTok <= 0n) { a.invalidQuotes++; this.record(a, "INVALID_QUOTE", event.tokenMint); return; }
    const buy = quotePumpBuy(input, vSol, vTok, PAPER_CONFIG.pumpFeeBps);
    const outflow = buy.totalWalletOutflowLamports + TX;
    const exposureCap = equity * BigInt(a.risk.exposureBps) / 10000n;
    const reserve = equity - exposureCap;
    if (input <= 0n || a.cash < outflow || a.cash - outflow < reserve || this.deployed(a) + outflow > exposureCap) {
      a.skips++;
      this.record(a, "INSUFFICIENT_CAPITAL", event.tokenMint, { requestedLamports: outflow.toString(),
        constraint: a.cash < outflow ? "cash" : "exposure-or-reserve" });
      return;
    }
    if (buy.tokensReceived <= 0n) { a.invalidQuotes++; this.record(a, "INVALID_QUOTE", event.tokenMint); return; }
    const p: Position = { mint: event.tokenMint, entryMs: this.timeMs, input, outflow, quantity: buy.tokensReceived,
      mark: 0n, grossMark: 0n, exitFee: 0n, entryLevel: a.strategy.thresholdSol, lastMarkMs: this.timeMs, status: "open" };
    this.quote(p, event); // Immediate executable mark includes both sides' costs and price impact.
    a.cash -= outflow;
    a.costs += outflow - input;
    a.positions.set(event.tokenMint, p);
    this.record(a, "ENTRY", event.tokenMint, { inputLamports: input.toString(), outflowLamports: outflow.toString(),
      tokenQuantity: p.quantity.toString(), entryCostsLamports: (outflow - input).toString() });
    this.recordEquityPoint(a);
  }
  public onSessionEnd(): void {
    if (this.ended) return;
    this.ended = true;
    for (const a of this.accounts) {
      for (const p of a.positions.values()) if (p.status === "open") {
        p.status = "session-censored";
        this.record(a, "session-censored", p.mint);
      }
      this.recordEquityPoint(a);
      this.record(a, "SESSION_END", null);
    }
  }

  public exportState(): SerializedPortfolioEngineState {
    const serializedTokens: SerializedTokenState[] = [];
    for (const [mint, t] of this.tokens.entries()) {
      if (t.trades > 0 || t.launchMs !== null || t.crossed.size > 0) {
        serializedTokens.push({
          mint,
          launchMs: t.launchMs,
          firstSlot: t.firstSlot,
          trades: t.trades,
          realSolLamports: t.real.toString(),
          crossed: Array.from(t.crossed),
        });
      }
    }

    const serializedAccounts: SerializedAccount[] = this.accounts.map((a) => {
      const positions: SerializedPosition[] = [];
      for (const p of a.positions.values()) {
        positions.push({
          mint: p.mint,
          entryMs: p.entryMs,
          inputLamports: p.input.toString(),
          outflowLamports: p.outflow.toString(),
          quantityUnits: p.quantity.toString(),
          markLamports: p.mark.toString(),
          grossMarkLamports: p.grossMark.toString(),
          exitFeeLamports: p.exitFee.toString(),
          entryLevel: p.entryLevel,
          lastMarkMs: p.lastMarkMs,
          status: p.status,
        });
      }
      return {
        id: a.id,
        strategyId: a.strategy.id,
        riskId: a.risk.id,
        bankroll: Number(a.starting / SOL),
        startingLamports: a.starting.toString(),
        cashLamports: a.cash.toString(),
        realizedLamports: a.realized.toString(),
        grossLamports: a.gross.toString(),
        costsLamports: a.costs.toString(),
        peakLamports: a.peak.toString(),
        drawdownPct: a.drawdownPct,
        closedLamports: a.closed.map((c) => c.toString()),
        signals: a.signals,
        skips: a.skips,
        invalidQuotes: a.invalidQuotes,
        curve: [...a.curve],
        positions,
      };
    });

    return {
      ended: this.ended,
      eventCount: this.eventCount,
      lastOrder: this.lastOrder,
      timeMs: this.timeMs,
      auditCount: this.auditCount,
      auditSha256: this.audit.copy().digest("hex"),
      tokens: serializedTokens,
      accounts: serializedAccounts,
    };
  }

  public importState(state: SerializedPortfolioEngineState, recentEventIds?: readonly string[]): void {
    this.ended = state.ended;
    this.eventCount = state.eventCount;
    this.lastOrder = state.lastOrder;
    this.timeMs = state.timeMs;
    this.auditCount = state.auditCount;

    if (recentEventIds) {
      for (const id of recentEventIds) {
        this.eventIds.add(id);
      }
    }

    this.tokens.clear();
    for (const t of state.tokens) {
      this.tokens.set(t.mint, {
        launchMs: t.launchMs,
        firstSlot: t.firstSlot,
        trades: t.trades,
        real: BigInt(t.realSolLamports),
        crossed: new Set(t.crossed),
      });
    }

    const stateAccountMap = new Map(state.accounts.map((a) => [a.id, a]));
    for (const a of this.accounts) {
      const saved = stateAccountMap.get(a.id);
      if (!saved) continue;
      a.starting = BigInt(saved.startingLamports);
      a.cash = BigInt(saved.cashLamports);
      a.realized = BigInt(saved.realizedLamports);
      a.gross = BigInt(saved.grossLamports);
      a.costs = BigInt(saved.costsLamports);
      a.peak = BigInt(saved.peakLamports);
      a.drawdownPct = saved.drawdownPct;
      a.closed = saved.closedLamports.map((c) => BigInt(c));
      a.signals = saved.signals;
      a.skips = saved.skips;
      a.invalidQuotes = saved.invalidQuotes;
      a.curve = [...saved.curve];

      a.positions.clear();
      for (const p of saved.positions) {
        a.positions.set(p.mint, {
          mint: p.mint,
          entryMs: p.entryMs,
          input: BigInt(p.inputLamports),
          outflow: BigInt(p.outflowLamports),
          quantity: BigInt(p.quantityUnits),
          mark: BigInt(p.markLamports),
          grossMark: BigInt(p.grossMarkLamports),
          exitFee: BigInt(p.exitFeeLamports),
          entryLevel: p.entryLevel,
          lastMarkMs: p.lastMarkMs,
          status: p.status,
        });
      }
    }
  }

  public summary(compact = false) {
    return { version: PORTFOLIO_VERSION, hypothetical: true, ended: this.ended, eventsProcessed: this.eventCount,
      lastEventTimeMs: this.timeMs, auditCount: this.auditCount, auditSha256: this.audit.copy().digest("hex"),
      costModel: { id: PAPER_CONFIG.costScenarioId, pumpFeeBps: Number(PAPER_CONFIG.pumpFeeBps),
        baseFeeLamports: PAPER_CONFIG.baseFeeLamportsPerTx.toString(), priorityFeeLamports: PAPER_CONFIG.priorityFeeLamportsPerTx.toString(),
        jitoTipLamports: PAPER_CONFIG.jitoTipLamportsPerTx.toString(), exitNetFloorLamports: "0" },
      exits: { tpNetPct: 30, slNetPct: -20, timeoutMs: 300000, timeoutSemantics: "first fresh token quote at or after deadline" },
      baselineReference: "organic-50sol-continuation-v1 remains fixed at 0.10 SOL outside the capital matrix",
      strategies: PORTFOLIO_STRATEGIES, risks: PORTFOLIO_RISKS.map(r => ({ ...r, maxLamports: r.maxLamports.toString() })),
      bankrolls: PORTFOLIO_BANKROLLS, portfolios: this.accounts.map(a => {
        const equity = this.equity(a);
        const positions = [...a.positions.values()];
        const unrealized = positions.reduce((sum, p) => sum + p.mark - p.outflow, 0n);
        const wins = a.closed.filter(p => p > 0n).length;
        const curve = compact ? a.curve.filter((_, i) => i % Math.max(1, Math.ceil(a.curve.length / 48)) === 0 || i === a.curve.length - 1) : a.curve;
        return { id: a.id, strategyId: a.strategy.id, riskMode: a.risk.id, thresholdSol: a.strategy.thresholdSol,
          startingSol: sol(a.starting), cashSol: sol(a.cash), deployedSol: sol(this.deployed(a)), equitySol: sol(equity),
          finalBalanceSol: this.ended ? sol(a.cash) : null, realizedPnlSol: sol(a.realized), unrealizedPnlSol: sol(unrealized),
          netPnlSol: sol(equity - a.starting), grossRealizedPnlSol: sol(a.gross), costsSol: sol(a.costs),
          peakEquitySol: sol(a.peak), returnPct: Number(equity - a.starting) / Number(a.starting) * 100,
          maxDrawdownPct: a.drawdownPct, trades: a.closed.length, entries: a.signals - a.skips - a.invalidQuotes,
          wins, losses: a.closed.filter(p => p < 0n).length, winRatePct: a.closed.length ? wins / a.closed.length * 100 : 0,
          evSol: a.closed.length ? sol(a.realized) / a.closed.length : 0, openPositions: positions.length,
          utilizationPct: equity > 0n ? Number(this.deployed(a)) / Number(equity) * 100 : 0,
          skippedInsufficientCapital: a.skips, invalidQuotes: a.invalidQuotes, ...outlierMetrics(a.closed),
          equityCurve: curve, positionsTruncated: compact && positions.length > 10,
          positions: (compact ? positions.slice(0, 10) : positions).map(p => ({
            mint: p.mint, status: p.status, entryMs: p.entryMs, entryLevel: p.entryLevel, entryLevelSol: p.entryLevel,
            sizeSol: sol(p.input), inputSol: sol(p.input), outflowSol: sol(p.outflow), markSol: sol(p.mark),
            markedPnlSol: sol(p.mark - p.outflow), unrealizedPnlSol: sol(p.mark - p.outflow),
            returnPct: Number(p.mark - p.outflow) / Number(p.outflow) * 100,
            netReturnPct: Number(p.mark - p.outflow) / Number(p.outflow) * 100,
            lastMarkMs: p.lastMarkMs ?? p.entryMs,
            timeoutDue: p.lastMarkMs >= p.entryMs + PAPER_CONFIG.timeoutDurationMs,
            tokenQuantity: p.quantity.toString(),
          })),
          balancesLamports: { cash: a.cash.toString(), equity: equity.toString(), realized: a.realized.toString(),
            deployed: this.deployed(a).toString(), costs: a.costs.toString(), peak: a.peak.toString() },
        };
      }) };
  }
}
export type PortfolioSummary = ReturnType<MultiPortfolioEngine["summary"]>;
