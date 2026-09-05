import { resolve } from "node:path";
import { replayDataset } from "./replay.js";

function usage(): string {
  return "Usage: pnpm replay <dataset-directory> [--output <events.jsonl>]";
}

async function run(): Promise<void> {
  const arguments_ = process.argv.slice(2);
  if (arguments_.length === 0 || arguments_.includes("--help")) {
    console.log(usage());
    return;
  }
  const dataset = arguments_[0];
  if (dataset === undefined) throw new Error("dataset directory is required");
  let output: string | undefined;
  const outputIndex = arguments_.indexOf("--output");
  if (outputIndex >= 0) {
    const value = arguments_[outputIndex + 1];
    if (value === undefined) throw new Error("--output requires a path");
    output = resolve(value);
  }
  const summary = await replayDataset(dataset, output);
  console.log(JSON.stringify(summary, null, 2));
  if (!summary.deterministicMatch) process.exitCode = 2;
}

void run().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
