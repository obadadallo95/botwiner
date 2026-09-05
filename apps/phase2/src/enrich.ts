import { captureRpcEvidence, rebuildDerivedResearchStore } from "@botwiner/research";

interface Options {
  readonly dataset: string;
  readonly rpcUrl: string;
  readonly concurrency: number;
  readonly maximumGapSignatures: number;
}

function usage(): string {
  return [
    "Usage: pnpm phase2:enrich <dataset-directory> [options]",
    "",
    "Options:",
    "  --rpc-url <https-url>           HTTP RPC endpoint (prefer SOLANA_RPC_URL)",
    "  --concurrency <1-32>             Concurrent requests (default: 4)",
    "  --max-gap-signatures <count>     Hard bound per detected gap (default: 5000)",
  ].join("\n");
}

function valueAfter(arguments_: readonly string[], index: number): string {
  const value = arguments_[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${arguments_[index]} requires a value`);
  return value;
}

function positiveInteger(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

function parseArguments(arguments_: readonly string[]): Options | null {
  if (arguments_.includes("--help")) return null;
  const dataset = arguments_[0];
  if (dataset === undefined || dataset.startsWith("--")) throw new Error("dataset directory is required");
  let rpcUrl = process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
  let concurrency = 4;
  let maximumGapSignatures = 5_000;
  for (let index = 1; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--rpc-url") {
      rpcUrl = valueAfter(arguments_, index);
      index += 1;
    } else if (argument === "--concurrency") {
      concurrency = positiveInteger(valueAfter(arguments_, index), argument);
      index += 1;
    } else if (argument === "--max-gap-signatures") {
      maximumGapSignatures = positiveInteger(valueAfter(arguments_, index), argument);
      index += 1;
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  if (new URL(rpcUrl).protocol !== "https:") throw new Error("RPC URL must use HTTPS");
  return { dataset, rpcUrl, concurrency, maximumGapSignatures };
}

async function run(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  if (options === null) {
    console.log(usage());
    return;
  }
  const capture = await captureRpcEvidence({
    datasetDirectory: options.dataset,
    rpcUrl: options.rpcUrl,
    concurrency: options.concurrency,
    maximumGapSignatures: options.maximumGapSignatures,
    onProgress: (progress) => console.log(JSON.stringify({ status: "enriching", ...progress })),
  });
  const rebuilt = await rebuildDerivedResearchStore(options.dataset);
  console.log(JSON.stringify({ capture, manifest: rebuilt.manifest, report: rebuilt.report }, null, 2));
}

void run().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
