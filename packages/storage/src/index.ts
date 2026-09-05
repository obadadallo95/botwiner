import { createReadStream } from "node:fs";
import {
  mkdir,
  open,
  readFile,
  rename,
  stat,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import {
  createDiagnostic,
  jsonLine,
  type Commitment,
  type DiagnosticRecord,
  type FeedTransportType,
  type NormalizedMarketEvent,
  type RawRecord,
} from "@botwiner/market-data";

export const RAW_FILE_NAME = "raw.jsonl";
export const EVENTS_FILE_NAME = "events.jsonl";
export const DIAGNOSTICS_FILE_NAME = "diagnostics.jsonl";
export const MANIFEST_FILE_NAME = "manifest.json";

export interface DatasetCounts {
  rawNotifications: number;
  normalizedEvents: number;
  launches: number;
  trades: number;
  duplicateEvents: number;
  malformedPumpEvents: number;
  invalidRpcMessages: number;
  failedTransactions: number;
  disconnects: number;
}

export interface DatasetManifest {
  readonly schemaVersion: 1;
  readonly sessionId: string;
  readonly status: "collecting" | "complete" | "aborted";
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly source: {
    readonly transport: FeedTransportType;
    readonly endpointLabel: string;
    readonly commitment: Commitment;
    readonly programId: string;
  };
  readonly parser: { readonly version: string; readonly officialIdlRevision: string };
  readonly files: {
    readonly raw: typeof RAW_FILE_NAME;
    readonly events: typeof EVENTS_FILE_NAME;
    readonly diagnostics: typeof DIAGNOSTICS_FILE_NAME;
  };
  readonly counts: Readonly<DatasetCounts>;
  readonly limitations: readonly string[];
}

export interface CreateDatasetOptions {
  readonly directory: string;
  readonly sessionId: string;
  readonly transport?: FeedTransportType | undefined;
  readonly endpointLabel: string;
  readonly commitment: Commitment;
  readonly programId: string;
  readonly parsingVersion: string;
  readonly officialIdlRevision: string;
}

export interface RecordRawOptions {
  readonly raw: RawRecord;
  readonly events: readonly NormalizedMarketEvent[];
  readonly parseFailures: readonly {
    readonly logIndex: number;
    readonly discriminatorHex: string;
    readonly message: string;
  }[];
  readonly invalidNotification: string | null;
  readonly transactionFailed: boolean;
}

function emptyCounts(): DatasetCounts {
  return {
    rawNotifications: 0,
    normalizedEvents: 0,
    launches: 0,
    trades: 0,
    duplicateEvents: 0,
    malformedPumpEvents: 0,
    invalidRpcMessages: 0,
    failedTransactions: 0,
    disconnects: 0,
  };
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

export interface ResearchSink {
  snapshotCounts(): Readonly<DatasetCounts>;
  recordRaw(options: RecordRawOptions): Promise<void>;
  recordDiagnostic(diagnostic: DiagnosticRecord): Promise<void>;
  close(status?: "complete" | "aborted" | "failed"): Promise<void>;
}

export class DatasetWriter implements ResearchSink {
  private readonly counts = emptyCounts();
  private readonly eventIds: Set<string>;
  private queue: Promise<void> = Promise.resolve();
  private closed = false;
  private status: DatasetManifest["status"] = "collecting";

  private constructor(
    public readonly directory: string,
    private readonly options: CreateDatasetOptions,
    private readonly startedAt: string,
    private readonly rawHandle: FileHandle,
    private readonly eventsHandle: FileHandle,
    private readonly diagnosticsHandle: FileHandle,
    eventIds: Set<string>,
  ) {
    this.eventIds = eventIds;
  }

  public static async create(options: CreateDatasetOptions): Promise<DatasetWriter> {
    const directory = resolve(options.directory);
    await mkdir(directory, { recursive: true });
    const rawPath = join(directory, RAW_FILE_NAME);
    const eventsPath = join(directory, EVENTS_FILE_NAME);
    const diagnosticsPath = join(directory, DIAGNOSTICS_FILE_NAME);
    const manifestPath = join(directory, MANIFEST_FILE_NAME);
    const sessionPaths = [rawPath, eventsPath, diagnosticsPath, manifestPath];
    const existing = (
      await Promise.all(sessionPaths.map(async (path) => ({ path, exists: await fileExists(path) })))
    ).filter((entry) => entry.exists);
    if (existing.length > 0) {
      throw new Error(
        `dataset directory already contains session files: ${existing.map((entry) => basename(entry.path)).join(", ")}`,
      );
    }
    const eventIds = new Set<string>();
    const [rawHandle, eventsHandle, diagnosticsHandle] = await Promise.all([
      open(rawPath, "a"),
      open(eventsPath, "a"),
      open(diagnosticsPath, "a"),
    ]);
    const writer = new DatasetWriter(
      directory,
      { ...options, directory },
      new Date().toISOString(),
      rawHandle,
      eventsHandle,
      diagnosticsHandle,
      eventIds,
    );
    await writer.writeManifest();
    return writer;
  }

  public snapshotCounts(): Readonly<DatasetCounts> {
    return { ...this.counts };
  }

  public recordRaw(options: RecordRawOptions): Promise<void> {
    return this.enqueue(async () => {
      await this.rawHandle.writeFile(jsonLine(options.raw));
      this.counts.rawNotifications += 1;
      if (options.transactionFailed) this.counts.failedTransactions += 1;

      if (options.invalidNotification !== null) {
        this.counts.invalidRpcMessages += 1;
        await this.writeDiagnosticNow(
          createDiagnostic(
            "invalid-rpc-message",
            options.invalidNotification,
            {},
            options.raw.sequence,
          ),
        );
      }

      for (const failure of options.parseFailures) {
        this.counts.malformedPumpEvents += 1;
        await this.writeDiagnosticNow(
          createDiagnostic(
            "malformed-pump-event",
            failure.message,
            { logIndex: failure.logIndex, discriminatorHex: failure.discriminatorHex },
            options.raw.sequence,
          ),
        );
      }

      for (const event of options.events) {
        if (this.eventIds.has(event.eventId)) {
          this.counts.duplicateEvents += 1;
          await this.writeDiagnosticNow(
            createDiagnostic(
              "duplicate-event",
              "normalized event was already present and was not written twice",
              { eventId: event.eventId },
              options.raw.sequence,
            ),
          );
          continue;
        }
        await this.eventsHandle.writeFile(jsonLine(event));
        this.eventIds.add(event.eventId);
        this.counts.normalizedEvents += 1;
        if (event.eventType === "launch") this.counts.launches += 1;
        if (event.eventType === "trade") this.counts.trades += 1;
      }
    });
  }

  public recordDiagnostic(diagnostic: DiagnosticRecord): Promise<void> {
    return this.enqueue(async () => {
      if (diagnostic.code === "connection-closed" && diagnostic.details.willReconnect === true) {
        this.counts.disconnects += 1;
      }
      await this.writeDiagnosticNow(diagnostic);
    });
  }

  public async close(status: "complete" | "aborted" = "complete"): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.status = status;
    await this.queue;
    await Promise.all([this.rawHandle.sync(), this.eventsHandle.sync(), this.diagnosticsHandle.sync()]);
    await Promise.all([this.rawHandle.close(), this.eventsHandle.close(), this.diagnosticsHandle.close()]);
    await this.writeManifest(new Date().toISOString());
  }

  private enqueue(work: () => Promise<void>): Promise<void> {
    if (this.closed) return Promise.reject(new Error("dataset writer is closed"));
    this.queue = this.queue.then(work);
    return this.queue;
  }

  private async writeDiagnosticNow(diagnostic: DiagnosticRecord): Promise<void> {
    await this.diagnosticsHandle.writeFile(jsonLine(diagnostic));
  }

  private async writeManifest(endedAt: string | null = null): Promise<void> {
    const manifest: DatasetManifest = {
      schemaVersion: 1,
      sessionId: this.options.sessionId,
      status: this.status,
      startedAt: this.startedAt,
      endedAt,
      source: {
        transport: this.options.transport ?? "solana-rpc-websocket",
        endpointLabel: this.options.endpointLabel,
        commitment: this.options.commitment,
        programId: this.options.programId,
      },
      parser: {
        version: this.options.parsingVersion,
        officialIdlRevision: this.options.officialIdlRevision,
      },
      files: {
        raw: RAW_FILE_NAME,
        events: EVENTS_FILE_NAME,
        diagnostics: DIAGNOSTICS_FILE_NAME,
      },
      counts: { ...this.counts },
      limitations: [
        "Standard RPC does not expose provider-side receive time.",
        "logsSubscribe has no completeness SLA or backfill cursor; disconnect intervals are gaps.",
        "processed notifications can be rolled back; failed notifications are kept raw and excluded from normalized events.",
        "block time and transaction index are not present in logsSubscribe notifications.",
      ],
    };
    const path = join(this.directory, MANIFEST_FILE_NAME);
    const temporaryPath = `${path}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await rename(temporaryPath, path);
  }
}

export interface JsonLine<T> {
  readonly lineNumber: number;
  readonly value: T;
  readonly text: string;
}

export async function* readJsonLines<T>(path: string): AsyncGenerator<JsonLine<T>> {
  const input = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  let lineNumber = 0;
  for await (const text of lines) {
    lineNumber += 1;
    if (text.trim() === "") continue;
    try {
      yield { lineNumber, value: JSON.parse(text) as T, text };
    } catch (error) {
      throw new Error(
        `invalid JSON in ${basename(path)} at line ${lineNumber}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

export async function writeJsonLines(path: string, values: readonly unknown[]): Promise<string> {
  await mkdir(dirname(resolve(path)), { recursive: true });
  const content = values.map(jsonLine).join("");
  await writeFile(path, content, "utf8");
  return sha256(content);
}

export async function digestFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  const input = createReadStream(path);
  for await (const chunk of input as AsyncIterable<Buffer>) hash.update(chunk);
  return hash.digest("hex");
}

export function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export async function readManifest(directory: string): Promise<DatasetManifest> {
  const text = await readFile(join(resolve(directory), MANIFEST_FILE_NAME), "utf8");
  return JSON.parse(text) as DatasetManifest;
}

export { DatasetWriter as LocalResearchSink };
export * from "./cloud-sink.js";
