import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  parseEventsForPivots,
  auditGraduationFlow,
  auditPostLaunchDumpRebound,
  auditSurvivorMomentum,
  computePivotComparisonReport,
} from "@botwiner/research";

async function main() {
  const datasetPath =
    process.env.BENCHMARK_DATASET_PATH ||
    "/Users/obadadallo/Development/botwiner/data/comparisons/phase-2-5c-benchmark-20260905-155539/candidate/events.jsonl";

  const outputDir =
    process.env.PIVOT_OUTPUT_DIR ||
    "/Users/obadadallo/Development/botwiner/data/simulations/phase-4a-results";

  console.log(`\n[Phase 4A Pivot Selection Research]`);
  console.log(`Parsing dataset: ${datasetPath}`);

  const { launchTimes, mintTrades } = await parseEventsForPivots(datasetPath);
  console.log(`Loaded ${launchTimes.size} launches and ${mintTrades.size} trading mints.`);

  // 1. Audit Graduation Flow
  console.log("\nAuditing Pivot A: Graduation / Migration Flow...");
  const graduation = auditGraduationFlow(mintTrades, launchTimes);
  console.log(`  Total tokens tracked: ${graduation.totalTokensTracked}`);
  console.log(`  Tokens reaching >=80 SOL: ${graduation.tokensReaching80Sol}`);
  console.log(`  Instant bundle completions (<1s): ${graduation.instantBundleGraduations}`);
  console.log(`  Organic graduations (>1s): ${graduation.organicGraduations}`);
  console.log(`  Max real SOL observed: ${graduation.maxRealSolObserved.toFixed(2)} SOL`);
  console.log(`  Data sufficiency: ${graduation.dataSufficiency}`);

  // 2. Audit Post-Launch Dump Rebound
  console.log("\nAuditing Pivot B: Post-Launch Dump Rebound...");
  const rebound = auditPostLaunchDumpRebound(launchTimes, mintTrades);
  console.log(`  Tokens with early peak (<=30s): ${rebound.tokensWithEarlyPeak}`);
  console.log(`  Tokens with >=30% drawdown: ${rebound.tokensWithMajorDrawdown}`);
  console.log(`  Rebounded by >= +10%: ${rebound.rebound10Count}`);
  console.log(`  Rebounded by >= +20%: ${rebound.rebound20Count} (${rebound.reboundRate20Pct.toFixed(1)}%)`);
  console.log(`  Rebounded by >= +50%: ${rebound.rebound50Count}`);
  console.log(`  Died / Flat (< +10%): ${rebound.dyingCount}`);
  console.log(`  Median time to trough: ${rebound.medianTimeToTroughSec.toFixed(1)}s`);
  console.log(`  Median time from trough to +20% rebound: ${rebound.medianTimeToReboundSec.toFixed(1)}s`);
  console.log(`  Data sufficiency: ${rebound.dataSufficiency}`);

  // 3. Audit Survivor Momentum
  console.log("\nAuditing Pivot C: Survivor Momentum...");
  const momentum = auditSurvivorMomentum(launchTimes, mintTrades);
  console.log(`  Tokens alive at 30s: ${momentum.tokensAliveAt30s}`);
  console.log(`  Tokens alive at 60s: ${momentum.tokensAliveAt60s}`);
  console.log(`  Tokens alive at 120s: ${momentum.tokensAliveAt120s}`);
  console.log(
    `  Unconditioned forward 30s->90s (N=${momentum.unconditionedEvaluated30to90}): ` +
      `${momentum.unconditionedPositiveFwd30to90} positive (${momentum.unconditionedWinRatePct.toFixed(1)}%)`,
  );
  console.log(
    `  Conditioned (>=5 buyers, buys>sells in 30s, N=${momentum.conditionedEvaluated30to90}): ` +
      `${momentum.conditionedPositiveFwd30to90} positive (${momentum.conditionedWinRatePct.toFixed(1)}%)`,
  );
  console.log(`  Data sufficiency: ${momentum.dataSufficiency}`);

  // 4. Generate Report and Rankings
  const report = computePivotComparisonReport(datasetPath, graduation, rebound, momentum);

  console.log("\n=== PIVOT RANKING SUMMARY ===");
  for (const r of report.ranking) {
    console.log(
      `Rank #${r.rank}: ${r.name.padEnd(35)} | Overall Score: ${r.overallScore}/100 | Gate: ${
        r.rank === 1 ? report.decisionGate : "ALTERNATIVE"
      }`,
    );
  }

  // 5. Save Output JSON
  await mkdir(outputDir, { recursive: true });
  const outPath = join(outputDir, "pivot-comparison-report.json");
  await writeFile(outPath, JSON.stringify(report, null, 2), "utf8");
  console.log(`\n[Phase 4A] Saved full pivot report to: ${outPath}\n`);
}

main().catch((err) => {
  console.error("Pivot research failed:", err);
  process.exit(1);
});
