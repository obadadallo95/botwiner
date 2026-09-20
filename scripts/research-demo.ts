import { createHash } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { replayDataset } from "../apps/replay/src/replay.js";
import { PaperTradingEngine } from "@botwiner/research";
import type { NormalizedMarketEvent } from "@botwiner/market-data";

interface ChecksumEntry {
  readonly digest: string;
  readonly path: string;
}

function parseChecksums(contents: string): Map<string, string> {
  const entries = new Map<string, string>();
  for (const line of contents.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    const match = /^(?<digest>[a-f0-9]{64})\s+(?<path>.+)$/u.exec(line.trim());
    const digestValue = match?.groups?.digest;
    const pathValue = match?.groups?.path;
    if (!digestValue || !pathValue) throw new Error(`Invalid checksum line: ${line}`);
    const entry: ChecksumEntry = { digest: digestValue, path: pathValue };
    entries.set(entry.path.replace(/^.*\//u, ""), entry.digest);
  }
  return entries;
}

function digest(contents: Buffer): string {
  return createHash("sha256").update(contents).digest("hex");
}

async function main(): Promise<void> {
  const dataset = resolve(process.argv[2] ?? "examples/sample-session");
  const checksums = parseChecksums(await readFile(join(dataset, "SHA256SUMS"), "utf8"));
  const expectedEventsDigest = checksums.get("events.jsonl");
  if (!expectedEventsDigest) throw new Error("SHA256SUMS does not contain events.jsonl");

  const eventsBytes = await readFile(join(dataset, "events.jsonl"));
  if (digest(eventsBytes) !== expectedEventsDigest) {
    throw new Error("FAIL: fixture events.jsonl does not match SHA256SUMS");
  }

  const outputDirectory = await mkdtemp(join(tmpdir(), "botwiner-research-demo-"));
  const first = await replayDataset(dataset, join(outputDirectory, "replay-1.jsonl"));
  const second = await replayDataset(dataset, join(outputDirectory, "replay-2.jsonl"));
  const firstOutput = await readFile(first.output, "utf8");
  const secondOutput = await readFile(second.output, "utf8");
  if (!first.deterministicMatch || !second.deterministicMatch || firstOutput !== secondOutput) {
    throw new Error("FAIL: deterministic replay or expected hash verification failed");
  }

  const engine = new PaperTradingEngine();
  const events = firstOutput
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as NormalizedMarketEvent);
  let lastTimestamp = 0;
  for (const event of events) {
    lastTimestamp = Math.max(lastTimestamp, event.timestamps.collectorReceivedAtUnixMs);
    if (event.eventType === "launch") engine.onLaunch(event);
    else engine.onTrade(event);
  }
  engine.onSessionEnd(lastTimestamp);
  const simulation = engine.exportSummary();

  console.log("PASS: sample fixture parsed and normalized");
  console.log(`PASS: deterministic replay (${first.emittedEvents} events, SHA-256 ${first.replayDigest})`);
  console.log(`PASS: small paper simulation (${simulation.entriesTriggered} entries, ${simulation.closedPositions} closed positions)`);
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
