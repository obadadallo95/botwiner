import test from "node:test";
import assert from "node:assert/strict";
import { MultiPortfolioEngine, PORTFOLIO_RISKS, portfolioPositionSize, outlierMetrics, type PortfolioAuditRecord } from "../packages/research/src/portfolio-engine.js";
import { PaperTradingEngine } from "../packages/research/src/paper-trading-engine.js";
import { createMockLaunch, createMockTrade } from "./fixtures/portfolio-events.js";
import type { NormalizedMarketEvent } from "@botwiner/market-data";
const SOL = 1_000_000_000n;
function harness() {
  const ledger: PortfolioAuditRecord[] = [];
  const engine = new MultiPortfolioEngine(r => ledger.push(r));
  const events: NormalizedMarketEvent[] = [];
  let sequence = 0;
  const send = (event: NormalizedMarketEvent) => {
    const ordered = { ...event, ordering: { ...event.ordering, collectorSequence: ++sequence } };
    events.push(ordered); engine.onEvent(ordered);
  };
  const launch = (mint: string) => send(createMockLaunch(mint));
  const trade = (mint: string, reserve: number, timeMs = 10000) => send(createMockTrade({ mint, side: "buy", realSolLamports: BigInt(reserve) * SOL, timeMs, slot: 101 }));
  const signal = (mint: string, reserve = 50) => { launch(mint); for (let i = 0; i < 6; i++) trade(mint, 10, 2000 + i * 1000); trade(mint, reserve); };
  const account = (bankroll = 2, risk = "balanced", strategy = "baseline-50sol-v1") => engine.summary().portfolios.find(p => p.startingSol === bankroll && p.riskMode === risk && p.strategyId === strategy)!;
  return { engine, events, ledger, send, launch, trade, signal, account };
}
test("60 independent frozen accounts include 2 and 20 SOL", () => {
  const h = harness(); h.signal("a");
  assert.equal(h.engine.summary().portfolios.length, 60);
  assert.equal(h.account(2).entries, 1); assert.equal(h.account(20).entries, 1);
  assert.equal(h.account(2).cashSol, 1.898945);
  assert.equal(h.account(20).cashSol, 19.898945);
  assert.equal(h.account(2, "balanced", "conservative-60sol-v1").cashSol, 2);
  assert.equal(h.account(2, "aggressive").positions[0]!.sizeSol, 0.2);
  assert.equal(h.account(2, "conservative").positions[0]!.sizeSol, 0.05);
  assert.ok(h.account().equitySol < 2); assert.ok(h.account().costsSol > 0);
});
test("sizing uses current equity with integer floor and hard maximum", () => {
  assert.equal(portfolioPositionSize(SOL, PORTFOLIO_RISKS[1]!), 50_000_000n);
  assert.equal(portfolioPositionSize(2n * SOL, PORTFOLIO_RISKS[1]!), 100_000_000n);
  assert.equal(portfolioPositionSize(20n * SOL, PORTFOLIO_RISKS[1]!), 100_000_000n);
  assert.equal(portfolioPositionSize(-SOL, PORTFOLIO_RISKS[1]!), 0n);
  assert.ok(portfolioPositionSize(900_000_000n, PORTFOLIO_RISKS[1]!) < portfolioPositionSize(SOL, PORTFOLIO_RISKS[1]!));
});
test("profits and losses change subsequent usable equity and size", () => {
  const loss = harness(); loss.signal("a"); loss.trade("a", 25, 11000);
  const equityAfterLoss = loss.account().equitySol;
  assert.ok(equityAfterLoss < 2); assert.equal(loss.account().losses, 1);
  loss.signal("b"); const smaller = loss.account().positions[0]!.sizeSol;
  assert.ok(smaller < 0.1);
  loss.trade("b", 80, 12000); assert.ok(loss.account().equitySol > equityAfterLoss);
  loss.signal("c"); assert.ok(loss.account().positions[0]!.sizeSol > smaller);
  const gain = harness(); gain.signal("a"); gain.trade("a", 80, 11000);
  assert.ok(gain.account().cashSol > 2); assert.equal(gain.account().wins, 1);
});
test("concurrent entries enforce reserve and exposure; consumed skips do not re-enter", () => {
  const h = harness(); for (let i = 0; i < 35; i++) h.signal(`mint${i}`);
  const p = h.account(); assert.ok(p.openPositions > 1); assert.ok(p.openPositions < 35);
  assert.ok(p.skippedInsufficientCapital > 0); assert.ok(p.cashSol >= p.equitySol * 0.6);
  // Entry fees are included in capital deployed; no negative wallet balances.
  assert.ok(p.deployedSol <= 2 * 0.4);
  assert.ok(h.account(20).entries > p.entries);
  assert.ok(h.engine.summary().portfolios.every(p => p.cashSol >= 0));
  const skipped = h.ledger.find(r => r.accountId === p.id && r.action === "INSUFFICIENT_CAPITAL")!;
  assert.ok(skipped); h.trade(skipped.mint!, 10, 11000); h.trade(skipped.mint!, 50, 12000);
  assert.equal(h.account().entries, p.entries);
});
test("fees reconcile gross, net, cash and drawdown", () => {
  const h = harness(); h.signal("a"); h.trade("a", 80, 11000);
  const p = h.account(); assert.equal(p.openPositions, 0);
  assert.ok(Math.abs(p.grossRealizedPnlSol - p.costsSol - p.realizedPnlSol) < 1e-12);
  assert.equal(BigInt(p.balancesLamports.cash), 2n * SOL + BigInt(p.balancesLamports.realized));
  assert.ok(p.maxDrawdownPct > 0); assert.ok(p.peakEquitySol > 2);
  h.signal("b"); h.trade("b", 20, 12000);
  const end = h.account(); const expected = (end.peakEquitySol - end.equitySol) / end.peakEquitySol * 100;
  assert.ok(Math.abs(end.maxDrawdownPct - expected) < 1e-10);
});
test("collector order drives same-time signals; reconnect duplicates are ignored and reversed novel evidence fails", () => {
  const h = harness(); h.signal("a"); h.signal("b");
  const entries = h.ledger.filter(r => r.accountId === h.account().id && r.action === "ENTRY");
  assert.deepEqual(entries.map(r => r.mint), ["a", "b"]);
  assert.throws(() => h.engine.onEvent({ ...h.events[0]!, eventId: "novel-out-of-order" }), /collector order/);
  const e = new MultiPortfolioEngine(); e.onEvent(h.events[0]!);
  e.onEvent(h.events[0]!); assert.equal(e.summary().eventsProcessed, 1);
});
test("saved JSON evidence recreates every audit record, balance and final summary exactly", () => {
  const h = harness(); for (let i = 0; i < 20; i++) h.signal(`a${i}`);
  h.trade("a0", 80, 12000); h.trade("a1", 20, 13000); h.engine.onSessionEnd();
  const audit: PortfolioAuditRecord[] = []; const replay = new MultiPortfolioEngine(r => audit.push(r));
  for (const event of JSON.parse(JSON.stringify(h.events)) as NormalizedMarketEvent[]) replay.onEvent(event);
  replay.onSessionEnd(); assert.deepEqual(replay.summary(), h.engine.summary()); assert.deepEqual(audit, h.ledger);
  assert.ok(h.account().positions.every(p => p.status === "session-censored"));
  assert.equal(h.account().finalBalanceSol, h.account().cashSol);
  assert.throws(() => replay.onEvent(h.events.at(-1)!), /already ended/);
});
test("first crossing eligibility and baseline entries agree with unchanged engine", () => {
  const h = harness(); h.signal("a");
  const baseline = new PaperTradingEngine(); for (const e of h.events) { if (e.eventType === "launch") baseline.onLaunch(e); else if (e.eventType === "trade") baseline.onTrade(e); }
  assert.equal(h.account().entries, baseline.getStats().entriesTriggered);
  assert.equal(h.account().positions[0]!.sizeSol, Number(baseline.getOpenPositions()[0]!.curveSolInputLamports) / 1e9);
  h.launch("early"); h.trade("early", 60, 2000); h.trade("early", 10, 9000); h.trade("early", 60, 12000);
  assert.equal(h.account().entries, 1);
});
test("outlier removal handles winners, losses, zero and fewer than five trades", () => {
  const m = outlierMetrics([10n * SOL, 2n * SOL, -SOL, -SOL, -SOL, -SOL]);
  assert.equal(m.excludingBestSol, -2); assert.equal(m.excludingTop5Sol, -1);
  assert.equal(m.top1ContributionPct, 125); assert.equal(m.largestLoserSol, -1);
  assert.equal(outlierMetrics([]).top1ContributionPct, null);
  assert.equal(outlierMetrics([SOL, -SOL]).excludingTop5Sol, 0);
});
test("timeout uses fresh quotes; invalid migration cannot mint cash", () => {
  const h = harness(); h.signal("a"); h.trade("a", 50, 310000);
  assert.equal(h.account().trades, 1); assert.ok(h.ledger.some(r => r.action === "timeout"));
  h.signal("b"); const cash = h.account().cashSol;
  h.send(createMockTrade({ mint: "b", side: "sell", realSolLamports: 85n * SOL, virtualSolLamports: 0n, virtualTokenBaseUnits: 0n, timeMs: 320000 }));
  assert.equal(h.account().cashSol, cash); assert.equal(h.account().positions[0]!.status, "migration-exit-unresolved");
});
