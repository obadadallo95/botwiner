import { basename, resolve } from "node:path";
import { createHash } from "node:crypto";
import { hostname } from "node:os";
import {
  type Commitment,
  type FeedTransportType,
  type NormalizedMarketEvent,
  type RawGrpcRecord,
  type RawLogRecord,
  type RawRecord,
} from "@botwiner/market-data";
import {
  PUMP_IDL_REVISION,
  PUMP_PARSING_VERSION,
  PUMP_PROGRAM_ID,
  normalizeRawGrpcRecord,
  normalizeRawLogRecord,
} from "@botwiner/pumpfun";
import {
  endpointLabelFromUrl,
  redactSecrets,
  sampleSntpClock,
  subscribeToProgramLogs,
  subscribeToYellowstone,
  type ReceivedGrpcMessage,
  type ReceivedLogsMessage,
} from "@botwiner/solana";
import { DatasetWriter, CloudResearchSink, type ResearchSink } from "@botwiner/storage";
import {
  GraduationTracker,
  FirestoreTelemetryReporter,
  PaperTradingEngine,
  TraderPnlTracker,
} from "@botwiner/research";

interface CollectorCliOptions {
  readonly transport: FeedTransportType;
  readonly feedProvider: "public" | "helius" | "yellowstone";
  readonly wsUrl: string;
  readonly grpcEndpoint: string;
  readonly grpcToken: string | undefined;
  readonly endpointLabel: string;
  readonly commitment: Commitment;
  readonly outputDirectory: string;
  readonly durationSeconds: number | null;
  readonly ntpHost: string | null;
  readonly ntpIntervalSeconds: number;
  readonly sink: "local" | "cloud";
  readonly sessionId: string;
  readonly comparison: {
    readonly comparisonId: string;
    readonly feedId: "public" | "candidate";
  } | null;
}

interface OrchestratedWindow {
  readonly startAtUnixMs: number;
  readonly stopAtUnixMs: number;
  readonly calibrationId: string;
}

function usage(): string {
  return [
    "Usage: pnpm collector:start [options]",
    "",
    "Options:",
    "  --output <directory>          Exact dataset directory",
    "  --duration-seconds <seconds>  Stop cleanly after a bounded interval",
    "  --commitment <level>          processed (default), confirmed, or finalized",
    "  --provider <name>             public (default), helius, or yellowstone",
    "  --transport <name>            solana-rpc-websocket or yellowstone-grpc",
    "  --ws-url <url>                Solana WebSocket URL (prefer SOLANA_WS_URL)",
    "  --grpc-endpoint <endpoint>    Yellowstone gRPC endpoint (prefer YELLOWSTONE_GRPC_ENDPOINT)",
    "  --grpc-token <token>          Yellowstone gRPC auth token (prefer YELLOWSTONE_GRPC_TOKEN)",
    "  --endpoint-label <label>      Sanitized endpoint identity for persisted metadata",
    "  --ntp-host <host>             SNTP host (default: time.cloudflare.com)",
    "  --ntp-interval-seconds <n>    Repeat clock-offset sampling (default: 300)",
    "  --disable-ntp                 Record that clock-offset sampling was skipped",
    "  --sink <local|cloud>          Destination sink (default: local or cloud if RESEARCH_SESSION_ID/GCS_BUCKET set)",
    "  --session-id <id>             Explicit session identifier",
    "  --help                        Show this help",
  ].join("\n");
}

function requireNext(arguments_: readonly string[], index: number, option: string): string {
  const value = arguments_[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${option} requires a value`);
  return value;
}

function defaultSessionDirectory(): string {
  const timestamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
  return resolve("data", "sessions", `${timestamp}-${process.pid}`);
}

function parseCommitment(value: string): Commitment {
  if (value === "processed" || value === "confirmed" || value === "finalized") return value;
  throw new Error(`invalid commitment: ${value}`);
}

function parseArguments(arguments_: readonly string[]): CollectorCliOptions {
  let feedProvider: "public" | "helius" | "yellowstone" =
    process.env.BOTWINER_FEED_PROVIDER === "yellowstone"
      ? "yellowstone"
      : process.env.BOTWINER_FEED_PROVIDER === "helius"
        ? "helius"
        : process.env.HELIUS_API_KEY && process.env.HELIUS_API_KEY.length > 0
          ? "helius"
          : "public";
  let transport: FeedTransportType =
    feedProvider === "yellowstone" ? "yellowstone-grpc" : "solana-rpc-websocket";
  let grpcEndpoint = process.env.YELLOWSTONE_GRPC_ENDPOINT ?? "";
  let grpcToken = process.env.YELLOWSTONE_GRPC_TOKEN;
  const heliusApiKey = process.env.HELIUS_API_KEY;
  let wsUrl =
    feedProvider === "helius"
      ? (() => {
          if (heliusApiKey === undefined || heliusApiKey.length === 0) {
            throw new Error("HELIUS_API_KEY is required for the Helius comparison collector");
          }
          const url = new URL("wss://mainnet.helius-rpc.com/");
          url.searchParams.set("api-key", heliusApiKey);
          return url.toString();
        })()
      : process.env.SOLANA_WS_URL ?? "wss://api.mainnet-beta.solana.com/";
  let endpointLabel =
    process.env.BOTWINER_ENDPOINT_LABEL ??
    (feedProvider === "yellowstone"
      ? "yellowstone-grpc"
      : feedProvider === "helius"
        ? "helius-mainnet-wss"
        : endpointLabelFromUrl(wsUrl));
  let commitment = parseCommitment(process.env.SOLANA_COMMITMENT ?? "processed");
  let outputDirectory = defaultSessionDirectory();
  let durationSeconds: number | null = null;
  if (process.env.RESEARCH_DURATION_SECONDS) {
    const rawSec = Number(process.env.RESEARCH_DURATION_SECONDS);
    if (Number.isFinite(rawSec) && rawSec > 0) durationSeconds = rawSec;
  }
  let sink: "local" | "cloud" =
    process.env.BOTWINER_SINK === "cloud" ||
    process.env.RESEARCH_SESSION_ID !== undefined ||
    process.env.GCS_BUCKET !== undefined
      ? "cloud"
      : "local";
  let sessionId = process.env.RESEARCH_SESSION_ID ?? basename(outputDirectory);
  let ntpHost: string | null = process.env.NTP_HOST ?? "time.cloudflare.com";
  let ntpIntervalSeconds = Number(process.env.NTP_INTERVAL_SECONDS ?? "300");
  const comparisonId = process.env.BOTWINER_COMPARISON_ID;
  const feedId = process.env.BOTWINER_FEED_ID;
  const comparison =
    comparisonId === undefined && feedId === undefined
      ? null
      : (() => {
          if (comparisonId === undefined || (feedId !== "public" && feedId !== "candidate")) {
            throw new Error("comparison collectors require BOTWINER_COMPARISON_ID and a valid BOTWINER_FEED_ID");
          }
          return { comparisonId, feedId } as const;
        })();

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--help") {
      console.log(usage());
      process.exitCode = 0;
      return {
        transport,
        feedProvider,
        wsUrl,
        grpcEndpoint,
        grpcToken,
        endpointLabel,
        commitment,
        outputDirectory,
        durationSeconds: 0,
        ntpHost,
        ntpIntervalSeconds,
        sink,
        sessionId,
        comparison,
      };
    }
    if (argument === "--provider") {
      const p = requireNext(arguments_, index, argument);
      if (p !== "public" && p !== "helius" && p !== "yellowstone") {
        throw new Error(`invalid provider: ${p}`);
      }
      feedProvider = p;
      if (feedProvider === "yellowstone") transport = "yellowstone-grpc";
      index += 1;
      continue;
    }
    if (argument === "--transport") {
      const t = requireNext(arguments_, index, argument);
      if (t !== "solana-rpc-websocket" && t !== "yellowstone-grpc") {
        throw new Error(`invalid transport: ${t}`);
      }
      transport = t;
      index += 1;
      continue;
    }
    if (argument === "--grpc-endpoint") {
      grpcEndpoint = requireNext(arguments_, index, argument);
      transport = "yellowstone-grpc";
      index += 1;
      continue;
    }
    if (argument === "--grpc-token") {
      grpcToken = requireNext(arguments_, index, argument);
      index += 1;
      continue;
    }
    if (argument === "--output") {
      outputDirectory = resolve(requireNext(arguments_, index, argument));
      index += 1;
      continue;
    }
    if (argument === "--duration-seconds") {
      const raw = requireNext(arguments_, index, argument);
      durationSeconds = Number(raw);
      if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
        throw new Error(`invalid duration: ${raw}`);
      }
      index += 1;
      continue;
    }
    if (argument === "--commitment") {
      commitment = parseCommitment(requireNext(arguments_, index, argument));
      index += 1;
      continue;
    }
    if (argument === "--ws-url") {
      wsUrl = requireNext(arguments_, index, argument);
      index += 1;
      continue;
    }
    if (argument === "--endpoint-label") {
      endpointLabel = requireNext(arguments_, index, argument);
      index += 1;
      continue;
    }
    if (argument === "--ntp-host") {
      ntpHost = requireNext(arguments_, index, argument);
      index += 1;
      continue;
    }
    if (argument === "--ntp-interval-seconds") {
      const raw = requireNext(arguments_, index, argument);
      ntpIntervalSeconds = Number(raw);
      if (!Number.isFinite(ntpIntervalSeconds) || ntpIntervalSeconds < 30) {
        throw new Error(`invalid NTP interval: ${raw}; minimum is 30 seconds`);
      }
      index += 1;
      continue;
    }
    if (argument === "--sink") {
      const s = requireNext(arguments_, index, argument);
      if (s !== "local" && s !== "cloud") throw new Error(`invalid sink: ${s}`);
      sink = s;
      index += 1;
      continue;
    }
    if (argument === "--session-id") {
      sessionId = requireNext(arguments_, index, argument);
      index += 1;
      continue;
    }
    if (argument === "--disable-ntp") {
      ntpHost = null;
      continue;
    }
    throw new Error(`unknown argument: ${argument}`);
  }

  if (transport === "yellowstone-grpc") {
    if (grpcEndpoint.length === 0) {
      throw new Error("YELLOWSTONE_GRPC_ENDPOINT is required when using Yellowstone gRPC transport");
    }
    try {
      const protocol = new URL(grpcEndpoint).protocol;
      if (protocol !== "http:" && protocol !== "https:") {
        throw new Error("Yellowstone gRPC endpoint must use http: or https:");
      }
    } catch (error) {
      throw new Error(`invalid Yellowstone gRPC endpoint: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else {
    const protocol = new URL(wsUrl).protocol;
    if (protocol !== "ws:" && protocol !== "wss:") {
      throw new Error("Solana WebSocket URL must use ws: or wss:");
    }
  }

  if (!Number.isFinite(ntpIntervalSeconds) || ntpIntervalSeconds < 30) {
    throw new Error("NTP_INTERVAL_SECONDS must be at least 30 seconds");
  }
  if (endpointLabel.length === 0 || endpointLabel.length > 100 || /[?&#@=\s]/u.test(endpointLabel)) {
    throw new Error("endpoint label must not contain credentials, query parameters, or whitespace");
  }
  return {
    transport,
    feedProvider,
    wsUrl,
    grpcEndpoint,
    grpcToken,
    endpointLabel,
    commitment,
    outputDirectory,
    durationSeconds,
    ntpHost,
    ntpIntervalSeconds,
    sink,
    sessionId,
    comparison,
  };
}

function sendToOrchestrator(message: Readonly<Record<string, unknown>>): void {
  if (typeof process.send === "function") process.send(message);
}

async function waitUntil(unixMs: number): Promise<void> {
  const remaining = unixMs - Date.now();
  if (remaining > 0) await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, remaining));
}

async function awaitOrchestratedWindow(options: CollectorCliOptions): Promise<OrchestratedWindow | null> {
  if (process.env.BOTWINER_ORCHESTRATED !== "1") return null;
  if (options.comparison === null || typeof process.send !== "function") {
    throw new Error("orchestrated collector requires comparison metadata and an IPC channel");
  }
  const comparison = options.comparison;

  return new Promise<OrchestratedWindow>((resolvePromise, reject) => {
    const onMessage = (message: unknown): void => {
      if (typeof message !== "object" || message === null) return;
      const value = message as Record<string, unknown>;
      if (value.kind === "calibration-ping" && typeof value.pingId === "string") {
        const childMonotonicNs = process.hrtime.bigint();
        const childWallUnixMs = Date.now();
        sendToOrchestrator({
          kind: "calibration-pong",
          feedId: comparison.feedId,
          pingId: value.pingId,
          childMonotonicNs: childMonotonicNs.toString(),
          childWallUnixMs,
        });
        return;
      }
      if (
        value.kind === "collector-start" &&
        typeof value.startAtUnixMs === "number" &&
        typeof value.stopAtUnixMs === "number" &&
        typeof value.calibrationId === "string"
      ) {
        if (value.stopAtUnixMs <= value.startAtUnixMs) {
          reject(new Error("invalid orchestrated comparison window"));
          return;
        }
        resolvePromise({
          startAtUnixMs: value.startAtUnixMs,
          stopAtUnixMs: value.stopAtUnixMs,
          calibrationId: value.calibrationId,
        });
        return;
      }
      if (value.kind === "collector-abort") reject(new Error("comparison aborted by orchestrator"));
    };
    process.on("message", onMessage);
    sendToOrchestrator({
      kind: "collector-ready",
      feedId: comparison.feedId,
      processId: process.pid,
      hostFingerprint: createHash("sha256").update(hostname()).digest("hex").slice(0, 16),
      wallUnixMs: Date.now(),
      monotonicNs: process.hrtime.bigint().toString(),
      commitment: options.commitment,
      programId: PUMP_PROGRAM_ID,
      parserVersion: PUMP_PARSING_VERSION,
      idlRevision: PUMP_IDL_REVISION,
      endpointLabel: options.endpointLabel,
    });
  });
}

function applyFinalCapture(
  events: readonly NormalizedMarketEvent[],
  raw: RawRecord,
): readonly NormalizedMarketEvent[] {
  return events.map((event) => ({
    ...event,
    timestamps: {
      ...event.timestamps,
      collectorParseCompletedAtUnixMs: raw.capture.parseCompletedAtUnixMs,
      collectorParseDurationNs: raw.capture.parseDurationNs,
    },
  }));
}

async function run(options: CollectorCliOptions, orchestratedWindow: OrchestratedWindow | null): Promise<void> {
  if (options.durationSeconds === 0) return;

  const controller = new AbortController();
  let stoppedBySignal = false;
  const failureState: { error: Error | undefined } = { error: undefined };
  let sequence = 0;
  const endpointLabel = options.endpointLabel;
  let writer: ResearchSink;
  let cloudSink: CloudResearchSink | null = null;
  let telemetryReporter: FirestoreTelemetryReporter | null = null;

  const graduationTracker = new GraduationTracker({
    onCandidateUpdated: (candidate) => {
      telemetryReporter?.queueCandidateUpdate(candidate);
    },
  });

  const paperTradingEngine = new PaperTradingEngine({
    onPositionOpened: (pos) => {
      telemetryReporter?.queuePaperTrade(pos);
    },
    onPositionClosed: (pos) => {
      telemetryReporter?.queuePaperTrade(pos);
    },
  });

  const traderPnlTracker = new TraderPnlTracker();

  if (options.sink === "cloud") {
    const bucket = process.env.GCS_BUCKET ?? "your-gcs-bucket";
    const projectId = process.env.GCP_PROJECT_ID ?? "your-gcp-project-id";
    telemetryReporter = new FirestoreTelemetryReporter({
      sessionId: options.sessionId,
      mode: process.env.RESEARCH_MODE ?? "graduation-research",
      provider: options.feedProvider,
      region: process.env.GCP_REGION ?? "europe-west3",
      requestedDurationSec: options.durationSeconds,
      gcpProjectId: projectId,
      firestoreDatabase: process.env.FIRESTORE_DATABASE ?? "(default)",
      heartbeatIntervalMs: Number(process.env.HEARTBEAT_INTERVAL_SECONDS ?? "15") * 1000,
      statsIntervalMs: Number(process.env.STATS_FLUSH_INTERVAL_SECONDS ?? "5") * 1000,
    });
    await telemetryReporter.initialize();

    cloudSink = await CloudResearchSink.create({
      directory: options.outputDirectory,
      sessionId: options.sessionId,
      transport: options.transport,
      endpointLabel,
      commitment: options.commitment,
      programId: PUMP_PROGRAM_ID,
      parsingVersion: PUMP_PARSING_VERSION,
      officialIdlRevision: PUMP_IDL_REVISION,
      gcsBucket: bucket,
      gcpProjectId: projectId,
      durationSeconds: options.durationSeconds,
      onChunkRotated: (chunk) => {
        telemetryReporter?.updateChunkAndBytes(chunk.index, cloudSink?.getTotalCompressedBytes() ?? 0);
      },
    });
    writer = cloudSink;
    telemetryReporter.markRunning();
  } else {
    writer = await DatasetWriter.create({
      directory: options.outputDirectory,
      sessionId: basename(options.outputDirectory),
      transport: options.transport,
      endpointLabel,
      commitment: options.commitment,
      programId: PUMP_PROGRAM_ID,
      parsingVersion: PUMP_PARSING_VERSION,
      officialIdlRevision: PUMP_IDL_REVISION,
    });
  }

  let clockSampleQueue = Promise.resolve();
  let clockSampleTimer: NodeJS.Timeout | undefined;
  if (options.ntpHost === null) {
    await writer.recordDiagnostic({
      schemaVersion: 1,
      kind: "diagnostic",
      code: "clock-offset-unavailable",
      atUnixMs: Date.now(),
      message: "Clock-offset sampling was disabled",
      sequence: null,
      details: { reason: "disabled" },
    });
  } else {
    const recordClockSample = async (): Promise<void> => {
    try {
      const sample = await sampleSntpClock(options.ntpHost ?? "");
      await writer.recordDiagnostic({
        schemaVersion: 1,
        kind: "diagnostic",
        code: "clock-offset-sampled",
        atUnixMs: sample.completedAtUnixMs,
        message: "Recorded SNTP clock-offset sample",
        sequence: null,
        details: { ...sample, interpretation: "sample evidence; not a synchronization SLA" },
      });
    } catch (error) {
      await writer.recordDiagnostic({
        schemaVersion: 1,
        kind: "diagnostic",
        code: "clock-offset-unavailable",
        atUnixMs: Date.now(),
        message: "SNTP clock-offset sample failed",
        sequence: null,
        details: { host: options.ntpHost, error: error instanceof Error ? error.message : String(error) },
      });
    }
    };
    await recordClockSample();
    clockSampleTimer = setInterval(() => {
      clockSampleQueue = clockSampleQueue.then(recordClockSample);
    }, options.ntpIntervalSeconds * 1_000);
  }

  const stopForSignal = (): void => {
    stoppedBySignal = true;
    controller.abort();
  };
  process.once("SIGINT", stopForSignal);
  process.once("SIGTERM", stopForSignal);

  const timer =
    orchestratedWindow !== null
      ? setTimeout(() => controller.abort(), Math.max(0, orchestratedWindow.stopAtUnixMs - Date.now()))
      : options.durationSeconds === null
        ? undefined
        : setTimeout(() => controller.abort(), options.durationSeconds * 1_000);

  const progressTimer =
    options.comparison === null
      ? undefined
      : setInterval(() => {
          sendToOrchestrator({
            kind: "collector-progress",
            feedId: options.comparison?.feedId,
            atUnixMs: Date.now(),
            counts: writer.snapshotCounts(),
          });
        }, 30_000);

  function fail(error: unknown): void {
    failureState.error = error instanceof Error ? error : new Error(String(error));
    controller.abort();
  }

  function recordNotification(message: ReceivedLogsMessage): Promise<void> {
    sequence += 1;
    const provisionalRaw: RawLogRecord = {
      schemaVersion: 1,
      kind: "solana.logs-notification",
      sequence,
      source: {
        transport: "solana-rpc-websocket",
        programId: PUMP_PROGRAM_ID,
        commitment: options.commitment,
        endpointLabel,
        ...(options.comparison === null || orchestratedWindow === null
          ? {}
          : {
              comparison: {
                comparisonId: options.comparison.comparisonId,
                feedId: options.comparison.feedId,
                collectorProcessId: process.pid,
                calibrationId: orchestratedWindow.calibrationId,
                connectionEpoch: message.connectionEpoch,
              },
            }),
      },
      capture: {
        receivedAtUnixMs: message.clock.receivedAtUnixMs,
        receivedAtIso: message.clock.receivedAtIso,
        receivedMonotonicNs: message.clock.receivedMonotonicNs.toString(),
        parseCompletedAtUnixMs: message.clock.transportParseCompletedAtUnixMs,
        parseDurationNs: message.clock.transportParseDurationNs.toString(),
        rpcProviderReceivedAtUnixMs: null,
      },
      rpcPayload: message.payload,
    };
    const normalized = normalizeRawLogRecord(provisionalRaw);
    const parseCompletedAtUnixMs = Date.now();
    const parseCompletedMonotonicNs = process.hrtime.bigint();
    const raw: RawLogRecord = {
      ...provisionalRaw,
      capture: {
        ...provisionalRaw.capture,
        parseCompletedAtUnixMs,
        parseDurationNs: (
          parseCompletedMonotonicNs - message.clock.receivedMonotonicNs
        ).toString(),
      },
    };
    const finalEvents = applyFinalCapture(normalized.events, raw);
    for (const event of finalEvents) {
      if (event.eventType === "launch") {
        graduationTracker.onLaunch(event);
        paperTradingEngine.onLaunch(event);
        traderPnlTracker.onLaunch(event);
      } else if (event.eventType === "trade") {
        graduationTracker.onTrade(event);
        paperTradingEngine.onTrade(event);
        traderPnlTracker.onTrade(event);
      }
    }
    if (telemetryReporter !== null) {
      telemetryReporter.updateTelemetry(
        writer.snapshotCounts(),
        graduationTracker.getSummaryCounters(),
        raw.capture.receivedAtIso,
      );
      telemetryReporter.updatePaperStats(paperTradingEngine.getStats());
      telemetryReporter.updateMarketParticipantStats(traderPnlTracker.getStats());
    }
    return writer
      .recordRaw({
        raw,
        events: finalEvents,
        parseFailures: normalized.failures,
        invalidNotification: normalized.invalidNotification,
        transactionFailed: normalized.transactionFailed,
      })
      .catch(fail);
  }

  function recordGrpcMessage(message: ReceivedGrpcMessage): Promise<void> {
    sequence += 1;
    const provisionalRaw: RawGrpcRecord = {
      schemaVersion: 1,
      kind: "solana.grpc-transaction",
      sequence,
      source: {
        transport: "yellowstone-grpc",
        programId: PUMP_PROGRAM_ID,
        commitment: options.commitment,
        endpointLabel,
        ...(options.comparison === null || orchestratedWindow === null
          ? {}
          : {
              comparison: {
                comparisonId: options.comparison.comparisonId,
                feedId: options.comparison.feedId,
                collectorProcessId: process.pid,
                calibrationId: orchestratedWindow.calibrationId,
                connectionEpoch: message.connectionEpoch,
              },
            }),
      },
      capture: {
        receivedAtUnixMs: message.clock.receivedAtUnixMs,
        receivedAtIso: message.clock.receivedAtIso,
        receivedMonotonicNs: message.clock.receivedMonotonicNs.toString(),
        parseCompletedAtUnixMs: message.clock.transportParseCompletedAtUnixMs,
        parseDurationNs: message.clock.transportParseDurationNs.toString(),
        rpcProviderReceivedAtUnixMs: null,
      },
      grpcPayload: message.payload,
    };
    const normalized = normalizeRawGrpcRecord(provisionalRaw);
    const parseCompletedAtUnixMs = Date.now();
    const parseCompletedMonotonicNs = process.hrtime.bigint();
    const raw: RawGrpcRecord = {
      ...provisionalRaw,
      capture: {
        ...provisionalRaw.capture,
        parseCompletedAtUnixMs,
        parseDurationNs: (
          parseCompletedMonotonicNs - message.clock.receivedMonotonicNs
        ).toString(),
      },
    };
    const finalEvents = applyFinalCapture(normalized.events, raw);
    for (const event of finalEvents) {
      if (event.eventType === "launch") {
        graduationTracker.onLaunch(event);
        paperTradingEngine.onLaunch(event);
        traderPnlTracker.onLaunch(event);
      } else if (event.eventType === "trade") {
        graduationTracker.onTrade(event);
        paperTradingEngine.onTrade(event);
        traderPnlTracker.onTrade(event);
      }
    }
    if (telemetryReporter !== null) {
      telemetryReporter.updateTelemetry(
        writer.snapshotCounts(),
        graduationTracker.getSummaryCounters(),
        raw.capture.receivedAtIso,
      );
      telemetryReporter.updatePaperStats(paperTradingEngine.getStats());
      telemetryReporter.updateMarketParticipantStats(traderPnlTracker.getStats());
    }
    return writer
      .recordRaw({
        raw,
        events: finalEvents,
        parseFailures: normalized.failures,
        invalidNotification: normalized.invalidNotification,
        transactionFailed: normalized.transactionFailed,
      })
      .catch(fail);
  }

  try {
    console.log(
      JSON.stringify({
        status: "collecting",
        dataset: options.outputDirectory,
        endpointLabel,
        commitment: options.commitment,
        programId: PUMP_PROGRAM_ID,
        durationSeconds: options.durationSeconds,
        transport: options.transport,
      }),
    );
    if (options.transport === "yellowstone-grpc") {
      await subscribeToYellowstone({
        endpoint: options.grpcEndpoint,
        token: options.grpcToken,
        programId: PUMP_PROGRAM_ID,
        commitment: options.commitment,
        signal: controller.signal,
        onNotification: recordGrpcMessage,
        endpointLabel,
        redactSecrets: [options.grpcToken ?? "", process.env.HELIUS_API_KEY ?? ""],
        onDiagnostic: (diagnostic) => {
          if (diagnostic.code === "connection-closed") {
            telemetryReporter?.markReconnecting();
          } else if (diagnostic.code === "connection-opened") {
            telemetryReporter?.markRunning();
          }
          if (options.comparison !== null) {
            sendToOrchestrator({
              kind: "collector-diagnostic",
              feedId: options.comparison.feedId,
              code: diagnostic.code,
              atUnixMs: diagnostic.atUnixMs,
            });
          }
          return writer.recordDiagnostic(diagnostic).catch(fail);
        },
      });
    } else {
      await subscribeToProgramLogs({
        url: options.wsUrl,
        programId: PUMP_PROGRAM_ID,
        commitment: options.commitment,
        signal: controller.signal,
        onNotification: recordNotification,
        endpointLabel,
        redactSecrets: [process.env.HELIUS_API_KEY ?? ""],
        onDiagnostic: (diagnostic) => {
          if (diagnostic.code === "connection-closed") {
            telemetryReporter?.markReconnecting();
          } else if (diagnostic.code === "connection-opened") {
            telemetryReporter?.markRunning();
          }
          if (options.comparison !== null) {
            sendToOrchestrator({
              kind: "collector-diagnostic",
              feedId: options.comparison.feedId,
              code: diagnostic.code,
              atUnixMs: diagnostic.atUnixMs,
            });
          }
          return writer.recordDiagnostic(diagnostic).catch(fail);
        },
      });
    }
  } catch (error) {
    fail(error);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (progressTimer !== undefined) clearInterval(progressTimer);
    if (clockSampleTimer !== undefined) clearInterval(clockSampleTimer);
    await clockSampleQueue;
    process.removeListener("SIGINT", stopForSignal);
    process.removeListener("SIGTERM", stopForSignal);
    paperTradingEngine.onSessionEnd(Date.now());
    if (telemetryReporter !== null) {
      telemetryReporter.updatePaperStats(paperTradingEngine.getStats());
      telemetryReporter.updateMarketParticipantStats(traderPnlTracker.getStats());
    }
    const finalStatus = failureState.error === undefined && !stoppedBySignal ? "complete" : "aborted";
    await writer.close(finalStatus);
    if (cloudSink !== null) {
      try {
        await cloudSink.uploadDerivedSummary("paper-trading-summary", paperTradingEngine.getStats());
        await cloudSink.uploadDerivedSummary("participant-analytics-summary", traderPnlTracker.getStats());
      } catch (err) {
        console.warn("[Collector] Failed to upload derived summaries to GCS:", err);
      }
    }
    if (telemetryReporter !== null) {
      const finalStatusToReport = stoppedBySignal ? "cancelled" : (finalStatus === "complete" ? "completed" : "failed");
      await telemetryReporter.close(finalStatusToReport);
    }
  }

  const summary = {
    status: failureState.error === undefined ? "complete" : "error",
    dataset: options.outputDirectory,
    counts: writer.snapshotCounts(),
  };
  console.log(JSON.stringify(summary));
  if (options.comparison !== null) {
    sendToOrchestrator({
      kind: "collector-complete",
      feedId: options.comparison.feedId,
      atUnixMs: Date.now(),
      counts: writer.snapshotCounts(),
    });
  }
  if (failureState.error !== undefined) throw failureState.error;
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  const orchestratedWindow = await awaitOrchestratedWindow(options);
  if (orchestratedWindow !== null) await waitUntil(orchestratedWindow.startAtUnixMs);
  try {
    await run(options, orchestratedWindow);
  } finally {
    if (process.connected) process.disconnect();
  }
}

void main().catch((error: unknown) => {
  console.error(redactSecrets(error instanceof Error ? error.message : String(error), [process.env.HELIUS_API_KEY ?? ""]));
  process.exitCode = 1;
});
