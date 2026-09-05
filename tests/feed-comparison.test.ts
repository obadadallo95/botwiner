import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { DiagnosticRecord, RawLogRecord } from "@botwiner/market-data";
import {
  PUMP_IDL_REVISION,
  PUMP_PARSING_VERSION,
  PUMP_PROGRAM_ID,
  normalizeRawLogRecord,
} from "@botwiner/pumpfun";
import {
  CANDIDATE_ENDPOINT_LABEL,
  PUBLIC_ENDPOINT_LABEL,
  analyzeFeedComparison,
  arrivalDeltaMs,
  buildTimingCalibration,
  childExitRequiresAbort,
  firstArrival,
  redactSecret,
  secretAppearsInFiles,
  validateCollectorStartupPair,
  writeFeedComparisonReports,
  type CollectorStartupTuple,
  type ComparisonFeedId,
  type FeedComparisonManifest,
  type TimingCalibration,
} from "@botwiner/research";
import { DatasetWriter } from "@botwiner/storage";
import { createEventData, logsFor, rawRecord, tradeEventData } from "./fixtures/pump-events.js";

const BASE_UNIX_MS = 1_780_000_000_000;

function startup(feedId: ComparisonFeedId, processId: number): CollectorStartupTuple {
  return {
    feedId,
    processId,
    hostFingerprint: "same-host-test",
    wallUnixMs: BASE_UNIX_MS,
    monotonicNs: "1000000000",
    commitment: "processed",
    programId: PUMP_PROGRAM_ID,
    parserVersion: PUMP_PARSING_VERSION,
    idlRevision: PUMP_IDL_REVISION,
    endpointLabel: feedId === "public" ? PUBLIC_ENDPOINT_LABEL : CANDIDATE_ENDPOINT_LABEL,
  };
}

function calibration(feedId: ComparisonFeedId, processId: number): TimingCalibration {
  return {
    calibrationId: `${feedId}-calibration`,
    feedId,
    processId,
    startup: startup(feedId, processId),
    anchor: {
      childMonotonicNs: "0",
      parentMonotonicNs: "0",
      childWallUnixMs: BASE_UNIX_MS,
      parentTimelineWallUnixMs: BASE_UNIX_MS,
    },
    minimumRoundTripNs: "100000",
    uncertaintyNs: "50000",
    wallResidualMs: 0,
    valid: true,
    validation: "valid test calibration",
  };
}

function comparisonManifest(comparisonId: string): FeedComparisonManifest {
  return {
    schemaVersion: 1,
    kind: "feed-comparison-manifest",
    comparisonId,
    status: "complete",
    startedAt: new Date(BASE_UNIX_MS).toISOString(),
    endedAt: new Date(BASE_UNIX_MS + 100_000).toISOString(),
    window: {
      requestedStartUnixMs: BASE_UNIX_MS,
      requestedEndUnixMs: BASE_UNIX_MS + 100_000,
      durationSeconds: 100,
    },
    orchestrator: {
      processId: 100,
      hostFingerprint: "same-host-test",
      wallBaselineUnixMs: BASE_UNIX_MS,
      monotonicBaselineNs: "0",
    },
    controls: {
      commitment: "processed",
      programId: PUMP_PROGRAM_ID,
      parserVersion: PUMP_PARSING_VERSION,
      idlRevision: PUMP_IDL_REVISION,
      tieToleranceMs: 1,
      calibrationMaximumUncertaintyMs: 10,
      calibrationMaximumWallResidualMs: 100,
    },
    feeds: {
      public: { dataset: "public", endpointLabel: PUBLIC_ENDPOINT_LABEL, processId: 101 },
      candidate: { dataset: "candidate", endpointLabel: CANDIDATE_ENDPOINT_LABEL, processId: 102 },
    },
    calibrations: { public: calibration("public", 101), candidate: calibration("candidate", 102) },
    runtimeChecks: {
      bothCollectorsReady: true,
      bothCollectorsCompleted: true,
      apiKeyWasPresent: true,
      apiKeyPersisted: false,
    },
    failure: null,
    limitations: [],
  };
}

function diagnostic(
  code: DiagnosticRecord["code"],
  atUnixMs: number,
  details: Readonly<Record<string, unknown>> = {},
): DiagnosticRecord {
  return {
    schemaVersion: 1,
    kind: "diagnostic",
    code,
    atUnixMs,
    message: code,
    sequence: null,
    details,
  };
}

function comparisonRaw(options: {
  readonly feedId: ComparisonFeedId;
  readonly processId: number;
  readonly sequence: number;
  readonly signature: string;
  readonly monotonicNs: bigint;
  readonly unixMs: number;
  readonly connectionEpoch?: number;
  readonly eventType?: "launch" | "trade";
  readonly malformedPayload?: boolean;
}): RawLogRecord {
  const original = rawRecord({
    sequence: options.sequence,
    signature: options.signature,
    logs: logsFor(options.eventType === "trade" ? tradeEventData() : createEventData()),
  });
  return {
    ...original,
    source: {
      ...original.source,
      endpointLabel: options.feedId === "public" ? PUBLIC_ENDPOINT_LABEL : CANDIDATE_ENDPOINT_LABEL,
      comparison: {
        comparisonId: "comparison-test",
        feedId: options.feedId,
        collectorProcessId: options.processId,
        calibrationId: `${options.feedId}-calibration`,
        connectionEpoch: options.connectionEpoch ?? 0,
      },
    },
    capture: {
      ...original.capture,
      receivedAtUnixMs: options.unixMs,
      receivedAtIso: new Date(options.unixMs).toISOString(),
      receivedMonotonicNs: options.monotonicNs.toString(),
    },
    rpcPayload: options.malformedPayload ? { unexpected: true } : original.rpcPayload,
  };
}

async function writeFeed(
  root: string,
  feedId: ComparisonFeedId,
  records: readonly RawLogRecord[],
  reconnectAtUnixMs: number | null = null,
): Promise<void> {
  const directory = join(root, feedId === "public" ? "public" : "candidate");
  const writer = await DatasetWriter.create({
    directory,
    sessionId: feedId,
    endpointLabel: feedId === "public" ? PUBLIC_ENDPOINT_LABEL : CANDIDATE_ENDPOINT_LABEL,
    commitment: "processed",
    programId: PUMP_PROGRAM_ID,
    parsingVersion: PUMP_PARSING_VERSION,
    officialIdlRevision: PUMP_IDL_REVISION,
  });
  await writer.recordDiagnostic(diagnostic("connection-opened", BASE_UNIX_MS - 10, { connectionEpoch: 0 }));
  await writer.recordDiagnostic(diagnostic("subscription-confirmed", BASE_UNIX_MS, { connectionEpoch: 0 }));
  for (const raw of records) {
    const normalized = normalizeRawLogRecord(raw);
    await writer.recordRaw({
      raw,
      events: normalized.events,
      parseFailures: normalized.failures,
      invalidNotification: normalized.invalidNotification,
      transactionFailed: normalized.transactionFailed,
    });
  }
  if (reconnectAtUnixMs !== null) {
    await writer.recordDiagnostic(
      diagnostic("connection-closed", reconnectAtUnixMs, { willReconnect: true, connectionEpoch: 0 }),
    );
    await writer.recordDiagnostic(
      diagnostic("connection-opened", reconnectAtUnixMs + 10, { connectionEpoch: 1 }),
    );
  }
  await writer.close();
}

test("calibrates child monotonic time onto the orchestrator timeline using the minimum RTT", () => {
  const result = buildTimingCalibration(
    "calibration",
    startup("public", 101),
    { wallUnixMs: BASE_UNIX_MS, monotonicNs: "10000000000" },
    [
      {
        parentSentMonotonicNs: "10000000000",
        parentReceivedMonotonicNs: "10010000000",
        childMonotonicNs: "5004000000",
        childWallUnixMs: BASE_UNIX_MS + 5,
      },
      {
        parentSentMonotonicNs: "10100000000",
        parentReceivedMonotonicNs: "10100200000",
        childMonotonicNs: "5100100000",
        childWallUnixMs: BASE_UNIX_MS + 100,
      },
    ],
  );
  assert.equal(result.minimumRoundTripNs, "200000");
  assert.equal(result.uncertaintyNs, "100000");
  assert.equal(result.anchor.parentMonotonicNs, "10100100000");
  assert.equal(result.valid, true);
});

test("calibrates a real separate Node child process without directly comparing clock origins", async () => {
  const child = spawn(
    process.execPath,
    [
      "--eval",
      "process.on('message',m=>{if(m==='ping')process.send({mono:process.hrtime.bigint().toString(),wall:Date.now()});if(m==='stop')process.exit(0)});process.send('ready')",
    ],
    { stdio: ["ignore", "ignore", "ignore", "ipc"] },
  );
  try {
    await new Promise<void>((resolvePromise, reject) => {
      const timer = setTimeout(() => reject(new Error("child readiness timed out")), 2_000);
      child.once("message", () => {
        clearTimeout(timer);
        resolvePromise();
      });
    });
    const baseline = { wallUnixMs: Date.now(), monotonicNs: process.hrtime.bigint().toString() };
    const sent = process.hrtime.bigint();
    child.send("ping");
    const pong = await new Promise<{ readonly mono: string; readonly wall: number }>((resolvePromise, reject) => {
      const timer = setTimeout(() => reject(new Error("child calibration timed out")), 2_000);
      child.once("message", (message: unknown) => {
        clearTimeout(timer);
        resolvePromise(message as { readonly mono: string; readonly wall: number });
      });
    });
    const received = process.hrtime.bigint();
    const result = buildTimingCalibration("real-child", startup("public", child.pid ?? 101), baseline, [{
      parentSentMonotonicNs: sent.toString(),
      parentReceivedMonotonicNs: received.toString(),
      childMonotonicNs: pong.mono,
      childWallUnixMs: pong.wall,
    }]);
    assert.equal(result.valid, true);
    assert.ok(Number(result.uncertaintyNs) >= 0);
  } finally {
    const exited = new Promise<void>((resolvePromise) => child.once("exit", () => resolvePromise()));
    child.send("stop");
    await exited;
  }
});

test("calculates signed arrival deltas and applies the configured tie tolerance", () => {
  const publicCalibration = calibration("public", 101);
  const candidateCalibration = calibration("candidate", 102);
  assert.equal(arrivalDeltaMs("2010000000", "2000000000", publicCalibration, candidateCalibration), 10);
  assert.equal(firstArrival(10, 1), "candidate");
  assert.equal(firstArrival(-10, 1), "public");
  assert.equal(firstArrival(0.75, 1), "tie");
});

test("matches signatures, measures asymmetric coverage, de-duplicates, and preserves parser compatibility", async () => {
  const root = await mkdtemp(join(tmpdir(), "botwiner-comparison-"));
  try {
    const shared = "3".repeat(88);
    const publicOnly = "4".repeat(88);
    const candidateOnly = "5".repeat(88);
    await Promise.all([
      writeFeed(root, "public", [
        comparisonRaw({ feedId: "public", processId: 101, sequence: 1, signature: shared, monotonicNs: 2_010_000_000n, unixMs: BASE_UNIX_MS + 10 }),
        comparisonRaw({ feedId: "public", processId: 101, sequence: 2, signature: publicOnly, monotonicNs: 2_020_000_000n, unixMs: BASE_UNIX_MS + 20, eventType: "trade" }),
      ]),
      writeFeed(root, "candidate", [
        comparisonRaw({ feedId: "candidate", processId: 102, sequence: 1, signature: shared, monotonicNs: 2_000_000_000n, unixMs: BASE_UNIX_MS + 9 }),
        comparisonRaw({ feedId: "candidate", processId: 102, sequence: 2, signature: shared, monotonicNs: 2_005_000_000n, unixMs: BASE_UNIX_MS + 11 }),
        comparisonRaw({ feedId: "candidate", processId: 102, sequence: 3, signature: candidateOnly, monotonicNs: 2_030_000_000n, unixMs: BASE_UNIX_MS + 30, eventType: "trade" }),
      ]),
    ]);
    const report = await analyzeFeedComparison(root, comparisonManifest("comparison-test"));
    assert.equal(report.coverage.matchedSignatures, 1);
    assert.equal(report.coverage.publicOnlySignatures, 1);
    assert.equal(report.coverage.candidateOnlySignatures, 1);
    assert.equal(report.feeds.candidate.duplicateNotifications, 1);
    assert.equal(report.feeds.candidate.duplicateEvents, 1);
    assert.equal(report.cleanLatency.deltaMs.p50, 10);
    assert.equal(report.compatibility.payloadMismatches, 0);
    assert.equal(report.compatibility.parserOutputMismatches, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("excludes reconnect-era matches and counts malformed candidate payload evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "botwiner-reconnect-"));
  try {
    const clean = "6".repeat(88);
    const afterReconnect = "7".repeat(88);
    await Promise.all([
      writeFeed(root, "public", [
        comparisonRaw({ feedId: "public", processId: 101, sequence: 1, signature: clean, monotonicNs: 2_000_000_000n, unixMs: BASE_UNIX_MS + 10 }),
        comparisonRaw({ feedId: "public", processId: 101, sequence: 2, signature: afterReconnect, monotonicNs: 2_100_000_000n, unixMs: BASE_UNIX_MS + 100, connectionEpoch: 1 }),
      ], BASE_UNIX_MS + 50),
      writeFeed(root, "candidate", [
        comparisonRaw({ feedId: "candidate", processId: 102, sequence: 1, signature: clean, monotonicNs: 1_999_000_000n, unixMs: BASE_UNIX_MS + 10 }),
        comparisonRaw({ feedId: "candidate", processId: 102, sequence: 2, signature: afterReconnect, monotonicNs: 2_090_000_000n, unixMs: BASE_UNIX_MS + 100, connectionEpoch: 1 }),
        comparisonRaw({ feedId: "candidate", processId: 102, sequence: 3, signature: "8".repeat(88), monotonicNs: 2_110_000_000n, unixMs: BASE_UNIX_MS + 110, malformedPayload: true }),
      ], BASE_UNIX_MS + 50),
    ]);
    const report = await analyzeFeedComparison(root, comparisonManifest("comparison-test"));
    assert.equal(report.coverage.matchedSignatures, 2);
    assert.equal(report.cleanLatency.deltaMs.count, 1);
    assert.equal(report.cleanLatency.excludedMatchedSignatures, 1);
    assert.equal(report.feeds.candidate.malformedFrames, 1);
    assert.equal(report.methodology.reconnectAffectedRecordsExcluded, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("writes deterministic reports for identical comparison evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "botwiner-report-"));
  try {
    const signature = "9".repeat(88);
    await Promise.all([
      writeFeed(root, "public", [comparisonRaw({ feedId: "public", processId: 101, sequence: 1, signature, monotonicNs: 2_002_000_000n, unixMs: BASE_UNIX_MS + 3 })]),
      writeFeed(root, "candidate", [comparisonRaw({ feedId: "candidate", processId: 102, sequence: 1, signature, monotonicNs: 2_000_000_000n, unixMs: BASE_UNIX_MS + 2 })]),
    ]);
    const manifest = comparisonManifest("comparison-test");
    const first = await analyzeFeedComparison(root, manifest);
    await writeFeedComparisonReports(root, first);
    const firstJson = await readFile(join(root, "feed-comparison-report.json"), "utf8");
    const second = await analyzeFeedComparison(root, manifest);
    await writeFeedComparisonReports(root, second);
    const secondJson = await readFile(join(root, "feed-comparison-report.json"), "utf8");
    assert.deepEqual(first, second);
    assert.equal(firstJson, secondJson);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("redacts and detects secrets without accepting credential-bearing endpoint labels", async () => {
  const root = await mkdtemp(join(tmpdir(), "botwiner-secret-"));
  try {
    const secret = "unit-test-helius-key";
    const path = join(root, "artifact.json");
    await writeFile(path, redactSecret(`https://example.invalid/?api-key=${secret}`, secret), "utf8");
    assert.equal(await secretAppearsInFiles([path], secret), false);
    assert.doesNotThrow(() => validateCollectorStartupPair(startup("public", 101), startup("candidate", 102)));
    assert.throws(
      () => validateCollectorStartupPair(startup("public", 101), null),
      /both collectors must report ready/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("requires comparison abort on child failure or early exit", () => {
  assert.equal(childExitRequiresAbort(1, BASE_UNIX_MS + 10_000, BASE_UNIX_MS + 20_000), true);
  assert.equal(childExitRequiresAbort(0, BASE_UNIX_MS + 10_000, BASE_UNIX_MS + 20_000), true);
  assert.equal(childExitRequiresAbort(0, BASE_UNIX_MS + 19_500, BASE_UNIX_MS + 20_000), false);
});
