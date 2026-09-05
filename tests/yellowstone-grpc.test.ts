import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseRawGrpcRecord,
  parseRawRecord,
  type DiagnosticRecord,
  type RawGrpcRecord,
} from "@botwiner/market-data";
import {
  PUMP_PROGRAM_ID,
  encodeBase58,
  normalizeRawGrpcRecord,
  normalizeRawRecord,
} from "@botwiner/pumpfun";
import {
  subscribeToYellowstone,
  type ReceivedGrpcMessage,
  type YellowstoneClientLike,
  type YellowstoneDuplexStreamLike,
} from "@botwiner/solana";
import {
  analyzeFeedComparison,
  buildTimingCalibration,
  writeFeedComparisonReports,
  type CalibrationExchange,
  type CollectorStartupTuple,
  type FeedComparisonManifest,
  type OrchestratorBaseline,
} from "@botwiner/research";
import { jsonLine } from "@botwiner/market-data";

class MockGrpcStream extends EventEmitter implements YellowstoneDuplexStreamLike {
  public isPaused = false;
  public pausedCount = 0;
  public resumedCount = 0;

  public pause(): this {
    this.isPaused = true;
    this.pausedCount += 1;
    return this;
  }

  public resume(): this {
    this.isPaused = false;
    this.resumedCount += 1;
    return this;
  }

  public end(): void {
    this.emit("end");
  }

  public destroy(): this {
    this.emit("close");
    return this;
  }
}

class MockYellowstoneClient implements YellowstoneClientLike {
  public connected = false;
  public lastSubscribeRequest: unknown = null;
  public activeStream: MockGrpcStream | null = null;

  public connect(): Promise<void> {
    this.connected = true;
    return Promise.resolve();
  }

  public subscribe(request?: unknown): Promise<YellowstoneDuplexStreamLike> {
    this.lastSubscribeRequest = request;
    const stream = new MockGrpcStream();
    this.activeStream = stream;
    return Promise.resolve(stream);
  }
}

function createSampleSignatureBytes(byteValue = 42): Uint8Array {
  const bytes = new Uint8Array(64);
  bytes.fill(byteValue);
  return bytes;
}

test("Yellowstone client captures boundary arrival timing and normalizes gRPC messages", async () => {
  const mockClient = new MockYellowstoneClient();
  const received: ReceivedGrpcMessage[] = [];
  const diagnostics: DiagnosticRecord[] = [];
  const abortController = new AbortController();

  const subscriberPromise = subscribeToYellowstone({
    endpoint: "http://127.0.0.1:10000",
    token: "mock-secret-token",
    programId: PUMP_PROGRAM_ID,
    commitment: "processed",
    signal: abortController.signal,
    clientFactory: () => mockClient,
    onNotification: (msg) => {
      received.push(msg);
    },
    onDiagnostic: (diag) => {
      diagnostics.push(diag);
    },
  });

  // Give loop a tick to connect and subscribe
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(mockClient.connected, true);
  assert.ok(mockClient.activeStream);

  const sigBytes = createSampleSignatureBytes(1);
  const expectedSigBase58 = encodeBase58(sigBytes);

  const update = {
    filters: ["pumpfun"],
    transaction: {
      slot: "320500100",
      transaction: {
        signature: sigBytes,
        isVote: false,
        meta: {
          err: null,
          logMessages: [
            `Program ${PUMP_PROGRAM_ID} invoke [1]`,
            `Program ${PUMP_PROGRAM_ID} success`,
          ],
        },
        transaction: {
          message: {
            accountKeys: [sigBytes.subarray(0, 32)],
          },
        },
        index: "5",
      },
    },
  };

  const beforeSendNs = process.hrtime.bigint();
  mockClient.activeStream.emit("data", update);
  const afterSendNs = process.hrtime.bigint();

  assert.equal(received.length, 1);
  const msg = received[0];
  assert.ok(msg);
  assert.equal(msg.payload.slot, 320500100);
  assert.equal(msg.payload.signature, expectedSigBase58);
  assert.equal(msg.payload.isVote, false);
  assert.equal(msg.payload.err, null);
  assert.equal(msg.payload.index, 5);
  assert.equal(msg.payload.logs.length, 2);
  assert.equal(msg.connectionEpoch, 0);

  // Verify arrival timing was captured at boundary
  assert.ok(msg.clock.receivedMonotonicNs >= beforeSendNs);
  assert.ok(msg.clock.receivedMonotonicNs <= afterSendNs);
  assert.ok(msg.clock.receivedAtUnixMs > 0);
  assert.ok(msg.clock.transportParseDurationNs >= 0n);

  abortController.abort();
  await subscriberPromise;
});

test("Yellowstone parser faithfully records failed transactions and invalid records", () => {
  const sigBytes = createSampleSignatureBytes(2);
  const signature = encodeBase58(sigBytes);

  const rawRecord: RawGrpcRecord = {
    schemaVersion: 1,
    kind: "solana.grpc-transaction",
    sequence: 1,
    source: {
      transport: "yellowstone-grpc",
      programId: PUMP_PROGRAM_ID,
      commitment: "processed",
      endpointLabel: "yellowstone-grpc",
    },
    capture: {
      receivedAtUnixMs: Date.now(),
      receivedAtIso: new Date().toISOString(),
      receivedMonotonicNs: process.hrtime.bigint().toString(),
      parseCompletedAtUnixMs: Date.now(),
      parseDurationNs: "1000",
      rpcProviderReceivedAtUnixMs: null,
    },
    grpcPayload: {
      slot: 320000001,
      signature,
      isVote: false,
      err: { InstructionError: [0, "Custom: 6000"] },
      logs: [
        `Program ${PUMP_PROGRAM_ID} invoke [1]`,
        `Program ${PUMP_PROGRAM_ID} failed: custom program error: 0x1770`,
      ],
      accountKeys: [signature.slice(0, 44)],
      index: 12,
    },
  };

  const parsedValidation = parseRawGrpcRecord(rawRecord);
  assert.equal(parsedValidation.ok, true);

  const genericValidation = parseRawRecord(rawRecord);
  assert.equal(genericValidation.ok, true);

  // Normalization must mark transaction as failed and not extract false events
  const normalized = normalizeRawGrpcRecord(rawRecord);
  assert.equal(normalized.transactionFailed, true);
  assert.equal(normalized.events.length, 0);
  assert.equal(normalized.invalidNotification, null);

  const genericNormalized = normalizeRawRecord(rawRecord);
  assert.equal(genericNormalized.transactionFailed, true);
  assert.equal(genericNormalized.events.length, 0);
});

test("Yellowstone client handles backpressure pause and resume thresholds cleanly", async () => {
  const mockClient = new MockYellowstoneClient();
  const abortController = new AbortController();
  const diagnostics: DiagnosticRecord[] = [];
  const inFlightResolvers: Array<() => void> = [];

  const subscriberPromise = subscribeToYellowstone({
    endpoint: "http://127.0.0.1:10000",
    programId: PUMP_PROGRAM_ID,
    commitment: "processed",
    signal: abortController.signal,
    clientFactory: () => mockClient,
    maxInFlight: 3,
    resumeThreshold: 1,
    onNotification: () =>
      new Promise<void>((resolve) => {
        inFlightResolvers.push(resolve);
      }),
    onDiagnostic: (diag) => {
      diagnostics.push(diag);
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 10));
  const stream = mockClient.activeStream!;

  const makeUpdate = (val: number) => ({
    filters: ["pumpfun"],
    transaction: {
      slot: "320000000",
      transaction: {
        signature: createSampleSignatureBytes(val),
        isVote: false,
        meta: { err: null, logMessages: [] },
      },
    },
  });

  // Emit 2 updates: below maxInFlight (3)
  stream.emit("data", makeUpdate(1));
  stream.emit("data", makeUpdate(2));
  assert.equal(stream.isPaused, false);

  // Emit 3rd update: hits maxInFlight (3) -> triggers pause
  stream.emit("data", makeUpdate(3));
  assert.equal(stream.isPaused, true);
  assert.equal(stream.pausedCount, 1);

  const pauseDiag = diagnostics.find((d) => d.code === "grpc-backpressure-warning" && d.details.action === "pause");
  assert.ok(pauseDiag);
  assert.equal(pauseDiag.details.inFlight, 3);

  // Resolve 1: inFlight goes from 3 -> 2 (still above resumeThreshold 1)
  inFlightResolvers.shift()!();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(stream.isPaused, true);

  // Resolve 2nd: inFlight goes from 2 -> 1 (<= resumeThreshold 1) -> triggers resume
  inFlightResolvers.shift()!();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(stream.isPaused, false);
  assert.equal(stream.resumedCount, 1);

  const resumeDiag = diagnostics.find((d) => d.code === "grpc-backpressure-warning" && d.details.action === "resume");
  assert.ok(resumeDiag);

  // Drain last in flight
  inFlightResolvers.shift()!();
  abortController.abort();
  await subscriberPromise;
});

test("Yellowstone subscriber handles reconnects, stream errors, and secret redaction", async () => {
  let attempts = 0;
  const SECRET_KEY = "super-secret-api-token-xyz";
  const diagnostics: DiagnosticRecord[] = [];
  const abortController = new AbortController();

  const subscriberPromise = subscribeToYellowstone({
    endpoint: "http://127.0.0.1:10000",
    token: SECRET_KEY,
    programId: PUMP_PROGRAM_ID,
    commitment: "processed",
    signal: abortController.signal,
    initialReconnectDelayMs: 10,
    maximumReconnectDelayMs: 20,
    redactSecrets: [SECRET_KEY],
    clientFactory: () => {
      attempts += 1;
      const client = new MockYellowstoneClient();
      if (attempts === 1) {
        // First connection fails on connect
        client.connect = () => {
          return Promise.reject(new Error(`Unauthorized connection with token: ${SECRET_KEY}`));
        };
      }
      return client;
    },
    onNotification: () => undefined,
    onDiagnostic: (diag) => {
      diagnostics.push(diag);
      if (attempts === 2 && diag.code === "connection-opened") {
        abortController.abort();
      }
    },
  });

  await subscriberPromise;

  assert.ok(attempts >= 2);
  const errorDiag = diagnostics.find((d) => d.code === "connection-error");
  assert.ok(errorDiag);
  // Ensure token was redacted
  assert.equal(typeof errorDiag.details.error, "string");
  assert.ok(!String(errorDiag.details.error).includes(SECRET_KEY));
  assert.ok(String(errorDiag.details.error).includes("[REDACTED]"));
});

test("Feed comparator evaluates WebSocket baseline vs Yellowstone gRPC candidate", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "botwiner-grpc-compare-"));
  try {
    const publicDir = join(tempDir, "public");
    const candidateDir = join(tempDir, "candidate");
    await mkdir(publicDir, { recursive: true });
    await mkdir(candidateDir, { recursive: true });

    const baseUnixMs = 1_700_000_000_000;
    const commonSig = encodeBase58(createSampleSignatureBytes(10));
    const publicOnlySig = encodeBase58(createSampleSignatureBytes(11));
    const grpcOnlySig = encodeBase58(createSampleSignatureBytes(12));

    // Public WebSocket dataset (RawLogRecord)
    const publicRawRecords = [
      {
        schemaVersion: 1,
        kind: "solana.logs-notification",
        sequence: 1,
        source: {
          transport: "solana-rpc-websocket",
          programId: PUMP_PROGRAM_ID,
          commitment: "processed",
          endpointLabel: "solana-public-mainnet-wss",
        },
        capture: {
          receivedAtUnixMs: baseUnixMs + 100, // arrived at +100ms
          receivedAtIso: new Date(baseUnixMs + 100).toISOString(),
          receivedMonotonicNs: "100000000",
          parseCompletedAtUnixMs: baseUnixMs + 101,
          parseDurationNs: "1000000",
          rpcProviderReceivedAtUnixMs: null,
        },
        rpcPayload: {
          jsonrpc: "2.0",
          method: "logsNotification",
          params: {
            subscription: 1,
            result: {
              context: { slot: 320000010 },
              value: { signature: commonSig, err: null, logs: [] },
            },
          },
        },
      },
      {
        schemaVersion: 1,
        kind: "solana.logs-notification",
        sequence: 2,
        source: {
          transport: "solana-rpc-websocket",
          programId: PUMP_PROGRAM_ID,
          commitment: "processed",
          endpointLabel: "solana-public-mainnet-wss",
        },
        capture: {
          receivedAtUnixMs: baseUnixMs + 200,
          receivedAtIso: new Date(baseUnixMs + 200).toISOString(),
          receivedMonotonicNs: "200000000",
          parseCompletedAtUnixMs: baseUnixMs + 201,
          parseDurationNs: "1000000",
          rpcProviderReceivedAtUnixMs: null,
        },
        rpcPayload: {
          jsonrpc: "2.0",
          method: "logsNotification",
          params: {
            subscription: 1,
            result: {
              context: { slot: 320000011 },
              value: { signature: publicOnlySig, err: null, logs: [] },
            },
          },
        },
      },
    ];

    // Yellowstone gRPC dataset (RawGrpcRecord) - arrives 40ms earlier for commonSig!
    const grpcRawRecords = [
      {
        schemaVersion: 1,
        kind: "solana.grpc-transaction",
        sequence: 1,
        source: {
          transport: "yellowstone-grpc",
          programId: PUMP_PROGRAM_ID,
          commitment: "processed",
          endpointLabel: "yellowstone-grpc",
        },
        capture: {
          receivedAtUnixMs: baseUnixMs + 60, // arrived at +60ms (40ms earlier than WS!)
          receivedAtIso: new Date(baseUnixMs + 60).toISOString(),
          receivedMonotonicNs: "60000000",
          parseCompletedAtUnixMs: baseUnixMs + 61,
          parseDurationNs: "1000000",
          rpcProviderReceivedAtUnixMs: null,
        },
        grpcPayload: {
          slot: 320000010,
          signature: commonSig,
          isVote: false,
          err: null,
          logs: [],
          index: 3,
        },
      },
      {
        schemaVersion: 1,
        kind: "solana.grpc-transaction",
        sequence: 2,
        source: {
          transport: "yellowstone-grpc",
          programId: PUMP_PROGRAM_ID,
          commitment: "processed",
          endpointLabel: "yellowstone-grpc",
        },
        capture: {
          receivedAtUnixMs: baseUnixMs + 250,
          receivedAtIso: new Date(baseUnixMs + 250).toISOString(),
          receivedMonotonicNs: "250000000",
          parseCompletedAtUnixMs: baseUnixMs + 251,
          parseDurationNs: "1000000",
          rpcProviderReceivedAtUnixMs: null,
        },
        grpcPayload: {
          slot: 320000012,
          signature: grpcOnlySig,
          isVote: false,
          err: null,
          logs: [],
          index: 4,
        },
      },
    ];

    await writeFile(join(publicDir, "raw.jsonl"), publicRawRecords.map(jsonLine).join(""), "utf8");
    await writeFile(join(publicDir, "events.jsonl"), "", "utf8");
    await writeFile(
      join(publicDir, "diagnostics.jsonl"),
      jsonLine({
        schemaVersion: 1,
        kind: "diagnostic",
        code: "subscription-confirmed",
        atUnixMs: baseUnixMs,
        message: "WS confirmed",
        sequence: null,
        details: {},
      }),
      "utf8",
    );
    await writeFile(
      join(publicDir, "manifest.json"),
      JSON.stringify({
        schemaVersion: 1,
        kind: "dataset-manifest",
        sessionId: "public",
        status: "complete",
        startedAt: new Date(baseUnixMs).toISOString(),
        endedAt: new Date(baseUnixMs + 1000).toISOString(),
        durationSeconds: 1,
        source: {
          transport: "solana-rpc-websocket",
          endpointLabel: "solana-public-mainnet-wss",
          commitment: "processed",
          programId: PUMP_PROGRAM_ID,
        },
        parser: {
          version: "v1",
          officialIdlRevision: "rev",
        },
        files: {
          raw: "raw.jsonl",
          events: "events.jsonl",
          diagnostics: "diagnostics.jsonl",
        },
        counts: { duplicateEvents: 0 },
        limitations: [],
      }),
      "utf8",
    );

    await writeFile(join(candidateDir, "raw.jsonl"), grpcRawRecords.map(jsonLine).join(""), "utf8");
    await writeFile(join(candidateDir, "events.jsonl"), "", "utf8");
    await writeFile(
      join(candidateDir, "diagnostics.jsonl"),
      jsonLine({
        schemaVersion: 1,
        kind: "diagnostic",
        code: "subscription-confirmed",
        atUnixMs: baseUnixMs,
        message: "gRPC confirmed",
        sequence: null,
        details: {},
      }),
      "utf8",
    );
    await writeFile(
      join(candidateDir, "manifest.json"),
      JSON.stringify({
        schemaVersion: 1,
        kind: "dataset-manifest",
        sessionId: "candidate",
        status: "complete",
        startedAt: new Date(baseUnixMs).toISOString(),
        endedAt: new Date(baseUnixMs + 1000).toISOString(),
        durationSeconds: 1,
        source: {
          transport: "yellowstone-grpc",
          endpointLabel: "yellowstone-grpc",
          commitment: "processed",
          programId: PUMP_PROGRAM_ID,
        },
        parser: {
          version: "v1",
          officialIdlRevision: "rev",
        },
        files: {
          raw: "raw.jsonl",
          events: "events.jsonl",
          diagnostics: "diagnostics.jsonl",
        },
        counts: { duplicateEvents: 0 },
        limitations: [],
      }),
      "utf8",
    );

    const baseline: OrchestratorBaseline = {
      wallUnixMs: baseUnixMs,
      monotonicNs: "0",
    };

    const makeStartup = (feedId: "public" | "candidate", endpointLabel: string): CollectorStartupTuple => ({
      feedId,
      processId: feedId === "public" ? 1001 : 1002,
      hostFingerprint: "host",
      wallUnixMs: baseUnixMs,
      monotonicNs: "0",
      commitment: "processed",
      programId: PUMP_PROGRAM_ID,
      parserVersion: "v1",
      idlRevision: "rev",
      endpointLabel,
    });

    const dummyExchange: CalibrationExchange = {
      parentSentMonotonicNs: "0",
      parentReceivedMonotonicNs: "1000000",
      childMonotonicNs: "500000",
      childWallUnixMs: baseUnixMs,
    };

    const publicCal = buildTimingCalibration("pub-cal", makeStartup("public", "solana-public-mainnet-wss"), baseline, [dummyExchange]);
    const candidateCal = buildTimingCalibration("cand-cal", makeStartup("candidate", "yellowstone-grpc"), baseline, [dummyExchange]);

    const manifest: FeedComparisonManifest = {
      schemaVersion: 1,
      kind: "feed-comparison-manifest",
      comparisonId: "grpc-ws-test-comparison",
      status: "complete",
      startedAt: new Date(baseUnixMs).toISOString(),
      endedAt: new Date(baseUnixMs + 1000).toISOString(),
      window: {
        requestedStartUnixMs: baseUnixMs,
        requestedEndUnixMs: baseUnixMs + 1000,
        durationSeconds: 1,
        windowDurationSeconds: 1,
      },
      orchestrator: {
        processId: 999,
        hostFingerprint: "host",
        wallBaselineUnixMs: baseUnixMs,
        monotonicBaselineNs: "0",
      },
      controls: {
        commitment: "processed",
        programId: PUMP_PROGRAM_ID,
        parserVersion: "v1",
        idlRevision: "rev",
        tieToleranceMs: 1,
        calibrationMaximumUncertaintyMs: 10,
        calibrationMaximumWallResidualMs: 100,
      },
      feeds: {
        public: { dataset: "public", endpointLabel: "solana-public-mainnet-wss", processId: 1001 },
        candidate: { dataset: "candidate", endpointLabel: "yellowstone-grpc", processId: 1002 },
      },
      calibrations: {
        public: publicCal,
        candidate: candidateCal,
      },
      runtimeChecks: {
        bothCollectorsReady: true,
        bothCollectorsCompleted: true,
        apiKeyWasPresent: true,
        apiKeyPersisted: false,
      },
      failure: null,
      limitations: ["Test comparison"],
    };

    await writeFile(join(tempDir, "comparison-manifest.json"), JSON.stringify(manifest, null, 2), "utf8");

    const report = await analyzeFeedComparison(tempDir, manifest);
    await writeFeedComparisonReports(tempDir, report);

    assert.equal(report.coverage.matchedSignatures, 1);
    assert.equal(report.coverage.publicOnlySignatures, 1);
    assert.equal(report.coverage.candidateOnlySignatures, 1);

    // Delta = wsArrival - grpcArrival = 100 - 60 = +40 ms (positive -> gRPC is earlier!)
    assert.equal(report.cleanLatency.deltaMs.count, 1);
    assert.ok(Math.abs(report.cleanLatency.deltaMs.p50! - 40) < 1.0);
    assert.equal(report.cleanLatency.winner.candidateFaster, 1);
    assert.equal(report.cleanLatency.winner.publicFaster, 0);

    // Check tail distribution: threshold 25ms (in [10, 25, 50, 100, 250, 500])
    const idx25 = report.cleanLatency.tails.thresholdsMs.indexOf(25);
    assert.ok(idx25 >= 0);
    assert.equal(report.cleanLatency.tails.candidateLeadCounts[idx25], 1);
    const idx50 = report.cleanLatency.tails.thresholdsMs.indexOf(50);
    assert.ok(idx50 >= 0);
    assert.equal(report.cleanLatency.tails.candidateLeadCounts[idx50], 0);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
