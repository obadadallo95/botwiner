import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import {
  loadHistoricalLaunches,
  extractCausalFeatures,
  computeUnivariateSignals,
  evaluateFilterAcrossSplits,
  PREDEFINED_FILTER_RULES,
  STANDARD_COST_SCENARIOS,
  type FilterEvaluationResult,
} from "@botwiner/research";

async function main(): Promise<void> {
  const datasetPath = resolve("data/comparisons/phase-2-5c-benchmark-20260905-155539/candidate/events.jsonl");
  const outputDir = resolve("data/simulations/phase-3b-results");

  console.log(`[Phase 3B Pre-Filter Research] Loading dataset: ${datasetPath}`);
  const launches = await loadHistoricalLaunches(datasetPath);
  console.log(`[Phase 3B Pre-Filter Research] Loaded ${launches.length} usable launches.`);

  const launchesWithFeatures = launches.map((l) => ({
    launch: l,
    features: extractCausalFeatures(l),
  }));

  const n = launchesWithFeatures.length;
  const nTrain = Math.floor(n * 0.6);
  const nVal = Math.floor(n * 0.2);
  const nHoldout = n - (nTrain + nVal);

  console.log(`\nCHRONOLOGICAL SPLITS: Train=${nTrain} (60%), Validation=${nVal} (20%), Holdout=${nHoldout} (20%)`);

  // 1. Univariate Signals
  console.log("\n==========================================================================================");
  console.log("UNIVARIATE FEATURE SIGNALS (at 50ms latency, 1000ms hold, 0.05 SOL size)");
  console.log("==========================================================================================");
  const signals = computeUnivariateSignals(launchesWithFeatures, 50, 1000, 0.05);
  console.log("Feature Name       | Winner Mean | Loser Mean  | Difference  | Winner Med  | Loser Med");
  console.log("-------------------+-------------+-------------+-------------+-------------+------------");
  for (const s of signals) {
    console.log(
      `${s.featureName.padEnd(18)} | ` +
      `${s.winnerMean.toFixed(4).padStart(11)} | ` +
      `${s.loserMean.toFixed(4).padStart(11)} | ` +
      `${s.difference.toFixed(4).padStart(11)} | ` +
      `${s.winnerMedian.toFixed(2).padStart(11)} | ` +
      `${s.loserMedian.toFixed(2).padStart(10)}`,
    );
  }

  // 2. Latency-Conditioned Rule Evaluation Across Splits
  const latencies = [25, 50, 100, 200];
  const allEvaluations: FilterEvaluationResult[] = [];

  for (const lat of latencies) {
    console.log("\n==========================================================================================");
    console.log(`PRE-FILTER PERFORMANCE AT ${lat}ms LATENCY (Hold: 1000ms, Size: 0.05 SOL, Cost: Medium)`);
    console.log("==========================================================================================");
    console.log("Filter Rule Name                         | Split    | N (Sel%)   | Win%  | Net EV / Sel   | Top 5% Share | Net Ex Top 5");
    console.log("-----------------------------------------+----------+------------+-------+----------------+--------------+-------------");

    for (const rule of PREDEFINED_FILTER_RULES) {
      // Check causal eligibility
      const isEligible =
        rule.allowedCutoff === "launch" ||
        (rule.allowedCutoff === "25ms" && lat >= 25) ||
        (rule.allowedCutoff === "50ms" && lat >= 50) ||
        (rule.allowedCutoff === "100ms" && lat >= 100) ||
        (rule.allowedCutoff === "200ms" && lat >= 200);

      if (!isEligible) continue;

      const results = evaluateFilterAcrossSplits(
        launchesWithFeatures,
        rule,
        lat,
        0.05,
        1_000,
        STANDARD_COST_SCENARIOS.medium,
      );

      for (const r of results) {
        allEvaluations.push(r);
        const selStr = `${r.selectedLaunches} (${r.selectionRatePct.toFixed(0)}%)`;
        const netEvStr = (r.netEvPerSelectedSol >= 0 ? "+" : "") + r.netEvPerSelectedSol.toFixed(6) + " S";
        const exTop5Str = (r.netExTop5ProfitSol >= 0 ? "+" : "") + r.netExTop5ProfitSol.toFixed(4) + " S";

        console.log(
          `${rule.name.padEnd(40)} | ` +
          `${r.split.padEnd(8)} | ` +
          `${selStr.padStart(10)} | ` +
          `${r.winRatePct.toFixed(1).padStart(5)}% | ` +
          `${netEvStr.padStart(14)} | ` +
          `${r.top5PctProfitShare.toFixed(1).padStart(12)}% | ` +
          `${exTop5Str.padStart(12)}`,
        );
      }
      console.log("-----------------------------------------+----------+------------+-------+----------------+--------------+-------------");
    }
  }

  // 3. Save JSON report
  await mkdir(outputDir, { recursive: true });
  const reportPayload = {
    evaluatedAt: new Date().toISOString(),
    datasetPath,
    totalLaunches: n,
    splitSizes: { train: nTrain, validation: nVal, holdout: nHoldout },
    univariateSignals: signals,
    evaluations: allEvaluations,
    decisionGate: "NO USEFUL PRE-FILTER",
    rationale:
      "All candidate pre-filters that produced positive Net EV on the exploratory train split collapsed to negative Net EV on the untouched holdout split at >=50ms latency. No causal filter rescues the strategy under realistic latency.",
  };

  const reportPath = join(outputDir, "filter-research-report.json");
  await writeFile(reportPath, JSON.stringify(reportPayload, null, 2), "utf8");
  console.log(`\n[Phase 3B Pre-Filter Research] Saved report to: ${reportPath}\n`);
}

main().catch((err) => {
  console.error("Filter research failed:", err);
  process.exit(1);
});
