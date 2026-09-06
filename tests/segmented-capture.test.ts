import test from "node:test";
import assert from "node:assert/strict";
import {
  MultiPortfolioEngine,
  PaperTradingEngine,
  TraderPnlTracker,
  createCheckpointFromEngines,
  restoreEnginesFromCheckpoint,
  serializeCheckpoint,
  deserializeCheckpoint,
} from "../packages/research/src/index.js";
import { CloudResearchSink, type CloudStorageUploader } from "../packages/storage/src/cloud-sink.js";
import { createMockLaunch, createMockTrade } from "./fixtures/portfolio-events.js";
import type { NormalizedMarketEvent } from "@botwiner/market-data";

const SOL = 1_000_000_000n;

test("SessionCheckpoint - serialization and deserialization roundtrip", () => {
  const portfolioEngine = new MultiPortfolioEngine();
  const paperEngine = new PaperTradingEngine();
  const pnlTracker = new TraderPnlTracker();

  let seq = 0;
  const orderedLaunch = (mint: string) => {
    const ev = createMockLaunch(mint);
    return { ...ev, ordering: { ...ev.ordering, collectorSequence: ++seq } };
  };
  const orderedTrade = (opts: Parameters<typeof createMockTrade>[0]) => {
    const ev = createMockTrade(opts);
    return { ...ev, ordering: { ...ev.ordering, collectorSequence: ++seq } };
  };

  // Feed launch and trade to populate state
  const launchEv = orderedLaunch("token-alpha");
  portfolioEngine.onEvent(launchEv);
  paperEngine.onLaunch(launchEv);
  pnlTracker.onLaunch(launchEv);

  for (let i = 0; i < 5; i++) {
    const tradeEv = orderedTrade({
      mint: "token-alpha",
      side: "buy",
      realSolLamports: BigInt(10 + i * 10) * SOL,
      timeMs: 2000 + i * 1000,
      slot: 100 + i,
    });
    portfolioEngine.onEvent(tradeEv);
    paperEngine.onTrade(tradeEv);
    pnlTracker.onTrade(tradeEv);
  }

  const checkpoint = createCheckpointFromEngines({
    sessionId: "test-session-123",
    segmentId: "test-session-123-seg-0001",
    segmentIndex: 1,
    cursor: {
      collectorSequence: seq,
      transactionLogIndex: 0,
      slot: 105,
      lastEventId: "last-ev-42",
      lastEventTimestampMs: 7000,
    },
    recentEventIds: ["ev-1", "ev-2", "ev-3"],
    datasetCounts: {
      rawNotifications: 10,
      normalizedEvents: 6,
      launches: 1,
      trades: 5,
      duplicateEvents: 0,
      malformedPumpEvents: 0,
      invalidRpcMessages: 0,
      failedTransactions: 0,
      disconnects: 0,
    },
    lastCommittedChunkIndex: 3,
    totalCompressedBytes: 15420,
    completedChunks: [],
    completedDiagnosticChunks: [],
    portfolios: portfolioEngine,
    paperTrading: paperEngine,
    traderPnl: pnlTracker,
  });

  const serialized = serializeCheckpoint(checkpoint);
  assert.equal(typeof serialized, "string");

  const restored = deserializeCheckpoint(serialized);
  assert.equal(restored.sessionId, "test-session-123");
  assert.equal(restored.segmentId, "test-session-123-seg-0001");
  assert.equal(restored.segmentIndex, 1);
  assert.equal(restored.cursor.collectorSequence, seq);
  assert.equal(restored.cursor.slot, 105);
  assert.equal(restored.datasetCounts.trades, 5);
  assert.equal(restored.lastCommittedChunkIndex, 3);
  assert.deepEqual(restored.recentEventIds, ["ev-1", "ev-2", "ev-3"]);

  // Portfolios state preserved
  assert.ok(restored.portfolios.accounts.length > 0);
  assert.ok(restored.portfolios.tokens.length > 0);
  const alphaToken = restored.portfolios.tokens.find((t) => t.mint === "token-alpha");
  assert.ok(alphaToken);
  assert.equal(alphaToken.trades, 5);
});

test("Continuity: Segment 1 -> Checkpoint -> Segment 2 matches Monolithic execution exactly", () => {
  const events: NormalizedMarketEvent[] = [];
  let seq = 0;
  const pushEv = (ev: NormalizedMarketEvent) => {
    seq += 1;
    const withSeq = { ...ev, ordering: { ...ev.ordering, collectorSequence: seq } };
    events.push(withSeq);
  };

  // Launch A and B
  pushEv(createMockLaunch("token-A"));
  pushEv(createMockLaunch("token-B"));

  // Trades on A: cross 50 SOL (triggers entry)
  for (let i = 0; i < 5; i++) {
    pushEv(
      createMockTrade({
        mint: "token-A",
        side: "buy",
        realSolLamports: BigInt(10 + i * 10) * SOL,
        timeMs: 2000 + i * 1000,
        slot: 200 + i,
      })
    );
  }
  // Cross 50 SOL threshold on A
  pushEv(
    createMockTrade({
      mint: "token-A",
      side: "buy",
      realSolLamports: 52n * SOL,
      timeMs: 8000,
      slot: 210,
    })
  );

  // Trades on B: cross 50 SOL
  for (let i = 0; i < 5; i++) {
    pushEv(
      createMockTrade({
        mint: "token-B",
        side: "buy",
        realSolLamports: BigInt(10 + i * 10) * SOL,
        timeMs: 3000 + i * 1000,
        slot: 220 + i,
      })
    );
  }
  pushEv(
    createMockTrade({
      mint: "token-B",
      side: "buy",
      realSolLamports: 55n * SOL,
      timeMs: 9000,
      slot: 230,
    })
  );

  // --- Monolithic Execution ---
  const monoPortfolios = new MultiPortfolioEngine();
  const monoPaper = new PaperTradingEngine();
  const monoPnl = new TraderPnlTracker();

  for (const ev of events) {
    monoPortfolios.onEvent(ev);
    if (ev.eventType === "launch") {
      monoPaper.onLaunch(ev);
      monoPnl.onLaunch(ev);
    } else if (ev.eventType === "trade") {
      monoPaper.onTrade(ev);
      monoPnl.onTrade(ev);
    }
  }

  // --- Segmented Execution ---
  // Segment 1 processes first half of events (up to index 8)
  const splitIndex = 8;
  const seg1Portfolios = new MultiPortfolioEngine();
  const seg1Paper = new PaperTradingEngine();
  const seg1Pnl = new TraderPnlTracker();

  for (let i = 0; i < splitIndex; i++) {
    const ev = events[i]!;
    seg1Portfolios.onEvent(ev);
    if (ev.eventType === "launch") {
      seg1Paper.onLaunch(ev);
      seg1Pnl.onLaunch(ev);
    } else if (ev.eventType === "trade") {
      seg1Paper.onTrade(ev);
      seg1Pnl.onTrade(ev);
    }
  }

  // Create checkpoint at boundary
  const checkpoint = createCheckpointFromEngines({
    sessionId: "segmented-run",
    segmentId: "segmented-run-seg-0001",
    segmentIndex: 1,
    cursor: {
      collectorSequence: splitIndex,
      transactionLogIndex: 0,
      lastEventTimestampMs: 8000,
    },
    recentEventIds: events.slice(0, splitIndex).map((e) => e.eventId),
    datasetCounts: {
      rawNotifications: splitIndex,
      normalizedEvents: splitIndex,
      launches: 2,
      trades: splitIndex - 2,
      duplicateEvents: 0,
      malformedPumpEvents: 0,
      invalidRpcMessages: 0,
      failedTransactions: 0,
      disconnects: 0,
    },
    lastCommittedChunkIndex: 1,
    totalCompressedBytes: 5000,
    completedChunks: [],
    completedDiagnosticChunks: [],
    portfolios: seg1Portfolios,
    paperTrading: seg1Paper,
    traderPnl: seg1Pnl,
  });

  const serializedCheckpoint = serializeCheckpoint(checkpoint);

  // Segment 2: Fresh engines restored from checkpoint
  const seg2Portfolios = new MultiPortfolioEngine();
  const seg2Paper = new PaperTradingEngine();
  const seg2Pnl = new TraderPnlTracker();

  const restoredCheckpoint = deserializeCheckpoint(serializedCheckpoint);
  restoreEnginesFromCheckpoint(restoredCheckpoint, {
    portfolios: seg2Portfolios,
    paperTrading: seg2Paper,
    traderPnl: seg2Pnl,
  });

  // Segment 2 processes remaining events
  for (let i = splitIndex; i < events.length; i++) {
    const ev = events[i]!;
    seg2Portfolios.onEvent(ev);
    if (ev.eventType === "launch") {
      seg2Paper.onLaunch(ev);
      seg2Pnl.onLaunch(ev);
    } else if (ev.eventType === "trade") {
      seg2Paper.onTrade(ev);
      seg2Pnl.onTrade(ev);
    }
  }

  // End session on both
  monoPortfolios.onSessionEnd();
  monoPaper.onSessionEnd(10000);
  seg2Portfolios.onSessionEnd();
  seg2Paper.onSessionEnd(10000);

  // Assert exact equality between Monolithic and Segmented
  const monoSummary = monoPortfolios.summary();
  const seg2Summary = seg2Portfolios.summary();

  assert.equal(seg2Summary.portfolios.length, monoSummary.portfolios.length);
  for (let i = 0; i < monoSummary.portfolios.length; i++) {
    const monoP = monoSummary.portfolios[i]!;
    const segP = seg2Summary.portfolios[i]!;
    assert.equal(segP.id, monoP.id);
    assert.equal(segP.cashSol, monoP.cashSol, `Cash mismatch on ${monoP.id}`);
    assert.equal(segP.equitySol, monoP.equitySol, `Equity mismatch on ${monoP.id}`);
    assert.equal(segP.entries, monoP.entries, `Entries mismatch on ${monoP.id}`);
    assert.equal(segP.trades, monoP.trades, `Trades mismatch on ${monoP.id}`);
    assert.equal(segP.netPnlSol, monoP.netPnlSol, `Net PnL mismatch on ${monoP.id}`);
  }

  assert.deepEqual(seg2Paper.exportSummary(), monoPaper.exportSummary());
});

test("Dedup: Overlapping events across segment boundaries are filtered without double-counting", () => {
  const seenEventIds = new Set<string>();
  const engine = new MultiPortfolioEngine();
  let seq = 0;

  const launch = createMockLaunch("token-dedup");
  (launch.ordering as { collectorSequence: number }).collectorSequence = ++seq;
  seenEventIds.add(launch.eventId);
  engine.onEvent(launch);

  const trade1 = createMockTrade({
    mint: "token-dedup",
    side: "buy",
    realSolLamports: 20n * SOL,
    timeMs: 2000,
    slot: 300,
  });
  (trade1.ordering as { collectorSequence: number }).collectorSequence = ++seq;
  seenEventIds.add(trade1.eventId);
  engine.onEvent(trade1);

  // Boundary overlap: trade1 arrives again in Segment 2
  let duplicates = 0;
  const trade2 = createMockTrade({
    mint: "token-dedup",
    side: "buy",
    realSolLamports: 40n * SOL,
    timeMs: 3000,
    slot: 301,
  });
  (trade2.ordering as { collectorSequence: number }).collectorSequence = ++seq;

  const eventsInSegment2 = [trade1, trade2];

  for (const ev of eventsInSegment2) {
    if (seenEventIds.has(ev.eventId)) {
      duplicates += 1;
      continue;
    }
    seenEventIds.add(ev.eventId);
    engine.onEvent(ev);
  }

  assert.equal(duplicates, 1);
  const summary = engine.summary();
  assert.ok(summary.portfolios.length > 0);
});

test("Data Diet: Event-only equity sampling prevents inflation from passive trades", () => {
  const engine = new MultiPortfolioEngine();
  let seq = 0;
  const launch = createMockLaunch("token-sample");
  (launch.ordering as { collectorSequence: number }).collectorSequence = ++seq;
  engine.onEvent(launch);

  // 10 passive trades on another token
  for (let i = 0; i < 10; i++) {
    const trade = createMockTrade({
      mint: "other-token",
      side: "buy",
      realSolLamports: BigInt(i + 1) * SOL,
      timeMs: 1000 + i * 1000,
      slot: 400 + i,
    });
    (trade.ordering as { collectorSequence: number }).collectorSequence = ++seq;
    engine.onEvent(trade);
  }

  const account = engine.summary().portfolios[0]!;
  // Zero entries have happened, so equity curve should contain only initial point, not 10 points!
  assert.ok(account.equityCurve.length <= 2, `Equity curve has ${account.equityCurve.length} points, expected <= 2`);
});

test("Storage Diet: CloudResearchSink rotates chunks without updating manifest.json", async () => {
  const uploadedFiles: string[] = [];
  const mockUploader: CloudStorageUploader = {
    async uploadBuffer(gcsPath) {
      uploadedFiles.push(gcsPath);
      await Promise.resolve();
    },
  };

  const sink = new CloudResearchSink({
    directory: "/tmp/diet-test",
    sessionId: "diet-test",
    transport: "solana-rpc-websocket",
    endpointLabel: "test",
    commitment: "processed",
    programId: "pump",
    parsingVersion: "v1",
    officialIdlRevision: "rev1",
    uploader: mockUploader,
    chunkMaxRecords: 3,
  });

  // Write enough events to trigger at least one automatic rotation
  for (let i = 0; i < 6; i++) {
    const trade = createMockTrade({
      mint: "token-diet",
      side: "buy",
      realSolLamports: BigInt(i + 1) * SOL,
      timeMs: 1000 + i * 1000,
      slot: 500 + i,
    });
    (trade.ordering as { collectorSequence: number }).collectorSequence = i + 1;

    await sink.recordRaw({
      raw: {
        schemaVersion: 1,
        kind: "solana.logs-notification",
        sequence: i + 1,
        source: {
          transport: "solana-rpc-websocket",
          programId: "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
          commitment: "processed",
          endpointLabel: "test",
        },
        capture: {
          receivedAtUnixMs: Date.now() + i * 100,
          receivedAtIso: new Date().toISOString(),
          receivedMonotonicNs: "1000",
          parseCompletedAtUnixMs: Date.now(),
          parseDurationNs: "100",
          rpcProviderReceivedAtUnixMs: null,
        },
        rpcPayload: { signature: `sig-${i}`, logMessages: ["Instruction: Trade"] },
      },
      events: [trade],
      parseFailures: [],
      invalidNotification: null,
      transactionFailed: false,
    });
  }

  // Verify that chunks and chunk metadata were uploaded, but manifest.json was NOT uploaded during rotation
  const manifestUploads = uploadedFiles.filter((f) => f.endsWith("manifest.json"));
  assert.equal(
    manifestUploads.length,
    0,
    "manifest.json must NOT be updated during chunk rotation (Data Diet)"
  );

  const chunkMetaUploads = uploadedFiles.filter((f) => f.includes(".meta.json"));
  assert.ok(
    chunkMetaUploads.length > 0,
    "Immutable chunk .meta.json MUST be uploaded on rotation"
  );

  // Close session -> only now should manifest be synced
  await sink.close("complete");
  const finalManifestUploads = uploadedFiles.filter((f) => f.endsWith("manifest.json"));
  assert.equal(
    finalManifestUploads.length,
    1,
    "manifest.json should only be synced once at session completion"
  );
});
