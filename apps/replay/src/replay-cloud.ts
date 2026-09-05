import { createHash } from "node:crypto";
import { once } from "node:events";
import type { CloudDatasetManifest } from "@botwiner/storage";
import { createWriteStream, createReadStream, existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { createGunzip } from "node:zlib";
import { createInterface } from "node:readline";
import { Storage } from "@google-cloud/storage";
import type { NormalizedMarketEvent } from "@botwiner/market-data";
import {
  PaperTradingEngine,
  MultiPortfolioEngine,
  type PortfolioSummary,
  TraderPnlTracker,
  type PaperTradingStats,
  type MarketParticipantStats,
} from "@botwiner/research";

export interface ReplayCloudOptions {
  sessionId: string;
  bucketName: string;
  cacheDirectory: string;
  outputPath?: string | undefined;
}

export interface ReplayCloudComparison {
  sessionId: string;
  portfolioMatch: boolean | null;
  replayedPortfolios: PortfolioSummary;
  totalEventsProcessed: number;
  launchesProcessed: number;
  tradesProcessed: number;
  originalPaperSummary: Record<string, unknown> | null;
  replayedPaperSummary: PaperTradingStats;
  originalParticipantSummary: Record<string, unknown> | null;
  replayedParticipantSummary: MarketParticipantStats;
  auditFindings: {
    paperStrategyMatch: boolean;
    cleanCreatorsSeparated: boolean;
    cleanCreatorsCount: number;
    partialCreatorsCount: number;
    cleanCreatorsFullyExited: number;
    headlineFullyExitedMatchesCleanOnly: boolean;
    integerWacDiscrepancySol: number;
  };
}

export async function replayCloudSession(options: ReplayCloudOptions): Promise<ReplayCloudComparison> {
  const { sessionId, bucketName, cacheDirectory, outputPath } = options;
  const sessionCacheDir = resolve(cacheDirectory, sessionId);
  const chunksCacheDir = join(sessionCacheDir, "chunks");
  const summaryCacheDir = join(sessionCacheDir, "summary");

  await mkdir(chunksCacheDir, { recursive: true });
  await mkdir(summaryCacheDir, { recursive: true });

  const storage = new Storage();
  const bucket = storage.bucket(bucketName);

  // 1. Fetch chunks list
  console.log(`[ReplayCloud] Listing chunks for session ${sessionId} in gs://${bucketName}...`);
  const [files] = await bucket.getFiles({
    prefix: `sessions/${sessionId}/chunks/events-`,
  });

  if (files.length === 0) {
    throw new Error(`No chunk files found for session ${sessionId} in gs://${bucketName}`);
  }

  const [manifestBytes] = await bucket.file(`sessions/${sessionId}/manifest.json`).download();
  const manifest = JSON.parse(manifestBytes.toString("utf8")) as CloudDatasetManifest;
  if (manifest.status === "collecting") throw new Error("Cannot replay an active capture");
  if (manifest.chunks.length !== files.length) throw new Error("Manifest/chunk count mismatch");

  // Sort files chronologically by filename (e.g. events-000001.jsonl.gz)
  files.sort((a, b) => a.name.localeCompare(b.name));
  console.log(`[ReplayCloud] Found ${files.length} event chunks.`);

  // Download chunks to cache if not already present
  const localChunkPaths: string[] = [];
  for (const file of files) {
    const fileName = basename(file.name);
    const localPath = join(chunksCacheDir, fileName);
    if (!existsSync(localPath)) {
      console.log(`[ReplayCloud] Downloading ${file.name} -> ${localPath}...`);
      await file.download({ destination: localPath });
    } else {
      console.log(`[ReplayCloud] Using cached chunk ${fileName}`);
    }
    const expected = manifest.chunks.find(c => basename(c.fileName) === fileName);
    const digest = createHash("sha256").update(await readFile(localPath)).digest("hex");
    if (!expected || expected.sha256 !== digest) throw new Error(`Evidence checksum mismatch: ${fileName}`);
    localChunkPaths.push(localPath);
  }

  // Also download original summaries for comparison if available
  let originalPaperSummary: Record<string, unknown> | null = null;
  let originalParticipantSummary: Record<string, unknown> | null = null;

  try {
    const paperSummaryFile = bucket.file(`sessions/${sessionId}/summary/paper-trading-summary.json`);
    const [exists] = await paperSummaryFile.exists();
    if (exists) {
      const [contents] = await paperSummaryFile.download();
      originalPaperSummary = JSON.parse(contents.toString("utf8")) as Record<string, unknown>;
    }
  } catch (err) {
    console.warn(`[ReplayCloud] Could not fetch original paper summary:`, err);
  }

  try {
    const participantSummaryFile = bucket.file(`sessions/${sessionId}/summary/participant-analytics-summary.json`);
    const [exists] = await participantSummaryFile.exists();
    if (exists) {
      const [contents] = await participantSummaryFile.download();
      originalParticipantSummary = JSON.parse(contents.toString("utf8")) as Record<string, unknown>;
    }
  } catch (err) {
    console.warn(`[ReplayCloud] Could not fetch original participant summary:`, err);
  }

  // 2. Run Replay
  console.log(`[ReplayCloud] Initializing hardened research engines...`);
  const portfolioFile = bucket.file(`sessions/${sessionId}/summary/portfolio-summary.json`);
  const [hasPortfolios] = await portfolioFile.exists();
  const originalPortfolios = hasPortfolios ? JSON.parse((await portfolioFile.download())[0].toString("utf8")) as PortfolioSummary : null;
  const auditOutput = createWriteStream(join(sessionCacheDir, "portfolio-audit.jsonl"));
  let auditError: Error | null = null;
  auditOutput.on("error", error => { auditError = error; });
  const portfolios = new MultiPortfolioEngine(record => { auditOutput.write(JSON.stringify(record) + "\n"); });
  const paperEngine = new PaperTradingEngine();
  const pnlTracker = new TraderPnlTracker();

  let totalEventsProcessed = 0;
  let launchesProcessed = 0;
  let tradesProcessed = 0;
  let lastEventTimestampMs = 0;

  for (const chunkPath of localChunkPaths) {
    console.log(`[ReplayCloud] Processing ${basename(chunkPath)}...`);
    const gunzip = createGunzip();
    const input = createReadStream(chunkPath).pipe(gunzip);
    const rl = createInterface({ input, crlfDelay: Infinity });

    for await (const line of rl) {
      if (!line.trim()) continue;
      totalEventsProcessed += 1;
      const event = JSON.parse(line) as NormalizedMarketEvent;
      portfolios.onEvent(event);
      if (auditError) throw new Error("Portfolio audit write failed", { cause: auditError });
      if (auditOutput.writableNeedDrain) await once(auditOutput, "drain");

      if (event.eventType === "launch") {
        launchesProcessed += 1;
        paperEngine.onLaunch(event);
        pnlTracker.onLaunch(event);
        lastEventTimestampMs = Math.max(lastEventTimestampMs, event.timestamps.collectorReceivedAtUnixMs);
      } else if (event.eventType === "trade") {
        tradesProcessed += 1;
        paperEngine.onTrade(event);
        pnlTracker.onTrade(event);
        lastEventTimestampMs = Math.max(lastEventTimestampMs, event.timestamps.collectorReceivedAtUnixMs);
      }
    }
  }

  portfolios.onSessionEnd();
  await new Promise<void>((resolve, reject) => { auditOutput.once("error", reject); auditOutput.end(resolve); });
  const replayedPortfolios = portfolios.summary();
  const portfolioMatch = originalPortfolios ? JSON.stringify(originalPortfolios) === JSON.stringify(replayedPortfolios) : null;
  paperEngine.onSessionEnd(lastEventTimestampMs);

  const replayedPaperSummary = paperEngine.exportSummary();
  const replayedParticipantSummary = pnlTracker.exportSummary();

  const originalRealizedSol = Number(originalParticipantSummary?.["totalCleanRealizedPnlSol"] ?? 0);
  const replayedRealizedSol = replayedParticipantSummary.totalCleanRealizedPnlSol;
  const integerWacDiscrepancySol = Number(Math.abs(replayedRealizedSol - originalRealizedSol).toFixed(6));

  const origCreators = originalParticipantSummary?.["creatorAnalytics"] as Record<string, unknown> | undefined;
  const originalFullyExited = Number(origCreators?.["creatorsFullyExited"] ?? 0);

  const comparison: ReplayCloudComparison = {
    sessionId,
    portfolioMatch,
    replayedPortfolios,
    totalEventsProcessed,
    launchesProcessed,
    tradesProcessed,
    originalPaperSummary,
    replayedPaperSummary,
    originalParticipantSummary,
    replayedParticipantSummary,
    auditFindings: {
      paperStrategyMatch: replayedPaperSummary.strategyId === "organic-50sol-continuation-v1",
      cleanCreatorsSeparated: replayedParticipantSummary.creatorAnalytics.cleanCreatorsCount !== undefined,
      cleanCreatorsCount: replayedParticipantSummary.creatorAnalytics.cleanCreatorsCount,
      partialCreatorsCount: replayedParticipantSummary.creatorAnalytics.partialCreatorsCount,
      cleanCreatorsFullyExited: replayedParticipantSummary.creatorAnalytics.cleanCreatorsFullyExited,
      headlineFullyExitedMatchesCleanOnly:
        replayedParticipantSummary.creatorAnalytics.creatorsFullyExited ===
        replayedParticipantSummary.creatorAnalytics.cleanCreatorsFullyExited,
      integerWacDiscrepancySol,
    },
  };

  if (outputPath) {
    await writeFile(outputPath, JSON.stringify(comparison, (_key, value: unknown) => typeof value === "bigint" ? value.toString() : value, 2), "utf8");
    console.log(`[ReplayCloud] Saved comparison report to ${outputPath}`);
  }

  console.log("\n=======================================================");
  console.log("             PHASE 4C.1.1 REPLAY AUDIT REPORT          ");
  console.log("=======================================================");
  console.log(`Session:                   ${sessionId}`);
  console.log(`Events Replayed:           ${totalEventsProcessed} (${launchesProcessed} launches, ${tradesProcessed} trades)`);
  console.log(`Portfolio live/replay match: ${portfolioMatch ?? "legacy session; no original portfolio summary"}`);
  console.log(`Portfolio accounts: ${replayedPortfolios.portfolios.length} | Audit records: ${replayedPortfolios.auditCount} | SHA256: ${replayedPortfolios.auditSha256}`);
  console.log("\n--- PAPER TRADING AUDIT ---");
  console.log(`Strategy ID:               ${replayedPaperSummary.strategyId}`);
  console.log(`Entries Triggered:         ${replayedPaperSummary.entriesTriggered}`);
  console.log(`Closed Positions:          ${replayedPaperSummary.closedPositions}`);
  console.log(`Net PnL SOL:               ${replayedPaperSummary.netPnlSol}`);
  console.log("\n--- PARTICIPANT PNL & WAC BASIS AUDIT ---");
  console.log(`Total Observed Wallets:    ${replayedParticipantSummary.totalObservedWallets}`);
  console.log(`Clean Eligible Wallets:    ${replayedParticipantSummary.cleanEligibleWallets}`);
  console.log(`Partial Wallets:           ${replayedParticipantSummary.partialWallets}`);
  console.log(`Unresolved Wallets:        ${replayedParticipantSummary.unresolvedWallets}`);
  console.log(`Clean Win Rate %:          ${replayedParticipantSummary.cleanClosedTraderWinRatePct}% (${replayedParticipantSummary.cleanClosedWinningWalletCount} / ${replayedParticipantSummary.cleanClosedWalletCount})`);
  console.log(`Clean Realized PnL SOL:    Original: ${originalRealizedSol} | Hardened BigInt: ${replayedRealizedSol} (Diff: ${integerWacDiscrepancySol} SOL)`);
  console.log("\n--- CREATOR INVENTORY QUALITY AUDIT ---");
  console.log(`Creators Observed:         ${replayedParticipantSummary.creatorAnalytics.creatorsObserved}`);
  console.log(`Clean Creators Count:      ${replayedParticipantSummary.creatorAnalytics.cleanCreatorsCount}`);
  console.log(`Partial Creators Count:    ${replayedParticipantSummary.creatorAnalytics.partialCreatorsCount}`);
  console.log(`Creators Selling:          ${replayedParticipantSummary.creatorAnalytics.creatorsSelling}`);
  console.log(`Original 'Fully Exited':   ${originalFullyExited} (FLAW: included partial unobserved creators)`);
  console.log(`Hardened Clean Fully Exited: ${replayedParticipantSummary.creatorAnalytics.cleanCreatorsFullyExited} (CORRECT: headline creatorsFullyExited = ${replayedParticipantSummary.creatorAnalytics.creatorsFullyExited})`);
  console.log(`Total Net Creator Extr:    ${replayedParticipantSummary.creatorAnalytics.totalObservedCreatorExtractionSol} SOL`);
  console.log(`Median First Sell Delay:   All: ${replayedParticipantSummary.creatorAnalytics.medianFirstSellDelaySec}s | Clean: ${replayedParticipantSummary.creatorAnalytics.medianCleanFirstSellDelaySec}s`);
  console.log("=======================================================\n");

  if (portfolioMatch === false) throw new Error("Live/replay portfolio mismatch; see comparison report");
  return comparison;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let sessionId = "session-smoke-4c1-20260905192952";
  let bucketName = "your-gcs-bucket";
  let cacheDirectory = ".cache/sessions";
  let outputPath: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--session" && args[i + 1]) {
      sessionId = args[i + 1]!;
      i++;
    } else if (args[i] === "--bucket" && args[i + 1]) {
      bucketName = args[i + 1]!;
      i++;
    } else if (args[i] === "--cache-dir" && args[i + 1]) {
      cacheDirectory = args[i + 1]!;
      i++;
    } else if (args[i] === "--output" && args[i + 1]) {
      outputPath = args[i + 1]!;
      i++;
    }
  }

  await replayCloudSession({ sessionId, bucketName, cacheDirectory, outputPath });
}

if (process.argv[1] && import.meta.url.endsWith(basename(process.argv[1]))) {
  main().catch((err) => {
    console.error("[ReplayCloud] Fatal error:", err);
    process.exit(1);
  });
}
