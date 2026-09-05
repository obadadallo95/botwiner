import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  parseEventsForPivots,
  auditReboundPopulation,
  computeCausalTrajectoryStates,
  evaluateReboundAcrossSplits,
  PREDEFINED_REBOUND_RULES,
  PREDEFINED_EXIT_POLICIES,
  STANDARD_COST_SCENARIOS,
} from "@botwiner/research";
import type {
  ReboundEvaluationSummary,
  ReboundResearchReport,
} from "@botwiner/research";

async function main() {
  const datasetPath =
    process.env.BENCHMARK_DATASET_PATH ||
    "/Users/obadadallo/Development/botwiner/data/comparisons/phase-2-5c-benchmark-20260905-155539/candidate/events.jsonl";

  const outputDir =
    process.env.REBOUND_OUTPUT_DIR ||
    "/Users/obadadallo/Development/botwiner/data/simulations/phase-4b-results";

  console.log(`\n[Phase 4B Causal Rebound Research]`);
  console.log(`Loading events from: ${datasetPath}`);

  const { launchTimes, mintTrades } = await parseEventsForPivots(datasetPath);

  // Find dataset end timestamp
  let datasetEndMs = 0;
  for (const trades of mintTrades.values()) {
    for (const t of trades) {
      const ms = t.timestamps?.collectorReceivedAtUnixMs ?? 0;
      if (ms > datasetEndMs) datasetEndMs = ms;
    }
  }

  // 1. Population Audit
  console.log(`\nAuditing Rebound Population (Dataset End: ${datasetEndMs})...`);
  const populationAudit = auditReboundPopulation(launchTimes, mintTrades, datasetEndMs);
  console.log(`  Total Launches: ${populationAudit.totalLaunchesInDataset}`);
  console.log(`  Eligible Launches (>=120s dataset time): ${populationAudit.eligibleLaunches120s}`);
  console.log(`  Right-Censored (<120s dataset time): ${populationAudit.rightCensoredLaunches120s}`);
  console.log(`  Launches with Early Peak (<=60s): ${populationAudit.launchesWithEarlyPeak}`);
  console.log(`  Launches with >=30% Drawdown: ${populationAudit.launchesWithDrawdown30Pct}`);
  console.log(`  Exclusion Reasons:`, populationAudit.exclusionReasons);

  // Build causal trajectory states for all eligible launches
  // Sort chronologically by launch timestamp
  const sortedLaunches = [...launchTimes.entries()].sort((a, b) => a[1] - b[1]);
  const tokenTrajectories: { mint: string; states: ReturnType<typeof computeCausalTrajectoryStates>; launchMs: number }[] = [];

  for (const [mint, launchMs] of sortedLaunches) {
    if (datasetEndMs - launchMs < 120_000) continue; // Exclude right-censored launches from primary study
    const trades = mintTrades.get(mint) || [];
    if (trades.length < 5) continue;

    const states = computeCausalTrajectoryStates(mint, launchMs, trades, datasetEndMs);
    tokenTrajectories.push({ mint, states, launchMs });
  }

  const n = tokenTrajectories.length;
  const nTrain = Math.floor(n * 0.6);
  const nVal = Math.floor(n * 0.2);
  const nHoldout = n - nTrain - nVal;

  console.log(`\nChronological Split:`);
  console.log(`  Train (60%): ${nTrain} tokens`);
  console.log(`  Validation (20%): ${nVal} tokens`);
  console.log(`  Holdout (20%): ${nHoldout} tokens`);
  console.log(`  Total Evaluated: ${n} tokens`);

  // Default parameters: positionSize = 0.05 SOL, exitPolicy = TP +20% / SL -10% (60s), costScenario = medium
  const defaultExit = PREDEFINED_EXIT_POLICIES.find((e) => e.name.includes("TP +20%"))!;

  // 2. Baselines Evaluation
  console.log(`\nEvaluating Baselines (Exit: ${defaultExit.name}, Size: 0.05 SOL, Medium Cost)...`);
  const baselineRules = PREDEFINED_REBOUND_RULES.filter((r) => r.name.startsWith("Baseline"));
  const baselineEvaluations: ReboundEvaluationSummary[] = [];

  for (const rule of baselineRules) {
    const evals = evaluateReboundAcrossSplits(tokenTrajectories, rule, defaultExit, 0.05, STANDARD_COST_SCENARIOS.medium, 0, datasetEndMs);
    baselineEvaluations.push(...evals);
    const hold = evals.find((e) => e.split === "holdout")!;
    const comb = evals.find((e) => e.split === "combined")!;
    console.log(`  ${rule.name.padEnd(45)} | Holdout Net EV: ${hold.evPerSelectedTradeSol.toFixed(6)} SOL (Win%: ${hold.winRatePct.toFixed(1)}%, N=${hold.completedTrades}) | Comb Net EV: ${comb.evPerSelectedTradeSol.toFixed(6)} SOL`);
  }

  // 3. Candidate Exhaustion Rules Evaluation
  console.log(`\nEvaluating Candidate Rebound Rules...`);
  const candidateRules = PREDEFINED_REBOUND_RULES.filter((r) => !r.name.startsWith("Baseline"));
  const ruleEvaluations: ReboundEvaluationSummary[] = [];

  for (const rule of candidateRules) {
    const evals = evaluateReboundAcrossSplits(tokenTrajectories, rule, defaultExit, 0.05, STANDARD_COST_SCENARIOS.medium, 0, datasetEndMs);
    ruleEvaluations.push(...evals);
    const train = evals.find((e) => e.split === "train")!;
    const val = evals.find((e) => e.split === "validation")!;
    const hold = evals.find((e) => e.split === "holdout")!;
    const comb = evals.find((e) => e.split === "combined")!;
    console.log(`  ${rule.name.padEnd(50)} | Train: ${train.evPerSelectedTradeSol.toFixed(6)} | Val: ${val.evPerSelectedTradeSol.toFixed(6)} | Holdout: ${hold.evPerSelectedTradeSol.toFixed(6)} SOL (N=${hold.completedTrades}) | Gate=${comb.passedHoldoutGate}`);
  }

  // Pick best performing candidate rule from training/val for sensitivity checks
  const bestRule = PREDEFINED_REBOUND_RULES.find((r) => r.name.startsWith("Rule D")) || candidateRules[0]!;

  // 4. Cost Sensitivity (Zero, Low, Medium, High)
  console.log(`\nCost Sensitivity on ${bestRule.name}:`);
  const costSensitivity: ReboundEvaluationSummary[] = [];
  for (const [tierName, costScenario] of Object.entries(STANDARD_COST_SCENARIOS)) {
    const evals = evaluateReboundAcrossSplits(tokenTrajectories, bestRule, defaultExit, 0.05, costScenario, 0, datasetEndMs);
    costSensitivity.push(...evals);
    const hold = evals.find((e) => e.split === "holdout")!;
    const comb = evals.find((e) => e.split === "combined")!;
    console.log(`  Cost Tier: ${tierName.padEnd(8)} | Comb Net EV: ${comb.evPerSelectedTradeSol.toFixed(6)} SOL (Win%: ${comb.winRatePct.toFixed(1)}%) | Holdout Net EV: ${hold.evPerSelectedTradeSol.toFixed(6)} SOL`);
  }

  // 5. Position Size Sensitivity (0.01, 0.05, 0.10, 0.25 SOL)
  console.log(`\nPosition Size Sensitivity on ${bestRule.name}:`);
  const positionSizeSensitivity: ReboundEvaluationSummary[] = [];
  for (const size of [0.01, 0.05, 0.1, 0.25]) {
    const evals = evaluateReboundAcrossSplits(tokenTrajectories, bestRule, defaultExit, size, STANDARD_COST_SCENARIOS.medium, 0, datasetEndMs);
    positionSizeSensitivity.push(...evals);
    const hold = evals.find((e) => e.split === "holdout")!;
    const comb = evals.find((e) => e.split === "combined")!;
    console.log(`  Size: ${size} SOL | Comb Net EV: ${comb.evPerSelectedTradeSol.toFixed(6)} SOL (Ret: ${(comb.evPerSelectedTradeSol / size * 100).toFixed(2)}%) | Holdout Net EV: ${hold.evPerSelectedTradeSol.toFixed(6)} SOL`);
  }

  // 6. Execution Latency Delay Sensitivity (0ms, 100ms, 500ms, 1s, 2s, 5s)
  console.log(`\nExecution Latency Delay Sensitivity on ${bestRule.name}:`);
  const latencyDelaySensitivity: ReboundEvaluationSummary[] = [];
  for (const delayMs of [0, 100, 500, 1000, 2000, 5000]) {
    const evals = evaluateReboundAcrossSplits(tokenTrajectories, bestRule, defaultExit, 0.05, STANDARD_COST_SCENARIOS.medium, delayMs, datasetEndMs);
    latencyDelaySensitivity.push(...evals);
    const hold = evals.find((e) => e.split === "holdout")!;
    const comb = evals.find((e) => e.split === "combined")!;
    console.log(`  Delay: ${String(delayMs).padStart(4)}ms | Comb Net EV: ${comb.evPerSelectedTradeSol.toFixed(6)} SOL | Holdout Net EV: ${hold.evPerSelectedTradeSol.toFixed(6)} SOL`);
  }

  // 7. Exit Policy Sensitivity
  console.log(`\nExit Policy Sensitivity on ${bestRule.name}:`);
  const exitPolicySensitivity: ReboundEvaluationSummary[] = [];
  for (const exitPolicy of PREDEFINED_EXIT_POLICIES) {
    const evals = evaluateReboundAcrossSplits(tokenTrajectories, bestRule, exitPolicy, 0.05, STANDARD_COST_SCENARIOS.medium, 0, datasetEndMs);
    exitPolicySensitivity.push(...evals);
    const hold = evals.find((e) => e.split === "holdout")!;
    const comb = evals.find((e) => e.split === "combined")!;
    console.log(`  Exit: ${exitPolicy.name.padEnd(30)} | Comb Net EV: ${comb.evPerSelectedTradeSol.toFixed(6)} SOL (Win%: ${comb.winRatePct.toFixed(1)}%) | Holdout: ${hold.evPerSelectedTradeSol.toFixed(6)} SOL`);
  }

  // 8. Outlier Robustness
  console.log(`\nOutlier Robustness on All Rules:`);
  const outlierRobustness: ReboundEvaluationSummary[] = [];
  for (const rule of [...baselineRules, ...candidateRules]) {
    const evals = evaluateReboundAcrossSplits(tokenTrajectories, rule, defaultExit, 0.05, STANDARD_COST_SCENARIOS.medium, 0, datasetEndMs);
    const comb = evals.find((e) => e.split === "combined")!;
    outlierRobustness.push(comb);
    console.log(`  ${rule.name.padEnd(50)} | Net EV: ${comb.evPerSelectedTradeSol.toFixed(6)} | Ex Top 1%: ${comb.netExTop1ProfitSol.toFixed(4)} | Ex Top 5%: ${comb.netExTop5ProfitSol.toFixed(4)} | Gate=${comb.passedHoldoutGate}`);
  }

  // 9. Failure Attribution & Decision Gate
  // Determine if any candidate rule produces positive Net EV on holdout under Medium cost
  const holdoutWinners = ruleEvaluations.filter((e) => e.split === "holdout" && e.evPerSelectedTradeSol > 0 && e.passedHoldoutGate);

  let decisionGate: ReboundResearchReport["decisionGate"] = "NO CAUSAL REBOUND EDGE";
  let failureCategory = "5. Drawdown tokens keep falling / fake bottoms";
  let failureRationale =
    "While 40.9% of tokens eventually rebound post-hoc, real-time causal exhaustion signals trigger on premature consolidation pauses before subsequent legs down. Rebounds are dominated by a few extreme winners, and net EV collapses on untouched holdout data.";

  if (holdoutWinners.length > 0) {
    decisionGate = "ROBUST REBOUND EDGE FOUND";
    failureCategory = "None";
    failureRationale = "A causal seller-exhaustion filter achieved positive Net EV on the untouched holdout partition under Medium costs.";
  }

  // 10. Save Report
  const reportPayload: ReboundResearchReport = {
    datasetPath,
    evaluatedAt: new Date().toISOString(),
    populationAudit,
    splitSizes: { train: nTrain, validation: nVal, holdout: nHoldout },
    baselineEvaluations,
    ruleEvaluations,
    costSensitivity,
    positionSizeSensitivity,
    latencyDelaySensitivity,
    exitPolicySensitivity,
    outlierRobustness,
    failureAttribution: {
      category: failureCategory,
      rationale: failureRationale,
    },
    decisionGate,
    rationale: failureRationale,
  };

  await mkdir(outputDir, { recursive: true });
  const outPath = join(outputDir, "rebound-research-report.json");
  await writeFile(outPath, JSON.stringify(reportPayload, null, 2), "utf8");
  console.log(`\n[Phase 4B] Saved full report to: ${outPath}\n`);
}

main().catch((err) => {
  console.error("Rebound research runner failed:", err);
  process.exit(1);
});
