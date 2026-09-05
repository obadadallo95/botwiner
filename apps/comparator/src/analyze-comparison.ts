import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  analyzeFeedComparison,
  writeFeedComparisonReports,
  type FeedComparisonManifest,
} from "@botwiner/research";

function usage(): string {
  return "Usage: pnpm comparison:analyze <comparison-directory>";
}

async function run(): Promise<void> {
  const directoryArgument = process.argv[2];
  if (directoryArgument === undefined || directoryArgument === "--help") {
    console.log(usage());
    return;
  }
  const directory = resolve(directoryArgument);
  const manifest = JSON.parse(
    await readFile(join(directory, "comparison-manifest.json"), "utf8"),
  ) as FeedComparisonManifest;
  if (manifest.status !== "complete") {
    throw new Error(`comparison is not complete: ${manifest.status}`);
  }
  const report = await analyzeFeedComparison(directory, manifest);
  await writeFeedComparisonReports(directory, report);
  console.log(JSON.stringify({
    status: "complete",
    comparisonId: report.comparisonId,
    matchedSignatures: report.coverage.matchedSignatures,
    cleanMatchedSignatures: report.cleanLatency.deltaMs.count,
  }));
}

void run().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
