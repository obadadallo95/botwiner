import { randomUUID } from "node:crypto";
import { fork, type ChildProcess } from "node:child_process";
import { mkdir, rename, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  CANDIDATE_ENDPOINT_LABEL,
  CALIBRATION_MAXIMUM_UNCERTAINTY_MS,
  CALIBRATION_MAXIMUM_WALL_RESIDUAL_MS,
  DEFAULT_TIE_TOLERANCE_MS,
  PUBLIC_ENDPOINT_LABEL,
  analyzeFeedComparison,
  buildTimingCalibration,
  childExitRequiresAbort,
  localHostFingerprint,
  redactSecret,
  secretAppearsInFiles,
  validateCollectorStartupPair,
  writeFeedComparisonReports,
  type CalibrationExchange,
  type CollectorStartupTuple,
  type ComparisonFeedId,
  type FeedComparisonManifest,
  type OrchestratorBaseline,
} from "@botwiner/research";
import {
  PUMP_IDL_REVISION,
  PUMP_PARSING_VERSION,
  PUMP_PROGRAM_ID,
} from "@botwiner/pumpfun";

interface CliOptions {
  readonly outputDirectory: string;
  readonly comparisonId: string;
  readonly durationSeconds: number;
  readonly windowDurationSeconds: number;
  readonly tieToleranceMs: number;
  readonly baselineProvider: "public" | "helius";
  readonly candidateProvider: "helius" | "yellowstone";
  readonly grpcEndpoint: string;
  readonly grpcToken: string | undefined;
}

interface ExitResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly atUnixMs: number;
}

interface PendingPing {
  readonly sentMonotonicNs: bigint;
  readonly resolve: (exchange: CalibrationExchange) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

function usage(): string {
  return [
    "Usage: pnpm comparison:run [options]",
    "",
    "Options:",
    "  --output <directory>                   Parent comparison directory",
    "  --comparison-id <id>                   Stable sanitized comparison id",
    "  --duration-seconds <seconds>           Simultaneous collection window (default: 300)",
    "  --window-duration-seconds <seconds>    Slice duration for stability windows (default: 300)",
    "  --tie-tolerance-ms <ms>                First-arrival tie tolerance (default: 1)",
    "  --baseline-provider <provider>         public (default) or helius",
    "  --candidate-provider <provider>        helius (default) or yellowstone",
    "  --grpc-endpoint <endpoint>             Yellowstone gRPC endpoint (prefer YELLOWSTONE_GRPC_ENDPOINT)",
    "  --grpc-token <token>                   Yellowstone gRPC token (prefer YELLOWSTONE_GRPC_TOKEN)",
    "  --help                                 Show this help",
  ].join("\n");
}

function requireNext(arguments_: readonly string[], index: number, option: string): string {
  const value = arguments_[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${option} requires a value`);
  return value;
}

function defaultComparisonId(): string {
  return `phase-2-5b-${new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-")}`;
}

function parseArguments(arguments_: readonly string[]): CliOptions | null {
  let comparisonId = defaultComparisonId();
  let outputDirectory: string | null = null;
  let durationSeconds = 300;
  let windowDurationSeconds = 300;
  let tieToleranceMs = DEFAULT_TIE_TOLERANCE_MS;
  let baselineProvider: "public" | "helius" =
    process.env.BOTWINER_BASELINE_PROVIDER === "helius" ? "helius" : "public";
  let candidateProvider: "helius" | "yellowstone" =
    process.env.BOTWINER_CANDIDATE_PROVIDER === "yellowstone" ? "yellowstone" : "helius";
  let grpcEndpoint = process.env.YELLOWSTONE_GRPC_ENDPOINT ?? "";
  let grpcToken = process.env.YELLOWSTONE_GRPC_TOKEN;

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--help") return null;
    if (argument === "--output") {
      outputDirectory = resolve(requireNext(arguments_, index, argument));
      index += 1;
      continue;
    }
    if (argument === "--comparison-id") {
      comparisonId = requireNext(arguments_, index, argument);
      index += 1;
      continue;
    }
    if (argument === "--duration-seconds") {
      durationSeconds = Number(requireNext(arguments_, index, argument));
      index += 1;
      continue;
    }
    if (argument === "--window-duration-seconds") {
      windowDurationSeconds = Number(requireNext(arguments_, index, argument));
      index += 1;
      continue;
    }
    if (argument === "--tie-tolerance-ms") {
      tieToleranceMs = Number(requireNext(arguments_, index, argument));
      index += 1;
      continue;
    }
    if (argument === "--baseline-provider") {
      const p = requireNext(arguments_, index, argument);
      if (p !== "public" && p !== "helius") throw new Error(`invalid baseline provider: ${p}`);
      baselineProvider = p;
      index += 1;
      continue;
    }
    if (argument === "--candidate-provider") {
      const p = requireNext(arguments_, index, argument);
      if (p !== "helius" && p !== "yellowstone") throw new Error(`invalid candidate provider: ${p}`);
      candidateProvider = p;
      index += 1;
      continue;
    }
    if (argument === "--grpc-endpoint") {
      grpcEndpoint = requireNext(arguments_, index, argument);
      candidateProvider = "yellowstone";
      index += 1;
      continue;
    }
    if (argument === "--grpc-token") {
      grpcToken = requireNext(arguments_, index, argument);
      index += 1;
      continue;
    }
    throw new Error(`unknown argument: ${argument}`);
  }
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/u.test(comparisonId)) {
    throw new Error("comparison id must be lowercase alphanumeric/hyphen and at most 80 characters");
  }
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error("duration must be a positive number of seconds");
  }
  if (!Number.isFinite(windowDurationSeconds) || windowDurationSeconds <= 0) {
    throw new Error("window duration must be a positive number of seconds");
  }
  if (!Number.isFinite(tieToleranceMs) || tieToleranceMs < 0) {
    throw new Error("tie tolerance must be a non-negative number");
  }
  return {
    comparisonId,
    outputDirectory: outputDirectory ?? resolve("data", "comparisons", comparisonId),
    durationSeconds,
    windowDurationSeconds,
    tieToleranceMs,
    baselineProvider,
    candidateProvider,
    grpcEndpoint,
    grpcToken,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

class ManagedCollector {
  public readonly process: ChildProcess;
  public readonly exit: Promise<ExitResult>;
  public startup: CollectorStartupTuple | null = null;
  public subscriptionConfirmedAtUnixMs: number | null = null;
  public progress: Record<string, unknown> = {};
  private readonly pendingPings = new Map<string, PendingPing>();
  private resolveReady: ((startup: CollectorStartupTuple) => void) | null = null;
  private rejectReady: ((error: Error) => void) | null = null;
  private resolveActive: ((atUnixMs: number) => void) | null = null;
  private rejectActive: ((error: Error) => void) | null = null;
  public readonly ready: Promise<CollectorStartupTuple>;
  public readonly active: Promise<number>;
  public readonly stderr: string[] = [];

  public constructor(
    public readonly feedId: ComparisonFeedId,
    outputDirectory: string,
    comparisonId: string,
    provider: "public" | "helius" | "yellowstone",
    endpointLabel: string,
    credentials: {
      heliusApiKey?: string | undefined;
      grpcEndpoint?: string | undefined;
      grpcToken?: string | undefined;
    },
  ) {
    const environment = { ...process.env };
    environment.BOTWINER_ORCHESTRATED = "1";
    environment.BOTWINER_COMPARISON_ID = comparisonId;
    environment.BOTWINER_FEED_ID = feedId;
    environment.BOTWINER_ENDPOINT_LABEL = endpointLabel;
    environment.BOTWINER_FEED_PROVIDER = provider;
    if (provider === "yellowstone") {
      environment.BOTWINER_TRANSPORT = "yellowstone-grpc";
      if (credentials.grpcEndpoint) environment.YELLOWSTONE_GRPC_ENDPOINT = credentials.grpcEndpoint;
      if (credentials.grpcToken) environment.YELLOWSTONE_GRPC_TOKEN = credentials.grpcToken;
      delete environment.HELIUS_API_KEY;
    } else if (provider === "helius") {
      environment.BOTWINER_TRANSPORT = "solana-rpc-websocket";
      if (credentials.heliusApiKey) environment.HELIUS_API_KEY = credentials.heliusApiKey;
      delete environment.YELLOWSTONE_GRPC_ENDPOINT;
      delete environment.YELLOWSTONE_GRPC_TOKEN;
    } else {
      environment.BOTWINER_TRANSPORT = "solana-rpc-websocket";
      delete environment.HELIUS_API_KEY;
      delete environment.YELLOWSTONE_GRPC_ENDPOINT;
      delete environment.YELLOWSTONE_GRPC_TOKEN;
    }
    const collectorPath = resolve("apps", "collector", "src", "main.ts");
    this.process = fork(
      collectorPath,
      ["--output", outputDirectory, "--commitment", "processed", "--disable-ntp"],
      {
        env: environment,
        execArgv: ["--import", "tsx"],
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      },
    );
    this.exit = new Promise<ExitResult>((resolveExit) => {
      this.process.once("exit", (code, signal) => {
        const error = new Error(`${this.feedId} collector exited before completing startup`);
        this.rejectReady?.(error);
        this.rejectActive?.(error);
        for (const pending of this.pendingPings.values()) {
          clearTimeout(pending.timer);
          pending.reject(error);
        }
        this.pendingPings.clear();
        resolveExit({ code, signal, atUnixMs: Date.now() });
      });
    });
    this.ready = new Promise<CollectorStartupTuple>((resolveReady, rejectReady) => {
      this.resolveReady = resolveReady;
      this.rejectReady = rejectReady;
    });
    this.active = new Promise<number>((resolveActive, rejectActive) => {
      this.resolveActive = resolveActive;
      this.rejectActive = rejectActive;
    });
    this.process.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      this.stderr.push(text);
    });
    this.process.on("message", (message: unknown) => {
      if (!isRecord(message)) return;
      if (message.kind === "collector-ready") {
        this.startup = message as unknown as CollectorStartupTuple;
        this.resolveReady?.(this.startup);
        return;
      }
      if (message.kind === "collector-diagnostic" && message.code === "subscription-confirmed") {
        this.subscriptionConfirmedAtUnixMs = Number(message.atUnixMs);
        this.resolveActive?.(this.subscriptionConfirmedAtUnixMs);
        return;
      }
      if (message.kind === "collector-progress" && isRecord(message.counts)) {
        this.progress = message.counts;
        return;
      }
      if (message.kind === "calibration-pong" && typeof message.pingId === "string") {
        const pending = this.pendingPings.get(message.pingId);
        if (pending === undefined) return;
        this.pendingPings.delete(message.pingId);
        clearTimeout(pending.timer);
        const parentReceivedMonotonicNs = process.hrtime.bigint();
        pending.resolve({
          parentSentMonotonicNs: pending.sentMonotonicNs.toString(),
          parentReceivedMonotonicNs: parentReceivedMonotonicNs.toString(),
          childMonotonicNs: String(message.childMonotonicNs),
          childWallUnixMs: Number(message.childWallUnixMs),
        });
      }
    });
  }

  public async calibrate(rounds = 7): Promise<readonly CalibrationExchange[]> {
    const exchanges: CalibrationExchange[] = [];
    for (let round = 0; round < rounds; round += 1) {
      const exchange = await this.ping();
      exchanges.push(exchange);
      await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 50));
    }
    return exchanges;
  }

  private ping(): Promise<CalibrationExchange> {
    return new Promise<CalibrationExchange>((resolvePing, rejectPing) => {
      const pingId = randomUUID();
      const sentMonotonicNs = process.hrtime.bigint();
      const timer = setTimeout(() => {
        this.pendingPings.delete(pingId);
        rejectPing(new Error(`calibration ping timed out for feed ${this.feedId}`));
      }, 5_000);
      this.pendingPings.set(pingId, {
        sentMonotonicNs,
        resolve: resolvePing,
        reject: rejectPing,
        timer,
      });
      this.process.send({ kind: "calibration-ping", pingId });
    });
  }

  public start(startAtUnixMs: number, stopAtUnixMs: number, calibrationId: string): void {
    this.process.send({ kind: "collector-start", startAtUnixMs, stopAtUnixMs, calibrationId });
  }

  public abort(): void {
    if (this.process.connected) this.process.send({ kind: "collector-abort" });
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolvePromise(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

async function writeManifest(directory: string, manifest: FeedComparisonManifest): Promise<void> {
  const temporary = join(directory, "comparison-manifest.json.tmp");
  const target = join(directory, "comparison-manifest.json");
  await writeFile(temporary, JSON.stringify(manifest, null, 2), "utf8");
  await rename(temporary, target);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function initialManifest(
  options: CliOptions,
  baseline: OrchestratorBaseline,
  publicEndpointLabel: string,
  candidateEndpointLabel: string,
): FeedComparisonManifest {
  return {
    schemaVersion: 1,
    kind: "feed-comparison-manifest",
    comparisonId: options.comparisonId,
    status: "starting",
    startedAt: new Date().toISOString(),
    endedAt: null,
    window: {
      requestedStartUnixMs: null,
      requestedEndUnixMs: null,
      durationSeconds: options.durationSeconds,
      windowDurationSeconds: options.windowDurationSeconds,
    },
    orchestrator: {
      processId: process.pid,
      hostFingerprint: localHostFingerprint(),
      wallBaselineUnixMs: baseline.wallUnixMs,
      monotonicBaselineNs: baseline.monotonicNs,
    },
    controls: {
      commitment: "processed",
      programId: PUMP_PROGRAM_ID,
      parserVersion: PUMP_PARSING_VERSION,
      idlRevision: PUMP_IDL_REVISION,
      tieToleranceMs: options.tieToleranceMs,
      calibrationMaximumUncertaintyMs: CALIBRATION_MAXIMUM_UNCERTAINTY_MS,
      calibrationMaximumWallResidualMs: CALIBRATION_MAXIMUM_WALL_RESIDUAL_MS,
    },
    feeds: {
      public: { dataset: "public", endpointLabel: publicEndpointLabel, processId: null },
      candidate: { dataset: "candidate", endpointLabel: candidateEndpointLabel, processId: null },
    },
    calibrations: { public: null, candidate: null },
    runtimeChecks: {
      bothCollectorsReady: false,
      bothCollectorsCompleted: false,
      apiKeyWasPresent: true,
      apiKeyPersisted: false,
    },
    failure: null,
    limitations: [
      options.candidateProvider === "yellowstone"
        ? "This is a same-host comparison of a WebSocket baseline against an independent Yellowstone gRPC feed."
        : "This is a same-host comparison of two standard logsSubscribe feeds, not Yellowstone/gRPC.",
      "Any credentials are passed into child-process memory and redacted from persisted manifests and reports.",
      "Standard logsSubscribe has no replay cursor; reconnect-era records are excluded from clean latency.",
    ],
  };
}

async function run(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  if (options === null) {
    console.log(usage());
    return;
  }
  const heliusApiKey = process.env.HELIUS_API_KEY;
  if (
    (options.baselineProvider === "helius" || options.candidateProvider === "helius") &&
    (heliusApiKey === undefined || heliusApiKey.length === 0)
  ) {
    throw new Error("HELIUS_API_KEY is required for the Helius comparison collector");
  }
  if (
    options.candidateProvider === "yellowstone" &&
    options.grpcEndpoint.length === 0
  ) {
    throw new Error("YELLOWSTONE_GRPC_ENDPOINT is required when using Yellowstone gRPC candidate");
  }
  const baseline: OrchestratorBaseline = {
    wallUnixMs: Date.now(),
    monotonicNs: process.hrtime.bigint().toString(),
  };
  if (await pathExists(options.outputDirectory)) {
    throw new Error("comparison output directory already exists; refusing to overwrite evidence");
  }
  await mkdir(options.outputDirectory, { recursive: true });

  const publicEndpointLabel =
    options.baselineProvider === "helius" ? CANDIDATE_ENDPOINT_LABEL : PUBLIC_ENDPOINT_LABEL;
  const candidateEndpointLabel =
    options.candidateProvider === "yellowstone" ? "yellowstone-grpc" : CANDIDATE_ENDPOINT_LABEL;

  let manifest = initialManifest(options, baseline, publicEndpointLabel, candidateEndpointLabel);
  await writeManifest(options.outputDirectory, manifest);

  const credentials = {
    heliusApiKey,
    grpcEndpoint: options.grpcEndpoint,
    grpcToken: options.grpcToken,
  };
  const publicCollector = new ManagedCollector(
    "public",
    join(options.outputDirectory, "public"),
    options.comparisonId,
    options.baselineProvider,
    publicEndpointLabel,
    credentials,
  );
  const candidateCollector = new ManagedCollector(
    "candidate",
    join(options.outputDirectory, "candidate"),
    options.comparisonId,
    options.candidateProvider,
    candidateEndpointLabel,
    credentials,
  );
  const collectors = [publicCollector, candidateCollector] as const;

  try {
    const [publicStartup, candidateStartup] = await withTimeout(
      Promise.all([publicCollector.ready, candidateCollector.ready]),
      15_000,
      "comparison aborted: both collectors did not become ready within 15 seconds",
    );
    validateCollectorStartupPair(publicStartup, candidateStartup);
    if (publicStartup.hostFingerprint !== localHostFingerprint()) {
      throw new Error("comparison aborted: child host does not match orchestrator host");
    }
    const [publicExchanges, candidateExchanges] = await Promise.all([
      publicCollector.calibrate(),
      candidateCollector.calibrate(),
    ]);
    const publicCalibrationId = `public-${randomUUID()}`;
    const candidateCalibrationId = `candidate-${randomUUID()}`;
    const publicCalibration = buildTimingCalibration(
      publicCalibrationId,
      publicStartup,
      baseline,
      publicExchanges,
    );
    const candidateCalibration = buildTimingCalibration(
      candidateCalibrationId,
      candidateStartup,
      baseline,
      candidateExchanges,
    );
    if (!publicCalibration.valid || !candidateCalibration.valid) {
      throw new Error("comparison aborted: startup timing calibration failed validation");
    }
    const startAtUnixMs = Date.now() + 1_000;
    const stopAtUnixMs = startAtUnixMs + options.durationSeconds * 1_000;
    manifest = {
      ...manifest,
      status: "collecting",
      window: { ...manifest.window, requestedStartUnixMs: startAtUnixMs, requestedEndUnixMs: stopAtUnixMs },
      feeds: {
        public: { ...manifest.feeds.public, processId: publicStartup.processId },
        candidate: { ...manifest.feeds.candidate, processId: candidateStartup.processId },
      },
      calibrations: { public: publicCalibration, candidate: candidateCalibration },
      runtimeChecks: { ...manifest.runtimeChecks, bothCollectorsReady: true },
    };
    await writeManifest(options.outputDirectory, manifest);
    publicCollector.start(startAtUnixMs, stopAtUnixMs, publicCalibrationId);
    candidateCollector.start(startAtUnixMs, stopAtUnixMs, candidateCalibrationId);
    await withTimeout(
      Promise.all([publicCollector.active, candidateCollector.active]),
      20_000,
      "comparison aborted: both subscriptions were not confirmed within 20 seconds",
    );
    console.log(JSON.stringify({
      status: "collecting",
      comparisonId: options.comparisonId,
      feeds: [publicEndpointLabel, candidateEndpointLabel],
      durationSeconds: options.durationSeconds,
      apiKey: "present-not-persisted",
    }));
    const progressTimer = setInterval(() => {
      console.log(JSON.stringify({
        status: "progress",
        elapsedSeconds: Math.max(0, Math.floor((Date.now() - startAtUnixMs) / 1_000)),
        public: publicCollector.progress,
        candidate: candidateCollector.progress,
      }));
    }, 30_000);
    for (const collector of collectors) {
      void collector.exit.then((result) => {
        if (childExitRequiresAbort(result.code, result.atUnixMs, stopAtUnixMs)) {
          for (const peer of collectors) if (peer !== collector) peer.abort();
        }
      });
    }
    const exits = await withTimeout(
      Promise.all(collectors.map((collector) => collector.exit)),
      options.durationSeconds * 1_000 + 30_000,
      "comparison aborted: collectors did not exit after the requested window",
    ).finally(() => clearInterval(progressTimer));
    if (exits.some((result) => childExitRequiresAbort(result.code, result.atUnixMs, stopAtUnixMs))) {
      const details = collectors
        .map((collector, index) => `${collector.feedId}: ${exits[index]?.code ?? "signal"} ${collector.stderr.join("").trim()}`)
        .join("; ");
      throw new Error(`comparison collector failure: ${details}`);
    }

    const artifactPaths = [
      join(options.outputDirectory, "comparison-manifest.json"),
      ...["public", "candidate"].flatMap((feed) =>
        ["raw.jsonl", "events.jsonl", "diagnostics.jsonl", "manifest.json"].map((file) =>
          join(options.outputDirectory, feed, file),
        ),
      ),
    ];
    const secretsToCheck = [heliusApiKey, options.grpcToken].filter(
      (s): s is string => typeof s === "string" && s.length > 0,
    );
    let apiKeyPersisted = false;
    for (const secret of secretsToCheck) {
      if (await secretAppearsInFiles(artifactPaths, secret)) {
        apiKeyPersisted = true;
        break;
      }
    }
    manifest = {
      ...manifest,
      status: "complete",
      endedAt: new Date().toISOString(),
      runtimeChecks: {
        ...manifest.runtimeChecks,
        bothCollectorsCompleted: true,
        apiKeyPersisted,
      },
    };
    await writeManifest(options.outputDirectory, manifest);
    if (apiKeyPersisted) throw new Error("security invariant failed: secret was found in a persisted artifact");
    const report = await analyzeFeedComparison(options.outputDirectory, manifest);
    await writeFeedComparisonReports(options.outputDirectory, report);
    const reportPaths = [
      join(options.outputDirectory, "feed-comparison-report.json"),
      join(options.outputDirectory, "feed-comparison-report.md"),
    ];
    for (const secret of secretsToCheck) {
      if (await secretAppearsInFiles(reportPaths, secret)) {
        throw new Error("security invariant failed: secret was found in a report");
      }
    }
    console.log(JSON.stringify({
      status: "complete",
      comparisonId: options.comparisonId,
      report: "feed-comparison-report.json",
      publicUniqueSignatures: report.feeds.public.uniqueSignatures,
      candidateUniqueSignatures: report.feeds.candidate.uniqueSignatures,
      matchedSignatures: report.coverage.matchedSignatures,
      cleanMatchedSignatures: report.cleanLatency.deltaMs.count,
    }));
  } catch (error) {
    for (const collector of collectors) collector.abort();
    await Promise.allSettled(collectors.map((collector) => collector.exit));
    const secretsToCheck = [heliusApiKey, options.grpcToken].filter(
      (s): s is string => typeof s === "string" && s.length > 0,
    );
    let message = error instanceof Error ? error.message : String(error);
    for (const secret of secretsToCheck) {
      message = redactSecret(message, secret);
    }
    manifest = {
      ...manifest,
      status: "aborted",
      endedAt: new Date().toISOString(),
      failure: message,
    };
    await writeManifest(options.outputDirectory, manifest);
    throw new Error(message);
  }
}

void run().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
