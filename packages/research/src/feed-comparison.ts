import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
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
  DistributionSummary,
  FeedComparisonManifest,
  FeedComparisonReport,
  FeedTotals,
  MatchedSignatureComparison,
  SignatureClassification,
  TimingCalibration,
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
