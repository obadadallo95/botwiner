import { readFeedQualityReport } from "@botwiner/research";

async function run(): Promise<void> {
  const dataset = process.argv[2];
  if (dataset === undefined || dataset === "--help") {
    console.log("Usage: pnpm phase2:quality <dataset-directory>");
    return;
  }
  console.log(JSON.stringify(await readFeedQualityReport(dataset), null, 2));
}

void run().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
