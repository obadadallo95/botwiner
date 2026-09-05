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
  readonly tieToleranceMs: number;
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

interface ProgressCounts {
  readonly rawNotifications?: number;
  readonly normalizedEvents?: number;
  readonly failedTransactions?: number;
}

function usage(): string {
  return [
    "Usage: pnpm comparison:run [options]",
    "",
    "Options:",
    "  --output <directory>          Parent comparison directory",
    "  --comparison-id <id>          Stable sanitized comparison id",
    "  --duration-seconds <seconds>  Simultaneous collection window (default: 300)",
    "  --tie-tolerance-ms <ms>       First-arrival tie tolerance (default: 1)",
    "  --help                        Show this help",
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
  let tieToleranceMs = DEFAULT_TIE_TOLERANCE_MS;
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
    if (argument === "--tie-tolerance-ms") {
      tieToleranceMs = Number(requireNext(arguments_, index, argument));
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
  if (!Number.isFinite(tieToleranceMs) || tieToleranceMs < 0) {
    throw new Error("tie tolerance must be a non-negative number");
  }
  return {
    comparisonId,
    outputDirectory: outputDirectory ?? resolve("data", "comparisons", comparisonId),
    durationSeconds,
    tieToleranceMs,
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
  public progress: ProgressCounts = {};
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
    heliusApiKey: string,
  ) {
    const environment = { ...process.env };
    environment.BOTWINER_ORCHESTRATED = "1";
    environment.BOTWINER_COMPARISON_ID = comparisonId;
    environment.BOTWINER_FEED_ID = feedId;
    environment.BOTWINER_ENDPOINT_LABEL =
      feedId === "public" ? PUBLIC_ENDPOINT_LABEL : CANDIDATE_ENDPOINT_LABEL;
    environment.BOTWINER_FEED_PROVIDER = feedId === "candidate" ? "helius" : "public";
    if (feedId === "public") delete environment.HELIUS_API_KEY;
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
    this.ready = new Promise((resolvePromise, reject) => {
      this.resolveReady = resolvePromise;
      this.rejectReady = reject;
    });
    this.active = new Promise((resolvePromise, reject) => {
      this.resolveActive = resolvePromise;
      this.rejectActive = reject;
    });
    this.process.stdout?.on("data", () => undefined);
    this.process.stderr?.on("data", (chunk: Buffer) => {
      this.stderr.push(redactSecret(chunk.toString("utf8"), heliusApiKey));
    });
    this.process.on("message", (message: unknown) => this.handleMessage(message));
    this.exit = new Promise((resolvePromise) => {
      this.process.once("exit", (code, signal) => {
        const result = { code, signal, atUnixMs: Date.now() };
        const error = new Error(`${this.feedId} collector exited before completing startup`);
        this.rejectReady?.(error);
        this.rejectActive?.(error);
        for (const pending of this.pendingPings.values()) {
          clearTimeout(pending.timer);
          pending.reject(error);
        }
        this.pendingPings.clear();
        resolvePromise(result);
      });
    });
  }

  private handleMessage(message: unknown): void {
    if (!isRecord(message)) return;
    if (message.kind === "collector-ready") {
      const startup = message as unknown as CollectorStartupTuple & { readonly kind: string };
      this.startup = startup;
      this.resolveReady?.(startup);
      return;
    }
    if (message.kind === "calibration-pong" && typeof message.pingId === "string") {
      const pending = this.pendingPings.get(message.pingId);
      if (
        pending !== undefined &&
        typeof message.childMonotonicNs === "string" &&
        typeof message.childWallUnixMs === "number"
      ) {
        clearTimeout(pending.timer);
        this.pendingPings.delete(message.pingId);
        pending.resolve({
          parentSentMonotonicNs: pending.sentMonotonicNs.toString(),
          parentReceivedMonotonicNs: process.hrtime.bigint().toString(),
          childMonotonicNs: message.childMonotonicNs,
          childWallUnixMs: message.childWallUnixMs,
        });
      }
      return;
    }
    if (
      message.kind === "collector-diagnostic" &&
      message.code === "subscription-confirmed" &&
      typeof message.atUnixMs === "number"
    ) {
      this.subscriptionConfirmedAtUnixMs = message.atUnixMs;
      this.resolveActive?.(message.atUnixMs);
      return;
    }
    if (message.kind === "collector-progress" && isRecord(message.counts)) {
      this.progress = message.counts;
    }
  }

  public async calibrate(rounds = 7): Promise<CalibrationExchange[]> {
    const exchanges: CalibrationExchange[] = [];
    for (let index = 0; index < rounds; index += 1) {
      const pingId = `${this.feedId}-${index}-${randomUUID()}`;
      const sentMonotonicNs = process.hrtime.bigint();
      const exchange = new Promise<CalibrationExchange>((resolvePromise, reject) => {
        const timer = setTimeout(() => {
          this.pendingPings.delete(pingId);
          reject(new Error(`${this.feedId} collector calibration timed out`));
        }, 2_000);
        this.pendingPings.set(pingId, { sentMonotonicNs, resolve: resolvePromise, reject, timer });
      });
      this.process.send?.({ kind: "calibration-ping", pingId });
      exchanges.push(await exchange);
    }
    return exchanges;
  }

  public start(startAtUnixMs: number, stopAtUnixMs: number, calibrationId: string): void {
    this.process.send?.({ kind: "collector-start", startAtUnixMs, stopAtUnixMs, calibrationId });
  }

  public abort(): void {
    if (this.process.exitCode !== null || this.process.killed) return;
    this.process.send?.({ kind: "collector-abort" });
    this.process.kill("SIGTERM");
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
  const path = join(directory, "comparison-manifest.json");
  const temporaryPath = `${path}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await rename(temporaryPath, path);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

function initialManifest(options: CliOptions, baseline: OrchestratorBaseline): FeedComparisonManifest {
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
      public: { dataset: "public", endpointLabel: PUBLIC_ENDPOINT_LABEL, processId: null },
      candidate: { dataset: "candidate", endpointLabel: CANDIDATE_ENDPOINT_LABEL, processId: null },
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
      "This is a same-host comparison of two standard logsSubscribe feeds, not Yellowstone/gRPC.",
      "The Helius credential is constructed into the candidate URL only in child-process memory.",
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
  if (heliusApiKey === undefined || heliusApiKey.length === 0) {
    throw new Error("HELIUS_API_KEY is not present; comparison not started");
  }
  const baseline: OrchestratorBaseline = {
    wallUnixMs: Date.now(),
    monotonicNs: process.hrtime.bigint().toString(),
  };
  if (await pathExists(options.outputDirectory)) {
    throw new Error("comparison output directory already exists; refusing to overwrite evidence");
  }
  await mkdir(options.outputDirectory, { recursive: true });
  let manifest = initialManifest(options, baseline);
  await writeManifest(options.outputDirectory, manifest);

  const publicCollector = new ManagedCollector(
    "public",
    join(options.outputDirectory, "public"),
    options.comparisonId,
    heliusApiKey,
  );
  const candidateCollector = new ManagedCollector(
    "candidate",
    join(options.outputDirectory, "candidate"),
    options.comparisonId,
    heliusApiKey,
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
      feeds: [PUBLIC_ENDPOINT_LABEL, CANDIDATE_ENDPOINT_LABEL],
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
    const apiKeyPersisted = await secretAppearsInFiles(artifactPaths, heliusApiKey);
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
    if (apiKeyPersisted) throw new Error("security invariant failed: API key was found in a persisted artifact");
    const report = await analyzeFeedComparison(options.outputDirectory, manifest);
    await writeFeedComparisonReports(options.outputDirectory, report);
    const reportPaths = [
      join(options.outputDirectory, "feed-comparison-report.json"),
      join(options.outputDirectory, "feed-comparison-report.md"),
    ];
    if (await secretAppearsInFiles(reportPaths, heliusApiKey)) {
      throw new Error("security invariant failed: API key was found in a report");
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
    const message = redactSecret(error instanceof Error ? error.message : String(error), heliusApiKey);
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
