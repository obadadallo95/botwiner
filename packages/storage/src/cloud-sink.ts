import { createHash, randomBytes } from "node:crypto";
import { gzipSync } from "node:zlib";
import { Storage, type Bucket } from "@google-cloud/storage";

export function generateCollisionResistantSessionId(prefix = "session", date = new Date()): string {
  const dateStr = date.toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const entropy = randomBytes(4).toString("hex");
  return `${prefix}-${dateStr}-${entropy}`;
}
import {
  createDiagnostic,
  jsonLine,
  type DiagnosticRecord,
} from "@botwiner/market-data";
import {
  type CreateDatasetOptions,
  type DatasetCounts,
  type RecordRawOptions,
  type ResearchSink,
} from "./index.js";

export interface CloudChunkMetadata {
  readonly index: number;
  readonly fileName: string;
  readonly eventCount: number;
  readonly rawCount: number;
  readonly compressedBytes: number;
  readonly uncompressedBytes: number;
  readonly sha256: string;
  readonly startAtUnixMs: number;
  readonly endAtUnixMs: number;
}

export interface CloudDiagnosticsChunkMetadata {
  readonly index: number;
  readonly fileName: string;
  readonly count: number;
  readonly compressedBytes: number;
  readonly sha256: string;
}

export interface CloudDatasetManifest {
  readonly schemaVersion: 1;
  readonly sessionId: string;
  readonly status: "collecting" | "complete" | "aborted" | "failed";
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly requestedDurationSec: number | null;
  readonly source: {
    readonly transport: string;
    readonly endpointLabel: string;
    readonly commitment: string;
    readonly programId: string;
  };
  readonly parser: {
    readonly version: string;
    readonly officialIdlRevision: string;
  };
  readonly totalCompressedBytes: number;
  readonly chunks: readonly CloudChunkMetadata[];
  readonly diagnosticChunks: readonly CloudDiagnosticsChunkMetadata[];
  readonly counts: Readonly<DatasetCounts>;
  readonly limitations: readonly string[];
}

export interface CloudStorageUploader {
  uploadBuffer(destinationPath: string, buffer: Buffer, contentType: string): Promise<void>;
}

export class GcsStorageUploader implements CloudStorageUploader {
  private readonly bucket: Bucket;

  public constructor(bucketName: string, projectId?: string) {
    const options: ConstructorParameters<typeof Storage>[0] = {};
    if (projectId !== undefined) {
      options.projectId = projectId;
    }
    const storage = new Storage(options);
    this.bucket = storage.bucket(bucketName);
  }

  public async uploadBuffer(destinationPath: string, buffer: Buffer, contentType: string): Promise<void> {
    const file = this.bucket.file(destinationPath);
    await file.save(buffer, {
      resumable: false,
      contentType,
      metadata: {
        cacheControl: "no-cache",
      },
    });
  }
}

export interface CloudResearchSinkOptions extends CreateDatasetOptions {
  readonly gcsBucket?: string | undefined;
  readonly gcpProjectId?: string | undefined;
  readonly uploader?: CloudStorageUploader | undefined;
  readonly durationSeconds?: number | null | undefined;
  readonly chunkIntervalMs?: number | undefined;
  readonly chunkMaxRecords?: number | undefined;
  readonly onChunkRotated?: ((metadata: CloudChunkMetadata) => void) | undefined;
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

export class CloudResearchSink implements ResearchSink {
  private readonly counts = emptyCounts();
  private readonly eventIds = new Set<string>();
  private readonly chunks: CloudChunkMetadata[] = [];
  private readonly diagnosticChunks: CloudDiagnosticsChunkMetadata[] = [];
  private readonly uploader: CloudStorageUploader;
  private readonly startedAt: string;
  private readonly requestedDurationSec: number | null;
  private readonly chunkIntervalMs: number;
  private readonly chunkMaxRecords: number;
  private readonly onChunkRotated?: ((metadata: CloudChunkMetadata) => void) | undefined;

  private currentChunkIndex = 1;
  private currentEventBuffer: string[] = [];
  private currentRawBuffer: string[] = [];
  private currentDiagnosticsBuffer: DiagnosticRecord[] = [];
  private currentChunkStartMs: number = Date.now();
  private totalCompressedBytes = 0;

  private rotationTimer?: NodeJS.Timeout | undefined;
  private queue: Promise<void> = Promise.resolve();
  private closed = false;
  private status: CloudDatasetManifest["status"] = "collecting";

  public constructor(private readonly options: CloudResearchSinkOptions) {
    this.startedAt = new Date().toISOString();
    this.requestedDurationSec = options.durationSeconds ?? null;
    this.chunkIntervalMs = options.chunkIntervalMs ?? 60_000;
    this.chunkMaxRecords = options.chunkMaxRecords ?? 10_000;
    if (options.onChunkRotated !== undefined) {
      this.onChunkRotated = options.onChunkRotated;
    }

    if (options.uploader) {
      this.uploader = options.uploader;
    } else if (options.gcsBucket) {
      this.uploader = new GcsStorageUploader(options.gcsBucket, options.gcpProjectId);
    } else {
      throw new Error("CloudResearchSink requires either a gcsBucket or a custom uploader");
    }

    this.scheduleRotationTimer();
  }

  public static async create(options: CloudResearchSinkOptions): Promise<CloudResearchSink> {
    const sink = new CloudResearchSink(options);
    await sink.syncManifest();
    return sink;
  }

  public getSessionId(): string {
    return this.options.sessionId;
  }

  public getCurrentChunkIndex(): number {
    return this.currentChunkIndex;
  }

  public getTotalCompressedBytes(): number {
    return this.totalCompressedBytes;
  }

  public snapshotCounts(): Readonly<DatasetCounts> {
    return { ...this.counts };
  }

  public recordRaw(options: RecordRawOptions): Promise<void> {
    return this.enqueue(async () => {
      this.counts.rawNotifications += 1;
      this.currentRawBuffer.push(jsonLine(options.raw));

      if (options.transactionFailed) {
        this.counts.failedTransactions += 1;
      }

      if (options.invalidNotification !== null) {
        this.counts.invalidRpcMessages += 1;
        this.recordDiagnosticInternal(
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
        this.recordDiagnosticInternal(
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
          this.recordDiagnosticInternal(
            createDiagnostic(
              "duplicate-event",
              "normalized event was already present and was not written twice",
              { eventId: event.eventId },
              options.raw.sequence,
            ),
          );
          continue;
        }

        this.eventIds.add(event.eventId);
        this.counts.normalizedEvents += 1;
        if (event.eventType === "launch") this.counts.launches += 1;
        if (event.eventType === "trade") this.counts.trades += 1;

        this.currentEventBuffer.push(jsonLine(event));
      }

      if (this.currentEventBuffer.length >= this.chunkMaxRecords) {
        await this.rotateChunkInternal();
      }
    });
  }

  public recordDiagnostic(diagnostic: DiagnosticRecord): Promise<void> {
    return this.enqueue(() => {
      if (diagnostic.code === "connection-closed" && diagnostic.details.willReconnect === true) {
        this.counts.disconnects += 1;
      }
      this.recordDiagnosticInternal(diagnostic);
      return Promise.resolve();
    });
  }

  public async close(status: "complete" | "aborted" | "failed" = "complete"): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.status = status;

    if (this.rotationTimer) {
      clearInterval(this.rotationTimer);
      this.rotationTimer = undefined;
    }

    await this.queue;
    await this.rotateChunkInternal(true);
    await this.syncManifest(new Date().toISOString());
    await this.writeSummary();
  }

  private scheduleRotationTimer(): void {
    this.rotationTimer = setInterval(() => {
      this.enqueue(async () => {
        if (!this.closed && (this.currentEventBuffer.length > 0 || this.currentDiagnosticsBuffer.length > 0)) {
          await this.rotateChunkInternal();
        }
      }).catch((err) => {
        console.error("[CloudResearchSink] periodic chunk rotation error:", err);
      });
    }, this.chunkIntervalMs);
  }

  private recordDiagnosticInternal(diagnostic: DiagnosticRecord): void {
    this.currentDiagnosticsBuffer.push(diagnostic);
  }

  private async rotateChunkInternal(isFinal = false): Promise<void> {
    if (this.currentEventBuffer.length === 0 && this.currentDiagnosticsBuffer.length === 0 && !isFinal) {
      return;
    }

    const chunkIdx = this.currentChunkIndex;
    const chunkIdxPadded = String(chunkIdx).padStart(6, "0");
    const endMs = Date.now();

    // 1. Process Events Chunk if we have events
    if (this.currentEventBuffer.length > 0) {
      const rawText = this.currentEventBuffer.join("");
      const uncompressedBuffer = Buffer.from(rawText, "utf8");
      const compressedBuffer = gzipSync(uncompressedBuffer);
      const sha256 = createHash("sha256").update(compressedBuffer).digest("hex");
      const fileName = `chunks/events-${chunkIdxPadded}.jsonl.gz`;
      const destinationPath = `sessions/${this.options.sessionId}/${fileName}`;

      await this.uploader.uploadBuffer(destinationPath, compressedBuffer, "application/gzip");

      const chunkMeta: CloudChunkMetadata = {
        index: chunkIdx,
        fileName,
        eventCount: this.currentEventBuffer.length,
        rawCount: this.currentRawBuffer.length,
        compressedBytes: compressedBuffer.byteLength,
        uncompressedBytes: uncompressedBuffer.byteLength,
        sha256,
        startAtUnixMs: this.currentChunkStartMs,
        endAtUnixMs: endMs,
      };

      this.chunks.push(chunkMeta);
      this.totalCompressedBytes += compressedBuffer.byteLength;
      if (this.onChunkRotated) {
        this.onChunkRotated(chunkMeta);
      }
    }

    // 2. Process Diagnostics Chunk if we have diagnostics
    if (this.currentDiagnosticsBuffer.length > 0) {
      const diagLines = this.currentDiagnosticsBuffer.map((d) => jsonLine(d)).join("");
      const uncompressedBuffer = Buffer.from(diagLines, "utf8");
      const compressedBuffer = gzipSync(uncompressedBuffer);
      const sha256 = createHash("sha256").update(compressedBuffer).digest("hex");
      const fileName = `diagnostics/diagnostics-${chunkIdxPadded}.jsonl.gz`;
      const destinationPath = `sessions/${this.options.sessionId}/${fileName}`;

      await this.uploader.uploadBuffer(destinationPath, compressedBuffer, "application/gzip");

      const diagMeta: CloudDiagnosticsChunkMetadata = {
        index: chunkIdx,
        fileName,
        count: this.currentDiagnosticsBuffer.length,
        compressedBytes: compressedBuffer.byteLength,
        sha256,
      };

      this.diagnosticChunks.push(diagMeta);
      this.totalCompressedBytes += compressedBuffer.byteLength;
    }

    // Reset buffer state
    this.currentEventBuffer = [];
    this.currentRawBuffer = [];
    this.currentDiagnosticsBuffer = [];
    this.currentChunkStartMs = Date.now();
    this.currentChunkIndex += 1;

    // Update manifest in flight
    await this.syncManifest();
  }

  private async syncManifest(endedAt: string | null = null): Promise<void> {
    const manifest: CloudDatasetManifest = {
      schemaVersion: 1,
      sessionId: this.options.sessionId,
      status: this.status,
      startedAt: this.startedAt,
      endedAt,
      requestedDurationSec: this.requestedDurationSec,
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
      totalCompressedBytes: this.totalCompressedBytes,
      chunks: [...this.chunks],
      diagnosticChunks: [...this.diagnosticChunks],
      counts: this.snapshotCounts(),
      limitations: [
        "logsSubscribe does not supply slot numbers or block execution timestamps; ordering derives from arrival sequence",
        "SNTP clock sampling provides proof of sample offset, not a continuous synchronization guarantee",
        "PumpSwap / Raydium migration event decoding is not yet available in current IDL revision",
      ],
    };

    const destinationPath = `sessions/${this.options.sessionId}/manifest.json`;
    const manifestBuffer = Buffer.from(JSON.stringify(manifest, null, 2), "utf8");
    await this.uploader.uploadBuffer(destinationPath, manifestBuffer, "application/json");
  }

  private async writeSummary(): Promise<void> {
    const summary = {
      sessionId: this.options.sessionId,
      status: this.status,
      startedAt: this.startedAt,
      endedAt: new Date().toISOString(),
      requestedDurationSec: this.requestedDurationSec,
      totalCompressedBytes: this.totalCompressedBytes,
      totalChunks: this.chunks.length,
      counts: this.snapshotCounts(),
    };
    const destinationPath = `sessions/${this.options.sessionId}/summary/final-summary.json`;
    const summaryBuffer = Buffer.from(JSON.stringify(summary, null, 2), "utf8");
    await this.uploader.uploadBuffer(destinationPath, summaryBuffer, "application/json");
  }

  public async uploadDerivedSummary(name: string, data: unknown): Promise<void> {
    const destinationPath = `sessions/${this.options.sessionId}/summary/${name}.json`;
    const buffer = Buffer.from(JSON.stringify(data, null, 2), "utf8");
    await this.uploader.uploadBuffer(destinationPath, buffer, "application/json");
  }

  private enqueue(work: () => Promise<void>): Promise<void> {
    if (this.closed) return Promise.reject(new Error("cloud research sink is closed"));
    this.queue = this.queue.then(work);
    return this.queue;
  }
}
