import { useState } from "react";
import type { PortfolioSummary } from "../../../packages/research/src/portfolio-engine.js";

const n = (value: number | null | undefined, digits = 4): string =>
  value == null ? "—" : value.toFixed(digits);

const pnlCls = (v: number | null | undefined) =>
  v == null ? "" : v >= 0 ? "pnl-pos" : "pnl-neg";

const pnlSign = (v: number | null | undefined) =>
  v != null && v > 0 ? "+" : "";

function Badge({ children, color }: { children: React.ReactNode; color?: string }) {
  return (
    <span className="chip" style={color ? { color, borderColor: `${color}44` } : undefined}>
      {children}
    </span>
  );
}

function KpiCard({
  label,
  value,
  sub,
  color,
}: {
  label: string;
  value: React.ReactNode;
  sub?: string;
  color?: string;
}) {
  return (
    <div className="kpi-card">
      <div className="kpi-label">{label}</div>
      <div className="kpi-value" style={color ? { color } : undefined}>
        {value}
      </div>
      {sub && <div className="kpi-sub">{sub}</div>}
    </div>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <tr>
      <td colSpan={20} className="table-empty">
        {text}
      </td>
    </tr>
  );
}

export function Portfolios({ data }: { data: PortfolioSummary | null }) {
  const [bankroll, setBankroll] = useState(5);
  const [risk, setRisk] = useState("balanced");
  const [strategy, setStrategy] = useState("baseline-50sol-v1");

  if (!data) {
    return (
      <section className="section-card">
        <div className="section-header">
          <h2 className="section-title">Portfolio Experiment</h2>
          <Badge color="var(--text-muted)">No Data</Badge>
        </div>
        <p style={{ color: "var(--text-muted)", fontSize: "0.875rem", padding: "1rem 0" }}>
          No portfolio evidence for this session. Portfolio stats are written every heartbeat once
          the collector is running with the portfolio engine enabled.
        </p>
      </section>
    );
  }

  const rows = data.portfolios.filter(
    (p) => p.startingSol === bankroll && p.riskMode === risk
  );
  const selected = rows.find((p) => p.strategyId === strategy);
  const points = selected?.equityCurve ?? [];
  const low = Math.min(...points.map((p) => p.equitySol), bankroll * 0.98);
  const high = Math.max(...points.map((p) => p.equitySol), bankroll * 1.02);
  const start = points[0]?.timeMs ?? 0;
  const end = points.at(-1)?.timeMs ?? start;
  const range = Math.max(1, end - start);
  const yRange = Math.max(0.000001, high - low);
  const svgW = 900;
  const svgH = 200;
  const padL = 80;
  const padR = 20;
  const padT = 20;
  const padB = 28;
  const chartW = svgW - padL - padR;
  const chartH = svgH - padT - padB;

  const toX = (ms: number) => padL + ((ms - start) / range) * chartW;
  const toY = (eq: number) => padT + ((high - eq) / yRange) * chartH;

  const polyline =
    points.length > 1
      ? points.map((p) => `${toX(p.timeMs)},${toY(p.equitySol)}`).join(" ")
      : "";

  const returnColor =
    selected == null
      ? undefined
      : selected.returnPct >= 0
      ? "var(--accent-emerald)"
      : "var(--accent-rose)";

  return (
    <section className="section-card portfolio-experiment">
      {/* Header */}
      <div className="section-header" style={{ marginBottom: "1.25rem" }}>
        <h2 className="section-title">Portfolio Experiment</h2>
        <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", alignItems: "center" }}>
          <Badge color="var(--accent-amber)">Hypothetical paper fills</Badge>
          <Badge color="var(--text-muted)">
            {data.ended ? "Final" : "Live"} · v{data.version}
          </Badge>
          <Badge color="var(--accent-cyan)">{data.eventsProcessed.toLocaleString()} events</Badge>
        </div>
      </div>

      <p className="note-text" style={{ marginBottom: "1.25rem" }}>
        Frozen evaluation: 4 strategies × 3 risk modes × 5 bankrolls. Costs and fills are modelled;
        results do not establish real execution accuracy. Same +30% net TP / −20% net SL / 300s
        timeout for all portfolios.
      </p>

      {/* Controls */}
      <div className="controls-row">
        <label className="control-label">
          Starting capital
          <select
            className="control-select"
            value={bankroll}
            onChange={(e) => setBankroll(Number(e.target.value))}
          >
            {data.bankrolls.map((b) => (
              <option key={b} value={b}>
                {b} SOL
              </option>
            ))}
          </select>
        </label>
        <label className="control-label">
          Risk mode
          <select
            className="control-select"
            value={risk}
            onChange={(e) => setRisk(e.target.value)}
          >
            {data.risks.map((r) => (
              <option key={r.id}>{r.id}</option>
            ))}
          </select>
        </label>
        <label className="control-label">
          Strategy
          <select
            className="control-select"
            value={strategy}
            onChange={(e) => setStrategy(e.target.value)}
          >
            {data.strategies.map((s) => (
              <option key={s.id}>{s.id}</option>
            ))}
          </select>
        </label>
      </div>

      {/* Primary KPI cards */}
      {selected && (
        <section className="kpi-grid" style={{ marginBottom: "1.5rem" }}>
          <KpiCard
            label="Starting Equity"
            value={`${n(selected.startingSol, 2)} SOL`}
          />
          <KpiCard
            label={data.ended ? "Final Equity" : "Current Equity"}
            value={`${n(selected.equitySol)} SOL`}
            sub={`Cash: ${n(selected.cashSol)} SOL`}
          />
          <KpiCard
            label="Net PnL"
            value={`${pnlSign(selected.netPnlSol)}${n(selected.netPnlSol)} SOL`}
            sub={`Realized: ${n(selected.realizedPnlSol)} SOL`}
            color={pnlCls(selected.netPnlSol) === "pnl-pos" ? "var(--accent-emerald)" : "var(--accent-rose)"}
          />
          <KpiCard
            label="Return %"
            value={`${pnlSign(selected.returnPct)}${n(selected.returnPct, 2)}%`}
            color={returnColor}
          />
          <KpiCard
            label="Max Drawdown"
            value={`${n(selected.maxDrawdownPct, 2)}%`}
            color="var(--accent-amber)"
          />
          <KpiCard
            label="Closed Trades"
            value={selected.trades}
            sub={`${selected.wins}W / ${selected.losses}L`}
          />
          <KpiCard
            label="Win Rate"
            value={`${n(selected.winRatePct, 1)}%`}
            color={
              selected.winRatePct >= 50 ? "var(--accent-emerald)" : "var(--accent-rose)"
            }
          />
          <KpiCard
            label="Capital Utilization"
            value={`${n(selected.utilizationPct, 1)}%`}
            sub={`${selected.openPositions} open · ${selected.skippedInsufficientCapital} skipped`}
          />
        </section>
      )}

      {/* Equity curve */}
      {selected && points.length > 1 && (
        <div className="section-card" style={{ marginBottom: "1.25rem", padding: "1rem" }}>
          <h3 className="section-subtitle" style={{ marginBottom: "0.75rem" }}>
            Equity Curve —{" "}
            <span className="field-mono" style={{ fontWeight: 400 }}>
              {strategy} / {risk} / {bankroll} SOL
            </span>
          </h3>
          <svg
            role="img"
            aria-label="Portfolio equity over session time"
            viewBox={`0 0 ${svgW} ${svgH}`}
            style={{ width: "100%", maxHeight: 220, display: "block" }}
          >
            {/* Axes */}
            <line
              x1={padL} y1={padT} x2={padL} y2={padT + chartH}
              stroke="rgba(255,255,255,0.1)" strokeWidth="1"
            />
            <line
              x1={padL} y1={padT + chartH} x2={padL + chartW} y2={padT + chartH}
              stroke="rgba(255,255,255,0.1)" strokeWidth="1"
            />
            {/* Zero line */}
            <line
              x1={padL} y1={toY(bankroll)} x2={padL + chartW} y2={toY(bankroll)}
              stroke="rgba(255,255,255,0.08)" strokeWidth="1" strokeDasharray="4 4"
            />
            {/* Y-axis labels */}
            <text x={padL - 6} y={toY(high) + 4} fill="#6b7280" fontSize="11" textAnchor="end">
              {n(high, 2)}
            </text>
            <text x={padL - 6} y={toY(low) + 4} fill="#6b7280" fontSize="11" textAnchor="end">
              {n(low, 2)}
            </text>
            <text x={padL - 6} y={toY(bankroll) + 4} fill="#6b7280" fontSize="10" textAnchor="end">
              {n(bankroll, 2)}
            </text>
            {/* Curve */}
            <polyline
              fill="none"
              stroke={returnColor ?? "#34d399"}
              strokeWidth="1.5"
              strokeLinejoin="round"
              points={polyline}
            />
            {/* Fill under curve */}
            <polygon
              fill={returnColor ?? "#34d399"}
              fillOpacity="0.07"
              points={`${toX(start)},${toY(bankroll)} ${polyline} ${toX(end)},${toY(bankroll)}`}
            />
          </svg>
          <div className="note-text" style={{ marginTop: "0.5rem" }}>
            {new Date(start).toISOString()} → {new Date(end).toISOString()} · Display sampled;
            drawdown uses every mark. Full curve in GCS summary.
          </div>
        </div>
      )}

      {/* Portfolio overview table */}
      <h3 className="section-subtitle" style={{ marginBottom: "0.5rem" }}>
        Strategy Comparison —{" "}
        <span className="field-mono" style={{ fontWeight: 400 }}>
          {bankroll} SOL · {risk}
        </span>
      </h3>
      <div className="table-container" style={{ marginBottom: "1.5rem" }}>
        <table className="data-table">
          <thead>
            <tr>
              {[
                "Strategy",
                "Equity SOL",
                "Net PnL SOL",
                "Return %",
                "Max DD %",
                "Closed",
                "Win %",
                "EV SOL/trade",
                "Open",
                "Util %",
                "Skips",
              ].map((h) => (
                <th key={h}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <EmptyState text="No portfolio data for selected filters." />
            ) : (
              rows.map((p) => (
                <tr
                  key={p.id}
                  style={
                    p.strategyId === strategy
                      ? { background: "rgba(99,102,241,0.06)" }
                      : undefined
                  }
                >
                  <td>
                    <span className="chip" style={{ color: "var(--accent-indigo)" }}>
                      {p.strategyId}
                    </span>
                  </td>
                  <td className="field-mono">{n(p.equitySol)}</td>
                  <td className={`field-mono ${pnlCls(p.netPnlSol)}`}>
                    {pnlSign(p.netPnlSol)}
                    {n(p.netPnlSol)}
                  </td>
                  <td className={`field-mono ${pnlCls(p.returnPct)}`}>
                    {pnlSign(p.returnPct)}
                    {n(p.returnPct, 2)}%
                  </td>
                  <td className="field-mono">{n(p.maxDrawdownPct, 2)}%</td>
                  <td>{p.trades}</td>
                  <td
                    className="field-mono"
                    style={{ color: p.winRatePct >= 50 ? "var(--accent-emerald)" : "var(--accent-rose)" }}
                  >
                    {n(p.winRatePct, 1)}%
                  </td>
                  <td className="field-mono">{n(p.evSol, 6)}</td>
                  <td>{p.openPositions}</td>
                  <td className="field-mono">{n(p.utilizationPct, 1)}%</td>
                  <td>{p.skippedInsufficientCapital}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Outlier robustness */}
      <h3 className="section-subtitle" style={{ marginBottom: "0.5rem" }}>
        Outlier Robustness — closed trades only
      </h3>
      <div className="table-container" style={{ marginBottom: "1.5rem" }}>
        <table className="data-table">
          <thead>
            <tr>
              {[
                "Strategy",
                "Threshold SOL",
                "Trades",
                "Net SOL",
                "EV/trade",
                "Largest winner",
                "Largest loser",
                "Top-1 %",
                "Top-5 %",
                "Excl. best SOL",
                "Excl. top 5 SOL",
              ].map((h) => (
                <th key={h}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <EmptyState text="No data." />
            ) : (
              rows.map((p) => (
                <tr key={p.id}>
                  <td>
                    <span className="chip" style={{ color: "var(--accent-indigo)" }}>
                      {p.strategyId}
                    </span>
                  </td>
                  {[
                    n(p.thresholdSol, 0),
                    p.trades,
                    n(p.realizedPnlSol),
                    n(p.evSol, 6),
                    n(p.largestWinnerSol),
                    n(p.largestLoserSol),
                    n(p.top1ContributionPct, 1),
                    n(p.top5ContributionPct, 1),
                    n(p.excludingBestSol),
                    n(p.excludingTop5Sol),
                  ].map((v, i) => (
                    <td key={i} className="field-mono">
                      {v}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <p className="note-text" style={{ marginBottom: "1.5rem" }}>
        * Return and drawdown include marked inventory. Contribution = top closed PnL / total closed
        net PnL; undefined at zero net PnL.
      </p>

      {/* Capital comparison */}
      <h3 className="section-subtitle" style={{ marginBottom: "0.5rem" }}>
        Capital Comparison —{" "}
        <span className="field-mono" style={{ fontWeight: 400 }}>
          {risk} risk
        </span>
      </h3>
      <div className="table-container" style={{ marginBottom: "1.5rem" }}>
        <table className="data-table">
          <thead>
            <tr>
              <th>Bankroll</th>
              {data.strategies.map((s) => (
                <th key={s.id}>
                  {s.id}
                  <br />
                  <span style={{ fontWeight: 400, color: "var(--text-muted)", fontSize: "0.75rem" }}>
                    equity / cash / return
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.bankrolls.map((b) => (
              <tr key={b}>
                <td className="field-mono">{b} SOL</td>
                {data.strategies.map((s) => {
                  const p = data.portfolios.find(
                    (pp) => pp.startingSol === b && pp.riskMode === risk && pp.strategyId === s.id
                  );
                  return (
                    <td key={s.id} className="field-mono">
                      {p ? (
                        <>
                          {n(p.equitySol)} /{" "}
                          <span style={{ color: "var(--text-muted)" }}>{n(p.cashSol)}</span> /{" "}
                          <span className={pnlCls(p.returnPct)}>
                            {pnlSign(p.returnPct)}
                            {n(p.returnPct, 2)}%
                          </span>
                        </>
                      ) : (
                        "—"
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Open positions */}
      {selected && (
        <>
          <h3 className="section-subtitle" style={{ marginBottom: "0.5rem" }}>
            Open / Locked Positions —{" "}
            <span className="field-mono" style={{ fontWeight: 400 }}>
              {strategy}
            </span>
          </h3>
          <p className="note-text" style={{ marginBottom: "0.5rem" }}>
            Timeout waits for a fresh token quote. Session-censored inventory remains marked at its
            last quote; unresolved migrations are marked zero and retain locked capital.
          </p>
          <div className="table-container" style={{ marginBottom: "1rem" }}>
            <table className="data-table">
              <thead>
                <tr>
                  {[
                    "Token",
                    "Entry time",
                    "Entry SOL level",
                    "Size SOL",
                    "Marked net SOL",
                    "Net return %",
                    "Last quote",
                    "Exit status",
                  ].map((h) => (
                    <th key={h}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {selected.positions.length === 0 ? (
                  <EmptyState text="No open positions." />
                ) : (
                  selected.positions.map((p) => (
                    <tr key={p.mint}>
                      <td className="field-mono">{p.mint.slice(0, 4)}…{p.mint.slice(-4)}</td>
                      <td>{new Date(p.entryMs).toISOString().slice(11, 19)}</td>
                      <td className="field-mono">{n(p.entryLevel, 2)} SOL</td>
                      <td className="field-mono">{n(p.sizeSol)}</td>
                      <td className={`field-mono ${pnlCls(p.markedPnlSol)}`}>
                        {pnlSign(p.markedPnlSol)}
                        {n(p.markedPnlSol)}
                      </td>
                      <td className={`field-mono ${pnlCls(p.netReturnPct)}`}>
                        {pnlSign(p.netReturnPct)}
                        {n(p.netReturnPct, 2)}%
                      </td>
                      <td>{new Date(p.lastMarkMs).toISOString().slice(11, 19)}</td>
                      <td>
                        <span className="chip" style={{ color: "var(--accent-cyan)", fontSize: "0.7rem" }}>
                          {p.status}
                          {p.timeoutDue ? " · timeout due" : ""}
                        </span>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          {selected.positionsTruncated && (
            <p className="note-text">Showing first 10 positions; full inventory in GCS evidence.</p>
          )}
        </>
      )}

      {/* Footer */}
      <div className="note-text" style={{ marginTop: "1rem", borderTop: "1px solid var(--border-color)", paddingTop: "0.75rem" }}>
        Evidence version: {data.version} · Events processed: {data.eventsProcessed.toLocaleString()} ·
        Audit records: {data.auditCount.toLocaleString()}
      </div>
    </section>
  );
}
