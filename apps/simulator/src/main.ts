import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import {
  loadHistoricalLaunches,
  evaluateChronologicalSplit,
  STANDARD_COST_SCENARIOS,
  type SimulationScenario,
  type ChronologicalSplitEvaluation,
  type ExitPolicy,
} from "@botwiner/research";

interface GridResult {
  latencyMs: number;
  holdDurationMs: number;
  sizeSol: number;
  fillModel: string;
  costScenario: string;
  evaluation: ChronologicalSplitEvaluation;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let datasetPath = resolve("data/comparisons/phase-2-5c-benchmark-20260905-155539/candidate/events.jsonl");
  let outputDir = resolve("data/simulations/phase-3a-results");

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--dataset" && args[i + 1]) {
      datasetPath = resolve(args[i + 1]!);
      i++;
    } else if (args[i] === "--output" && args[i + 1]) {
      outputDir = resolve(args[i + 1]!);
      i++;
    }
  }

  console.log(`[Phase 3A Simulator] Loading dataset from: ${datasetPath}`);
  const launches = await loadHistoricalLaunches(datasetPath);
  console.log(`[Phase 3A Simulator] Loaded ${launches.length} launches for evaluation.`);

  if (launches.length === 0) {
    console.error("No launches found in dataset. Aborting.");
    process.exit(1);
  }

  const latencies = [0, 25, 50, 100, 200, 500];
  const holdDurations = [100, 250, 500, 1_000, 2_000, 5_000];
  const positionSizes = [0.01, 0.05, 0.1];
  const costScenarios = [STANDARD_COST_SCENARIOS.zero, STANDARD_COST_SCENARIOS.low, STANDARD_COST_SCENARIOS.medium, STANDARD_COST_SCENARIOS.high];

  const gridResults: GridResult[] = [];

  console.log("\n==========================================================================================");
  console.log("LATENCY SENSITIVITY TABLE (Hold: 1000ms, Size: 0.05 SOL, Cost: Medium, Executable-Curve)");
  console.log("==========================================================================================");
  console.log(
    "Latency | Fill Rate | Win Rate | Gross Total | Net Total  | Avg Gross EV | Avg Net EV   | Top 5% Share | Attribution",
  );
  console.log(
    "--------+-----------+----------+-------------+------------+--------------+--------------+--------------+-------------------------------",
  );

  for (const lat of latencies) {
    const scenario: SimulationScenario = {
      latencyMs: lat,
      exitPolicy: { type: "time", holdDurationMs: 1_000 },
      positionSizeSol: 0.05,
      fillModel: "executable-curve",
      costScenario: STANDARD_COST_SCENARIOS.medium,
    };

    const evalResult = evaluateChronologicalSplit(launches, scenario, 0.5);
    gridResults.push({
      latencyMs: lat,
      holdDurationMs: 1_000,
      sizeSol: 0.05,
      fillModel: "executable-curve",
      costScenario: "medium",
      evaluation: evalResult,
    });

    const c = evalResult.combined;
    const grossTotal = c.grossPnlTotalSol >= 0 ? `+${c.grossPnlTotalSol.toFixed(3)}` : c.grossPnlTotalSol.toFixed(3);
    const netTotal = c.netPnlTotalSol >= 0 ? `+${c.netPnlTotalSol.toFixed(3)}` : c.netPnlTotalSol.toFixed(3);
    const grossEv = (c.grossPnlTotalSol / c.eligibleLaunches);
    const grossEvStr = grossEv >= 0 ? `+${grossEv.toFixed(6)}` : grossEv.toFixed(6);
    const netEvStr = c.expectedValuePerAttemptedSol >= 0 ? `+${c.expectedValuePerAttemptedSol.toFixed(6)}` : c.expectedValuePerAttemptedSol.toFixed(6);

    console.log(
      `${String(lat).padStart(4)} ms | ` +
      `${c.fillRatePct.toFixed(1).padStart(7)}% | ` +
      `${c.winRatePct.toFixed(1).padStart(6)}% | ` +
      `${grossTotal.padStart(9)} S | ` +
      `${netTotal.padStart(8)} S | ` +
      `${grossEvStr.padStart(10)} S | ` +
      `${netEvStr.padStart(10)} S | ` +
      `${c.outliers.top5PctProfitShare.toFixed(1).padStart(10)}% | ` +
      `${c.attribution}`,
    );
  }

  console.log("\n==========================================================================================");
  console.log("CHRONOLOGICAL TRAIN / VALIDATION SPLIT (Hold: 1000ms, Size: 0.05 SOL, Cost: Medium)");
  console.log("==========================================================================================");
  console.log("Latency | Exploratory Net EV | Validation Net EV  | Exploratory Win% | Validation Win%");
  console.log("--------+--------------------+--------------------+------------------+-----------------");

  for (const lat of latencies) {
    const scenario: SimulationScenario = {
      latencyMs: lat,
      exitPolicy: { type: "time", holdDurationMs: 1_000 },
      positionSizeSol: 0.05,
      fillModel: "executable-curve",
      costScenario: STANDARD_COST_SCENARIOS.medium,
    };
    const evalResult = evaluateChronologicalSplit(launches, scenario, 0.5);
    const expNet = evalResult.exploratory.expectedValuePerAttemptedSol;
    const valNet = evalResult.validation.expectedValuePerAttemptedSol;
    const expNetStr = expNet >= 0 ? `+${expNet.toFixed(6)}` : expNet.toFixed(6);
    const valNetStr = valNet >= 0 ? `+${valNet.toFixed(6)}` : valNet.toFixed(6);
    console.log(
      `${String(lat).padStart(4)} ms | ` +
      `${expNetStr.padStart(16)} S | ` +
      `${valNetStr.padStart(16)} S | ` +
      `${evalResult.exploratory.winRatePct.toFixed(1).padStart(14)}% | ` +
      `${evalResult.validation.winRatePct.toFixed(1).padStart(13)}%`,
    );
  }

  console.log("\n==========================================================================================");
  console.log("POSITION SIZE SENSITIVITY (Latency: 0ms, Hold: 1000ms, Cost: Medium, Executable-Curve)");
  console.log("==========================================================================================");
  console.log("Size (SOL) | Total Net PnL | Net EV / Launch | Return on Capital % | Top 5% Profit Share");
  console.log("-----------+---------------+-----------------+---------------------+--------------------");
  for (const size of positionSizes) {
    const scenario: SimulationScenario = {
      latencyMs: 0,
      exitPolicy: { type: "time", holdDurationMs: 1_000 },
      positionSizeSol: size,
      fillModel: "executable-curve",
      costScenario: STANDARD_COST_SCENARIOS.medium,
    };
    const evalResult = evaluateChronologicalSplit(launches, scenario, 0.5);
    const c = evalResult.combined;
    const retPct = (c.netPnlTotalSol / (size * c.eligibleLaunches)) * 100;
    console.log(
      `${size.toFixed(2).padStart(8)} S | ` +
      `${c.netPnlTotalSol.toFixed(4).padStart(11)} S | ` +
      `${c.expectedValuePerAttemptedSol.toFixed(6).padStart(13)} S | ` +
      `${retPct.toFixed(2).padStart(17)}% | ` +
      `${c.outliers.top5PctProfitShare.toFixed(1).padStart(17)}%`,
    );
  }

  console.log("\n==========================================================================================");
  console.log("COST SCENARIO SENSITIVITY (Latency: 0ms, Hold: 1000ms, Size: 0.05 SOL, Executable-Curve)");
  console.log("==========================================================================================");
  console.log("Cost Tier | Total Fees Paid | Total Net PnL | Net EV / Launch | Win Rate % | Attribution");
  console.log("----------+-----------------+---------------+-----------------+------------+-------------------------------");
  for (const cost of costScenarios) {
    const scenario: SimulationScenario = {
      latencyMs: 0,
      exitPolicy: { type: "time", holdDurationMs: 1_000 },
      positionSizeSol: 0.05,
      fillModel: "executable-curve",
      costScenario: cost,
    };
    const evalResult = evaluateChronologicalSplit(launches, scenario, 0.5);
    const c = evalResult.combined;
    const totalFees = c.grossPnlTotalSol - c.netPnlTotalSol;
    console.log(
      `${cost.name.padEnd(8)}  | ` +
      `${totalFees.toFixed(4).padStart(13)} S | ` +
      `${c.netPnlTotalSol.toFixed(4).padStart(11)} S | ` +
      `${c.expectedValuePerAttemptedSol.toFixed(6).padStart(13)} S | ` +
      `${c.winRatePct.toFixed(1).padStart(8)}% | ` +
      `${c.attribution}`,
    );
  }

  console.log("\n==========================================================================================");
  console.log("DYNAMIC TP/SL EXIT POLICY SENSITIVITY (Latency: 0ms, Size: 0.05 SOL, Cost: Medium)");
  console.log("==========================================================================================");
  const tpSlPolicies: ExitPolicy[] = [
    { type: "time", holdDurationMs: 500 },
    { type: "time", holdDurationMs: 1000 },
    { type: "time", holdDurationMs: 2000 },
    { type: "tp-sl", takeProfitPct: 10, stopLossPct: -5, maxHoldDurationMs: 5000 },
    { type: "tp-sl", takeProfitPct: 20, stopLossPct: -10, maxHoldDurationMs: 5000 },
    { type: "tp-sl", takeProfitPct: 5, stopLossPct: -3, maxHoldDurationMs: 2000 },
  ];
  console.log("Exit Policy Description           | Total Net PnL | Net EV / Launch | Win Rate % | Top 5% Share");
  console.log("----------------------------------+---------------+-----------------+------------+-------------");
  for (const policy of tpSlPolicies) {
    const label =
      policy.type === "time"
        ? `Fixed Time ${policy.holdDurationMs}ms`
        : `TP +${policy.takeProfitPct}% / SL ${policy.stopLossPct}% (max ${policy.maxHoldDurationMs}ms)`;
    const scenario: SimulationScenario = {
      latencyMs: 0,
      exitPolicy: policy,
      positionSizeSol: 0.05,
      fillModel: "executable-curve",
      costScenario: STANDARD_COST_SCENARIOS.medium,
    };
    const evalResult = evaluateChronologicalSplit(launches, scenario, 0.5);
    const c = evalResult.combined;
    console.log(
      `${label.padEnd(32)} | ` +
      `${c.netPnlTotalSol.toFixed(4).padStart(11)} S | ` +
      `${c.expectedValuePerAttemptedSol.toFixed(6).padStart(13)} S | ` +
      `${c.winRatePct.toFixed(1).padStart(8)}% | ` +
      `${c.outliers.top5PctProfitShare.toFixed(1).padStart(10)}%`,
    );
  }

  // Write artifact output
  await mkdir(outputDir, { recursive: true });
  const reportPayload = {
    evaluatedAt: new Date().toISOString(),
    dataset: datasetPath,
    launchesLoaded: launches.length,
    latencies,
    holdDurations,
    positionSizes,
    costScenarios: Object.keys(STANDARD_COST_SCENARIOS),
    gridResults,
  };

  const reportJsonPath = join(outputDir, "simulation-report.json");
  await writeFile(reportJsonPath, JSON.stringify(reportPayload, null, 2), "utf8");
  console.log(`\n[Phase 3A Simulator] Saved JSON report to: ${reportJsonPath}\n`);
}

main().catch((err) => {
  console.error("Simulation failed:", err);
  process.exit(1);
});
