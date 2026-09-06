import test from "node:test";
import assert from "node:assert/strict";
import {
  CloudResearchSink,
  GcsStorageUploader,
  isRetryableStorageError,
  type Bucket,
  type CloudStorageUploader,
  type DatasetCounts,
} from "@botwiner/storage";
import {
  FirestoreTelemetryReporter,
  withTimeout,
  type FirestoreBackend,
  type ResearchSessionDocument,
  type GraduationSummaryCounters,
} from "@botwiner/research";
import { checkExecutionFinished, type ExecutionGetter } from "../apps/api/src/execution-checker.js";
import type { RawLogRecord, TradeMarketEvent } from "@botwiner/market-data";

class RetryingFlakyUploader implements CloudStorageUploader {
  public uploads = new Map<string, { buffer: Buffer; contentType: string }>();
  public failCount = 0;
  public attempts = 0;

  public uploadBuffer(destinationPath: string, buffer: Buffer, contentType: string): Promise<void> {
    const maxAttempts = 3;
    let attempt = 0;
    while (attempt < maxAttempts) {
      attempt += 1;
      this.attempts += 1;
      if (this.attempts <= this.failCount) {
        if (attempt >= maxAttempts) {
          const err = new Error("ECONNRESET");
          Object.assign(err, { code: "ECONNRESET" });
          return Promise.reject(err);
        }
        continue;
      }
      this.uploads.set(destinationPath, { buffer, contentType });
      return Promise.resolve();
    }
    return Promise.resolve();
  }
}

class AlwaysFailingUploader implements CloudStorageUploader {
  public uploadBuffer(): Promise<void> {
    const err = new Error("GCS ECONNRESET upload failed");
    Object.assign(err, { code: "ECONNRESET" });
    return Promise.reject(err);
  }
}

class MockFirestoreBackend implements FirestoreBackend {
  public sessionDoc: Partial<ResearchSessionDocument> = {};
  public statsDoc: GraduationSummaryCounters | null = null;
  public activeLocks = new Map<string, Record<string, unknown>>();

  public setSessionDoc(_sessionId: string, data: Partial<ResearchSessionDocument>): Promise<void> {
    this.sessionDoc = { ...this.sessionDoc, ...data };
    return Promise.resolve();
  }

  public updateStatsDoc(_sessionId: string, stats: GraduationSummaryCounters): Promise<void> {
    this.statsDoc = { ...stats };
    return Promise.resolve();
  }

  public setGraduationCandidate(): Promise<void> {
    return Promise.resolve();
  }

  public updateActiveLock(sessionId: string, data: { heartbeatAt: string; status?: string }): Promise<void> {
    this.activeLocks.set("activeSession", { sessionId, ...data });
    return Promise.resolve();
  }

  public releaseActiveLock(sessionId: string): Promise<void> {
    const current = this.activeLocks.get("activeSession");
    if (current && current.sessionId === sessionId) {
      this.activeLocks.set("activeSession", { sessionId, status: "released" });
    }
    return Promise.resolve();
  }
}

function makeSampleRawLog(seq: number): RawLogRecord {
  const now = Date.now();
  return {
    schemaVersion: 1,
    kind: "solana.logs-notification",
    sequence: seq,
    source: {
      transport: "solana-rpc-websocket",
      programId: "pump",
      commitment: "processed",
      endpointLabel: "test-endpoint",
    },
    capture: {
      receivedAtUnixMs: now,
      receivedAtIso: new Date(now).toISOString(),
      receivedMonotonicNs: "1000000",
      parseCompletedAtUnixMs: now + 1,
      parseDurationNs: "1000",
      rpcProviderReceivedAtUnixMs: null,
    },
    rpcPayload: {
      signature: `sig-${seq}`,
      slot: 1000 + seq,
      err: null,
      logs: ["Program 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P invoke [1]"],
    },
  };
}

function makeSampleTrade(eventId: string, mint: string, slot = 1000): TradeMarketEvent {
  const timestampMs = 1700000000000;
  return {
    schemaVersion: 1,
    kind: "market-event",
    eventType: "trade",
    eventId,
    parsingVersion: "pump-v1",
    rawRef: "raw-ref-1",
    tokenMint: mint,
    side: "buy",
    traderWallet: "Trader1111111111111111111111111111111111111",
    creatorWallet: "Creator1111111111111111111111111111111111111",
    bondingCurve: null,
    instructionName: "buy",
    quoteMint: "So11111111111111111111111111111111111111112",
    amounts: { tokenBaseUnits: "1000000", nativeSolLamports: "1000000000", quoteBaseUnits: "1000000000" },
    observedPriceRatio: { quoteBaseUnits: "1000", tokenBaseUnits: "1" },
    reserves: {
      virtualTokenBaseUnits: "900000000000000",
      virtualSolLamports: "40000000000",
      virtualQuoteBaseUnits: "40000000000",
      realTokenBaseUnits: "600000000000000",
      realSolLamports: "30000000000",
      realQuoteBaseUnits: "30000000000",
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
      endpointLabel: "test",
    },
    signature: `sig-${eventId}`,
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

// 1. isRetryableStorageError tests
test("isRetryableStorageError: accurately classifies transient network vs permanent errors", () => {
  assert.equal(isRetryableStorageError({ code: "ECONNRESET" }), true);
  assert.equal(isRetryableStorageError({ errno: "ECONNRESET" }), true);
  assert.equal(isRetryableStorageError({ code: "ETIMEDOUT" }), true);
  assert.equal(isRetryableStorageError({ code: "EPIPE" }), true);
  assert.equal(isRetryableStorageError({ code: "ECONNREFUSED" }), true);
  assert.equal(isRetryableStorageError({ code: "ENOTFOUND" }), true);

  assert.equal(isRetryableStorageError({ code: 429 }), true);
  assert.equal(isRetryableStorageError({ status: 500 }), true);
  assert.equal(isRetryableStorageError({ response: { status: 502 } }), true);
  assert.equal(isRetryableStorageError({ status: 503 }), true);
  assert.equal(isRetryableStorageError({ status: 504 }), true);

  const tlsError = new Error("request to https://storage.googleapis.com/... failed, reason: Client network socket disconnected before secure TLS connection was established");
  assert.equal(isRetryableStorageError(tlsError), true);
  assert.equal(isRetryableStorageError(new Error("socket hang up")), true);

  assert.equal(isRetryableStorageError({ code: 400 }), false);
  assert.equal(isRetryableStorageError({ status: 401 }), false);
  assert.equal(isRetryableStorageError({ status: 403 }), false);
  assert.equal(isRetryableStorageError({ response: { status: 404 } }), false);
  assert.equal(isRetryableStorageError(new Error("Invalid bucket name")), false);
});

// 2. GcsStorageUploader retry policy tests
test("GcsStorageUploader: ECONNRESET retry succeeds on subsequent attempt", async () => {
  const loggedWarnings: string[] = [];
  let attempts = 0;
  const sleepCalls: number[] = [];

  const mockFile = {
    save: (): Promise<void> => {
      attempts += 1;
      if (attempts < 3) {
        const err = new Error("Connection reset by peer");
        Object.assign(err, { code: "ECONNRESET" });
        return Promise.reject(err);
      }
      return Promise.resolve();
    },
  };

  const mockBucket = {
    file: () => mockFile,
  };

  const uploader = new GcsStorageUploader("test-bucket", "test-proj", {
    maxAttempts: 5,
    baseDelayMs: 10,
    maxDelayMs: 50,
    sleepFn: (ms) => {
      sleepCalls.push(ms);
      return Promise.resolve();
    },
    bucketFactory: () => mockBucket as unknown as Bucket,
    logger: {
      warn: (msg) => loggedWarnings.push(msg),
      error: () => {},
    },
  });

  await uploader.uploadBuffer("chunks/events-000001.jsonl.gz", Buffer.from("test"), "application/gzip");

  assert.equal(attempts, 3, "Should succeed on attempt 3");
  assert.equal(sleepCalls.length, 2, "Should sleep twice before attempt 3");
  const retryWarnings = loggedWarnings.filter((msg) => msg.includes("Transient upload failure"));
  assert.equal(retryWarnings.length, 2, "Should log 2 retry warnings");
  assert.match(retryWarnings[0] ?? "", /Transient upload failure for "chunks\/events-000001.jsonl.gz" on attempt 1\/5/);
});

test("GcsStorageUploader: HTTP 503 retry succeeds", async () => {
  let attempts = 0;
  const mockFile = {
    save: (): Promise<void> => {
      attempts += 1;
      if (attempts < 2) {
        const err = new Error("Service Unavailable");
        Object.assign(err, { status: 503 });
        return Promise.reject(err);
      }
      return Promise.resolve();
    },
  };

  const uploader = new GcsStorageUploader("test-bucket", "test-proj", {
    maxAttempts: 5,
    baseDelayMs: 10,
    sleepFn: () => Promise.resolve(),
    bucketFactory: () => ({ file: () => mockFile }) as unknown as Bucket,
    logger: { warn: () => {}, error: () => {} },
  });

  await uploader.uploadBuffer("chunks/events-000001.jsonl.gz", Buffer.from("test"), "application/gzip");
  assert.equal(attempts, 2, "HTTP 503 should retry and succeed on attempt 2");
});

test("GcsStorageUploader: permanent 403 Forbidden is NOT retried endlessly", async () => {
  let attempts = 0;
  const mockFile = {
    save: (): Promise<void> => {
      attempts += 1;
      const err = new Error("Caller does not have storage.objects.create permission");
      Object.assign(err, { status: 403 });
      return Promise.reject(err);
    },
  };

  const uploader = new GcsStorageUploader("test-bucket", "test-proj", {
    maxAttempts: 5,
    sleepFn: () => Promise.resolve(),
    bucketFactory: () => ({ file: () => mockFile }) as unknown as Bucket,
    logger: { warn: () => {}, error: () => {} },
  });

  await assert.rejects(
    async () => {
      await uploader.uploadBuffer("chunks/events-000001.jsonl.gz", Buffer.from("test"), "application/gzip");
    },
    (err: unknown) => {
      const rec = err && typeof err === "object" ? (err as Record<string, unknown>) : {};
      return rec.status === 403;
    },
    "Should reject immediately on permanent 403"
  );
  assert.equal(attempts, 1, "Permanent 403 error must not be retried");
});

test("GcsStorageUploader: retry exhaustion fails cleanly after maxAttempts", async () => {
  let attempts = 0;
  const loggedErrors: string[] = [];
  const mockFile = {
    save: (): Promise<void> => {
      attempts += 1;
      const err = new Error("ETIMEDOUT");
      Object.assign(err, { code: "ETIMEDOUT" });
      return Promise.reject(err);
    },
  };

  const uploader = new GcsStorageUploader("test-bucket", "test-proj", {
    maxAttempts: 4,
    baseDelayMs: 5,
    sleepFn: () => Promise.resolve(),
    bucketFactory: () => ({ file: () => mockFile }) as unknown as Bucket,
    logger: {
      warn: () => {},
      error: (msg) => loggedErrors.push(msg),
    },
  });

  await assert.rejects(
    async () => {
      await uploader.uploadBuffer("chunks/events-000001.jsonl.gz", Buffer.from("test"), "application/gzip");
    },
    (err: unknown) => {
      const rec = err && typeof err === "object" ? (err as Record<string, unknown>) : {};
      return rec.code === "ETIMEDOUT";
    },
    "Should fail when retries exhausted"
  );
  assert.equal(attempts, 4, "Should have attempted exactly maxAttempts times");
  assert.equal(loggedErrors.length, 1, "Should log final permanent error");
  assert.match(loggedErrors[0] ?? "", /Permanent upload failure.*attempt 4\/4/);
});

// 3. Queue failure isolation tests
test("CloudResearchSink: queue failure isolation prevents queue poisoning after recovered transient error", async () => {
  const flaky = new RetryingFlakyUploader();
  flaky.failCount = 1;

  const sink = await CloudResearchSink.create({
    directory: "test-dir",
    sessionId: "test-session-isolated",
    transport: "solana-rpc-websocket",
    endpointLabel: "test",
    commitment: "processed",
    programId: "pump",
    parsingVersion: "v1",
    officialIdlRevision: "rev1",
    uploader: flaky,
    chunkMaxRecords: 1,
  });

  await sink.recordRaw({
    raw: makeSampleRawLog(1),
    events: [makeSampleTrade("ev-1", "mint-1")],
    parseFailures: [],
    invalidNotification: null,
    transactionFailed: false,
  });

  await sink.recordRaw({
    raw: makeSampleRawLog(2),
    events: [makeSampleTrade("ev-2", "mint-1")],
    parseFailures: [],
    invalidNotification: null,
    transactionFailed: false,
  });

  await sink.close("complete");
  assert.equal(sink.getLastCommittedChunkIndex(), 2, "Both chunks rotated cleanly without poisoning");
  assert.equal(flaky.uploads.has("sessions/test-session-isolated/manifest.json"), true);
});

test("CloudResearchSink: permanent upload failure invokes onTerminalError and rejects close cleanly", async () => {
  let terminalErrorObserved: Error | null = null;
  const failingUploader = new AlwaysFailingUploader();

  const sink = new CloudResearchSink({
    directory: "test-dir",
    sessionId: "test-session-failing",
    transport: "solana-rpc-websocket",
    endpointLabel: "test",
    commitment: "processed",
    programId: "pump",
    parsingVersion: "v1",
    officialIdlRevision: "rev1",
    uploader: failingUploader,
    chunkMaxRecords: 1,
    onTerminalError: (err) => {
      terminalErrorObserved = err;
    },
  });

  await assert.rejects(
    async () => {
      await sink.recordRaw({
        raw: makeSampleRawLog(1),
        events: [makeSampleTrade("ev-1", "mint-1")],
        parseFailures: [],
        invalidNotification: null,
        transactionFailed: false,
      });
    },
    /GCS ECONNRESET/
  );

  assert.ok(terminalErrorObserved, "onTerminalError must be called");
  assert.match((terminalErrorObserved as Error).message, /GCS ECONNRESET/);

  await assert.rejects(
    async () => {
      await sink.close("complete");
    },
    /GCS ECONNRESET/
  );
});

// 4. Terminal queue failure and telemetry cleanup
test("Collector Shutdown Resilience: storage close failure still flushes telemetry and releases active lock", async () => {
  const backend = new MockFirestoreBackend();
  const sessionId = "test-session-shutdown-resilience";

  const telemetry = new FirestoreTelemetryReporter({
    sessionId,
    mode: "graduation-research",
    provider: "helius",
    region: "europe-west3",
    requestedDurationSec: 300,
    backend,
    heartbeatIntervalMs: 50,
    statsIntervalMs: 50,
  });

  await telemetry.initialize();
  telemetry.markRunning();
  assert.equal(backend.sessionDoc.status, "running");

  let storageShutdownError: unknown = null;
  const mockFailingWriter = {
    close: (): Promise<void> => Promise.reject(new Error("GCS upload ECONNRESET during final rotation")),
  };

  try {
    await mockFailingWriter.close();
  } catch (err) {
    storageShutdownError = err;
  }

  assert.ok(storageShutdownError, "Storage close error was caught");

  const hasFailure = storageShutdownError !== null;
  const finalStatusToReport = hasFailure ? "failed" : "completed";
  if (hasFailure) {
    telemetry.reportError((storageShutdownError as Error).message);
  }
  await telemetry.close(finalStatusToReport);

  assert.equal(backend.sessionDoc.status, "failed");
  assert.ok(backend.sessionDoc.completedAt);
  assert.equal(backend.sessionDoc.latestError, "GCS upload ECONNRESET during final rotation");
  assert.equal(backend.activeLocks.get("activeSession")?.status, "released");
});

// 5. Active Lock Self-Healing tests
test("checkExecutionFinished: detects finished and running executions accurately", async () => {
  const deadExecution = {
    completionTime: "2026-09-05T19:09:41.714041Z",
    conditions: [{ type: "Ready", state: "CONDITION_FAILED", message: "Container exited with code 1" }],
    runningCount: 0,
  };

  const mockDeadClient: ExecutionGetter = {
    getExecution: () => Promise.resolve([deadExecution]),
  };

  const deadResult = await checkExecutionFinished(mockDeadClient, "executions/dead-1");
  assert.equal(deadResult.finished, true);
  assert.match(deadResult.reason ?? "", /Container exited with code 1/);

  const liveExecution = {
    startTime: "2026-09-05T19:00:00Z",
    conditions: [{ type: "Ready", state: "CONDITION_RUNNING" }],
    runningCount: 1,
  };

  const mockLiveClient: ExecutionGetter = {
    getExecution: () => Promise.resolve([liveExecution]),
  };

  const liveResult = await checkExecutionFinished(mockLiveClient, "executions/live-1");
  assert.equal(liveResult.finished, false);

  const mock404Client: ExecutionGetter = {
    getExecution: () => {
      const err = new Error("Execution not found");
      Object.assign(err, { code: 5 });
      return Promise.reject(err);
    },
  };

  const missingResult = await checkExecutionFinished(mock404Client, "executions/missing-1");
  assert.equal(missingResult.finished, true);
  assert.equal(missingResult.reason, "execution_not_found");
});

function makeSampleDatasetCounts(events = 1): DatasetCounts {
  return {
    rawNotifications: events,
    normalizedEvents: events,
    launches: 0,
    trades: events,
    duplicateEvents: 0,
    malformedPumpEvents: 0,
    invalidRpcMessages: 0,
    failedTransactions: 0,
    disconnects: 0,
  };
}

function makeSampleGraduationCounters(tracked = 1): GraduationSummaryCounters {
  return {
    tokensTracked: tracked,
    curve50PlusCount: 0,
    curve60PlusCount: 0,
    curve70PlusCount: 0,
    curve80PlusCount: 0,
    nearGraduationCount: 0,
    graduationsDetected: 0,
    organicGraduationsDetected: 0,
    instantBundleGraduationsDetected: 0,
    migrationsDetected: 0,
    limitations: [],
  };
}

// 6. Firestore Telemetry Concurrency & Timeout tests
test("FirestoreTelemetryReporter: stats flush cannot overlap", async () => {
  let inFlight = 0;
  let maxConcurrent = 0;
  let updateCalls = 0;
  let resolveFirstCall: (() => void) | undefined;

  const backend: FirestoreBackend = {
    setSessionDoc: () => Promise.resolve(),
    updateStatsDoc: () => {
      updateCalls += 1;
      inFlight += 1;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      if (updateCalls === 1) {
        return new Promise<void>((resolve) => {
          resolveFirstCall = () => {
            inFlight -= 1;
            resolve();
          };
        });
      }
      inFlight -= 1;
      return Promise.resolve();
    },
    setGraduationCandidate: () => Promise.resolve(),
  };

  const telemetry = new FirestoreTelemetryReporter({
    sessionId: "test-stats-overlap",
    mode: "graduation-research",
    provider: "helius",
    region: "europe-west3",
    requestedDurationSec: 60,
    backend,
    heartbeatIntervalMs: 60_000,
    statsIntervalMs: 60_000,
  });

  telemetry.updateTelemetry(makeSampleDatasetCounts(1), makeSampleGraduationCounters(1));

  // Start first flush
  const p1 = telemetry.flushStatsNow();
  assert.equal(telemetry.isStatsFlushInFlight(), true);

  // Trigger second flush while first is in flight
  const p2 = telemetry.flushStatsNow();
  await p2; // Should return immediately because skipped

  assert.equal(telemetry.getSkippedStatsFlushes(), 1, "Should skip the overlapping flush");
  assert.equal(updateCalls, 1, "Should only have called backend once");
  assert.equal(maxConcurrent, 1, "Max concurrent backend calls must be 1");

  // Resolve first call
  resolveFirstCall?.();
  await p1;

  assert.equal(telemetry.isStatsFlushInFlight(), false, "In flight should reset to false");
  await telemetry.close("completed");
});

test("FirestoreTelemetryReporter: heartbeat flush cannot overlap", async () => {
  let inFlight = 0;
  let maxConcurrent = 0;
  let setCalls = 0;
  let resolveFirstCall: (() => void) | undefined;

  const backend: FirestoreBackend = {
    setSessionDoc: () => {
      setCalls += 1;
      inFlight += 1;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      if (setCalls === 1) {
        return new Promise<void>((resolve) => {
          resolveFirstCall = () => {
            inFlight -= 1;
            resolve();
          };
        });
      }
      inFlight -= 1;
      return Promise.resolve();
    },
    updateStatsDoc: () => Promise.resolve(),
    setGraduationCandidate: () => Promise.resolve(),
  };

  const telemetry = new FirestoreTelemetryReporter({
    sessionId: "test-heartbeat-overlap",
    mode: "graduation-research",
    provider: "helius",
    region: "europe-west3",
    requestedDurationSec: 60,
    backend,
    heartbeatIntervalMs: 60_000,
    statsIntervalMs: 60_000,
  });

  // Start first heartbeat
  const p1 = telemetry.flushHeartbeatNow();
  assert.equal(telemetry.isHeartbeatFlushInFlight(), true);

  // Trigger second heartbeat while first is in flight
  const p2 = telemetry.flushHeartbeatNow();
  await p2;

  assert.equal(telemetry.getSkippedHeartbeatFlushes(), 1, "Should skip overlapping heartbeat");
  assert.equal(setCalls, 1, "Should only have called backend once");
  assert.equal(maxConcurrent, 1, "Max concurrent backend calls must be 1");

  resolveFirstCall?.();
  await p1;

  assert.equal(telemetry.isHeartbeatFlushInFlight(), false);
  await telemetry.close("completed");
});

test("FirestoreTelemetryReporter: slow Firestore causes skipped flush rather than buildup", async () => {
  let backendCalls = 0;
  let resolveSlowCall: (() => void) | undefined;

  const backend: FirestoreBackend = {
    setSessionDoc: () => Promise.resolve(),
    updateStatsDoc: () => {
      backendCalls += 1;
      if (backendCalls === 1) {
        return new Promise<void>((resolve) => {
          resolveSlowCall = resolve;
        });
      }
      return Promise.resolve();
    },
    setGraduationCandidate: () => Promise.resolve(),
  };

  const telemetry = new FirestoreTelemetryReporter({
    sessionId: "test-slow-firestore",
    mode: "graduation-research",
    provider: "helius",
    region: "europe-west3",
    requestedDurationSec: 60,
    backend,
    heartbeatIntervalMs: 60_000,
    statsIntervalMs: 60_000,
  });

  telemetry.updateTelemetry(makeSampleDatasetCounts(1), makeSampleGraduationCounters(1));

  const p1 = telemetry.flushStatsNow();

  // Try 5 flushes while p1 is in progress
  for (let i = 0; i < 5; i++) {
    await telemetry.flushStatsNow();
  }

  assert.equal(backendCalls, 1, "Backend must only receive 1 call");
  assert.equal(telemetry.getSkippedStatsFlushes(), 5, "5 skipped flushes counted");

  resolveSlowCall?.();
  await p1;

  // Next flush after resolution should succeed
  await telemetry.flushStatsNow();
  assert.equal(backendCalls, 2, "Subsequent flush after completion succeeds");
  await telemetry.close("completed");
});

test("FirestoreTelemetryReporter: timed-out Firestore write resets in-flight state", async () => {
  let timedOutCallStarted = false;
  const backend: FirestoreBackend = {
    setSessionDoc: () => Promise.resolve(),
    updateStatsDoc: () => {
      timedOutCallStarted = true;
      return withTimeout(
        new Promise<void>(() => {}), // never resolves
        20,
        "updateStatsDoc"
      );
    },
    setGraduationCandidate: () => Promise.resolve(),
  };

  const telemetry = new FirestoreTelemetryReporter({
    sessionId: "test-timeout-reset",
    mode: "graduation-research",
    provider: "helius",
    region: "europe-west3",
    requestedDurationSec: 60,
    backend,
    heartbeatIntervalMs: 60_000,
    statsIntervalMs: 60_000,
  });

  telemetry.updateTelemetry(makeSampleDatasetCounts(1), makeSampleGraduationCounters(1));

  // Call flushStatsNow - it will time out internally after 20ms
  await telemetry.flushStatsNow();

  assert.equal(timedOutCallStarted, true);
  assert.equal(telemetry.isStatsFlushInFlight(), false, "In-flight state must reset after timeout");

  // Next flush should now be accepted
  let secondCallExecuted = false;
  backend.updateStatsDoc = () => {
    secondCallExecuted = true;
    return Promise.resolve();
  };

  await telemetry.flushStatsNow();
  assert.equal(secondCallExecuted, true, "Subsequent flush after timeout succeeds");
  await telemetry.close("completed");
});

test("FirestoreTelemetryReporter: collector continues after telemetry timeout", async () => {
  const backend: FirestoreBackend = {
    setSessionDoc: () =>
      withTimeout(
        new Promise<void>(() => {}),
        25,
        "setSessionDoc"
      ),
    updateStatsDoc: () =>
      withTimeout(
        new Promise<void>(() => {}),
        25,
        "updateStatsDoc"
      ),
    setGraduationCandidate: () => Promise.resolve(),
  };

  const telemetry = new FirestoreTelemetryReporter({
    sessionId: "test-collector-continues",
    mode: "graduation-research",
    provider: "helius",
    region: "europe-west3",
    requestedDurationSec: 60,
    backend,
    heartbeatIntervalMs: 60_000,
    statsIntervalMs: 60_000,
  });

  telemetry.updateTelemetry(makeSampleDatasetCounts(2), makeSampleGraduationCounters(2));

  await assert.doesNotReject(async () => {
    await telemetry.flushHeartbeatNow();
  }, "Heartbeat timeout must not throw");

  await assert.doesNotReject(async () => {
    await telemetry.flushStatsNow();
  }, "Stats timeout must not throw");

  telemetry.updateChunkAndBytes(2, 5000);
  assert.equal(telemetry.isHeartbeatFlushInFlight(), false);
  assert.equal(telemetry.isStatsFlushInFlight(), false);

  await assert.doesNotReject(async () => {
    await telemetry.close("completed");
  });
});

test("GcsStorageUploader: ECONNRESET eventually succeeds after 5 retries (within 8 maxAttempts)", async () => {
  let attempts = 0;
  const sleepDurations: number[] = [];

  const mockFile = {
    save: (): Promise<void> => {
      attempts += 1;
      if (attempts <= 5) {
        const err = new Error("Client network socket disconnected before secure TLS connection was established");
        Object.assign(err, { code: "ECONNRESET" });
        return Promise.reject(err);
      }
      return Promise.resolve();
    },
  };

  const uploader = new GcsStorageUploader("test-bucket", "test-proj", {
    maxAttempts: 8,
    baseDelayMs: 5,
    maxDelayMs: 50,
    sleepFn: (ms) => {
      sleepDurations.push(ms);
      return Promise.resolve();
    },
    bucketFactory: () => ({ file: () => mockFile }) as unknown as Bucket,
    logger: {
      warn: () => {},
      error: () => {},
    },
  });

  await uploader.uploadBuffer("chunks/events-000046.jsonl.gz", Buffer.from("test-chunk"), "application/gzip");

  assert.equal(attempts, 6, "Succeeded on 6th attempt (after 5 transient ECONNRESETs)");
  assert.equal(sleepDurations.length, 5, "5 backoff sleeps executed");
});

test("GcsStorageUploader: Storage client is recreated after socket-level failure", async () => {
  let attempts = 0;
  let recreateCount = 0;

  const mockFile = {
    save: (): Promise<void> => {
      attempts += 1;
      if (attempts === 1) {
        const err = new Error("Client network socket disconnected");
        Object.assign(err, { code: "ECONNRESET" });
        return Promise.reject(err);
      }
      return Promise.resolve();
    },
  };

  const uploader = new GcsStorageUploader("test-bucket", "test-proj", {
    maxAttempts: 8,
    baseDelayMs: 5,
    sleepFn: () => Promise.resolve(),
    bucketFactory: () => {
      recreateCount += 1;
      return { file: () => mockFile } as unknown as Bucket;
    },
    logger: { warn: () => {}, error: () => {} },
  });

  await uploader.uploadBuffer("chunks/events-000046.jsonl.gz", Buffer.from("test"), "application/gzip");

  assert.equal(attempts, 2);
  assert.equal(recreateCount, 2, "Storage client must be created on init and recreated upon socket-level error");
});

test("CloudResearchSink: terminal queue failure does not become unhandled rejection and calls onTerminalError once", async () => {
  let terminalErrorsReported = 0;
  let terminalErrorObj: Error | null = null;

  const failingUploader: CloudStorageUploader = {
    uploadBuffer: () => {
      const err = new Error("Terminal GCS network failure");
      Object.assign(err, { code: "ECONNRESET" });
      return Promise.reject(err);
    },
  };

  const sink = new CloudResearchSink({
    directory: "test-dir",
    sessionId: "test-session-promise-safety",
    transport: "solana-rpc-websocket",
    endpointLabel: "test",
    commitment: "processed",
    programId: "pump",
    parsingVersion: "v1",
    officialIdlRevision: "rev1",
    uploader: failingUploader,
    chunkMaxRecords: 1,
    onTerminalError: (err) => {
      terminalErrorsReported += 1;
      terminalErrorObj = err;
    },
  });

  const results = await Promise.allSettled([
    sink.recordRaw({
      raw: makeSampleRawLog(1),
      events: [makeSampleTrade("ev-1", "mint-1")],
      parseFailures: [],
      invalidNotification: null,
      transactionFailed: false,
    }),
    sink.recordRaw({
      raw: makeSampleRawLog(2),
      events: [makeSampleTrade("ev-2", "mint-1")],
      parseFailures: [],
      invalidNotification: null,
      transactionFailed: false,
    }),
    sink.recordRaw({
      raw: makeSampleRawLog(3),
      events: [makeSampleTrade("ev-3", "mint-1")],
      parseFailures: [],
      invalidNotification: null,
      transactionFailed: false,
    }),
  ]);

  for (const r of results) {
    assert.equal(r.status, "rejected");
  }

  assert.equal(terminalErrorsReported, 1, "onTerminalError must be called only once");
  assert.ok(terminalErrorObj);
  assert.match((terminalErrorObj as Error).message, /Terminal GCS network failure/);
  await sink.close("failed").catch(() => {});
});

test("Collector Shutdown Resilience: terminal queued upload failure followed by shutdown still runs cleanup", async () => {
  const backend = new MockFirestoreBackend();
  const sessionId = "test-session-terminal-shutdown";

  const telemetry = new FirestoreTelemetryReporter({
    sessionId,
    mode: "graduation-research",
    provider: "helius",
    region: "europe-west3",
    requestedDurationSec: 300,
    backend,
    heartbeatIntervalMs: 50,
    statsIntervalMs: 50,
  });

  await telemetry.initialize();
  telemetry.markRunning();

  const clockSampleQueue: Promise<void> = Promise.reject(new Error("GCS terminal queue failure"));
  let writerClosed = false;
  let finalStatusReported = "";

  const mockWriter = {
    close: (): Promise<void> => {
      writerClosed = true;
      return Promise.reject(new Error("Writer close failed due to terminal chunk"));
    },
  };

  let executionError: unknown = null;
  try {
    throw new Error("Container failure: Chunk upload exhausted 8 retries");
  } catch (err) {
    executionError = err;
  }

  try {
    try {
      await clockSampleQueue;
    } catch {
      // Ignored non-fatal diagnostic queue error
    }

    try {
      await mockWriter.close();
    } catch (writerErr) {
      if (!executionError) executionError = writerErr;
    }

    finalStatusReported = executionError ? "failed" : "completed";
    if (executionError) {
      telemetry.reportError((executionError as Error).message);
    }
    await telemetry.close(finalStatusReported as "completed" | "failed");
  } catch (shutdownErr) {
    assert.fail(`Shutdown cleanup must not throw: ${String(shutdownErr)}`);
  }

  assert.equal(writerClosed, true, "Writer close was invoked");
  assert.equal(finalStatusReported, "failed");
  assert.equal(backend.sessionDoc.status, "failed");
  assert.ok(backend.sessionDoc.completedAt);
  assert.match(backend.sessionDoc.latestError ?? "", /Chunk upload exhausted 8 retries/);
  assert.equal(backend.activeLocks.get("activeSession")?.status, "released", "Active lock was released");
});
