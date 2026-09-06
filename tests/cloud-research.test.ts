import test from "node:test";
import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import {
  GraduationTracker,
  PaperTradingEngine,
  MultiPortfolioEngine,
  FirestoreTelemetryReporter,
  type FirestoreBackend,
  type ResearchSessionDocument,
  type GraduationSummaryCounters,
} from "@botwiner/research";
import {
  CloudResearchSink,
  generateCollisionResistantSessionId,
  type CloudStorageUploader,
  type CloudDatasetManifest,
} from "@botwiner/storage";
import type { LaunchMarketEvent, TradeMarketEvent } from "@botwiner/market-data";

class MockStorageUploader implements CloudStorageUploader {
  public readonly uploads = new Map<string, { buffer: Buffer; contentType: string }>();

  public uploadBuffer(destinationPath: string, buffer: Buffer, contentType: string): Promise<void> {
    this.uploads.set(destinationPath, { buffer, contentType });
    return Promise.resolve();
  }
}

class MockFirestoreBackend implements FirestoreBackend {
  public sessionDoc: Partial<ResearchSessionDocument> = {};
  public statsDoc: GraduationSummaryCounters | null = null;
  public candidates = new Map<string, Record<string, unknown>>();
  public activeLocks = new Map<string, Record<string, unknown>>();
  public shouldFail = false;

  public setSessionDoc(_sessionId: string, data: Partial<ResearchSessionDocument>): Promise<void> {
    if (this.shouldFail) return Promise.reject(new Error("simulated firestore network error"));
    this.sessionDoc = { ...this.sessionDoc, ...data };
    return Promise.resolve();
  }

  public updateStatsDoc(_sessionId: string, stats: GraduationSummaryCounters): Promise<void> {
    if (this.shouldFail) return Promise.reject(new Error("simulated firestore stats error"));
    this.statsDoc = { ...stats };
    return Promise.resolve();
  }

  public setGraduationCandidate(_sessionId: string, mint: string, candidate: Record<string, unknown>): Promise<void> {
    if (this.shouldFail) return Promise.reject(new Error("simulated firestore candidate error"));
    this.candidates.set(mint, candidate);
    return Promise.resolve();
  }

  public updateActiveLock(sessionId: string, data: { heartbeatAt: string; status?: string }): Promise<void> {
    if (this.shouldFail) return Promise.reject(new Error("simulated lock error"));
    this.activeLocks.set("activeSession", { sessionId, ...data });
    return Promise.resolve();
  }

  public releaseActiveLock(sessionId: string): Promise<void> {
    if (this.shouldFail) return Promise.reject(new Error("simulated lock error"));
    const current = this.activeLocks.get("activeSession");
    if (current && current.sessionId === sessionId) {
      this.activeLocks.set("activeSession", { sessionId, status: "released" });
    }
    return Promise.resolve();
  }
}

function makeSampleLaunch(mint: string, creator: string, timestampMs: number, slot = 1000): LaunchMarketEvent {
  return {
    schemaVersion: 1,
    kind: "market-event",
    eventType: "launch",
    eventId: `launch-${mint}`,
    parsingVersion: "pump-v1",
    rawRef: "raw-1",
    tokenMint: mint,
    bondingCurve: `curve-${mint}`,
    creatorWallet: creator,
    submittingWallet: creator,
    metadata: { name: "Test", symbol: "TST", uri: "https://test.com" },
    tokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    quoteMint: "So11111111111111111111111111111111111111112",
    reserves: {
      virtualTokenBaseUnits: "1073000000000000",
      virtualSolLamports: "30000000000",
      virtualQuoteBaseUnits: "30000000000",
      realTokenBaseUnits: "793100000000000",
      tokenTotalSupplyBaseUnits: "1000000000000000",
    },
    flags: { mayhemMode: false, cashbackEnabled: false },
    source: {
      transport: "solana-rpc-websocket",
      programId: "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
      commitment: "processed",
      endpointLabel: "helius-mainnet-wss",
    },
    signature: `sig-launch-${mint}`,
    ordering: { slot, collectorSequence: 1, transactionLogIndex: 1 },
    timestamps: {
      chainEventUnixSeconds: String(Math.floor(timestampMs / 1000)),
      blockTimeUnixSeconds: null,
      collectorReceivedAtUnixMs: timestampMs,
      collectorReceivedAtIso: new Date(timestampMs).toISOString(),
      collectorReceivedMonotonicNs: "1000000",
      collectorParseCompletedAtUnixMs: timestampMs + 1,
      collectorParseDurationNs: "1000",
      rpcProviderReceivedAtUnixMs: null,
    },
    unparsedTrailingBytes: 0,
  };
}

function makeSampleTrade(
  mint: string,
  realSolSol: number,
  timestampMs: number,
  isBuy = true,
  slot = 1001,
): TradeMarketEvent {
  const realSolLamports = String(BigInt(Math.floor(realSolSol * 1e9)));
  return {
    schemaVersion: 1,
    kind: "market-event",
    eventType: "trade",
    eventId: `trade-${mint}-${realSolSol}-${timestampMs}`,
    parsingVersion: "pump-v1",
    rawRef: "raw-2",
    tokenMint: mint,
    side: isBuy ? "buy" : "sell",
    traderWallet: "Trader1111111111111111111111111111111111111",
    creatorWallet: "Creator1111111111111111111111111111111111111",
    bondingCurve: null,
    instructionName: isBuy ? "buy" : "sell",
    quoteMint: "So11111111111111111111111111111111111111112",
    amounts: { tokenBaseUnits: "1000000", nativeSolLamports: "1000000000", quoteBaseUnits: "1000000000" },
    observedPriceRatio: { quoteBaseUnits: "1000", tokenBaseUnits: "1" },
    reserves: {
      virtualTokenBaseUnits: "900000000000000",
      virtualSolLamports: "40000000000",
      virtualQuoteBaseUnits: "40000000000",
      realTokenBaseUnits: "600000000000000",
      realSolLamports,
      realQuoteBaseUnits: realSolLamports,
    },
    fees: {
      protocolRecipient: "Fee111111111111111111111111111111111111111",
      protocolBasisPoints: "100",
      protocolQuoteBaseUnits: "10000000",
      creatorBasisPoints: "0",
      creatorQuoteBaseUnits: "0",
      cashbackBasisPoints: "0",
      cashbackQuoteBaseUnits: "0",
      buybackBasisPoints: "0",
      buybackQuoteBaseUnits: "0",
    },
    volumeTracking: {
      enabled: false,
      totalUnclaimedTokens: "0",
      totalClaimedTokens: "0",
      currentSolVolumeLamports: "0",
      lastUpdateUnixSeconds: "0",
    },
    flags: { mayhemMode: false },
    shareholders: [],
    source: {
      transport: "solana-rpc-websocket",
      programId: "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
      commitment: "processed",
      endpointLabel: "helius-mainnet-wss",
    },
    signature: `sig-trade-${mint}-${timestampMs}`,
    ordering: { slot, collectorSequence: 2, transactionLogIndex: 1 },
    timestamps: {
      chainEventUnixSeconds: String(Math.floor(timestampMs / 1000)),
      blockTimeUnixSeconds: null,
      collectorReceivedAtUnixMs: timestampMs,
      collectorReceivedAtIso: new Date(timestampMs).toISOString(),
      collectorReceivedMonotonicNs: "2000000",
      collectorParseCompletedAtUnixMs: timestampMs + 1,
      collectorParseDurationNs: "1000",
      rpcProviderReceivedAtUnixMs: null,
    },
    unparsedTrailingBytes: 0,
  };
}

test("GraduationTracker: tracks curve progress, threshold crossings, duplicate suppression, and organic classification", () => {
  const updatedCandidates: string[] = [];
  const tracker = new GraduationTracker({
    onCandidateUpdated: (c) => {
      updatedCandidates.push(`${c.mint}:${c.curveProgressPct.toFixed(0)}%`);
    },
  });

  const mint = "TokenOrganic1111111111111111111111111111111";
  const startMs = 1_700_000_000_000;

  // 1. Launch token
  tracker.onLaunch(makeSampleLaunch(mint, "Creator1", startMs, 1000));
  let state = tracker.getTokenState(mint);
  assert.ok(state);
  assert.equal(state.launchSeenAtUnixMs, startMs);
  assert.equal(state.tradeCount, 0);

  // 2. Trades progressing up the curve
  // Trade 1: 30 SOL
  tracker.onTrade(makeSampleTrade(mint, 30, startMs + 10_000, true, 1010));
  // Trade 2: 52 SOL -> crosses 50 SOL
  tracker.onTrade(makeSampleTrade(mint, 52, startMs + 20_000, true, 1020));
  state = tracker.getTokenState(mint);
  assert.equal(state?.crossings.t50AtUnixMs, startMs + 20_000);
  assert.equal(state?.crossingDurationsMs.to50Ms, 20_000);

  // Trade 3: 53 SOL -> duplicate threshold suppression (50 SOL crossing timestamp unchanged)
  tracker.onTrade(makeSampleTrade(mint, 53, startMs + 25_000, true, 1025));
  assert.equal(tracker.getTokenState(mint)?.crossings.t50AtUnixMs, startMs + 20_000);

  // Trade 4: 65 SOL -> crosses 60 SOL
  tracker.onTrade(makeSampleTrade(mint, 65, startMs + 35_000, true, 1035));
  // Trade 5: 75 SOL -> crosses 70 SOL
  tracker.onTrade(makeSampleTrade(mint, 75, startMs + 45_000, true, 1045));
  // Trade 6: 82 SOL -> crosses 80 SOL (near graduation)
  tracker.onTrade(makeSampleTrade(mint, 82, startMs + 55_000, true, 1055));

  // Add 10 small trades to ensure trade count > 10
  for (let i = 0; i < 10; i++) {
    tracker.onTrade(makeSampleTrade(mint, 82.5 + i * 0.1, startMs + 60_000 + i * 1000, true, 1060 + i));
  }

  // Trade: 85 SOL -> graduates!
  tracker.onTrade(makeSampleTrade(mint, 85.0, startMs + 75_000, true, 1080));

  state = tracker.getTokenState(mint);
  assert.ok(state?.graduated);
  assert.equal(state?.classification, "organic");

  const summary = tracker.getSummaryCounters();
  assert.equal(summary.tokensTracked, 1);
  assert.equal(summary.curve50PlusCount, 1);
  assert.equal(summary.curve60PlusCount, 1);
  assert.equal(summary.curve70PlusCount, 1);
  assert.equal(summary.curve80PlusCount, 1);
  assert.equal(summary.nearGraduationCount, 1);
  assert.equal(summary.graduationsDetected, 1);
  assert.equal(summary.organicGraduationsDetected, 1);
  assert.equal(summary.instantBundleGraduationsDetected, 0);
  assert.equal(summary.migrationsDetected, 0); // limitation adhered to
});

test("GraduationTracker: correctly classifies instant bundle completion", () => {
  const tracker = new GraduationTracker();
  const mint = "TokenBundle11111111111111111111111111111111";
  const startMs = 1_700_000_000_000;

  // Single-block buyout (< 1 sec, same slot)
  tracker.onLaunch(makeSampleLaunch(mint, "CreatorBundle", startMs, 5000));
  tracker.onTrade(makeSampleTrade(mint, 85.0, startMs + 200, true, 5000));

  const state = tracker.getTokenState(mint);
  assert.ok(state?.graduated);
  assert.equal(state?.classification, "instant-bundle");

  const summary = tracker.getSummaryCounters();
  assert.equal(summary.graduationsDetected, 1);
  assert.equal(summary.instantBundleGraduationsDetected, 1);
  assert.equal(summary.organicGraduationsDetected, 0);
});

test("CloudResearchSink: streams gzip compressed chunks with SHA256 checksums and updates manifest", async () => {
  const uploader = new MockStorageUploader();
  const sessionId = "test-session-cloud-1";

  const sink = await CloudResearchSink.create({
    directory: "data/sessions/dummy",
    sessionId,
    commitment: "processed",
    programId: "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
    parsingVersion: "pump-v1",
    officialIdlRevision: "rev-1",
    endpointLabel: "helius-test",
    uploader,
    chunkMaxRecords: 5, // rotate after 5 records
  });

  // Under Phase 4C.3 Data Diet, initial and per-rotation manifest overwrites are omitted to eliminate GCS hotkeys.
  // Manifest is finalized upon close(). Immutable .meta.json files are uploaded alongside chunks instead.
  assert.equal(uploader.uploads.has(`sessions/${sessionId}/manifest.json`), false);

  // Write 12 events to trigger 2 rotations + 1 final flush
  for (let i = 1; i <= 12; i++) {
    const launch = makeSampleLaunch(`Mint${i}`, "Creator", Date.now());
    await sink.recordRaw({
      raw: {
        schemaVersion: 1,
        kind: "solana.logs-notification",
        sequence: i,
        source: {
          transport: "solana-rpc-websocket",
          programId: "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
          commitment: "processed",
          endpointLabel: "helius-test",
        },
        capture: {
          receivedAtUnixMs: Date.now(),
          receivedAtIso: new Date().toISOString(),
          receivedMonotonicNs: "1000",
          parseCompletedAtUnixMs: Date.now(),
          parseDurationNs: "100",
          rpcProviderReceivedAtUnixMs: null,
        },
        rpcPayload: {},
      },
      events: [launch],
      parseFailures: [],
      invalidNotification: null,
      transactionFailed: false,
    });
  }

  await sink.close("complete");

  // Verify chunks uploaded
  const chunk1Path = `sessions/${sessionId}/chunks/events-000001.jsonl.gz`;
  const chunk2Path = `sessions/${sessionId}/chunks/events-000002.jsonl.gz`;
  const chunk3Path = `sessions/${sessionId}/chunks/events-000003.jsonl.gz`;
  assert.ok(uploader.uploads.has(chunk1Path), "chunk 1 should exist");
  assert.ok(uploader.uploads.has(chunk2Path), "chunk 2 should exist");
  assert.ok(uploader.uploads.has(chunk3Path), "chunk 3 should exist");
  assert.ok(uploader.uploads.has(`sessions/${sessionId}/chunks/events-000001.meta.json`), "chunk 1 meta should exist");
  assert.ok(uploader.uploads.has(`sessions/${sessionId}/chunks/events-000002.meta.json`), "chunk 2 meta should exist");
  assert.ok(uploader.uploads.has(`sessions/${sessionId}/chunks/events-000003.meta.json`), "chunk 3 meta should exist");

  // Verify chunk 1 decompression and sha256 checksum
  const chunk1Data = uploader.uploads.get(chunk1Path)!;
  assert.equal(chunk1Data.contentType, "application/gzip");
  const decompressed = gunzipSync(chunk1Data.buffer).toString("utf8");
  const lines = decompressed.trim().split("\n");
  assert.equal(lines.length, 5);
  const calculatedSha = createHash("sha256").update(chunk1Data.buffer).digest("hex");

  // Verify final manifest
  const manifestData = uploader.uploads.get(`sessions/${sessionId}/manifest.json`)!;
  const manifest = JSON.parse(manifestData.buffer.toString("utf8")) as CloudDatasetManifest;
  assert.equal(manifest.status, "complete");
  assert.equal(manifest.chunks.length, 3);
  const firstChunk = manifest.chunks[0];
  assert.ok(firstChunk);
  assert.equal(firstChunk.sha256, calculatedSha);
  assert.equal(manifest.counts.launches, 12);

  // Verify summary uploaded
  const summaryPath = `sessions/${sessionId}/summary/final-summary.json`;
  assert.ok(uploader.uploads.has(summaryPath));
});

test("FirestoreTelemetryReporter: handles heartbeat, throttled stats, and resilient error recovery", async () => {
  const backend = new MockFirestoreBackend();
  const sessionId = "test-session-telemetry-1";

  const reporter = new FirestoreTelemetryReporter({
    sessionId,
    mode: "graduation-research",
    provider: "helius",
    region: "europe-west3",
    requestedDurationSec: 300,
    backend,
    heartbeatIntervalMs: 50,
    statsIntervalMs: 50,
  });

  await reporter.initialize();
  assert.equal(backend.sessionDoc.sessionId, sessionId);
  assert.equal(backend.sessionDoc.status, "starting");

  reporter.markRunning();
  assert.equal(backend.sessionDoc.status, "running");

  reporter.markReconnecting();
  assert.equal(backend.sessionDoc.status, "reconnecting");
  assert.equal(backend.sessionDoc.reconnectCount, 1);

  // Test error resilience: when backend throws, reporter does NOT crash
  backend.shouldFail = true;
  reporter.markRunning();
  backend.shouldFail = false;

  await reporter.close("completed");
  assert.equal(backend.sessionDoc.status, "completed");
  assert.ok(backend.sessionDoc.completedAt);
  assert.equal(backend.activeLocks.get("activeSession")?.status, "released");
});

test("generateCollisionResistantSessionId produces collision-resistant, well-formatted IDs", () => {
  const sample = generateCollisionResistantSessionId();
  // format: session-YYYYMMDDHHMMSS-<8 hex chars>
  const match = /^session-\d{14}-[a-f0-9]{8}$/.exec(sample);
  assert.ok(match, `ID "${sample}" should match session timestamp format`);

  // Custom prefix support
  const custom = generateCollisionResistantSessionId("custom-test");
  assert.ok(custom.startsWith("custom-test-"), `ID "${custom}" should start with prefix`);

  // Uniqueness across 1,000 rapid iterations
  const ids = new Set<string>();
  const count = 1000;
  for (let i = 0; i < count; i += 1) {
    ids.add(generateCollisionResistantSessionId());
  }
  assert.equal(ids.size, count, "1,000 generated session IDs must all be unique");
});

test("Cloud summaries preserve nested BigInt strategy definitions as exact decimal strings", async () => {
  const uploader = new MockStorageUploader();
  const sink = await CloudResearchSink.create({ directory: "data/sessions/dummy", sessionId: "bigint-summary-test",
    commitment: "processed", programId: "pump", parsingVersion: "v1", officialIdlRevision: "rev1",
    endpointLabel: "test", uploader });
  const value = { definition: { threshold: 50_000_000_000n }, fee: 55_000n };
  await sink.uploadDerivedSummary("paper-trading-summary", value);
  const uploaded = uploader.uploads.get("sessions/bigint-summary-test/summary/paper-trading-summary.json")!;
  assert.deepEqual(JSON.parse(uploaded.buffer.toString()), { definition: { threshold: "50000000000" }, fee: "55000" });
  assert.equal(value.definition.threshold, 50_000_000_000n);
  await sink.close("complete");
});


test("Telemetry serializes the unchanged baseline and publishes all portfolio accounts on close", async () => {
  class SummaryBackend extends MockFirestoreBackend {
    paper: Record<string, unknown> | null = null;
    portfolios: Record<string, unknown> | null = null;
    updatePaperStatsDoc(_id: string, data: Record<string, unknown>): Promise<void> {
      JSON.stringify(data); this.paper = data; return Promise.resolve();
    }
    updatePortfolioStatsDoc(_id: string, data: Record<string, unknown>): Promise<void> {
      JSON.stringify(data); this.portfolios = data; return Promise.resolve();
    }
  }
  const backend = new SummaryBackend();
  const reporter = new FirestoreTelemetryReporter({ sessionId: "summary-test", mode: "smoke", provider: "helius",
    region: "europe-west3", requestedDurationSec: 90, backend });
  await reporter.initialize();
  reporter.updatePaperStats(new PaperTradingEngine().getStats());
  reporter.updatePortfolioStats(new MultiPortfolioEngine().summary(true));
  await reporter.close("completed");
  assert.ok(backend.paper);
  assert.match(JSON.stringify(backend.paper), /50000000000/);
  assert.equal((backend.portfolios?.portfolios as unknown[]).length, 60);
});
