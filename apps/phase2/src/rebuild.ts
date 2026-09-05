import { rebuildDerivedResearchStore } from "@botwiner/research";

async function run(): Promise<void> {
  const dataset = process.argv[2];
  if (dataset === undefined || dataset === "--help") {
    console.log("Usage: pnpm phase2:rebuild <dataset-directory>");
    return;
  }
  const result = await rebuildDerivedResearchStore(dataset);
  console.log(JSON.stringify({ manifest: result.manifest, report: result.report }, null, 2));
}

void run().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
