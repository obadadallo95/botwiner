#!/usr/bin/env python3
"""Generate the small, source-controlled figures used by the research README.

The only numeric inputs are read from the published scenario sweep. The
pipeline diagram is structural and contains no experimental measurements.
"""

from __future__ import annotations

import html
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DATA_PATH = ROOT / "docs" / "research" / "SCENARIO-SWEEP-2026-09-17.json"
OUTPUT_DIR = ROOT / "docs" / "assets"

NAVY = "#102a43"
INK = "#243b53"
MUTED = "#627d98"
GRID = "#d9e2ec"
TEAL = "#0f766e"
BLUE = "#2563eb"
RED = "#c2413b"
PALE = "#f7fafc"


def esc(value: object) -> str:
    return html.escape(str(value), quote=True)


def svg_document(title: str, description: str, body: str, width: int = 960, height: int = 540) -> str:
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} {height}" role="img" aria-labelledby="title desc">
  <title id="title">{esc(title)}</title>
  <desc id="desc">{esc(description)}</desc>
  <rect width="{width}" height="{height}" fill="white"/>
  <style>
    text {{ font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; fill: {INK}; }}
    .title {{ font-size: 24px; font-weight: 700; fill: {NAVY}; }}
    .subtitle {{ font-size: 13px; fill: {MUTED}; }}
    .axis {{ font-size: 12px; fill: {MUTED}; }}
    .label {{ font-size: 13px; font-weight: 600; }}
    .value {{ font-size: 14px; font-weight: 700; }}
    .small {{ font-size: 11px; fill: {MUTED}; }}
  </style>
  {body}
</svg>
'''


def chart_header(title: str, subtitle: str) -> str:
    return f'<text x="48" y="48" class="title">{esc(title)}</text><text x="48" y="72" class="subtitle">{esc(subtitle)}</text>'


def latency_figure(data: dict) -> str:
    rows = data["latencySensitivity"]
    x0, y0, width, height = 110, 125, 760, 300
    values = [float(row["markEvPerAttemptSol"]) for row in rows] + [float(row["conservativeEvPerAttemptSol"]) for row in rows]
    lo = min(values + [0.0])
    hi = max(values + [0.0])
    pad = max((hi - lo) * 0.15, 0.003)
    lo -= pad
    hi += pad

    def x(index: int) -> float:
        return x0 + index * width / max(1, len(rows) - 1)

    def y(value: float) -> float:
        return y0 + (hi - value) * height / (hi - lo)

    parts = [chart_header("Latency sensitivity", "5 SOL threshold · 0.1 SOL position · 15-second hold · SOL per attempt")]
    for tick in range(5):
        value = lo + (hi - lo) * tick / 4
        yy = y(value)
        parts.append(f'<line x1="{x0}" y1="{yy:.1f}" x2="{x0 + width}" y2="{yy:.1f}" stroke="{GRID}"/>')
        parts.append(f'<text x="{x0 - 12}" y="{yy + 4:.1f}" text-anchor="end" class="axis">{value:+.3f}</text>')
    zero_y = y(0)
    parts.append(f'<line x1="{x0}" y1="{zero_y:.1f}" x2="{x0 + width}" y2="{zero_y:.1f}" stroke="{INK}" stroke-dasharray="5 4"/>')
    parts.append(f'<text x="{x0 - 12}" y="{zero_y + 4:.1f}" text-anchor="end" class="axis">0</text>')
    for index, row in enumerate(rows):
        xx = x(index)
        parts.append(f'<line x1="{xx:.1f}" y1="{y0 + height}" x2="{xx:.1f}" y2="{y0 + height + 6}" stroke="{MUTED}"/>')
        parts.append(f'<text x="{xx:.1f}" y="{y0 + height + 26}" text-anchor="middle" class="axis">{row["entryLatencyMs"]} ms</text>')
    mark_points = " ".join(f"{x(i):.1f},{y(float(row['markEvPerAttemptSol'])):.1f}" for i, row in enumerate(rows))
    conservative_points = " ".join(f"{x(i):.1f},{y(float(row['conservativeEvPerAttemptSol'])):.1f}" for i, row in enumerate(rows))
    parts.append(f'<polyline points="{mark_points}" fill="none" stroke="{BLUE}" stroke-width="3"/>')
    parts.append(f'<polyline points="{conservative_points}" fill="none" stroke="{RED}" stroke-width="3"/>')
    for i, row in enumerate(rows):
        parts.append(f'<circle cx="{x(i):.1f}" cy="{y(float(row["markEvPerAttemptSol"])):.1f}" r="5" fill="white" stroke="{BLUE}" stroke-width="3"/>')
        parts.append(f'<circle cx="{x(i):.1f}" cy="{y(float(row["conservativeEvPerAttemptSol"])):.1f}" r="5" fill="white" stroke="{RED}" stroke-width="3"/>')
    parts.append(f'<line x1="{x0}" y1="{y0 + height}" x2="{x0 + width}" y2="{y0 + height}" stroke="{MUTED}"/>')
    parts.append(f'<text x="{x0 + width / 2}" y="{y0 + height + 52}" text-anchor="middle" class="axis">Simulated entry latency</text>')
    parts.append(f'<line x1="680" y1="96" x2="708" y2="96" stroke="{BLUE}" stroke-width="3"/><text x="716" y="100" class="axis">last-observation mark</text>')
    parts.append(f'<line x1="680" y1="116" x2="708" y2="116" stroke="{RED}" stroke-width="3"/><text x="716" y="120" class="axis">conservative exit</text>')
    parts.append(f'<text x="48" y="505" class="small">Source: docs/research/SCENARIO-SWEEP-2026-09-17.json · no new observations</text>')
    return svg_document("Latency sensitivity", "Mark and conservative expected value across simulated entry latency.", "".join(parts))


def observed_vs_conservative(data: dict) -> str:
    mark = float(data["bestObservedMark"]["evPerAttemptSol"])
    conservative = float(data["bestObservedMark"]["conservativeEvPerAttemptSol"])
    values = [("Best observed mark", mark, BLUE), ("Same row, conservative", conservative, RED)]
    x0, y0, width, height = 480, 165, 360, 220
    lo, hi = min(conservative, 0) - 0.04, max(mark, 0) + 0.04

    def x(value: float) -> float:
        return x0 + (value - lo) * width / (hi - lo)

    parts = [chart_header("Observed mark vs conservative result", "The highest mark row is not the executable result")]
    zero = x(0)
    parts.append(f'<line x1="{zero:.1f}" y1="{y0 - 15}" x2="{zero:.1f}" y2="{y0 + height + 10}" stroke="{INK}" stroke-dasharray="5 4"/>')
    parts.append(f'<text x="{zero:.1f}" y="{y0 - 28}" text-anchor="middle" class="axis">0 SOL</text>')
    for i, (label, value, color) in enumerate(values):
        yy = y0 + i * 92
        start = min(zero, x(value))
        bar_width = abs(x(value) - zero)
        parts.append(f'<text x="48" y="{yy + 24}" class="label">{esc(label)}</text>')
        parts.append(f'<rect x="{start:.1f}" y="{yy}" width="{bar_width:.1f}" height="42" rx="7" fill="{color}" opacity="0.92"/>')
        parts.append(f'<text x="{(x(value) + (8 if value >= 0 else -8)):.1f}" y="{yy + 27}" text-anchor="{"start" if value >= 0 else "end"}" class="value" fill="{color}">{value:+.4f} SOL</text>')
    parts.append(f'<text x="48" y="425" class="small">Fresh exit observation rate for this row: {data["bestObservedMark"]["freshExitPct"]:.1f}%</text>')
    parts.append(f'<text x="48" y="452" class="small">Source: docs/research/SCENARIO-SWEEP-2026-09-17.json</text>')
    return svg_document("Observed mark versus conservative result", "Comparison of the best observed mark and its conservative treatment.", "".join(parts))


def pipeline_figure() -> str:
    boxes = [
        (55, "Capture", "raw RPC evidence"),
        (210, "Normalize", "causal events"),
        (365, "Enrich", "finalized evidence"),
        (520, "Replay", "deterministic bytes"),
        (675, "Simulate", "cost + latency"),
        (830, "Publish", "auditable result"),
    ]
    parts = [chart_header("Execution-aware research pipeline", "Observed data and post-hoc evidence remain separate")]
    parts.append('<defs><marker id="arrow" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto"><path d="M0,0 L0,6 L9,3 z" fill="#627d98"/></marker></defs>')
    for index, (xx, title, subtitle) in enumerate(boxes):
        parts.append(f'<rect x="{xx}" y="190" width="115" height="90" rx="12" fill="{PALE}" stroke="{TEAL}" stroke-width="2"/>')
        parts.append(f'<text x="{xx + 57.5}" y="225" text-anchor="middle" class="label">{title}</text>')
        parts.append(f'<text x="{xx + 57.5}" y="248" text-anchor="middle" class="small">{subtitle}</text>')
        if index < len(boxes) - 1:
            parts.append(f'<line x1="{xx + 115}" y1="235" x2="{boxes[index + 1][0] - 12}" y2="235" stroke="{MUTED}" stroke-width="2" marker-end="url(#arrow)"/>')
    parts.append(f'<path d="M 118 335 C 260 390, 705 390, 887 335" fill="none" stroke="{BLUE}" stroke-width="2" stroke-dasharray="7 6"/>')
    parts.append('<text x="500" y="410" text-anchor="middle" class="axis">provenance, hashes, limitations, and reproducible artifacts</text>')
    parts.append(f'<text x="48" y="505" class="small">Causal boundary: only information available at observation time enters the execution model.</text>')
    return svg_document("Execution-aware research pipeline", "Architecture from capture through publication.", "".join(parts))


def search_space_figure(data: dict) -> str:
    universe = data["universe"]
    search = data["search"]
    cards = [
        ("Token paths", f"{universe['pathsWithAtLeastTwoNativeSolTradeStates']:,}", "cloud + local"),
        ("Fixed horizons", f"{search['fixedHorizonCombinations']:,}", "threshold × size × latency × hold"),
        ("TP / SL rows", f"{search['takeProfitStopLossCombinations']:,}", "strongest candidates"),
        ("Cost audits", f"{search['costAudits']:,}", "low / medium / high"),
    ]
    parts = [chart_header("Experimental search space", "Published capital-aware sweep · 17 September 2026")]
    for i, (label, value, subtitle) in enumerate(cards):
        xx = 58 + (i % 2) * 430
        yy = 135 + (i // 2) * 145
        parts.append(f'<rect x="{xx}" y="{yy}" width="370" height="105" rx="12" fill="{PALE}" stroke="{GRID}"/>')
        parts.append(f'<text x="{xx + 24}" y="{yy + 34}" class="label">{esc(label)}</text>')
        parts.append(f'<text x="{xx + 24}" y="{yy + 76}" class="value" style="font-size:30px;fill:{NAVY}">{esc(value)}</text>')
        parts.append(f'<text x="{xx + 190}" y="{yy + 76}" class="small">{esc(subtitle)}</text>')
    parts.append(f'<text x="58" y="450" class="axis">Capital-aware starts: 0.5, 1, 2, and 5 SOL · real trades: false</text>')
    parts.append(f'<text x="58" y="485" class="small">Source: docs/research/SCENARIO-SWEEP-2026-09-17.json</text>')
    return svg_document("Experimental search space", "Scale of the published negative-result experiment.", "".join(parts))


def main() -> None:
    data = json.loads(DATA_PATH.read_text())
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    outputs = {
        "latency-sensitivity.svg": latency_figure(data),
        "observed-vs-conservative.svg": observed_vs_conservative(data),
        "research-pipeline.svg": pipeline_figure(),
        "experimental-search-space.svg": search_space_figure(data),
    }
    for name, content in outputs.items():
        (OUTPUT_DIR / name).write_text(content, encoding="utf-8")
        print(f"wrote {OUTPUT_DIR / name}")


if __name__ == "__main__":
    main()
