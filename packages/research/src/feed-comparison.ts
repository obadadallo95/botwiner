import { createHash } from "node:crypto";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import {
  parseLogsNotification,
  parseRawLogRecord,
  type DiagnosticRecord,
  type NormalizedMarketEvent,
  type RawLogRecord,
  type SolanaLogsNotification,
} from "@botwiner/market-data";
import {
  DIAGNOSTICS_FILE_NAME,
  EVENTS_FILE_NAME,
  RAW_FILE_NAME,
  readJsonLines,
  readManifest,
} from "@botwiner/storage";
import type {
  CalibrationExchange,
  CollectorStartupTuple,
  ComparisonFeedId,
  ComparisonWindowMetrics,
  DistributionSummary,
  FeedComparisonManifest,
  FeedComparisonReport,
  FeedTotals,
  MatchedSignatureComparison,
  ProviderLimitAudit,
  SignatureClassification,
  StorageAccountingSummary,
  TimingCalibration,
  TruncationAwareCoverageSection,
  WindowStabilitySummary,
} from "./feed-comparison-types.js";

export const PUBLIC_ENDPOINT_LABEL = "solana-public-mainnet-wss" as const;
export const CANDIDATE_ENDPOINT_LABEL = "helius-mainnet-wss" as const;
export const DEFAULT_TIE_TOLERANCE_MS = 1;
export const CALIBRATION_MAXIMUM_UNCERTAINTY_MS = 10;
export const CALIBRATION_MAXIMUM_WALL_RESIDUAL_MS = 100;
export const TAIL_THRESHOLDS_MS = [10, 25, 50, 100, 250, 500] as const;
export const COVERAGE_BOUNDARY_GUARD_MS = 1_000;

export interface OrchestratorBaseline {
  readonly wallUnixMs: number;
  readonly monotonicNs: string;
}

export function localHostFingerprint(): string {
  return createHash("sha256").update(hostname()).digest("hex").slice(0, 16);
}

export function redactSecret(text: string, secret: string | undefined): string {
  return secret === undefined || secret.length === 0 ? text : text.replaceAll(secret, "[REDACTED]");
}

export function assertSafeEndpointLabel(label: string): void {
  if (label !== PUBLIC_ENDPOINT_LABEL && label !== CANDIDATE_ENDPOINT_LABEL) {
    throw new Error(`unsupported comparison endpoint label: ${label}`);
  }
  if (/[?&#@=]/u.test(label)) throw new Error("comparison endpoint label contains URL credential syntax");
}

export function validateCollectorStartupPair(
  publicStartup: CollectorStartupTuple | null,
  candidateStartup: CollectorStartupTuple | null,
): void {
  if (publicStartup === null || candidateStartup === null) {
    throw new Error("comparison aborted: both collectors must report ready before either starts");
  }
  if (publicStartup.feedId !== "public" || candidateStartup.feedId !== "candidate") {
    throw new Error("comparison aborted: collector feed identities are invalid");
  }
  if (publicStartup.processId === candidateStartup.processId) {
    throw new Error("comparison aborted: feeds must run in different processes");
  }
  if (
    publicStartup.hostFingerprint.length === 0 ||
    publicStartup.hostFingerprint !== candidateStartup.hostFingerprint
  ) {
    throw new Error("comparison aborted: collectors did not verify the same host");
  }
  if (
    publicStartup.commitment !== candidateStartup.commitment ||
    publicStartup.programId !== candidateStartup.programId ||
    publicStartup.parserVersion !== candidateStartup.parserVersion ||
    publicStartup.idlRevision !== candidateStartup.idlRevision
  ) {
    throw new Error("comparison aborted: collector methodology differs");
  }
  assertSafeEndpointLabel(publicStartup.endpointLabel);
  assertSafeEndpointLabel(candidateStartup.endpointLabel);
}

export function childExitRequiresAbort(
  exitCode: number | null,
  exitAtUnixMs: number,
  requestedEndUnixMs: number,
): boolean {
  return exitCode !== 0 || exitAtUnixMs < requestedEndUnixMs - 1_000;
}

export function buildTimingCalibration(
  calibrationId: string,
  startup: CollectorStartupTuple,
  baseline: OrchestratorBaseline,
  exchanges: readonly CalibrationExchange[],
  maximumUncertaintyMs = CALIBRATION_MAXIMUM_UNCERTAINTY_MS,
  maximumWallResidualMs = CALIBRATION_MAXIMUM_WALL_RESIDUAL_MS,
): TimingCalibration {
  if (exchanges.length === 0) throw new Error("at least one calibration exchange is required");
  const usable = exchanges.map((exchange) => {
    const sent = BigInt(exchange.parentSentMonotonicNs);
    const received = BigInt(exchange.parentReceivedMonotonicNs);
    if (received < sent) throw new Error("calibration receive timestamp precedes send timestamp");
    const roundTrip = received - sent;
    return { exchange, sent, received, roundTrip };
  });
  usable.sort((left, right) =>
    left.roundTrip < right.roundTrip ? -1 : left.roundTrip > right.roundTrip ? 1 : 0,
  );
  const selected = usable[0];
  if (selected === undefined) throw new Error("calibration selection failed");
  const parentMidpoint = selected.sent + selected.roundTrip / 2n;
  const baselineMonotonic = BigInt(baseline.monotonicNs);
  const parentTimelineWallUnixMs =
    baseline.wallUnixMs + Number(parentMidpoint - baselineMonotonic) / 1_000_000;
  const wallResidualMs = selected.exchange.childWallUnixMs - parentTimelineWallUnixMs;
  const uncertaintyNs = selected.roundTrip / 2n;
  const valid =
    Number(uncertaintyNs) / 1_000_000 <= maximumUncertaintyMs &&
    Math.abs(wallResidualMs) <= maximumWallResidualMs;
  return {
    calibrationId,
    feedId: startup.feedId,
    processId: startup.processId,
    startup,
    anchor: {
      childMonotonicNs: selected.exchange.childMonotonicNs,
      parentMonotonicNs: parentMidpoint.toString(),
      childWallUnixMs: selected.exchange.childWallUnixMs,
      parentTimelineWallUnixMs,
    },
    minimumRoundTripNs: selected.roundTrip.toString(),
    uncertaintyNs: uncertaintyNs.toString(),
    wallResidualMs,
    valid,
    validation: valid
      ? "valid: minimum-RTT IPC midpoint anchor passed uncertainty and wall-clock residual checks"
      : "invalid: IPC uncertainty or wall-clock residual exceeded the configured bound",
  };
}

export function normalizeChildMonotonicNs(
  childMonotonicNs: string,
  calibration: TimingCalibration,
): bigint {
  return (
    BigInt(calibration.anchor.parentMonotonicNs) +
    (BigInt(childMonotonicNs) - BigInt(calibration.anchor.childMonotonicNs))
  );
}

export function arrivalDeltaMs(
  publicMonotonicNs: string,
  candidateMonotonicNs: string,
  publicCalibration: TimingCalibration,
  candidateCalibration: TimingCalibration,
): number {
  const publicNormalized = normalizeChildMonotonicNs(publicMonotonicNs, publicCalibration);
  const candidateNormalized = normalizeChildMonotonicNs(candidateMonotonicNs, candidateCalibration);
  return Number(publicNormalized - candidateNormalized) / 1_000_000;
}

export function firstArrival(deltaMs: number, tieToleranceMs: number): "public" | "candidate" | "tie" {
  if (Math.abs(deltaMs) <= tieToleranceMs) return "tie";
  return deltaMs > 0 ? "candidate" : "public";
}

function quantile(sorted: readonly number[], percentile: number): number | null {
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0] ?? null;
  const position = (sorted.length - 1) * percentile;
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  const lower = sorted[lowerIndex];
  const upper = sorted[upperIndex];
  if (lower === undefined || upper === undefined) return null;
  return lower + (upper - lower) * (position - lowerIndex);
}

export function summarizeDistribution(values: readonly number[]): DistributionSummary {
  if (values.length === 0) {
    return {
      count: 0,
      min: null,
      p25: null,
      p50: null,
      p75: null,
      p90: null,
      p95: null,
      p99: null,
      max: null,
      mean: null,
      standardDeviation: null,
      iqr: null,
    };
  }
  const sorted = [...values].sort((left, right) => left - right);
  const mean = values.reduce((total, value) => total + value, 0) / values.length;
  const variance =
    values.reduce((total, value) => total + (value - mean) ** 2, 0) / values.length;
  const p25 = quantile(sorted, 0.25);
  const p75 = quantile(sorted, 0.75);
  return {
    count: values.length,
    min: sorted[0] ?? null,
    p25,
    p50: quantile(sorted, 0.5),
    p75,
    p90: quantile(sorted, 0.9),
    p95: quantile(sorted, 0.95),
    p99: quantile(sorted, 0.99),
    max: sorted.at(-1) ?? null,
    mean,
    standardDeviation: Math.sqrt(variance),
    iqr: p25 === null || p75 === null ? null : p75 - p25,
  };
}

interface FeedObservation {
  readonly raw: RawLogRecord;
  readonly notification: SolanaLogsNotification;
  readonly signature: string;
  readonly slot: number;
  readonly succeeded: boolean;
  readonly normalizedTimelineNs: bigint;
  readonly connectionEpoch: number;
  readonly payloadFingerprint: string;
  readonly logsTruncated: boolean;
}

interface EventSummary {
  readonly count: number;
  readonly launches: number;
  readonly trades: number;
  readonly classification: SignatureClassification;
  readonly fingerprint: string;
}

interface LoadedFeed {
  readonly totals: FeedTotals;
  readonly observations: ReadonlyMap<string, FeedObservation>;
  readonly events: ReadonlyMap<string, EventSummary>;
  readonly diagnostics: readonly DiagnosticRecord[];
  readonly subscriptionConfirmedAtUnixMs: number | null;
  readonly uninterruptedEndUnixMs: number;
  readonly manifest: Awaited<ReturnType<typeof readManifest>>;
}

function isDiagnostic(value: unknown): value is DiagnosticRecord {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { kind?: unknown }).kind === "diagnostic" &&
    typeof (value as { code?: unknown }).code === "string" &&
    typeof (value as { atUnixMs?: unknown }).atUnixMs === "number"
  );
}

function eventFingerprint(event: NormalizedMarketEvent): string {
  const copy = { ...event } as Record<string, unknown>;
  delete copy.source;
  delete copy.rawRef;
  delete copy.timestamps;
  const ordering = event.ordering;
  copy.ordering = { slot: ordering.slot, transactionLogIndex: ordering.transactionLogIndex };
  return JSON.stringify(copy);
}

function summarizeEvents(events: readonly NormalizedMarketEvent[]): EventSummary {
  const launches = events.filter((event) => event.eventType === "launch").length;
  const trades = events.filter((event) => event.eventType === "trade").length;
  const classification: SignatureClassification =
    launches > 0 && trades > 0
      ? "launch-and-trade"
      : launches > 0
        ? "launch"
        : trades > 0
          ? "trade"
          : "none";
  return {
    count: events.length,
    launches,
    trades,
    classification,
    fingerprint: [...events]
      .sort((left, right) => left.ordering.transactionLogIndex - right.ordering.transactionLogIndex)
      .map(eventFingerprint)
      .join("\n"),
  };
}

async function loadFeedDataset(
  directory: string,
  calibration: TimingCalibration,
): Promise<LoadedFeed> {
  const datasetDirectory = resolve(directory);
  const manifest = await readManifest(datasetDirectory);
  const observations = new Map<string, FeedObservation>();
  let rawNotifications = 0;
  let validNotifications = 0;
  let malformedRawRecords = 0;
  const arrivalTimes: number[] = [];

  for await (const line of readJsonLines<unknown>(join(datasetDirectory, RAW_FILE_NAME))) {
    rawNotifications += 1;
    const parsedRaw = parseRawLogRecord(line.value);
    if (!parsedRaw.ok) {
      malformedRawRecords += 1;
      continue;
    }
    const parsedNotification = parseLogsNotification(parsedRaw.value.rpcPayload);
    if (!parsedNotification.ok) continue;
    validNotifications += 1;
    arrivalTimes.push(parsedRaw.value.capture.receivedAtUnixMs);
    const signature = parsedNotification.value.params.result.value.signature;
    const comparison = parsedRaw.value.source.comparison;
    const observation: FeedObservation = {
      raw: parsedRaw.value,
      notification: parsedNotification.value,
      signature,
      slot: parsedNotification.value.params.result.context.slot,
      succeeded: parsedNotification.value.params.result.value.err === null,
      normalizedTimelineNs: normalizeChildMonotonicNs(
        parsedRaw.value.capture.receivedMonotonicNs,
        calibration,
      ),
      connectionEpoch: comparison?.connectionEpoch ?? 0,
      payloadFingerprint: JSON.stringify(parsedNotification.value.params.result),
      logsTruncated: parsedNotification.value.params.result.value.logs.some((line) =>
        line.toLowerCase().includes("log truncated"),
      ),
    };
    const previous = observations.get(signature);
    if (previous === undefined || observation.normalizedTimelineNs < previous.normalizedTimelineNs) {
      observations.set(signature, observation);
    }
  }

  const eventsBySignature = new Map<string, NormalizedMarketEvent[]>();
  let normalizedPumpEvents = 0;
  let launches = 0;
  let trades = 0;
  for await (const line of readJsonLines<NormalizedMarketEvent>(join(datasetDirectory, EVENTS_FILE_NAME))) {
    const event = line.value;
    normalizedPumpEvents += 1;
    if (event.eventType === "launch") launches += 1;
    if (event.eventType === "trade") trades += 1;
    const existing = eventsBySignature.get(event.signature) ?? [];
    existing.push(event);
    eventsBySignature.set(event.signature, existing);
  }
  const events = new Map<string, EventSummary>();
  for (const [signature, values] of eventsBySignature) events.set(signature, summarizeEvents(values));

  const diagnostics: DiagnosticRecord[] = [];
  for await (const line of readJsonLines<unknown>(join(datasetDirectory, DIAGNOSTICS_FILE_NAME))) {
    if (isDiagnostic(line.value)) diagnostics.push(line.value);
  }
  const opened = diagnostics
    .filter((diagnostic) => diagnostic.code === "connection-opened")
    .sort((left, right) => left.atUnixMs - right.atUnixMs);
  const disconnects = diagnostics
    .filter(
      (diagnostic) =>
        diagnostic.code === "connection-closed" && diagnostic.details.willReconnect === true,
    )
    .sort((left, right) => left.atUnixMs - right.atUnixMs);
  let totalDisconnectedDurationMs = 0;
  for (const disconnected of disconnects) {
    const reopened = opened.find((diagnostic) => diagnostic.atUnixMs >= disconnected.atUnixMs);
    if (reopened !== undefined) totalDisconnectedDurationMs += reopened.atUnixMs - disconnected.atUnixMs;
  }
  const confirmed = diagnostics
    .filter((diagnostic) => diagnostic.code === "subscription-confirmed")
    .sort((left, right) => left.atUnixMs - right.atUnixMs);
  const endedAtUnixMs = manifest.endedAt === null ? Number.POSITIVE_INFINITY : Date.parse(manifest.endedAt);
  const uninterruptedEndUnixMs = Math.min(
    disconnects[0]?.atUnixMs ?? Number.POSITIVE_INFINITY,
    endedAtUnixMs,
  );
  arrivalTimes.sort((left, right) => left - right);
  let longestObservedInterMessageGapMs: number | null = null;
  for (let index = 1; index < arrivalTimes.length; index += 1) {
    const current = arrivalTimes[index];
    const previous = arrivalTimes[index - 1];
    if (current === undefined || previous === undefined) continue;
    const gap = current - previous;
    longestObservedInterMessageGapMs = Math.max(longestObservedInterMessageGapMs ?? 0, gap);
  }
  const successfulTransactions = [...observations.values()].filter((entry) => entry.succeeded).length;
  const parserErrors = diagnostics.filter((entry) => entry.code === "malformed-pump-event").length;
  const malformedFrames =
    malformedRawRecords + diagnostics.filter((entry) => entry.code === "invalid-rpc-message").length;
  return {
    totals: {
      rawNotifications,
      uniqueSignatures: observations.size,
      successfulTransactions,
      failedTransactions: observations.size - successfulTransactions,
      normalizedPumpEvents,
      launches,
      trades,
      duplicateNotifications: validNotifications - observations.size,
      duplicateNotificationRate:
        validNotifications === 0 ? 0 : (validNotifications - observations.size) / validNotifications,
      duplicateEvents: manifest.counts.duplicateEvents,
      parserErrors,
      parserErrorRatePerRawNotification: rawNotifications === 0 ? 0 : parserErrors / rawNotifications,
      malformedFrames,
      malformedFrameRatePerRawNotification:
        rawNotifications === 0 ? 0 : malformedFrames / rawNotifications,
      unexpectedRpcMessages: diagnostics.filter((entry) => entry.code === "unexpected-rpc-message").length,
      disconnects: disconnects.length,
      reconnects: Math.max(0, opened.length - 1),
      totalDisconnectedDurationMs,
      longestObservedInterMessageGapMs,
    },
    observations,
    events,
    diagnostics,
    subscriptionConfirmedAtUnixMs: confirmed[0]?.atUnixMs ?? null,
    uninterruptedEndUnixMs,
    manifest,
  };
}

function percentage(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : (numerator / denominator) * 100;
}

function classificationIncludes(summary: EventSummary | undefined, type: "launch" | "trade"): boolean {
  return type === "launch" ? (summary?.launches ?? 0) > 0 : (summary?.trades ?? 0) > 0;
}

function compareOrdering(matches: readonly MatchedSignatureComparison[]): FeedComparisonReport["ordering"] {
  const bySlot = new Map<number, MatchedSignatureComparison[]>();
  for (const match of matches) {
    if (!match.includedInCleanLatency || !match.slotsMatch) continue;
    const values = bySlot.get(match.publicSlot) ?? [];
    values.push(match);
    bySlot.set(match.publicSlot, values);
  }
  let comparablePairs = 0;
  let disagreements = 0;
  for (const values of bySlot.values()) {
    for (let leftIndex = 0; leftIndex < values.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < values.length; rightIndex += 1) {
        const left = values[leftIndex];
        const right = values[rightIndex];
        if (left === undefined || right === undefined) continue;
        const publicOrder =
          BigInt(left.publicNormalizedTimelineNs) < BigInt(right.publicNormalizedTimelineNs) ? -1 : 1;
        const candidateOrder =
          BigInt(left.candidateNormalizedTimelineNs) < BigInt(right.candidateNormalizedTimelineNs) ? -1 : 1;
        comparablePairs += 1;
        if (publicOrder !== candidateOrder) disagreements += 1;
      }
    }
  }
  return {
    method: "within-observed-slot-pairs",
    comparablePairs,
    disagreements,
    disagreementRate: comparablePairs === 0 ? 0 : disagreements / comparablePairs,
  };
}

async function getDirectoryTotalBytes(directoryPath: string): Promise<number> {
  let total = 0;
  try {
    const entries = await readdir(directoryPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile()) {
        const fileStat = await stat(join(directoryPath, entry.name));
        total += fileStat.size;
      }
    }
  } catch {
    // Directory might not exist or be unreadable
  }
  return total;
}

export async function computeStorageAccounting(
  comparisonDirectory: string,
  manifest: FeedComparisonManifest,
): Promise<StorageAccountingSummary> {
  const root = resolve(comparisonDirectory);
  const publicDatasetBytes = await getDirectoryTotalBytes(join(root, manifest.feeds.public.dataset));
  const candidateDatasetBytes = await getDirectoryTotalBytes(join(root, manifest.feeds.candidate.dataset));
  let comparisonOutputBytes = 0;
  try {
    const manifestStat = await stat(join(root, "comparison-manifest.json"));
    comparisonOutputBytes += manifestStat.size;
  } catch {
    // comparison-manifest might not be on disk yet
  }

  const totalBytes = publicDatasetBytes + candidateDatasetBytes + comparisonOutputBytes;
  const totalMegabytes = totalBytes / (1024 * 1024);
  const durationSeconds = manifest.window.durationSeconds > 0 ? manifest.window.durationSeconds : 300;
  const elapsedMinutes = Math.max(0.01, durationSeconds / 60);
  const megabytesPerMinute = totalMegabytes / elapsedMinutes;

  const estimated15MinMegabytes = megabytesPerMinute * 15;
  const estimated30MinMegabytes = megabytesPerMinute * 30;
  const estimated120MinMegabytes = megabytesPerMinute * 120;
  const assessment = `Storage consumption is ${megabytesPerMinute.toFixed(2)} MB/min; projected 15-minute footprint is ${estimated15MinMegabytes.toFixed(1)} MB (${(estimated15MinMegabytes / 1024).toFixed(2)} GB).`;

  return {
    publicDatasetBytes,
    candidateDatasetBytes,
    comparisonOutputBytes,
    totalBytes,
    totalMegabytes,
    elapsedMinutes,
    megabytesPerMinute,
    projections: {
      estimated15MinMegabytes,
      estimated30MinMegabytes,
      estimated120MinMegabytes,
    },
    assessment,
  };
}

export function auditProviderLimitsForFeed(
  feedId: ComparisonFeedId,
  endpointLabel: string,
  diagnostics: readonly DiagnosticRecord[],
  longestGapMs: number | null,
): ProviderLimitAudit {
  const subscriptionErrors = diagnostics.filter((d) => d.code === "subscription-error").length;
  const connectionErrors = diagnostics.filter((d) => d.code === "connection-error").length;
  const disconnects = diagnostics.filter(
    (d) => d.code === "connection-closed" && d.details.willReconnect === true,
  ).length;
  const opened = diagnostics.filter((d) => d.code === "connection-opened").length;
  const reconnects = Math.max(0, opened - 1);

  const throttleDiagnostics: string[] = [];
  for (const d of diagnostics) {
    const text = JSON.stringify(d).toLowerCase();
    if (
      text.includes("429") ||
      text.includes("rate limit") ||
      text.includes("too many requests") ||
      text.includes("quota exceeded") ||
      text.includes("throttl")
    ) {
      throttleDiagnostics.push(`[${d.code}] ${d.message}`);
    }
  }

  const abnormalGapsCount = longestGapMs !== null && longestGapMs > 5000 ? 1 : 0;
  const freePlanCreditTrackingNotice =
    feedId === "candidate"
      ? "Helius does not expose remaining monthly credits (1M free credits limit) via standard WebSocket JSON-RPC. Monthly credit usage must be audited directly from the Helius developer dashboard at https://dashboard.helius.dev."
      : "Solana public RPC enforces unannounced IP rate limits; monitor disconnects and HTTP/WS dropouts.";

  return {
    feedId,
    endpointLabel,
    subscriptionErrors,
    connectionErrors,
    disconnects,
    reconnects,
    rateLimitOrThrottleCount: throttleDiagnostics.length,
    abnormalGapsCount,
    longestObservedInterMessageGapMs: longestGapMs,
    observedThrottleDiagnostics: throttleDiagnostics,
    freePlanCreditTrackingNotice,
  };
}

export function buildTruncationAwareCoverage(
  matches: readonly MatchedSignatureComparison[],
  publicSignatures: ReadonlySet<string>,
  candidateSignatures: ReadonlySet<string>,
  publicTotals: FeedTotals,
  candidateTotals: FeedTotals,
): TruncationAwareCoverageSection {
  const unionCount = new Set([...publicSignatures, ...candidateSignatures]).size;
  const matchedCount = matches.length;
  const publicOnlyCount = [...publicSignatures].filter((s) => !candidateSignatures.has(s)).length;
  const candidateOnlyCount = [...candidateSignatures].filter((s) => !publicSignatures.has(s)).length;

  const identicalPayloadCount = matches.filter((m) => m.payloadMatches).length;
  const payloadMismatchCount = matches.filter((m) => !m.payloadMatches).length;
  const candidateLogTruncations = matches.filter((m) => m.candidateLogsTruncated).length;
  const publicLogTruncations = matches.filter((m) => m.publicLogsTruncated).length;
  const payloadMismatchesWithLogTruncation = matches.filter(
    (m) => !m.payloadMatches && (m.candidateLogsTruncated || m.publicLogsTruncated),
  ).length;
  const unexplainedPayloadMismatches = payloadMismatchCount - payloadMismatchesWithLogTruncation;

  const identicalPumpEventsCount = matches.filter((m) => m.parserOutputMatches).length;
  const pumpEventMismatchCount = matches.filter((m) => !m.parserOutputMatches).length;
  const pumpEventMismatchesWithLogTruncation = matches.filter(
    (m) => !m.parserOutputMatches && (m.candidateLogsTruncated || m.publicLogsTruncated),
  ).length;
  const unexplainedPumpEventMismatches = pumpEventMismatchCount - pumpEventMismatchesWithLogTruncation;

  const candidateSignatureLossRate = unionCount === 0 ? 0 : publicOnlyCount / unionCount;
  const publicSignatureLossRate = unionCount === 0 ? 0 : candidateOnlyCount / unionCount;
  const candidatePayloadTruncationRate = matchedCount === 0 ? 0 : candidateLogTruncations / matchedCount;

  return {
    signatureCompleteness: {
      matchedSignatures: matchedCount,
      publicOnlySignatures: publicOnlyCount,
      candidateOnlySignatures: candidateOnlyCount,
      unionSignatures: unionCount,
      jaccard: unionCount === 0 ? 0 : matchedCount / unionCount,
      candidateSignatureLossRate,
      publicSignatureLossRate,
      interpretation:
        candidateOnlyCount === 0 && publicOnlyCount === 0
          ? "Perfect signature parity between feeds; zero feed-level signature loss."
          : `Signature coverage: ${publicOnlyCount} public-only, ${candidateOnlyCount} candidate-only. Boundary-guarded analysis determines whether loss is boundary timing or true dropouts.`,
    },
    rawPayloadCompleteness: {
      matchedSignatures: matchedCount,
      identicalPayloadSignatures: identicalPayloadCount,
      payloadMismatchSignatures: payloadMismatchCount,
      candidateLogTruncations,
      publicLogTruncations,
      payloadMismatchesWithLogTruncation,
      unexplainedPayloadMismatches,
      candidatePayloadTruncationRate,
      interpretation:
        unexplainedPayloadMismatches === 0
          ? `All ${payloadMismatchCount} payload differences are 100% accounted for by Helius candidate 'Log truncated' entries; zero unexplained payload mutations.`
          : `Warning: ${unexplainedPayloadMismatches} payload mismatches were observed without candidate log truncation.`,
    },
    parsedPumpEventCompleteness: {
      publicNormalizedPumpEvents: publicTotals.normalizedPumpEvents,
      candidateNormalizedPumpEvents: candidateTotals.normalizedPumpEvents,
      eventCountDelta: publicTotals.normalizedPumpEvents - candidateTotals.normalizedPumpEvents,
      matchedSignaturesWithIdenticalPumpEvents: identicalPumpEventsCount,
      matchedSignaturesWithPumpEventMismatches: pumpEventMismatchCount,
      pumpEventMismatchesWithLogTruncation,
      unexplainedPumpEventMismatches,
      interpretation:
        unexplainedPumpEventMismatches === 0
          ? `All ${pumpEventMismatchCount} Pump parser output mismatches are strictly caused by Helius upstream log truncation; zero program-parsing divergence on intact logs.`
          : `Warning: ${unexplainedPumpEventMismatches} parser output differences occurred without log truncation.`,
    },
  };
}

export function computeComparisonWindows(
  matches: readonly MatchedSignatureComparison[],
  publicFeed: LoadedFeed,
  candidateFeed: LoadedFeed,
  commonStartUnixMs: number,
  commonEndUnixMs: number,
  windowDurationSeconds: number,
): readonly ComparisonWindowMetrics[] {
  const commonDurationMs = Math.max(0, commonEndUnixMs - commonStartUnixMs);
  const targetWindowDurationMs = Math.max(1000, windowDurationSeconds * 1000);
  const numWindows = Math.max(1, Math.floor(commonDurationMs / targetWindowDurationMs));
  const windows: ComparisonWindowMetrics[] = [];

  const publicExclusives = [...publicFeed.observations.entries()].filter(
    ([sig]) => !candidateFeed.observations.has(sig),
  );
  const candidateExclusives = [...candidateFeed.observations.entries()].filter(
    ([sig]) => !publicFeed.observations.has(sig),
  );

  for (let i = 0; i < numWindows; i += 1) {
    const windowStart = commonStartUnixMs + i * targetWindowDurationMs;
    const isLast = i === numWindows - 1;
    const windowEnd = isLast ? commonEndUnixMs : windowStart + targetWindowDurationMs;
    const startMin = Math.round((i * windowDurationSeconds) / 60);
    const endMin = Math.round(((i + 1) * windowDurationSeconds) / 60);
    const label = numWindows === 1 ? "Window 1 (full window)" : `Window ${i + 1} (${startMin}-${endMin}m)`;

    const windowMatches = matches.filter((m) => {
      if (!m.includedInCleanLatency) return false;
      const arrival = m.publicArrivalUnixMs;
      return isLast ? arrival >= windowStart && arrival <= windowEnd : arrival >= windowStart && arrival < windowEnd;
    });

    const windowPublicOnly = publicExclusives.filter(([, obs]) => {
      const arrival = obs.raw.capture.receivedAtUnixMs;
      return isLast ? arrival >= windowStart && arrival <= windowEnd : arrival >= windowStart && arrival < windowEnd;
    }).length;

    const windowCandidateOnly = candidateExclusives.filter(([, obs]) => {
      const arrival = obs.raw.capture.receivedAtUnixMs;
      return isLast ? arrival >= windowStart && arrival <= windowEnd : arrival >= windowStart && arrival < windowEnd;
    }).length;

    const union = windowMatches.length + windowPublicOnly + windowCandidateOnly;
    const jaccard = union === 0 ? 0 : windowMatches.length / union;

    const deltas = windowMatches.map((m) => m.deltaMs);
    const candidateFaster = windowMatches.filter((m) => m.first === "candidate").length;
    const publicFaster = windowMatches.filter((m) => m.first === "public").length;
    const ties = windowMatches.length - candidateFaster - publicFaster;

    const dist = summarizeDistribution(deltas);

    const publicDiagInWindow = publicFeed.diagnostics.filter((d) =>
      isLast ? d.atUnixMs >= windowStart && d.atUnixMs <= windowEnd : d.atUnixMs >= windowStart && d.atUnixMs < windowEnd,
    );
    const candidateDiagInWindow = candidateFeed.diagnostics.filter((d) =>
      isLast ? d.atUnixMs >= windowStart && d.atUnixMs <= windowEnd : d.atUnixMs >= windowStart && d.atUnixMs < windowEnd,
    );

    const publicDisconnects = publicDiagInWindow.filter(
      (d) => d.code === "connection-closed" && d.details.willReconnect === true,
    ).length;
    const candidateDisconnects = candidateDiagInWindow.filter(
      (d) => d.code === "connection-closed" && d.details.willReconnect === true,
    ).length;

    const publicReconnects = publicDiagInWindow.filter((d) => d.code === "connection-opened").length;
    const candidateReconnects = candidateDiagInWindow.filter((d) => d.code === "connection-opened").length;

    const publicParserErrors = publicDiagInWindow.filter((d) => d.code === "malformed-pump-event").length;
    const candidateParserErrors = candidateDiagInWindow.filter((d) => d.code === "malformed-pump-event").length;

    const candidateLogTruncations = windowMatches.filter((m) => m.candidateLogsTruncated).length;
    const parserMismatchesWithLogTruncation = windowMatches.filter(
      (m) => !m.parserOutputMatches && (m.candidateLogsTruncated || m.publicLogsTruncated),
    ).length;

    windows.push({
      windowIndex: i + 1,
      label,
      startUnixMs: windowStart,
      endUnixMs: windowEnd,
      durationSeconds: Math.round((windowEnd - windowStart) / 1000),
      matchedSignatures: windowMatches.length,
      publicOnlySignatures: windowPublicOnly,
      candidateOnlySignatures: windowCandidateOnly,
      unionSignatures: union,
      jaccard,
      cleanLatency: {
        count: dist.count,
        p50: dist.p50,
        p95: dist.p95,
        p99: dist.p99,
        min: dist.min,
        max: dist.max,
        mean: dist.mean,
        standardDeviation: dist.standardDeviation,
        winner: {
          candidateFaster,
          publicFaster,
          ties,
          candidateFasterPercentage: percentage(candidateFaster, windowMatches.length),
          publicFasterPercentage: percentage(publicFaster, windowMatches.length),
          tiePercentage: percentage(ties, windowMatches.length),
        },
        tails: {
          thresholdsMs: TAIL_THRESHOLDS_MS,
          candidateLeadCounts: TAIL_THRESHOLDS_MS.map(
            (threshold) => deltas.filter((delta) => delta > threshold).length,
          ),
          publicLeadCounts: TAIL_THRESHOLDS_MS.map(
            (threshold) => deltas.filter((delta) => delta < -threshold).length,
          ),
        },
      },
      disconnects: { public: publicDisconnects, candidate: candidateDisconnects },
      reconnects: { public: publicReconnects, candidate: candidateReconnects },
      duplicateNotificationRate: {
        public: publicFeed.totals.duplicateNotificationRate,
        candidate: candidateFeed.totals.duplicateNotificationRate,
      },
      parserErrors: { public: publicParserErrors, candidate: candidateParserErrors },
      candidateLogTruncations,
      parserMismatchesWithLogTruncation,
    });
  }

  return windows;
}

export function summarizeWindowStability(
  windows: readonly ComparisonWindowMetrics[],
  windowDurationSeconds: number,
): WindowStabilitySummary {
  const windowCount = windows.length;
  const p50DeltasMs = windows.map((w) => w.cleanLatency.p50);
  const p95DeltasMs = windows.map((w) => w.cleanLatency.p95);
  const p99DeltasMs = windows.map((w) => w.cleanLatency.p99);
  const candidateWinPercentages = windows.map((w) => w.cleanLatency.winner.candidateFasterPercentage);
  const publicWinPercentages = windows.map((w) => w.cleanLatency.winner.publicFasterPercentage);
  const tiePercentages = windows.map((w) => w.cleanLatency.winner.tiePercentage);
  const truncationCounts = windows.map((w) => w.candidateLogTruncations);

  const validP50s = p50DeltasMs.filter((v): v is number => v !== null);
  const validP95s = p95DeltasMs.filter((v): v is number => v !== null);

  const directionalConsistency =
    windowCount > 1 && validP50s.length === windowCount && validP50s.every((p50) => p50 > 0);

  const p50SpreadMs =
    validP50s.length > 1 ? Math.max(...validP50s) - Math.min(...validP50s) : null;
  const p95SpreadMs =
    validP95s.length > 1 ? Math.max(...validP95s) - Math.min(...validP95s) : null;

  let stabilityAssessment: WindowStabilitySummary["stabilityAssessment"];
  let summary: string;

  if (windowCount <= 1) {
    stabilityAssessment = "single-window-baseline";
    summary = "Run contains 1 time window. Multi-window stability requires at least 2 windows (e.g. 15-minute run with 3 x 5-minute windows).";
  } else if (directionalConsistency && (p50SpreadMs ?? 0) <= 30) {
    stabilityAssessment = "stable-candidate-lead";
    summary = `Candidate lead is directionally consistent across all ${windowCount} windows with tight p50 spread (${p50SpreadMs?.toFixed(2)} ms).`;
  } else if (directionalConsistency) {
    stabilityAssessment = "variable-candidate-lead";
    summary = `Candidate maintains positive p50 lead in all ${windowCount} windows, but latency spread is wide (p50 spread: ${p50SpreadMs?.toFixed(2)} ms).`;
  } else if (validP50s.every((p50) => p50 < 0)) {
    stabilityAssessment = "public-lead";
    summary = `Public RPC leads across all ${windowCount} windows.`;
  } else {
    stabilityAssessment = "inconsistent-lead";
    summary = `Winner alternates across windows; no stable latency advantage.`;
  }

  return {
    windowCount,
    windowDurationSeconds,
    p50DeltasMs,
    p95DeltasMs,
    p99DeltasMs,
    candidateWinPercentages,
    publicWinPercentages,
    tiePercentages,
    directionalConsistency,
    p50SpreadMs,
    p95SpreadMs,
    truncationCounts,
    stabilityAssessment,
    summary,
  };
}

export async function analyzeFeedComparison(
  comparisonDirectory: string,
  manifest: FeedComparisonManifest,
): Promise<FeedComparisonReport> {
  const publicCalibration = manifest.calibrations.public;
  const candidateCalibration = manifest.calibrations.candidate;
  if (publicCalibration === null || candidateCalibration === null) {
    throw new Error("comparison manifest does not contain both timing calibrations");
  }
  const root = resolve(comparisonDirectory);
  const [publicFeed, candidateFeed] = await Promise.all([
    loadFeedDataset(join(root, manifest.feeds.public.dataset), publicCalibration),
    loadFeedDataset(join(root, manifest.feeds.candidate.dataset), candidateCalibration),
  ]);
  const publicSignatures = new Set(publicFeed.observations.keys());
  const candidateSignatures = new Set(candidateFeed.observations.keys());
  const union = new Set([...publicSignatures, ...candidateSignatures]);
  const matchedSignatures = [...publicSignatures]
    .filter((signature) => candidateSignatures.has(signature))
    .sort();
  const commonStartUnixMs = Math.max(
    publicFeed.subscriptionConfirmedAtUnixMs ?? Number.POSITIVE_INFINITY,
    candidateFeed.subscriptionConfirmedAtUnixMs ?? Number.POSITIVE_INFINITY,
    manifest.window.requestedStartUnixMs ?? Number.NEGATIVE_INFINITY,
  );
  const commonEndUnixMs = Math.min(
    publicFeed.uninterruptedEndUnixMs,
    candidateFeed.uninterruptedEndUnixMs,
    manifest.window.requestedEndUnixMs ?? Number.POSITIVE_INFINITY,
  );

  const matches: MatchedSignatureComparison[] = [];
  for (const signature of matchedSignatures) {
    const publicObservation = publicFeed.observations.get(signature);
    const candidateObservation = candidateFeed.observations.get(signature);
    if (publicObservation === undefined || candidateObservation === undefined) continue;
    const publicEvents = publicFeed.events.get(signature);
    const candidateEvents = candidateFeed.events.get(signature);
    const deltaMs = Number(
      publicObservation.normalizedTimelineNs - candidateObservation.normalizedTimelineNs,
    ) / 1_000_000;
    const withinCommonWindow =
      publicObservation.raw.capture.receivedAtUnixMs >= commonStartUnixMs &&
      candidateObservation.raw.capture.receivedAtUnixMs >= commonStartUnixMs &&
      publicObservation.raw.capture.receivedAtUnixMs <= commonEndUnixMs &&
      candidateObservation.raw.capture.receivedAtUnixMs <= commonEndUnixMs;
    const initialConnections =
      publicObservation.connectionEpoch === 0 && candidateObservation.connectionEpoch === 0;
    const includedInCleanLatency = withinCommonWindow && initialConnections;
    const exclusionReason = includedInCleanLatency
      ? null
      : !initialConnections
        ? "observed after a reconnect"
        : "outside the common confirmed subscription window";
    matches.push({
      signature,
      publicArrivalUnixMs: publicObservation.raw.capture.receivedAtUnixMs,
      candidateArrivalUnixMs: candidateObservation.raw.capture.receivedAtUnixMs,
      publicArrivalMonotonicNs: publicObservation.raw.capture.receivedMonotonicNs,
      candidateArrivalMonotonicNs: candidateObservation.raw.capture.receivedMonotonicNs,
      publicNormalizedTimelineNs: publicObservation.normalizedTimelineNs.toString(),
      candidateNormalizedTimelineNs: candidateObservation.normalizedTimelineNs.toString(),
      deltaMs,
      absoluteDeltaMs: Math.abs(deltaMs),
      first: firstArrival(deltaMs, manifest.controls.tieToleranceMs),
      publicSlot: publicObservation.slot,
      candidateSlot: candidateObservation.slot,
      slotsMatch: publicObservation.slot === candidateObservation.slot,
      publicSucceeded: publicObservation.succeeded,
      candidateSucceeded: candidateObservation.succeeded,
      successStatusMatches: publicObservation.succeeded === candidateObservation.succeeded,
      publicPumpEvents: publicEvents?.count ?? 0,
      candidatePumpEvents: candidateEvents?.count ?? 0,
      publicClassification: publicEvents?.classification ?? "none",
      candidateClassification: candidateEvents?.classification ?? "none",
      payloadMatches: publicObservation.payloadFingerprint === candidateObservation.payloadFingerprint,
      parserOutputMatches: (publicEvents?.fingerprint ?? "") === (candidateEvents?.fingerprint ?? ""),
      publicConnectionEpoch: publicObservation.connectionEpoch,
      candidateConnectionEpoch: candidateObservation.connectionEpoch,
      publicLogsTruncated: publicObservation.logsTruncated,
      candidateLogsTruncated: candidateObservation.logsTruncated,
      includedInCleanLatency,
      exclusionReason,
    });
  }
  matches.sort((left, right) => {
    const leftNs = BigInt(left.publicNormalizedTimelineNs) < BigInt(left.candidateNormalizedTimelineNs)
      ? BigInt(left.publicNormalizedTimelineNs)
      : BigInt(left.candidateNormalizedTimelineNs);
    const rightNs = BigInt(right.publicNormalizedTimelineNs) < BigInt(right.candidateNormalizedTimelineNs)
      ? BigInt(right.publicNormalizedTimelineNs)
      : BigInt(right.candidateNormalizedTimelineNs);
    return leftNs < rightNs ? -1 : leftNs > rightNs ? 1 : left.signature.localeCompare(right.signature);
  });

  const clean = matches.filter((match) => match.includedInCleanLatency);
  const deltas = clean.map((match) => match.deltaMs);
  const candidateFaster = clean.filter((match) => match.first === "candidate").length;
  const publicFaster = clean.filter((match) => match.first === "public").length;
  const ties = clean.length - candidateFaster - publicFaster;
  const nonTies = clean.filter((match) => match.first !== "tie");
  const maximum = nonTies.reduce<MatchedSignatureComparison | null>(
    (current, match) => current === null || match.absoluteDeltaMs > current.absoluteDeltaMs ? match : current,
    null,
  );

  const launchUnion = [...union].filter(
    (signature) =>
      classificationIncludes(publicFeed.events.get(signature), "launch") ||
      classificationIncludes(candidateFeed.events.get(signature), "launch"),
  );
  const launchMatched = launchUnion.filter(
    (signature) =>
      classificationIncludes(publicFeed.events.get(signature), "launch") &&
      classificationIncludes(candidateFeed.events.get(signature), "launch"),
  ).length;
  const tradeUnion = [...union].filter(
    (signature) =>
      classificationIncludes(publicFeed.events.get(signature), "trade") ||
      classificationIncludes(candidateFeed.events.get(signature), "trade"),
  );
  const tradeMatched = tradeUnion.filter(
    (signature) =>
      classificationIncludes(publicFeed.events.get(signature), "trade") &&
      classificationIncludes(candidateFeed.events.get(signature), "trade"),
  ).length;
  const guardedStartUnixMs = commonStartUnixMs + COVERAGE_BOUNDARY_GUARD_MS;
  const guardedEndUnixMs = commonEndUnixMs - COVERAGE_BOUNDARY_GUARD_MS;
  const insideGuard = (observation: FeedObservation | undefined): boolean =>
    observation !== undefined &&
    observation.connectionEpoch === 0 &&
    observation.raw.capture.receivedAtUnixMs >= guardedStartUnixMs &&
    observation.raw.capture.receivedAtUnixMs <= guardedEndUnixMs;
  const guardedMatched = matches.filter(
    (match) =>
      insideGuard(publicFeed.observations.get(match.signature)) &&
      insideGuard(candidateFeed.observations.get(match.signature)),
  ).length;
  const guardedPublicOnly = [...publicSignatures].filter(
    (signature) =>
      !candidateSignatures.has(signature) && insideGuard(publicFeed.observations.get(signature)),
  ).length;
  const guardedCandidateOnly = [...candidateSignatures].filter(
    (signature) =>
      !publicSignatures.has(signature) && insideGuard(candidateFeed.observations.get(signature)),
  ).length;
  const guardedUnionSize = guardedMatched + guardedPublicOnly + guardedCandidateOnly;

  const windowDurationSeconds = manifest.window.windowDurationSeconds ?? 300;
  const windows = computeComparisonWindows(
    matches,
    publicFeed,
    candidateFeed,
    commonStartUnixMs,
    commonEndUnixMs,
    windowDurationSeconds,
  );
  const windowStability = summarizeWindowStability(windows, windowDurationSeconds);
  const truncationAwareCoverage = buildTruncationAwareCoverage(
    matches,
    publicSignatures,
    candidateSignatures,
    publicFeed.totals,
    candidateFeed.totals,
  );
  const providerLimits = {
    public: auditProviderLimitsForFeed(
      "public",
      PUBLIC_ENDPOINT_LABEL,
      publicFeed.diagnostics,
      publicFeed.totals.longestObservedInterMessageGapMs,
    ),
    candidate: auditProviderLimitsForFeed(
      "candidate",
      CANDIDATE_ENDPOINT_LABEL,
      candidateFeed.diagnostics,
      candidateFeed.totals.longestObservedInterMessageGapMs,
    ),
  };
  const storage = await computeStorageAccounting(comparisonDirectory, manifest);

  return {
    schemaVersion: 1,
    kind: "feed-comparison-report",
    comparisonId: manifest.comparisonId,
    feeds: { public: publicFeed.totals, candidate: candidateFeed.totals },
    coverage: {
      matchedSignatures: matches.length,
      publicOnlySignatures: [...publicSignatures].filter((signature) => !candidateSignatures.has(signature)).length,
      candidateOnlySignatures: [...candidateSignatures].filter((signature) => !publicSignatures.has(signature)).length,
      unionSignatures: union.size,
      jaccard: union.size === 0 ? 0 : matches.length / union.size,
      percentageRelativeToUnion: percentage(matches.length, union.size),
      launch: { matched: launchMatched, union: launchUnion.length, percentage: percentage(launchMatched, launchUnion.length) },
      trade: { matched: tradeMatched, union: tradeUnion.length, percentage: percentage(tradeMatched, tradeUnion.length) },
      uninterruptedGuardedWindow: {
        boundaryGuardMs: COVERAGE_BOUNDARY_GUARD_MS,
        matchedSignatures: guardedMatched,
        publicOnlySignatures: guardedPublicOnly,
        candidateOnlySignatures: guardedCandidateOnly,
        unionSignatures: guardedUnionSize,
        jaccard: guardedUnionSize === 0 ? 0 : guardedMatched / guardedUnionSize,
        percentageRelativeToUnion: percentage(guardedMatched, guardedUnionSize),
      },
    },
    cleanLatency: {
      definition: "Matched first observations inside both initial uninterrupted subscription intervals; no reconnect-era, backfill, finalized, or canonical data.",
      excludedMatchedSignatures: matches.length - clean.length,
      deltaMs: summarizeDistribution(deltas),
      winner: {
        tieToleranceMs: manifest.controls.tieToleranceMs,
        candidateFaster,
        publicFaster,
        ties,
        candidateFasterPercentage: percentage(candidateFaster, clean.length),
        publicFasterPercentage: percentage(publicFaster, clean.length),
        tiePercentage: percentage(ties, clean.length),
      },
      tails: {
        thresholdsMs: TAIL_THRESHOLDS_MS,
        candidateLeadCounts: TAIL_THRESHOLDS_MS.map(
          (threshold) => deltas.filter((delta) => delta > threshold).length,
        ),
        publicLeadCounts: TAIL_THRESHOLDS_MS.map(
          (threshold) => deltas.filter((delta) => delta < -threshold).length,
        ),
      },
      maximumMeaningfulLead: {
        feed: maximum?.first ?? "tie",
        milliseconds: maximum?.absoluteDeltaMs ?? 0,
        definition: "Largest non-tie absolute delta in the clean uninterrupted matched population; descriptive, not an execution advantage.",
      },
    },
    ordering: compareOrdering(matches),
    compatibility: {
      slotMismatches: matches.filter((match) => !match.slotsMatch).length,
      successStatusMismatches: matches.filter((match) => !match.successStatusMatches).length,
      payloadMismatches: matches.filter((match) => !match.payloadMatches).length,
      parserOutputMismatches: matches.filter((match) => !match.parserOutputMatches).length,
      publicLogTruncations: matches.filter((match) => match.publicLogsTruncated).length,
      candidateLogTruncations: matches.filter((match) => match.candidateLogsTruncated).length,
      payloadMismatchesWithLogTruncation: matches.filter(
        (match) => !match.payloadMatches && (match.publicLogsTruncated || match.candidateLogsTruncated),
      ).length,
      parserMismatchesWithLogTruncation: matches.filter(
        (match) => !match.parserOutputMatches && (match.publicLogsTruncated || match.candidateLogsTruncated),
      ).length,
    },
    windows,
    windowStability,
    truncationAwareCoverage,
    providerLimits,
    storage,
    methodology: {
      sameCommitment: publicFeed.manifest.source.commitment === candidateFeed.manifest.source.commitment,
      sameProgramFilter: publicFeed.manifest.source.programId === candidateFeed.manifest.source.programId,
      sameParserVersion: publicFeed.manifest.parser.version === candidateFeed.manifest.parser.version,
      sameIdlRevision: publicFeed.manifest.parser.officialIdlRevision === candidateFeed.manifest.parser.officialIdlRevision,
      sameHost:
        publicCalibration.startup.hostFingerprint === manifest.orchestrator.hostFingerprint &&
        candidateCalibration.startup.hostFingerprint === manifest.orchestrator.hostFingerprint,
      differentProcesses:
        publicCalibration.processId !== candidateCalibration.processId &&
        publicCalibration.processId !== manifest.orchestrator.processId &&
        candidateCalibration.processId !== manifest.orchestrator.processId,
      sameRequestedWindow:
        manifest.window.requestedStartUnixMs !== null && manifest.window.requestedEndUnixMs !== null,
      timingCalibrationValid: publicCalibration.valid && candidateCalibration.valid,
      noCanonicalDataUsed: true,
      apiKeyNeverPersisted:
        manifest.runtimeChecks.apiKeyWasPresent && !manifest.runtimeChecks.apiKeyPersisted,
      reconnectAffectedRecordsExcluded: matches.every(
        (match) =>
          !match.includedInCleanLatency ||
          (match.publicConnectionEpoch === 0 && match.candidateConnectionEpoch === 0),
      ),
      standardLogsSubscribeReplayBehavior:
        "Standard logsSubscribe exposes no replay cursor and does not promise replay after reconnect; post-reconnect observations are conservatively separated, not called backfill.",
    },
    matches,
    limitations: [
      "This compares two standard processed logsSubscribe feeds on one host, not validator ingress or Yellowstone/gRPC.",
      "IPC midpoint calibration has bounded uncertainty and does not create provider-side timestamps.",
      "A clean match measures relative client callback arrival only; it does not imply execution or profitability advantage.",
      "Exclusive signatures can reflect provider delivery, connection timing, processed-fork behavior, or observation gaps; zero exclusives would not prove completeness.",
      "Five minutes is a smoke test, not a profitability or long-run reliability study.",
    ],
  };
}

function metric(value: number | null): string {
  return value === null ? "n/a" : `${value.toFixed(3)} ms`;
}

export function renderFeedComparisonMarkdown(report: FeedComparisonReport): string {
  const latency = report.cleanLatency.deltaMs;
  const winner = report.cleanLatency.winner;
  return [
    `# Feed comparison ${report.comparisonId}`,
    "",
    "This is a same-host comparison of public Solana and Helius standard `logsSubscribe` at `processed`; it is not a validator-ingress, gRPC, execution, or profitability benchmark.",
    "",
    "## Coverage",
    "",
    "| Metric | Public | Helius candidate |",
    "| --- | ---: | ---: |",
    `| Raw notifications | ${report.feeds.public.rawNotifications} | ${report.feeds.candidate.rawNotifications} |`,
    `| Unique signatures | ${report.feeds.public.uniqueSignatures} | ${report.feeds.candidate.uniqueSignatures} |`,
    `| Failed transactions | ${report.feeds.public.failedTransactions} | ${report.feeds.candidate.failedTransactions} |`,
    `| Normalized Pump events | ${report.feeds.public.normalizedPumpEvents} | ${report.feeds.candidate.normalizedPumpEvents} |`,
    `| Disconnects / reconnects | ${report.feeds.public.disconnects} / ${report.feeds.public.reconnects} | ${report.feeds.candidate.disconnects} / ${report.feeds.candidate.reconnects} |`,
    "",
    `Matched ${report.coverage.matchedSignatures}; public-only ${report.coverage.publicOnlySignatures}; Helius-only ${report.coverage.candidateOnlySignatures}; Jaccard ${(report.coverage.jaccard * 100).toFixed(3)}%.`,
    `With a ${report.coverage.uninterruptedGuardedWindow.boundaryGuardMs} ms boundary guard: matched ${report.coverage.uninterruptedGuardedWindow.matchedSignatures}; public-only ${report.coverage.uninterruptedGuardedWindow.publicOnlySignatures}; Helius-only ${report.coverage.uninterruptedGuardedWindow.candidateOnlySignatures}.`,
    "",
    "## Clean first-arrival delta",
    "",
    "`delta_ms = public_arrival - helius_arrival`; positive means Helius arrived first.",
    "",
    `Population: ${latency.count} matched signatures (${report.cleanLatency.excludedMatchedSignatures} excluded).`,
    "",
    `- p50: ${metric(latency.p50)}`,
    `- p95: ${metric(latency.p95)}`,
    `- p99: ${metric(latency.p99)}`,
    `- min / max: ${metric(latency.min)} / ${metric(latency.max)}`,
    `- mean / standard deviation: ${metric(latency.mean)} / ${metric(latency.standardDeviation)}`,
    `- Helius wins / public wins / ties (±${winner.tieToleranceMs} ms): ${winner.candidateFaster} / ${winner.publicFaster} / ${winner.ties}`,
    `- Maximum clean non-tie lead: ${report.cleanLatency.maximumMeaningfulLead.feed} by ${metric(report.cleanLatency.maximumMeaningfulLead.milliseconds)}`,
    "",
    "## Window stability",
    "",
    `Stability assessment: **${report.windowStability.stabilityAssessment}** (${report.windowStability.summary})`,
    "",
    "| Window | Matched | Public-only | Helius-only | p50 delta | p95 delta | p99 delta | Helius wins % | Disconnects (pub/hel) | Helius truncations |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...report.windows.map(
      (w) =>
        `| ${w.label} | ${w.matchedSignatures} | ${w.publicOnlySignatures} | ${w.candidateOnlySignatures} | ${metric(w.cleanLatency.p50)} | ${metric(w.cleanLatency.p95)} | ${metric(w.cleanLatency.p99)} | ${w.cleanLatency.winner.candidateFasterPercentage.toFixed(1)}% | ${w.disconnects.public} / ${w.disconnects.candidate} | ${w.candidateLogTruncations} |`,
    ),
    "",
    "## Truncation-aware event coverage",
    "",
    "### A. Signature completeness",
    `- Matched signatures: ${report.truncationAwareCoverage.signatureCompleteness.matchedSignatures}`,
    `- Public-only signatures: ${report.truncationAwareCoverage.signatureCompleteness.publicOnlySignatures}`,
    `- Helius-only signatures: ${report.truncationAwareCoverage.signatureCompleteness.candidateOnlySignatures}`,
    `- Jaccard signature similarity: ${(report.truncationAwareCoverage.signatureCompleteness.jaccard * 100).toFixed(3)}%`,
    `- Assessment: ${report.truncationAwareCoverage.signatureCompleteness.interpretation}`,
    "",
    "### B. Raw log payload completeness",
    `- Total matched payloads: ${report.truncationAwareCoverage.rawPayloadCompleteness.matchedSignatures}`,
    `- Identical payloads: ${report.truncationAwareCoverage.rawPayloadCompleteness.identicalPayloadSignatures}`,
    `- Payload mismatches: ${report.truncationAwareCoverage.rawPayloadCompleteness.payloadMismatchSignatures}`,
    `- Candidate "Log truncated" count: ${report.truncationAwareCoverage.rawPayloadCompleteness.candidateLogTruncations}`,
    `- Mismatches explained by truncation: ${report.truncationAwareCoverage.rawPayloadCompleteness.payloadMismatchesWithLogTruncation}`,
    `- Unexplained payload mismatches: ${report.truncationAwareCoverage.rawPayloadCompleteness.unexplainedPayloadMismatches}`,
    `- Assessment: ${report.truncationAwareCoverage.rawPayloadCompleteness.interpretation}`,
    "",
    "### C. Parsed Pump event completeness",
    `- Public normalized Pump events: ${report.truncationAwareCoverage.parsedPumpEventCompleteness.publicNormalizedPumpEvents}`,
    `- Helius normalized Pump events: ${report.truncationAwareCoverage.parsedPumpEventCompleteness.candidateNormalizedPumpEvents}`,
    `- Net event delta (public - candidate): ${report.truncationAwareCoverage.parsedPumpEventCompleteness.eventCountDelta}`,
    `- Signatures with identical parsed events: ${report.truncationAwareCoverage.parsedPumpEventCompleteness.matchedSignaturesWithIdenticalPumpEvents}`,
    `- Signatures with parsed event mismatches: ${report.truncationAwareCoverage.parsedPumpEventCompleteness.matchedSignaturesWithPumpEventMismatches}`,
    `- Parser mismatches caused by log truncation: ${report.truncationAwareCoverage.parsedPumpEventCompleteness.pumpEventMismatchesWithLogTruncation}`,
    `- Unexplained parser mismatches: ${report.truncationAwareCoverage.parsedPumpEventCompleteness.unexplainedPumpEventMismatches}`,
    `- Assessment: ${report.truncationAwareCoverage.parsedPumpEventCompleteness.interpretation}`,
    "",
    "## Provider limits & observability",
    "",
    "| Metric | Public RPC | Helius candidate |",
    "| --- | ---: | ---: |",
    `| Endpoint label | ${report.providerLimits.public.endpointLabel} | ${report.providerLimits.candidate.endpointLabel} |`,
    `| Subscription errors | ${report.providerLimits.public.subscriptionErrors} | ${report.providerLimits.candidate.subscriptionErrors} |`,
    `| Connection errors | ${report.providerLimits.public.connectionErrors} | ${report.providerLimits.candidate.connectionErrors} |`,
    `| Disconnects / Reconnects | ${report.providerLimits.public.disconnects} / ${report.providerLimits.public.reconnects} | ${report.providerLimits.candidate.disconnects} / ${report.providerLimits.candidate.reconnects} |`,
    `| Rate limit / throttle messages | ${report.providerLimits.public.rateLimitOrThrottleCount} | ${report.providerLimits.candidate.rateLimitOrThrottleCount} |`,
    `| Abnormal delivery gaps (>5s) | ${report.providerLimits.public.abnormalGapsCount} | ${report.providerLimits.candidate.abnormalGapsCount} |`,
    `| Longest observed gap | ${report.providerLimits.public.longestObservedInterMessageGapMs ?? "n/a"} ms | ${report.providerLimits.candidate.longestObservedInterMessageGapMs ?? "n/a"} ms |`,
    "",
    `Note: ${report.providerLimits.candidate.freePlanCreditTrackingNotice}`,
    "",
    "## Storage accounting & projections",
    "",
    `- Public dataset size: ${(report.storage.publicDatasetBytes / (1024 * 1024)).toFixed(2)} MB`,
    `- Helius dataset size: ${(report.storage.candidateDatasetBytes / (1024 * 1024)).toFixed(2)} MB`,
    `- Comparison manifest size: ${(report.storage.comparisonOutputBytes / 1024).toFixed(2)} KB`,
    `- Total observed input size: ${report.storage.totalMegabytes.toFixed(2)} MB over ${report.storage.elapsedMinutes.toFixed(1)} min (${report.storage.megabytesPerMinute.toFixed(2)} MB/min)`,
    `- Estimated 15-minute footprint: ${report.storage.projections.estimated15MinMegabytes.toFixed(1)} MB (${(report.storage.projections.estimated15MinMegabytes / 1024).toFixed(2)} GB)`,
    `- Estimated 30-minute footprint: ${report.storage.projections.estimated30MinMegabytes.toFixed(1)} MB (${(report.storage.projections.estimated30MinMegabytes / 1024).toFixed(2)} GB)`,
    `- Estimated 120-minute footprint: ${report.storage.projections.estimated120MinMegabytes.toFixed(1)} MB (${(report.storage.projections.estimated120MinMegabytes / 1024).toFixed(2)} GB)`,
    `- Assessment: ${report.storage.assessment}`,
    "",
    "## Compatibility and controls",
    "",
    `Payload mismatches: ${report.compatibility.payloadMismatches}; parser-output mismatches: ${report.compatibility.parserOutputMismatches}; slot mismatches: ${report.compatibility.slotMismatches}. Helius log truncations: ${report.compatibility.candidateLogTruncations}; truncation-linked parser mismatches: ${report.compatibility.parserMismatchesWithLogTruncation}.`,
    "",
    `Timing calibration valid: ${report.methodology.timingCalibrationValid}; separate processes: ${report.methodology.differentProcesses}; API key absent from persisted artifacts: ${report.methodology.apiKeyNeverPersisted}; reconnect records excluded: ${report.methodology.reconnectAffectedRecordsExcluded}.`,
    "",
    "## Limitations",
    "",
    ...report.limitations.map((limitation) => `- ${limitation}`),
    "",
  ].join("\n");
}

export async function writeFeedComparisonReports(
  comparisonDirectory: string,
  report: FeedComparisonReport,
): Promise<void> {
  const root = resolve(comparisonDirectory);
  await Promise.all([
    writeFile(join(root, "feed-comparison-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8"),
    writeFile(join(root, "feed-comparison-report.md"), renderFeedComparisonMarkdown(report), "utf8"),
  ]);
}

export async function secretAppearsInFiles(paths: readonly string[], secret: string): Promise<boolean> {
  if (secret.length === 0) throw new Error("secret presence check requires a non-empty secret");
  for (const path of paths) {
    const content = await readFile(path, "utf8");
    if (content.includes(secret)) return true;
  }
  return false;
}
