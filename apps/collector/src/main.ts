import { basename, resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { hostname } from "node:os";
import {
  bigintSafeJsonStringify,
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
import {
  DatasetWriter,
  CloudResearchSink,
  downloadGcsFile,
  type ResearchSink,
  type CloudChunkMetadata,
  type CloudDiagnosticsChunkMetadata,
} from "@botwiner/storage";
import {
  GraduationTracker,
  FirestoreTelemetryReporter,
  PaperTradingEngine,
  MultiPortfolioEngine,
  TraderPnlTracker,
  createCheckpointFromEngines,
  restoreEnginesFromCheckpoint,
  deserializeCheckpoint,
  serializeCheckpoint,
  type CheckpointCursor,
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
  readonly telemetry: "none" | "cloud";
  readonly telemetryHeartbeatIntervalSeconds: number;
  readonly telemetryStatsIntervalSeconds: number;
  readonly sessionId: string;
  readonly segmentId: string;
  readonly segmentIndex: number;
  readonly totalSegmentsExpected: number;
  readonly segmentDurationSeconds: number;
  readonly logicalDurationSeconds: number;
  readonly checkpointPath: string | undefined;
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
    "  --telemetry <none|cloud>      Publish dashboard telemetry independently of the data sink",
    "  --telemetry-heartbeat-seconds <n>  Dashboard heartbeat interval (default: 60)",
    "  --telemetry-stats-seconds <n>      Dashboard stats interval (default: 1800 for local hybrid)",
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
  let telemetry: "none" | "cloud" = sink === "cloud" ? "cloud" : "none";
  let telemetryWasExplicit = process.env.BOTWINER_TELEMETRY !== undefined;
  if (process.env.BOTWINER_TELEMETRY !== undefined) {
    if (process.env.BOTWINER_TELEMETRY !== "none" && process.env.BOTWINER_TELEMETRY !== "cloud") {
      throw new Error(`invalid BOTWINER_TELEMETRY: ${process.env.BOTWINER_TELEMETRY}`);
    }
    telemetry = process.env.BOTWINER_TELEMETRY;
  }
  const configuredHeartbeatSeconds = process.env.TELEMETRY_HEARTBEAT_INTERVAL_SECONDS ?? process.env.HEARTBEAT_INTERVAL_SECONDS;
  const configuredStatsSeconds = process.env.TELEMETRY_STATS_INTERVAL_SECONDS ?? process.env.STATS_FLUSH_INTERVAL_SECONDS;
  let telemetryHeartbeatIntervalSeconds = configuredHeartbeatSeconds === undefined ? 60 : Number(configuredHeartbeatSeconds);
  let telemetryStatsIntervalSeconds = configuredStatsSeconds === undefined ? 60 : Number(configuredStatsSeconds);
  let telemetryStatsWasExplicit = configuredStatsSeconds !== undefined;
  let sessionId = process.env.RESEARCH_SESSION_ID ?? basename(outputDirectory);
  let segmentIndex = Number(process.env.RESEARCH_SEGMENT_INDEX ?? "1");
  let segmentDurationSeconds = Number(process.env.RESEARCH_SEGMENT_DURATION_SECONDS ?? "1800");
  let logicalDurationSeconds = Number(
    process.env.RESEARCH_LOGICAL_DURATION_SECONDS ?? (durationSeconds ?? segmentDurationSeconds)
  );
  let checkpointPath: string | undefined = process.env.RESEARCH_CHECKPOINT_PATH;
  let totalSegmentsExpected = Number(
    process.env.RESEARCH_TOTAL_SEGMENTS ?? Math.max(1, Math.ceil(logicalDurationSeconds / segmentDurationSeconds))
  );
  let segmentId =
    process.env.RESEARCH_SEGMENT_ID ?? `${sessionId}-seg-${String(segmentIndex).padStart(4, "0")}`;
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
        telemetry,
        telemetryHeartbeatIntervalSeconds,
        telemetryStatsIntervalSeconds,
        sessionId,
        segmentId,
        segmentIndex,
        totalSegmentsExpected,
        segmentDurationSeconds,
        logicalDurationSeconds,
        checkpointPath,
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
    if (argument === "--segment-index") {
      const raw = requireNext(arguments_, index, argument);
      segmentIndex = Number(raw);
      index += 1;
      continue;
    }
    if (argument === "--segment-id") {
      segmentId = requireNext(arguments_, index, argument);
      index += 1;
      continue;
    }
    if (argument === "--segment-duration-seconds") {
      const raw = requireNext(arguments_, index, argument);
      segmentDurationSeconds = Number(raw);
      index += 1;
      continue;
    }
    if (argument === "--logical-duration-seconds") {
      const raw = requireNext(arguments_, index, argument);
      logicalDurationSeconds = Number(raw);
      index += 1;
      continue;
    }
    if (argument === "--checkpoint-path") {
      checkpointPath = requireNext(arguments_, index, argument);
      index += 1;
      continue;
    }
    if (argument === "--total-segments") {
      const raw = requireNext(arguments_, index, argument);
      totalSegmentsExpected = Number(raw);
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
    if (argument === "--telemetry") {
      const t = requireNext(arguments_, index, argument);
      if (t !== "none" && t !== "cloud") throw new Error(`invalid telemetry: ${t}`);
      telemetry = t;
      telemetryWasExplicit = true;
      index += 1;
      continue;
    }
    if (argument === "--telemetry-heartbeat-seconds") {
      const raw = requireNext(arguments_, index, argument);
      telemetryHeartbeatIntervalSeconds = Number(raw);
      index += 1;
      continue;
    }
    if (argument === "--telemetry-stats-seconds") {
      const raw = requireNext(arguments_, index, argument);
      telemetryStatsIntervalSeconds = Number(raw);
      telemetryStatsWasExplicit = true;
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
  if (!telemetryWasExplicit) telemetry = sink === "cloud" ? "cloud" : "none";
  if (!telemetryStatsWasExplicit && sink === "local" && telemetry === "cloud") {
    telemetryStatsIntervalSeconds = 1_800;
  }
  if (!Number.isFinite(telemetryHeartbeatIntervalSeconds) || telemetryHeartbeatIntervalSeconds < 5) {
    throw new Error("telemetry heartbeat interval must be at least 5 seconds");
  }
  if (!Number.isFinite(telemetryStatsIntervalSeconds) || telemetryStatsIntervalSeconds < 1) {
    throw new Error("telemetry stats interval must be at least 1 second");
  }
  if (endpointLabel.length === 0 || endpointLabel.length > 100 || /[?&#@=\s]/u.test(endpointLabel)) {
    throw new Error("endpoint label must not contain credentials, query parameters, or whitespace");
  }

  // Calculate this worker process's run duration
  if (durationSeconds !== null && process.env.RESEARCH_LOGICAL_DURATION_SECONDS === undefined && !arguments_.includes("--logical-duration-seconds")) {
    logicalDurationSeconds = durationSeconds;
    if (process.env.RESEARCH_SEGMENT_DURATION_SECONDS === undefined && !arguments_.includes("--segment-duration-seconds")) {
      segmentDurationSeconds = durationSeconds;
      totalSegmentsExpected = 1;
    }
  }

  const remainingLogicalSec = Math.max(0, logicalDurationSeconds - segmentIndex * segmentDurationSeconds);
  const thisSegmentDuration = Math.min(segmentDurationSeconds, remainingLogicalSec > 0 ? remainingLogicalSec : segmentDurationSeconds);
  durationSeconds = thisSegmentDuration;
  if (!segmentId || (segmentId === `${sessionId}-s0` && segmentIndex > 0)) {
    segmentId = `${sessionId}-s${segmentIndex}`;
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
    telemetry,
    telemetryHeartbeatIntervalSeconds,
    telemetryStatsIntervalSeconds,
    sessionId,
    segmentId,
    segmentIndex,
    totalSegmentsExpected,
    segmentDurationSeconds,
    logicalDurationSeconds,
    checkpointPath,
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
  let storageShutdownError: unknown = null;
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

  const portfolios = new MultiPortfolioEngine();
  let portfolioTelemetryAt = 0;
  const updatePortfolioTelemetry = (): void => {
    const now = Date.now();
    if (now - portfolioTelemetryAt >= 5000) {
      telemetryReporter?.updatePortfolioStats(portfolios.summary(true));
      portfolioTelemetryAt = now;
    }
  };
  const paperTradingEngine = new PaperTradingEngine({
    onPositionOpened: (pos) => {
      telemetryReporter?.queuePaperTrade(pos);
    },
    onPositionClosed: (pos) => {
      telemetryReporter?.queuePaperTrade(pos);
    },
  });

  const traderPnlTracker = new TraderPnlTracker();

  const seenEventIds = new Set<string>();
  const recentEventIds: string[] = [];
  let handoffGapMs: number | null = null;
  let handoffOverlapCount = 0;
  let lastEventCursor: CheckpointCursor | null = null;
  let lastCheckpointCursor: CheckpointCursor | null = null;
  let initialChunkIndex = 1;
  let initialCompressedBytes = 0;
  const initialChunks: CloudChunkMetadata[] = [];
  const initialDiagnosticChunks: CloudDiagnosticsChunkMetadata[] = [];

  const createTelemetryReporter = (): FirestoreTelemetryReporter =>
    new FirestoreTelemetryReporter({
      sessionId: options.sessionId,
      segmentId: options.segmentId,
      segmentIndex: options.segmentIndex,
      totalSegmentsExpected: options.totalSegmentsExpected,
      mode: process.env.RESEARCH_MODE ?? (options.sink === "local" ? "graduation-research-local" : "graduation-research"),
      provider: options.feedProvider,
      region: options.sink === "local" ? "local" : process.env.GCP_REGION ?? "europe-west3",
      requestedDurationSec: options.logicalDurationSeconds,
      gcpProjectId: process.env.GCP_PROJECT_ID ?? "your-gcp-project-id",
      firestoreDatabase: process.env.FIRESTORE_DATABASE ?? "(default)",
      firestoreOperationTimeoutMs:
        options.sink === "local"
          ? (() => {
              const configured = Number(process.env.TELEMETRY_OPERATION_TIMEOUT_MS ?? "5000");
              return Number.isFinite(configured) && configured > 0 ? configured : 5_000;
            })()
          : undefined,
      heartbeatIntervalMs: options.telemetryHeartbeatIntervalSeconds * 1000,
      statsIntervalMs: options.telemetryStatsIntervalSeconds * 1000,
      writePaperTradesImmediately: options.sink === "cloud",
    });

  if (options.checkpointPath) {
    try {
      console.log(`[Collector] Restoring state from checkpoint: ${options.checkpointPath}`);
      let rawJson: string;
      if (options.sink === "cloud") {
        const bucket = process.env.GCS_BUCKET ?? "your-gcs-bucket";
        const projectId = process.env.GCP_PROJECT_ID ?? "your-gcp-project-id";
        const buffer = await downloadGcsFile(bucket, options.checkpointPath, projectId);
        rawJson = buffer.toString("utf8");
      } else {
        rawJson = await readFile(resolve(options.checkpointPath), "utf8");
      }
      const checkpoint = deserializeCheckpoint(rawJson);
      restoreEnginesFromCheckpoint(checkpoint, {
        portfolios,
        paperTrading: paperTradingEngine,
        traderPnl: traderPnlTracker,
      });
      for (const id of checkpoint.recentEventIds) {
        seenEventIds.add(id);
      }
      recentEventIds.push(...checkpoint.recentEventIds);
      lastCheckpointCursor = checkpoint.cursor;
      lastEventCursor = checkpoint.cursor;
      sequence = checkpoint.cursor.collectorSequence;
      initialChunkIndex = checkpoint.lastCommittedChunkIndex + 1;
      initialCompressedBytes = checkpoint.totalCompressedBytes;
      if (checkpoint.completedChunks) {
        initialChunks.push(...checkpoint.completedChunks);
      }
      if (checkpoint.completedDiagnosticChunks) {
        initialDiagnosticChunks.push(...checkpoint.completedDiagnosticChunks);
      }
      console.log(
        `[Collector] Restored state from checkpoint "${options.checkpointPath}": cursor lastEventTimestampMs=${checkpoint.cursor.lastEventTimestampMs}, openPositions=${portfolios.summary().portfolios[0]?.openPositions ?? 0}, nextChunk=${initialChunkIndex}`
      );
    } catch (err) {
      console.error(`[Collector] Failed to restore from checkpoint "${options.checkpointPath}":`, err);
      throw err;
    }
  }

  if (options.telemetry === "cloud") {
    telemetryReporter = createTelemetryReporter();
    await telemetryReporter.initialize();
    try {
      await telemetryReporter.recordSegmentStart({
        segmentId: options.segmentId,
        segmentIndex: options.segmentIndex,
        totalSegmentsExpected: options.totalSegmentsExpected,
        checkpointPath: options.checkpointPath,
      });
    } catch (error) {
      if (options.sink === "cloud") throw error;
      console.warn("[Collector] Local capture could not publish telemetry start; continuing locally:", error);
    }
  }

  if (options.sink === "cloud") {
    const bucket = process.env.GCS_BUCKET ?? "your-gcs-bucket";
    const projectId = process.env.GCP_PROJECT_ID ?? "your-gcp-project-id";
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
      startChunkIndex: initialChunkIndex,
      initialChunks,
      initialDiagnosticChunks,
      initialCompressedBytes,
      onChunkRotated: (chunk) => {
        telemetryReporter?.updateChunkAndBytes(chunk.index, cloudSink?.getTotalCompressedBytes() ?? 0);
      },
      onTerminalError: (err) => {
        console.error("[Collector] Terminal storage error callback triggered:", err);
        fail(err);
      },
    });
    writer = cloudSink;
    telemetryReporter?.markRunning();
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
    telemetryReporter?.markRunning();
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
        try {
          await writer.recordDiagnostic({
            schemaVersion: 1,
            kind: "diagnostic",
            code: "clock-offset-unavailable",
            atUnixMs: Date.now(),
            message: "SNTP clock-offset sample failed",
            sequence: null,
            details: { host: options.ntpHost, error: error instanceof Error ? error.message : String(error) },
          });
        } catch (diagErr) {
          console.warn("[Collector] Failed to record clock-offset diagnostic:", diagErr);
        }
      }
    };
    await recordClockSample();
    clockSampleTimer = setInterval(() => {
      clockSampleQueue = clockSampleQueue
        .then(recordClockSample)
        .catch((err) => {
          console.warn("[Collector] Background clock sample queue error:", err);
        });
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

  function handleEvents(events: readonly NormalizedMarketEvent[]): readonly NormalizedMarketEvent[] {
    const acceptedEvents: NormalizedMarketEvent[] = [];
    for (const event of events) {
      if (seenEventIds.has(event.eventId)) {
        handoffOverlapCount += 1;
        continue;
      }
      seenEventIds.add(event.eventId);
      recentEventIds.push(event.eventId);
      if (recentEventIds.length > 10_000) {
        recentEventIds.shift();
      }

      if (lastCheckpointCursor !== null && handoffGapMs === null) {
        handoffGapMs = Math.max(0, event.timestamps.collectorReceivedAtUnixMs - lastCheckpointCursor.lastEventTimestampMs);
        console.log(
          `[Collector] Handoff gap measured: ${handoffGapMs}ms from checkpoint at ${lastCheckpointCursor.lastEventTimestampMs}`
        );
      }

      lastEventCursor = {
        collectorSequence: sequence,
        transactionLogIndex: 0,
        slot: event.ordering.slot,
        lastEventId: event.eventId,
        lastEventTimestampMs: event.timestamps.collectorReceivedAtUnixMs,
      };

      portfolios.onEvent(event);
      if (event.eventType === "launch") {
        graduationTracker.onLaunch(event);
        paperTradingEngine.onLaunch(event);
        traderPnlTracker.onLaunch(event);
      } else if (event.eventType === "trade") {
        graduationTracker.onTrade(event);
        paperTradingEngine.onTrade(event);
        traderPnlTracker.onTrade(event);
      }
      acceptedEvents.push(event);
    }
    return acceptedEvents;
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
    handleEvents(finalEvents);

    if (telemetryReporter !== null) {
      telemetryReporter.updateTelemetry(
        writer.snapshotCounts(),
        graduationTracker.getSummaryCounters(),
        raw.capture.receivedAtIso,
      );
      updatePortfolioTelemetry();
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
    handleEvents(finalEvents);

    if (telemetryReporter !== null) {
      telemetryReporter.updateTelemetry(
        writer.snapshotCounts(),
        graduationTracker.getSummaryCounters(),
        raw.capture.receivedAtIso,
      );
      updatePortfolioTelemetry();
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
      bigintSafeJsonStringify({
        status: "collecting",
        dataset: options.outputDirectory,
        sessionId: options.sessionId,
        segmentId: options.segmentId,
        segmentIndex: options.segmentIndex,
        totalSegmentsExpected: options.totalSegmentsExpected,
        segmentDurationSeconds: options.segmentDurationSeconds,
        logicalDurationSeconds: options.logicalDurationSeconds,
        endpointLabel,
        commitment: options.commitment,
        programId: PUMP_PROGRAM_ID,
        durationSeconds: options.durationSeconds,
        transport: options.transport,
        sink: options.sink,
        telemetry: options.telemetry,
        telemetryHeartbeatIntervalSeconds: options.telemetryHeartbeatIntervalSeconds,
        telemetryStatsIntervalSeconds: options.telemetryStatsIntervalSeconds,
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
    try {
      await clockSampleQueue;
    } catch (clockQueueErr) {
      console.warn("[Collector] Clock sample queue drained with error:", clockQueueErr);
    }
    process.removeListener("SIGINT", stopForSignal);
    process.removeListener("SIGTERM", stopForSignal);

    const isFinalSegment = options.segmentIndex >= options.totalSegmentsExpected;
    const hasFailure = failureState.error !== undefined || storageShutdownError !== null;
    const isCleanSegmentComplete = !hasFailure && !stoppedBySignal;

    if (isFinalSegment || !isCleanSegmentComplete) {
      paperTradingEngine.onSessionEnd(Date.now());
      portfolios.onSessionEnd();
    }

    if (telemetryReporter !== null) {
      updatePortfolioTelemetry();
      telemetryReporter.updatePaperStats(paperTradingEngine.getStats());
      telemetryReporter.updateMarketParticipantStats(traderPnlTracker.getStats());
    }

    const finalStatus = isCleanSegmentComplete ? "complete" : "aborted";
    try {
      await writer.close(finalStatus);
    } catch (storageErr) {
      storageShutdownError = storageErr;
      console.error("[Collector] Storage shutdown error:", storageErr);
    }

    let checkpointGcsPath: string | undefined;
    if (cloudSink !== null && isCleanSegmentComplete && !isFinalSegment) {
      try {
        const checkpoint = createCheckpointFromEngines({
          sessionId: options.sessionId,
          segmentId: options.segmentId,
          segmentIndex: options.segmentIndex,
          cursor: lastEventCursor ?? lastCheckpointCursor ?? {
            collectorSequence: sequence,
            transactionLogIndex: 0,
            lastEventTimestampMs: Date.now(),
          },
          recentEventIds,
          datasetCounts: writer.snapshotCounts(),
          lastCommittedChunkIndex: cloudSink.getLastCommittedChunkIndex(),
          totalCompressedBytes: cloudSink.getTotalCompressedBytes(),
          completedChunks: cloudSink.getChunks(),
          completedDiagnosticChunks: cloudSink.getDiagnosticChunks(),
          portfolios,
          paperTrading: paperTradingEngine,
          traderPnl: traderPnlTracker,
        });

        const checkpointFileName = `checkpoints/checkpoint-${options.segmentId}.json`;
        checkpointGcsPath = `sessions/${options.sessionId}/${checkpointFileName}`;
        await cloudSink.getUploader().uploadBuffer(
          checkpointGcsPath,
          Buffer.from(serializeCheckpoint(checkpoint), "utf8"),
          "application/json"
        );
        console.log(`[Collector] Persisted durable checkpoint to ${checkpointGcsPath}`);

        if (telemetryReporter !== null) {
          await telemetryReporter.recordSegmentCheckpoint(checkpointGcsPath, {
            cursor: checkpoint.cursor,
          });
          await telemetryReporter.recordSegmentComplete({
            status: "completed",
            checkpointPath: checkpointGcsPath,
            chunksWritten: cloudSink.getChunks().length,
            handoffGapMs,
            handoffOverlapCount,
            lastCommittedChunkIndex: cloudSink.getLastCommittedChunkIndex(),
          });
          const nextSegmentId = `${options.sessionId}-seg-${String(options.segmentIndex + 1).padStart(4, "0")}`;
          await telemetryReporter.closeSegment(options.segmentId, options.segmentIndex, nextSegmentId);
        }
      } catch (checkpointErr) {
        console.error("[Collector] Failed to persist segment checkpoint:", checkpointErr);
        storageShutdownError = checkpointErr;
      }
    }

    if (cloudSink !== null && isCleanSegmentComplete && isFinalSegment) {
      try {
        await cloudSink.uploadDerivedSummary("portfolio-summary", portfolios.summary());
        await cloudSink.uploadDerivedSummary("paper-trading-summary", paperTradingEngine.getStats());
        await cloudSink.uploadDerivedSummary("participant-analytics-summary", traderPnlTracker.getStats());
        await cloudSink.syncManifest();
        console.log(`[Collector] Final segment complete. Uploaded derived summaries and finalized manifest.`);
      } catch (err) {
        storageShutdownError = err;
        console.warn("[Collector] Failed to upload derived summaries to GCS:", err);
      }
    }

    if (telemetryReporter !== null) {
      if (hasFailure || stoppedBySignal) {
        const finalStatusToReport = stoppedBySignal ? "cancelled" : "failed";
        const errorToReport = failureState.error ?? storageShutdownError;
        const errorMsg =
          errorToReport instanceof Error
            ? errorToReport.message
            : typeof errorToReport === "string"
              ? errorToReport
              : JSON.stringify(errorToReport);
        if (errorToReport) {
          telemetryReporter.reportError(errorMsg);
        }
        try {
          await telemetryReporter.recordSegmentComplete({
            status: finalStatusToReport,
            checkpointPath: options.checkpointPath ?? null,
            error: errorToReport ? errorMsg : null,
          });
          await telemetryReporter.close(finalStatusToReport);
        } catch (telemetryErr) {
          console.error("[Collector] Telemetry cleanup error during failure shutdown:", telemetryErr);
        }
      } else if (isFinalSegment) {
        try {
          await telemetryReporter.recordSegmentComplete({
            status: "completed",
            finalSegment: true,
            chunksWritten: cloudSink?.getChunks().length ?? 0,
            handoffGapMs,
            handoffOverlapCount,
          });
          await telemetryReporter.close("completed");
        } catch (telemetryErr) {
          console.error("[Collector] Telemetry cleanup error during final shutdown:", telemetryErr);
        }
      }
    }

    // Auto-dispatch next segment if running in cloud and segment completed cleanly:
    if (options.sink === "cloud" && isCleanSegmentComplete && !isFinalSegment && checkpointGcsPath) {
      try {
        const nextSegmentIndex = options.segmentIndex + 1;
        const nextSegmentId = `${options.sessionId}-seg-${String(nextSegmentIndex).padStart(4, "0")}`;
        console.log(`[Collector] Dispatching next segment ${nextSegmentIndex}/${options.totalSegmentsExpected} (${nextSegmentId})`);

        const { JobsClient } = await import("@google-cloud/run");
        const projectId = process.env.GCP_PROJECT_ID ?? "your-gcp-project-id";
        const region = process.env.GCP_REGION ?? "europe-west3";
        const jobName = process.env.CLOUD_RUN_JOB_NAME ?? "pump-collector-runner";
        const jobFullName = `projects/${projectId}/locations/${region}/jobs/${jobName}`;

        const jobsClient = new JobsClient();
        const [operation] = await jobsClient.runJob({
          name: jobFullName,
          overrides: {
            containerOverrides: [
              {
                env: [
                  { name: "RESEARCH_SESSION_ID", value: options.sessionId },
                  { name: "RESEARCH_SEGMENT_INDEX", value: String(nextSegmentIndex) },
                  { name: "RESEARCH_SEGMENT_ID", value: nextSegmentId },
                  { name: "RESEARCH_TOTAL_SEGMENTS", value: String(options.totalSegmentsExpected) },
                  { name: "RESEARCH_SEGMENT_DURATION_SECONDS", value: String(options.segmentDurationSeconds) },
                  { name: "RESEARCH_LOGICAL_DURATION_SECONDS", value: String(options.logicalDurationSeconds) },
                  { name: "RESEARCH_CHECKPOINT_PATH", value: checkpointGcsPath },
                  { name: "RESEARCH_MODE", value: process.env.RESEARCH_MODE ?? "graduation-research" },
                  { name: "GCS_BUCKET", value: process.env.GCS_BUCKET ?? "your-gcs-bucket" },
                  { name: "GCP_PROJECT_ID", value: projectId },
                  { name: "GCP_REGION", value: region },
                  { name: "BOTWINER_FEED_PROVIDER", value: options.feedProvider },
                  { name: "BOTWINER_SINK", value: "cloud" },
                ],
              },
            ],
          },
        });
        console.log(`[Collector] Successfully dispatched Cloud Run Job execution for ${nextSegmentId}: ${operation.name ?? "unnamed"}`);
      } catch (dispatchErr) {
        console.error("[Collector] Failed to dispatch next segment Cloud Run Job:", dispatchErr);
      }
    }
  }

  const summary = {
    status: failureState.error === undefined && storageShutdownError === null ? "complete" : "error",
    dataset: options.outputDirectory,
    counts: writer.snapshotCounts(),
  };
  console.log(bigintSafeJsonStringify(summary));
  if (options.comparison !== null) {
    sendToOrchestrator({
      kind: "collector-complete",
      feedId: options.comparison.feedId,
      atUnixMs: Date.now(),
      counts: writer.snapshotCounts(),
    });
  }
  if (failureState.error !== undefined) throw failureState.error;
  if (storageShutdownError !== null) {
    throw storageShutdownError instanceof Error
      ? storageShutdownError
      : new Error(typeof storageShutdownError === "string" ? storageShutdownError : bigintSafeJsonStringify(storageShutdownError));
  }
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
