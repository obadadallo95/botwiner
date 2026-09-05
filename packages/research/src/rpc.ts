import { mkdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseLogsNotification, type DiagnosticRecord, type RawLogRecord } from "@botwiner/market-data";
import { PUMP_PROGRAM_ID } from "@botwiner/pumpfun";
import { DIAGNOSTICS_FILE_NAME, RAW_FILE_NAME, readJsonLines, writeJsonLines } from "@botwiner/storage";
import {
  PHASE2_DIRECTORY,
  type GapBoundary,
  type GapRecoveryRecord,
  type RawRpcRecord,
  type RpcMethod,
} from "./types.js";

export const PHASE2_RAW_DIRECTORY = "raw-rpc";
export const RPC_TRANSACTIONS_FILE = "get-transactions.jsonl";
export const RPC_BLOCKS_FILE = "get-blocks.jsonl";
export const GAP_RECOVERY_FILE = "gap-recovery.jsonl";

interface RpcClientOptions {
  readonly rpcUrl: string;
  readonly maximumAttempts?: number;
  readonly baseRetryDelayMs?: number;
  readonly fetchImplementation?: typeof fetch;
}

export interface CaptureRpcEvidenceOptions extends RpcClientOptions {
  readonly datasetDirectory: string;
  readonly concurrency?: number;
  readonly maximumGapSignatures?: number;
  readonly onProgress?: (progress: {
    readonly stage: "transactions" | "blocks";
    readonly completed: number;
    readonly total: number;
  }) => void;
}

export interface CaptureRpcEvidenceSummary {
  readonly dataset: string;
  readonly rawDirectory: string;
  readonly liveSignatures: number;
  readonly backfilledSignatures: number;
  readonly transactionRequests: number;
  readonly blockRequests: number;
  readonly gaps: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

function endpointLabel(url: string): string {
  const parsed = new URL(url);
  return `${parsed.protocol}//${parsed.host}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function retryAfterMs(response: Response, fallback: number): number {
  const value = response.headers.get("retry-after");
  if (value === null) return fallback;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1_000 : fallback;
}

export async function callSolanaRpc(
  options: RpcClientOptions,
  method: RpcMethod,
  subject: string,
  params: readonly unknown[],
  provenance: RawRpcRecord["provenance"],
): Promise<RawRpcRecord> {
  const fetchImplementation = options.fetchImplementation ?? fetch;
  const maximumAttempts = options.maximumAttempts ?? 6;
  const baseRetryDelayMs = options.baseRetryDelayMs ?? 500;
  const requestedAtUnixMs = Date.now();
  const startedAtNs = process.hrtime.bigint();
  let attempts = 0;
  let responseValue: unknown = { transportError: "request was not attempted" };

  while (attempts < maximumAttempts) {
    attempts += 1;
    try {
      const response = await fetchImplementation(options.rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      if (response.ok) {
        responseValue = await response.json();
        break;
      }
      const body = await response.text();
      responseValue = { transportError: `HTTP ${response.status}`, responseBody: body };
      if (response.status !== 429 && response.status < 500) break;
      if (attempts < maximumAttempts) {
        await delay(retryAfterMs(response, baseRetryDelayMs * 2 ** (attempts - 1)));
      }
    } catch (error) {
      responseValue = { transportError: error instanceof Error ? error.message : String(error) };
      if (attempts < maximumAttempts) await delay(baseRetryDelayMs * 2 ** (attempts - 1));
    }
  }

  return {
    schemaVersion: 1,
    kind: "solana-rpc-response",
    request: { method, subject, params, commitment: "finalized" },
    provenance,
    endpointLabel: endpointLabel(options.rpcUrl),
    capture: {
      requestedAtUnixMs,
      completedAtUnixMs: Date.now(),
      durationNs: (process.hrtime.bigint() - startedAtNs).toString(),
      attempts,
    },
    response: responseValue,
  };
}

async function mapConcurrent<T, U>(
  values: readonly T[],
  concurrency: number,
  work: (value: T, index: number) => Promise<U>,
): Promise<U[]> {
  const output = new Array<U>(values.length);
  let nextIndex = 0;
  async function worker(): Promise<void> {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= values.length) return;
      const value = values[index];
      if (value !== undefined) output[index] = await work(value, index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
  return output;
}

interface ObservedSignature {
  readonly signature: string;
  readonly slot: number;
  readonly receivedAtUnixMs: number;
  readonly sequence: number;
}

async function readObservedSignatures(dataset: string): Promise<ObservedSignature[]> {
  const bySignature = new Map<string, ObservedSignature>();
  for await (const line of readJsonLines<RawLogRecord>(join(dataset, RAW_FILE_NAME))) {
    const parsed = parseLogsNotification(line.value.rpcPayload);
    if (!parsed.ok) continue;
    const result = parsed.value.params.result;
    const observed = {
      signature: result.value.signature,
      slot: result.context.slot,
      receivedAtUnixMs: line.value.capture.receivedAtUnixMs,
      sequence: line.value.sequence,
    };
    const existing = bySignature.get(observed.signature);
    if (existing === undefined || observed.sequence < existing.sequence) {
      bySignature.set(observed.signature, observed);
    }
  }
  return [...bySignature.values()].sort((left, right) => left.sequence - right.sequence);
}

async function readDiagnostics(dataset: string): Promise<DiagnosticRecord[]> {
  const diagnostics: DiagnosticRecord[] = [];
  for await (const line of readJsonLines<DiagnosticRecord>(join(dataset, DIAGNOSTICS_FILE_NAME))) {
    diagnostics.push(line.value);
  }
  return diagnostics;
}

function boundary(value: ObservedSignature | undefined): GapBoundary | null {
  return value === undefined
    ? null
    : {
        signature: value.signature,
        slot: value.slot,
        receivedAtUnixMs: value.receivedAtUnixMs,
      };
}

export function detectGaps(
  diagnostics: readonly DiagnosticRecord[],
  observed: readonly ObservedSignature[],
): Omit<GapRecoveryRecord, "queryCompleted" | "queryTruncatedByBound" | "candidateSignatures" | "newlyDiscoveredSignatures" | "limitation" | "error">[] {
  const gaps: Omit<GapRecoveryRecord, "queryCompleted" | "queryTruncatedByBound" | "candidateSignatures" | "newlyDiscoveredSignatures" | "limitation" | "error">[] = [];
  for (let index = 0; index < diagnostics.length; index += 1) {
    const diagnostic = diagnostics[index];
    if (diagnostic?.code !== "connection-closed" || diagnostic.details.willReconnect !== true) continue;
    const reopened = diagnostics.slice(index + 1).find((item) => item.code === "connection-opened");
    if (reopened === undefined) continue;
    const before = [...observed]
      .reverse()
      .find((item) => item.receivedAtUnixMs <= diagnostic.atUnixMs);
    const after = observed.find((item) => item.receivedAtUnixMs >= reopened.atUnixMs);
    gaps.push({
      schemaVersion: 1,
      kind: "gap-recovery",
      gapId: `gap-${gaps.length + 1}`,
      closedAtUnixMs: diagnostic.atUnixMs,
      reopenedAtUnixMs: reopened.atUnixMs,
      estimatedDurationMs: Math.max(0, reopened.atUnixMs - diagnostic.atUnixMs),
      beforeGap: boundary(before),
      afterGap: boundary(after),
    });
  }
  return gaps;
}

function signatureItems(response: unknown): GapRecoveryRecord["candidateSignatures"] {
  if (!isRecord(response) || !Array.isArray(response.result)) return [];
  const result: GapRecoveryRecord["candidateSignatures"][number][] = [];
  for (const item of response.result) {
    if (!isRecord(item) || typeof item.signature !== "string" || !Number.isSafeInteger(item.slot)) continue;
    result.push({
      signature: item.signature,
      slot: item.slot as number,
      blockTimeUnixSeconds: Number.isSafeInteger(item.blockTime) ? (item.blockTime as number) : null,
      error: item.err ?? null,
      confirmationStatus: typeof item.confirmationStatus === "string" ? item.confirmationStatus : null,
    });
  }
  return result;
}

function rpcResponseError(response: unknown): string | null {
  if (!isRecord(response)) return "RPC response is not an object";
  if ("transportError" in response) return String(response.transportError);
  return response.error === undefined ? null : JSON.stringify(response.error);
}

async function recoverGap(
  options: RpcClientOptions,
  detected: ReturnType<typeof detectGaps>[number],
  liveSignatures: ReadonlySet<string>,
  maximumGapSignatures: number,
): Promise<GapRecoveryRecord> {
  if (detected.beforeGap === null || detected.afterGap === null) {
    return {
      ...detected,
      queryCompleted: false,
      queryTruncatedByBound: false,
      candidateSignatures: [],
      newlyDiscoveredSignatures: [],
      limitation: "A boundary signature is missing, so public RPC cannot delimit this disconnect interval.",
      error: "missing boundary signature",
    };
  }

  const candidates: GapRecoveryRecord["candidateSignatures"][number][] = [];
  let before = detected.afterGap.signature;
  let queryCompleted = false;
  let error: string | null = null;
  while (candidates.length < maximumGapSignatures) {
    const limit = Math.min(1_000, maximumGapSignatures - candidates.length);
    const record = await callSolanaRpc(
      options,
      "getSignaturesForAddress",
      detected.gapId,
      [PUMP_PROGRAM_ID, { before, until: detected.beforeGap.signature, limit, commitment: "finalized" }],
      "gap-recovery",
    );
    error = rpcResponseError(record.response);
    if (error !== null) break;
    const page = signatureItems(record.response);
    candidates.push(...page);
    if (page.length < limit) {
      queryCompleted = true;
      break;
    }
    const last = page.at(-1);
    if (last === undefined || last.signature === before) {
      error = "pagination made no progress";
      break;
    }
    before = last.signature;
  }
  const queryTruncatedByBound = !queryCompleted && error === null && candidates.length >= maximumGapSignatures;
  const newlyDiscoveredSignatures = candidates
    .map((item) => item.signature)
    .filter((signature, index, values) => !liveSignatures.has(signature) && values.indexOf(signature) === index);
  return {
    ...detected,
    queryCompleted,
    queryTruncatedByBound,
    candidateSignatures: candidates,
    newlyDiscoveredSignatures,
    limitation:
      "getSignaturesForAddress is bounded address history, not a delivery receipt; even a completed query cannot prove the live feed had no silent omissions or that provider history was complete.",
    error,
  };
}

export async function captureRpcEvidence(
  options: CaptureRpcEvidenceOptions,
): Promise<CaptureRpcEvidenceSummary> {
  const dataset = resolve(options.datasetDirectory);
  const rawDirectory = join(dataset, PHASE2_DIRECTORY, PHASE2_RAW_DIRECTORY);
  const targetFiles = [RPC_TRANSACTIONS_FILE, RPC_BLOCKS_FILE, GAP_RECOVERY_FILE].map((file) =>
    join(rawDirectory, file),
  );
  if ((await Promise.all(targetFiles.map(exists))).some(Boolean)) {
    throw new Error("Phase 2 raw RPC evidence already exists; use phase2:rebuild or a new dataset");
  }
  await mkdir(rawDirectory, { recursive: true });

  const observed = await readObservedSignatures(dataset);
  const liveSignatures = new Set(observed.map((item) => item.signature));
  const diagnostics = await readDiagnostics(dataset);
  const detectedGaps = detectGaps(diagnostics, observed);
  const gapRecords: GapRecoveryRecord[] = [];
  for (const gap of detectedGaps) {
    gapRecords.push(
      await recoverGap(options, gap, liveSignatures, options.maximumGapSignatures ?? 5_000),
    );
  }
  const backfilledSignatures = gapRecords.flatMap((gap) => gap.newlyDiscoveredSignatures);
  const uniqueBackfilled = [...new Set(backfilledSignatures)].sort();
  const backfilledSlotBySignature = new Map(
    gapRecords.flatMap((gap) => gap.candidateSignatures.map((item) => [item.signature, item.slot] as const)),
  );
  const concurrency = options.concurrency ?? 4;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 32) {
    throw new Error("concurrency must be an integer from 1 to 32");
  }

  const transactionRecords: RawRpcRecord[] = [];
  const slots = [...new Set([
    ...observed.map((item) => item.slot),
    ...uniqueBackfilled.flatMap((signature) => {
      const slot = backfilledSlotBySignature.get(signature);
      return slot === undefined ? [] : [slot];
    }),
  ])].sort((left, right) => left - right);
  let completedBlocks = 0;
  const blockRecords = await mapConcurrent(slots, concurrency, async (slot) => {
    const record = await callSolanaRpc(
      options,
      "getBlock",
      String(slot),
      [slot, { commitment: "finalized", encoding: "json", transactionDetails: "full", rewards: false, maxSupportedTransactionVersion: 0 }],
      "canonical-order",
    );
    completedBlocks += 1;
    if (completedBlocks === slots.length || completedBlocks % 25 === 0) {
      options.onProgress?.({ stage: "blocks", completed: completedBlocks, total: slots.length });
    }
    return record;
  });

  await Promise.all([
    writeJsonLines(targetFiles[0] ?? "", transactionRecords),
    writeJsonLines(targetFiles[1] ?? "", blockRecords),
    writeJsonLines(targetFiles[2] ?? "", gapRecords),
  ]);
  return {
    dataset,
    rawDirectory,
    liveSignatures: observed.length,
    backfilledSignatures: uniqueBackfilled.length,
    transactionRequests: 0,
    blockRequests: blockRecords.length,
    gaps: gapRecords.length,
  };
}
