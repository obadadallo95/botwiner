import { useState } from "react";
import type { PortfolioSummary } from "../../../packages/research/src/portfolio-engine.js";
const n = (value: number | null, digits = 4) => value === null ? "—" : value.toFixed(digits);
export function Portfolios({ data }: { data: PortfolioSummary | null }) {
  const [bankroll, setBankroll] = useState(5);
  const [risk, setRisk] = useState("balanced");
  const [strategy, setStrategy] = useState("baseline-50sol-v1");
  if (!data) return <section className="card"><h2>Multi-strategy portfolios</h2><p>No portfolio evidence for this session. Select a new experiment session after deployment.</p></section>;
  const rows = data.portfolios.filter(p => p.startingSol === bankroll && p.riskMode === risk);
  const selected = rows.find(p => p.strategyId === strategy);
  const points = selected?.equityCurve ?? [];
  const low = Math.min(...points.map(p => p.equitySol), bankroll);
  const high = Math.max(...points.map(p => p.equitySol), bankroll);
  const start = points[0]?.timeMs ?? 0;
  const end = points.at(-1)?.timeMs ?? start;
  return <section className="section-card portfolio-experiment">
    <h2>Portfolio experiment — hypothetical paper fills</h2>
    <p>Frozen evaluation: 4 strategies × 3 risk modes × 5 bankrolls. Costs and fills are modeled; results do not establish real execution accuracy. Any winner is a candidate for validation on a new capture.</p>
    <div style={{ display: "flex", gap: 20, flexWrap: "wrap", margin: "20px 0" }}>
      <label>Starting capital <select value={bankroll} onChange={e => setBankroll(Number(e.target.value))}>{data.bankrolls.map(b => <option key={b} value={b}>{b} SOL</option>)}</select></label>
      <label>Portfolio risk mode <select value={risk} onChange={e => setRisk(e.target.value)}>{data.risks.map(r => <option key={r.id}>{r.id}</option>)}</select></label>
      <label>Strategy <select value={strategy} onChange={e => setStrategy(e.target.value)}>{data.strategies.map(s => <option key={s.id}>{s.id}</option>)}</select></label>
    </div>
    <p>{data.ended ? "Final" : "Live"} marked equity includes locked inventory. Final cash is shown separately. Same +30% net TP / −20% net SL / 300s timeout for all portfolios.</p>
    <h3>Portfolio overview — {bankroll} SOL / {risk} risk</h3>
    <div className="table-container"><table className="data-table"><thead><tr>{["Strategy", "Equity SOL", "Net PnL SOL", "Return %", "Max DD %", "Closed trades", "Win %", "EV SOL/trade", "Open / locked", "Utilization %", "Capital skips"].map(h => <th key={h}>{h}</th>)}</tr></thead><tbody>{rows.map(p => <tr key={p.id}><td>{p.strategyId}</td><td>{n(p.equitySol)}</td><td>{n(p.netPnlSol)}</td><td>{n(p.returnPct, 2)}</td><td>{n(p.maxDrawdownPct, 2)}</td><td>{p.trades}</td><td>{n(p.winRatePct, 1)}</td><td>{n(p.evSol, 6)}</td><td>{p.openPositions}</td><td>{n(p.utilizationPct, 1)}</td><td>{p.skippedInsufficientCapital}</td></tr>)}</tbody></table></div>
    <h3>Strategy comparison — closed trades only</h3>
    <div className="table-container"><table className="data-table"><thead><tr>{["Strategy", "Threshold SOL", "Trades", "Wins", "Losses", "Net SOL", "EV/trade", "Return %*", "Max DD %*", "Largest winner", "Largest loser", "Top-1 %", "Top-5 %", "Excl. best SOL", "Excl. top 5 SOL"].map(h => <th key={h}>{h}</th>)}</tr></thead><tbody>{rows.map(p => <tr key={p.id}><td>{p.strategyId}</td>{[p.thresholdSol, p.trades, p.wins, p.losses, p.realizedPnlSol, p.evSol, p.returnPct, p.maxDrawdownPct, p.largestWinnerSol, p.largestLoserSol, p.top1ContributionPct, p.top5ContributionPct, p.excludingBestSol, p.excludingTop5Sol].map((v, i) => <td key={i}>{n(v)}</td>)}</tr>)}</tbody></table></div>
    <p>* Return and drawdown include marked inventory. Contribution = top closed PnL / total closed net PnL; undefined at zero, may exceed 100% or be negative.</p>
    <h3>Capital comparison — {risk} risk mode</h3>
    <div className="table-container"><table className="data-table"><thead><tr><th>Bankroll</th>{data.strategies.map(s => <th key={s.id}>{s.id}<br/>Equity / cash / return</th>)}</tr></thead><tbody>{data.bankrolls.map(b => <tr key={b}><td>{b} SOL</td>{data.strategies.map(s => { const p = data.portfolios.find(p => p.startingSol === b && p.riskMode === risk && p.strategyId === s.id); return <td key={s.id}>{p ? `${n(p.equitySol)} / ${n(p.cashSol)} SOL / ${n(p.returnPct, 2)}%` : "—"}</td>; })}</tr>)}</tbody></table></div>
    {selected && <>
      <h3>Equity curve — {strategy} / {risk} / {bankroll} SOL</h3>
      <svg role="img" aria-label="Marked portfolio equity over session time" viewBox="0 0 900 200" style={{ width: "100%", maxHeight: 260, background: "#111827" }}>
        <text x="10" y="18" fill="#cbd5e1">{n(high)} SOL</text><text x="10" y="190" fill="#cbd5e1">{n(low)} SOL</text>
        <polyline fill="none" stroke="#34d399" strokeWidth="2" points={points.map(p => `${110 + (p.timeMs - start) / Math.max(1, end - start) * 780},${175 - (p.equitySol - low) / Math.max(0.000001, high - low) * 145}`).join(" ")} />
      </svg>
      <p>{new Date(start).toISOString()} → {new Date(end).toISOString()}. Display sampled; drawdown uses every mark. Full curve in GCS summary.</p>
      <p>Available cash: {n(selected.cashSol)} SOL · Deployed: {n(selected.deployedSol)} · Realized net: {n(selected.realizedPnlSol)} · Unrealized net: {n(selected.unrealizedPnlSol)} · Realized gross: {n(selected.grossRealizedPnlSol)} · Paid modeled costs: {n(selected.costsSol, 6)} · Peak equity: {n(selected.peakEquitySol)} · Final cash: {n(selected.finalBalanceSol)}</p>
      <h3>Open / locked positions</h3>
      <p>Timeout waits for a fresh token quote. Session-censored inventory remains marked at its last quote; unresolved migrations are marked zero and retain locked capital.</p>
      <div className="table-container"><table className="data-table"><thead><tr>{["Token", "Entry time", "Entry SOL level", "Size SOL", "Marked net SOL", "Net return %", "Last quote", "Exit status"].map(h => <th key={h}>{h}</th>)}</tr></thead><tbody>{selected.positions.map(p => <tr key={p.mint}><td>{p.mint}</td><td>{new Date(p.entryMs).toISOString()}</td><td>{p.entryLevel}</td><td>{n(p.sizeSol)}</td><td>{n(p.markedPnlSol)}</td><td>{n(p.netReturnPct, 2)}</td><td>{new Date(p.lastMarkMs).toISOString()}</td><td>{p.status}{p.timeoutDue ? " · timeout due" : " · TP +30% / SL −20%"}</td></tr>)}</tbody></table></div>
      {selected.positionsTruncated && <p>Showing the first 10 positions; full inventory is in saved evidence.</p>}
    </>}
    <p>Evidence version: {data.version} · Events: {data.eventsProcessed} · Audit records: {data.auditCount}</p>
  </section>;
}
