import { basename, resolve } from "node:path";
import {
  type Commitment,
  type NormalizedMarketEvent,
  type RawLogRecord,
} from "@botwiner/market-data";
import {
  PUMP_IDL_REVISION,
  PUMP_PARSING_VERSION,
  PUMP_PROGRAM_ID,
  normalizeRawLogRecord,
} from "@botwiner/pumpfun";
import {
  endpointLabelFromUrl,
  sampleSntpClock,
  subscribeToProgramLogs,
  type ReceivedLogsMessage,
} from "@botwiner/solana";
import { DatasetWriter } from "@botwiner/storage";

interface CollectorCliOptions {
  readonly wsUrl: string;
  readonly commitment: Commitment;
  readonly outputDirectory: string;
  readonly durationSeconds: number | null;
  readonly ntpHost: string | null;
}

function usage(): string {
  return [
    "Usage: pnpm collector:start [options]",
    "",
    "Options:",
    "  --output <directory>          Exact dataset directory",
    "  --duration-seconds <seconds>  Stop cleanly after a bounded interval",
    "  --commitment <level>          processed (default), confirmed, or finalized",
    "  --ws-url <url>                Solana WebSocket URL (prefer SOLANA_WS_URL)",
    "  --ntp-host <host>             One startup SNTP sample (default: time.cloudflare.com)",
    "  --disable-ntp                 Record that clock-offset sampling was skipped",
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
  let wsUrl = process.env.SOLANA_WS_URL ?? "wss://api.mainnet-beta.solana.com/";
  let commitment = parseCommitment(process.env.SOLANA_COMMITMENT ?? "processed");
  let outputDirectory = defaultSessionDirectory();
  let durationSeconds: number | null = null;
  let ntpHost: string | null = process.env.NTP_HOST ?? "time.cloudflare.com";

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--help") {
      console.log(usage());
      process.exitCode = 0;
      return { wsUrl, commitment, outputDirectory, durationSeconds: 0, ntpHost };
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
    if (argument === "--ntp-host") {
      ntpHost = requireNext(arguments_, index, argument);
      index += 1;
      continue;
    }
    if (argument === "--disable-ntp") {
      ntpHost = null;
      continue;
    }
    throw new Error(`unknown argument: ${argument}`);
  }

  const protocol = new URL(wsUrl).protocol;
  if (protocol !== "ws:" && protocol !== "wss:") {
    throw new Error("Solana WebSocket URL must use ws: or wss:");
  }
  return { wsUrl, commitment, outputDirectory, durationSeconds, ntpHost };
}

function applyFinalCapture(
  events: readonly NormalizedMarketEvent[],
  raw: RawLogRecord,
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

async function run(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  if (options.durationSeconds === 0) return;

  const controller = new AbortController();
  let stoppedBySignal = false;
  const failureState: { error: Error | undefined } = { error: undefined };
  let sequence = 0;
  const endpointLabel = endpointLabelFromUrl(options.wsUrl);
  const writer = await DatasetWriter.create({
    directory: options.outputDirectory,
    sessionId: basename(options.outputDirectory),
    endpointLabel,
    commitment: options.commitment,
    programId: PUMP_PROGRAM_ID,
    parsingVersion: PUMP_PARSING_VERSION,
    officialIdlRevision: PUMP_IDL_REVISION,
  });

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
    try {
      const sample = await sampleSntpClock(options.ntpHost);
      await writer.recordDiagnostic({
        schemaVersion: 1,
        kind: "diagnostic",
        code: "clock-offset-sampled",
        atUnixMs: sample.completedAtUnixMs,
        message: "Recorded one SNTP clock-offset sample",
        sequence: null,
        details: { ...sample, interpretation: "single-sample evidence; not a synchronization SLA" },
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
  }

  const stopForSignal = (): void => {
    stoppedBySignal = true;
    controller.abort();
  };
  process.once("SIGINT", stopForSignal);
  process.once("SIGTERM", stopForSignal);

  const timer =
    options.durationSeconds === null
      ? undefined
      : setTimeout(() => controller.abort(), options.durationSeconds * 1_000);

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
    return writer
      .recordRaw({
        raw,
        events: applyFinalCapture(normalized.events, raw),
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
        dataset: writer.directory,
        endpointLabel,
        commitment: options.commitment,
        programId: PUMP_PROGRAM_ID,
        durationSeconds: options.durationSeconds,
      }),
    );
    await subscribeToProgramLogs({
      url: options.wsUrl,
      programId: PUMP_PROGRAM_ID,
      commitment: options.commitment,
      signal: controller.signal,
      onNotification: recordNotification,
      onDiagnostic: (diagnostic) => writer.recordDiagnostic(diagnostic).catch(fail),
    });
  } catch (error) {
    fail(error);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    process.removeListener("SIGINT", stopForSignal);
    process.removeListener("SIGTERM", stopForSignal);
    await writer.close(failureState.error === undefined && !stoppedBySignal ? "complete" : "aborted");
  }

  const summary = {
    status: failureState.error === undefined ? "complete" : "error",
    dataset: writer.directory,
    counts: writer.snapshotCounts(),
  };
  console.log(JSON.stringify(summary));
  if (failureState.error !== undefined) throw failureState.error;
}

void run().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
