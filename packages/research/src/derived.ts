import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  parseLogsNotification,
  type DiagnosticRecord,
  type NormalizedMarketEvent,
  type RawLogRecord,
  type VenueEventEnvelope,
} from "@botwiner/market-data";
import { parsePumpProgramLogs, type PumpEvent } from "@botwiner/pumpfun";
import {
  DIAGNOSTICS_FILE_NAME,
  EVENTS_FILE_NAME,
  MANIFEST_FILE_NAME,
  RAW_FILE_NAME,
  digestFile,
  readJsonLines,
  sha256,
  writeJsonLines,
  type DatasetManifest,
} from "@botwiner/storage";
import {
  compareCanonicalEvents,
  compareObservedEvents,
  parseTransactionEnrichment,
  transactionEnrichmentsFromFullBlocks,
  transactionIndexesFromBlockRecords,
  venueEnvelopeFromLiveEvent,
} from "./enrichment.js";
import {
  GAP_RECOVERY_FILE,
  PHASE2_RAW_DIRECTORY,
  RPC_BLOCKS_FILE,
  RPC_TRANSACTIONS_FILE,
} from "./rpc.js";
import {
  PHASE2_DIRECTORY,
  type DerivedResearchData,
  type Distribution,
  type FeedQualityReport,
  type GapRecoveryRecord,
  type ObservedTransactionRecord,
  type Phase2Manifest,
  type RawRpcRecord,
  type TransactionEnrichment,
} from "./types.js";

export const PHASE2_DERIVED_DIRECTORY = "derived";
export const TRANSACTIONS_FILE = "transactions.jsonl";
export const VENUE_EVENTS_FILE = "venue-events.jsonl";
export const CANONICAL_VENUE_EVENTS_FILE = "venue-events-canonical.jsonl";
export const OBSERVED_TRANSACTIONS_FILE = "transactions-observed.jsonl";
export const GAPS_FILE = "gaps.jsonl";
export const FEED_QUALITY_FILE = "feed-quality.json";
export const PHASE2_MANIFEST_FILE = "manifest.json";

function jsonSafe(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (_key, item: unknown) =>
    typeof item === "bigint" ? item.toString() : item,
  )) as unknown;
}

async function collect<T>(path: string): Promise<T[]> {
  const result: T[] = [];
  for await (const line of readJsonLines<T>(path)) result.push(line.value);
  return result;
}

function distribution(values: readonly number[]): Distribution {
  if (values.length === 0) return { count: 0, min: null, p50: null, p95: null, p99: null, max: null };
  const sorted = [...values].sort((left, right) => left - right);
  const quantile = (ratio: number): number => {
    const value = sorted[Math.floor((sorted.length - 1) * ratio)] ?? 0;
    return Math.round(value * 1_000) / 1_000;
  };
  return {
    count: sorted.length,
    min: quantile(0),
    p50: quantile(0.5),
    p95: quantile(0.95),
    p99: quantile(0.99),
    max: quantile(1),
  };
}

function pairwiseInversions(values: readonly number[]): number {
  function count(items: number[]): { sorted: number[]; inversions: number } {
    if (items.length < 2) return { sorted: items, inversions: 0 };
    const middle = Math.floor(items.length / 2);
    const left = count(items.slice(0, middle));
    const right = count(items.slice(middle));
    const sorted: number[] = [];
    let leftIndex = 0;
    let rightIndex = 0;
    let inversions = left.inversions + right.inversions;
    while (leftIndex < left.sorted.length && rightIndex < right.sorted.length) {
      const leftValue = left.sorted[leftIndex] ?? 0;
      const rightValue = right.sorted[rightIndex] ?? 0;
      if (leftValue <= rightValue) {
        sorted.push(leftValue);
        leftIndex += 1;
      } else {
        sorted.push(rightValue);
        rightIndex += 1;
        inversions += left.sorted.length - leftIndex;
      }
    }
    sorted.push(...left.sorted.slice(leftIndex), ...right.sorted.slice(rightIndex));
    return { sorted, inversions };
  }
  return count([...values]).inversions;
}

interface LiveObservation {
  readonly slot: number;
  readonly receivedAtUnixMs: number;
  readonly receivedMonotonicNs: string;
  readonly sequence: number;
  readonly error: unknown;
}

function backfilledEnvelope(
  signature: string,
  located: ReturnType<typeof parsePumpProgramLogs>["events"][number],
  enrichment: TransactionEnrichment,
): VenueEventEnvelope {
  const event: PumpEvent = located.event;
  const trade = event.kind === "trade" ? event : null;
  return {
    schemaVersion: 1,
    kind: "venue-event",
    eventId: `${signature}:${located.logIndex}:${event.kind === "create" ? "launch" : "trade"}`,
    venue: "pumpfun-bonding-curve",
    chain: "solana-mainnet",
    provenance: "backfilled",
    instrument: {
      baseMint: event.mint,
      quoteMint: event.quoteMint,
    },
    eventType: event.kind === "create" ? "launch" : "trade",
    side: trade === null ? null : trade.isBuy ? "buy" : "sell",
    signature,
    observed: {
      collectorSequence: null,
      receivedAtUnixMs: null,
      receivedMonotonicNs: null,
      parseDurationNs: null,
      providerReceivedAtUnixMs: null,
    },
    canonical: {
      slot: enrichment.slot,
      transactionIndex: enrichment.canonicalTransactionIndex,
      outerInstructionIndex: located.outerInstructionIndex,
      outerInstructionIndexSource: located.outerInstructionIndexSource,
      transactionLogIndex: located.logIndex,
      eventIndex: located.eventIndex,
      blockTimeUnixSeconds: enrichment.blockTimeUnixSeconds,
      confirmationStatus: enrichment.confirmationStatus,
    },
    amounts: {
      baseUnits: trade?.tokenAmount.toString() ?? null,
      quoteBaseUnits: trade?.quoteAmount.toString() ?? null,
    },
    transactionCost: {
      feeLamports: enrichment.feeLamports,
      computeUnitsConsumed: enrichment.computeUnitsConsumed,
      requestedComputeUnitLimit: enrichment.computeBudget.requestedComputeUnitLimit,
      effectiveComputeUnitLimit: enrichment.computeBudget.effectiveComputeUnitLimit,
      computeUnitLimitSource: enrichment.computeBudget.computeUnitLimitSource,
      requestedComputeUnitPriceMicroLamports:
        enrichment.computeBudget.requestedComputeUnitPriceMicroLamports,
      requestedPriorityFeeLamports: enrichment.computeBudget.requestedPriorityFeeLamports,
      observableJitoTipLamports: enrichment.jitoTip.totalLamports,
      observableJitoTipStatus: enrichment.jitoTip.status,
    },
    venuePayload: jsonSafe(event),
  };
}

async function phase1Evidence(dataset: string): Promise<{
  readonly manifest: DatasetManifest;
  readonly events: NormalizedMarketEvent[];
  readonly diagnostics: DiagnosticRecord[];
  readonly rawParseDurationsMicroseconds: readonly number[];
  readonly observations: ReadonlyMap<string, LiveObservation>;
  readonly eventLocations: ReadonlyMap<string, {
    outerInstructionIndex: number | null;
    outerInstructionIndexSource: VenueEventEnvelope["canonical"]["outerInstructionIndexSource"];
    eventIndex: number;
  }>;
}> {
  const [manifestText, events, diagnostics] = await Promise.all([
    readFile(join(dataset, MANIFEST_FILE_NAME), "utf8"),
    collect<NormalizedMarketEvent>(join(dataset, EVENTS_FILE_NAME)),
    collect<DiagnosticRecord>(join(dataset, DIAGNOSTICS_FILE_NAME)),
  ]);
  const observations = new Map<string, LiveObservation>();
  const eventLocations = new Map<string, {
    outerInstructionIndex: number | null;
    outerInstructionIndexSource: VenueEventEnvelope["canonical"]["outerInstructionIndexSource"];
    eventIndex: number;
  }>();
  const rawParseDurationsMicroseconds: number[] = [];
  for await (const line of readJsonLines<RawLogRecord>(join(dataset, RAW_FILE_NAME))) {
    const raw = line.value;
    try {
      rawParseDurationsMicroseconds.push(Number(BigInt(raw.capture.parseDurationNs)) / 1_000);
    } catch {
      // Malformed duration evidence is excluded from this distribution, not invented.
    }
    const notification = parseLogsNotification(raw.rpcPayload);
    if (!notification.ok) continue;
    const signature = notification.value.params.result.value.signature;
    const existing = observations.get(signature);
    if (existing === undefined || raw.sequence < existing.sequence) {
      observations.set(signature, {
        slot: notification.value.params.result.context.slot,
        receivedAtUnixMs: raw.capture.receivedAtUnixMs,
        receivedMonotonicNs: raw.capture.receivedMonotonicNs,
        sequence: raw.sequence,
        error: notification.value.params.result.value.err,
      });
    }
    const parsed = parsePumpProgramLogs(notification.value.params.result.value.logs);
    for (const located of parsed.events) {
      const type = located.event.kind === "create" ? "launch" : "trade";
      eventLocations.set(`${signature}:${located.logIndex}:${type}`, {
        outerInstructionIndex: located.outerInstructionIndex,
        outerInstructionIndexSource: located.outerInstructionIndexSource,
        eventIndex: located.eventIndex,
      });
    }
  }
  return {
    manifest: JSON.parse(manifestText) as DatasetManifest,
    events,
    diagnostics,
    rawParseDurationsMicroseconds,
    observations,
    eventLocations,
  };
}

function qualityReport(options: {
  readonly phase1: Awaited<ReturnType<typeof phase1Evidence>>;
  readonly transactions: readonly TransactionEnrichment[];
  readonly venueEvents: readonly VenueEventEnvelope[];
  readonly gaps: readonly GapRecoveryRecord[];
  readonly inputDigests: FeedQualityReport["inputDigests"];
}): FeedQualityReport {
  const { phase1, transactions, venueEvents, gaps } = options;
  const success = transactions.filter((item) => item.enrichmentStatus === "success");
  const enrichmentBySignature = new Map(transactions.map((item) => [item.signature, item]));
  const receiveMinusBlock: number[] = [];
  const confirmationObservation: number[] = [];
  for (const [signature, observed] of phase1.observations) {
    const enrichment = enrichmentBySignature.get(signature);
    if (enrichment?.blockTimeUnixSeconds !== null && enrichment?.blockTimeUnixSeconds !== undefined) {
      receiveMinusBlock.push(observed.receivedAtUnixMs - enrichment.blockTimeUnixSeconds * 1_000);
    }
    if (enrichment?.confirmationStatus === "finalized") {
      confirmationObservation.push(enrichment.fetchedAtUnixMs - observed.receivedAtUnixMs);
    }
  }
  const parseMicroseconds = phase1.rawParseDurationsMicroseconds;

  const comparable = venueEvents.filter(
    (event) =>
      event.provenance === "live" &&
      event.observed.collectorSequence !== null &&
      event.canonical.slot !== null &&
      event.canonical.transactionIndex !== null,
  );
  const canonical = [...comparable].sort(compareCanonicalEvents);
  const ranks = new Map(canonical.map((event, index) => [event.eventId, index]));
  const observedRanks = [...comparable]
    .sort((left, right) =>
      (left.observed.collectorSequence ?? 0) - (right.observed.collectorSequence ?? 0) ||
      left.canonical.transactionLogIndex - right.canonical.transactionLogIndex,
    )
    .map((event) => ranks.get(event.eventId) ?? 0);

  const launchesByMint = new Map<string, VenueEventEnvelope>();
  for (const event of venueEvents) {
    if (event.provenance === "live" && event.eventType === "launch") {
      const existing = launchesByMint.get(event.instrument.baseMint);
      if (
        existing === undefined ||
        (event.observed.collectorSequence ?? Number.MAX_SAFE_INTEGER) <
          (existing.observed.collectorSequence ?? Number.MAX_SAFE_INTEGER)
      ) {
        launchesByMint.set(event.instrument.baseMint, event);
      }
    }
  }
  const firstTradeByMint = new Map<string, VenueEventEnvelope>();
  for (const event of venueEvents) {
    if (event.provenance !== "live" || event.eventType !== "trade") continue;
    const existing = firstTradeByMint.get(event.instrument.baseMint);
    if (
      existing === undefined ||
      (event.observed.collectorSequence ?? Number.MAX_SAFE_INTEGER) <
        (existing.observed.collectorSequence ?? Number.MAX_SAFE_INTEGER)
    ) {
      firstTradeByMint.set(event.instrument.baseMint, event);
    }
  }
  const firstTradeDelayByToken: { tokenMint: string; delayMs: number }[] = [];
  for (const [tokenMint, launch] of launchesByMint) {
    const trade = firstTradeByMint.get(tokenMint);
    if (trade === undefined || trade.observed.receivedMonotonicNs === null || launch.observed.receivedMonotonicNs === null) continue;
    const delayMs = Number(
      BigInt(trade.observed.receivedMonotonicNs) - BigInt(launch.observed.receivedMonotonicNs),
    ) / 1_000_000;
    firstTradeDelayByToken.push({ tokenMint, delayMs: Math.round(delayMs * 1_000) / 1_000 });
  }
  firstTradeDelayByToken.sort((left, right) => left.tokenMint.localeCompare(right.tokenMint));

  const countBySlot = new Map<number, number>();
  for (const event of venueEvents) {
    if (event.canonical.slot !== null) {
      countBySlot.set(event.canonical.slot, (countBySlot.get(event.canonical.slot) ?? 0) + 1);
    }
  }
  const knownUnrecoveredSignatures = gaps.reduce((total, gap) =>
    total + gap.newlyDiscoveredSignatures.filter(
      (signature) => enrichmentBySignature.get(signature)?.enrichmentStatus !== "success",
    ).length,
  0);
  const rawCount = phase1.manifest.counts.rawNotifications;
  const duplicateDenominator = phase1.manifest.counts.normalizedEvents + phase1.manifest.counts.duplicateEvents;
  const enrichmentCount = transactions.length;
  let observedVsFinalizedSlotComparisons = 0;
  let observedVsFinalizedSlotMismatches = 0;
  const failedBySlot = new Map<number, { failed: number; observed: number }>();
  for (const [signature, observation] of phase1.observations) {
    const enrichment = enrichmentBySignature.get(signature);
    if (enrichment?.slot !== null && enrichment?.slot !== undefined) {
      observedVsFinalizedSlotComparisons += 1;
      if (enrichment.slot !== observation.slot) observedVsFinalizedSlotMismatches += 1;
    }
    const slot = failedBySlot.get(observation.slot) ?? { failed: 0, observed: 0 };
    slot.observed += 1;
    if (observation.error !== null) slot.failed += 1;
    failedBySlot.set(observation.slot, slot);
  }
  const sntpDiagnostics = phase1.diagnostics.filter((item) => item.code === "clock-offset-sampled");
  const diagnosticNumbers = (field: string): number[] => sntpDiagnostics.flatMap((item) => {
    const value = item.details[field];
    return typeof value === "number" && Number.isFinite(value) ? [value] : [];
  });
  const observableJitoTipLamports = success.reduce(
    (total, item) => total + BigInt(item.jitoTip.totalLamports ?? "0"),
    0n,
  );

  return {
    schemaVersion: 1,
    kind: "feed-quality-report",
    sessionId: phase1.manifest.sessionId,
    inputDigests: options.inputDigests,
    counts: {
      liveRawNotifications: rawCount,
      successfulNormalizedEvents: phase1.manifest.counts.normalizedEvents,
      failedTransactionsObserved: phase1.manifest.counts.failedTransactions,
      duplicateEvents: phase1.manifest.counts.duplicateEvents,
      parserFailures: phase1.manifest.counts.malformedPumpEvents,
      disconnectsWithReconnect: phase1.manifest.counts.disconnects,
      detectedGaps: gaps.length,
      backfilledEvents: venueEvents.filter((event) => event.provenance === "backfilled").length,
      knownUnrecoveredSignatures,
      eventsUnrecovered: null,
      launches: venueEvents.filter((event) => event.eventType === "launch").length,
      trades: venueEvents.filter((event) => event.eventType === "trade").length,
    },
    rates: {
      duplicateRate: duplicateDenominator === 0 ? null : phase1.manifest.counts.duplicateEvents / duplicateDenominator,
      parserFailureRatePerRawNotification:
        rawCount === 0 ? null : phase1.manifest.counts.malformedPumpEvents / rawCount,
      enrichmentSuccessRate: enrichmentCount === 0 ? null : success.length / enrichmentCount,
      enrichmentFailureRate: enrichmentCount === 0 ? null : (enrichmentCount - success.length) / enrichmentCount,
    },
    gaps: {
      estimatedTotalDurationMs: gaps.reduce((total, gap) => total + gap.estimatedDurationMs, 0),
      fullyBoundedQueriesCompleted: gaps.filter((gap) => gap.queryCompleted).length,
      truncatedQueries: gaps.filter((gap) => gap.queryTruncatedByBound).length,
      unrecoverableGaps: gaps.filter((gap) => !gap.queryCompleted).length,
      completenessClaim: false,
      caveat:
        "Disconnect recovery uses bounded address history. It cannot detect silent PubSub loss, prove provider history retention, or convert unknown missing signatures into an exact missing-event count.",
    },
    ordering: {
      comparableLiveEvents: comparable.length,
      pairwiseObservedVsCanonicalInversions: pairwiseInversions(observedRanks),
      eventsWithoutCanonicalOrder: venueEvents.length - venueEvents.filter(
        (event) => event.canonical.slot !== null && event.canonical.transactionIndex !== null,
      ).length,
      observedVsFinalizedSlotComparisons,
      observedVsFinalizedSlotMismatches,
    },
    congestion: {
      observedTransactions: phase1.observations.size,
      failedTransactions: phase1.manifest.counts.failedTransactions,
      failedTransactionRate:
        phase1.observations.size === 0
          ? null
          : phase1.manifest.counts.failedTransactions / phase1.observations.size,
      failedTransactionsByObservedSlot: [...failedBySlot]
        .sort(([left], [right]) => left - right)
        .map(([slot, counts]) => ({ slot, ...counts })),
      caveat:
        "The observed transaction stream retains failed transactions as congestion evidence. It is not a complete mempool or leader ingress trace.",
    },
    clock: {
      sntpSamples: sntpDiagnostics.length,
      offsetMs: distribution(diagnosticNumbers("offsetMs")),
      roundTripTimeMs: distribution(diagnosticNumbers("roundTripMs")),
      caveat:
        "SNTP samples are intermittent local clock evidence. They do not calibrate provider ingress time, eliminate asymmetric path error, or replace monotonic timing for within-process intervals.",
    },
    latency: {
      collectorReceiveMinusBlockTimeMs: distribution(receiveMinusBlock),
      collectorReceiveMinusBlockTimeCaveat:
        "Block time is validator-estimated and second-resolution. This value mixes block timestamp coarseness, provider delivery, network transit, and local wall-clock offset; it is not millisecond network latency.",
      collectorReceiveMinusBlockTimeEligibleForExecutionModel: false,
      collectorParseDurationMicroseconds: distribution(parseMicroseconds),
      confirmationObservationDelayMs: distribution(confirmationObservation),
      confirmationObservationDelayCaveat:
        "Measured from live receipt to the later finalized getTransaction response. It includes when the enrichment job started and RPC service time, so it is only an upper-bound observation, not consensus confirmation latency.",
      firstObservedTradeDelayMs: distribution(firstTradeDelayByToken.map((item) => item.delayMs)),
      firstObservedTradeDelayByToken: firstTradeDelayByToken,
    },
    enrichment: {
      requestedSignatures: enrichmentCount,
      successful: success.length,
      unavailable: transactions.filter((item) => item.enrichmentStatus === "unavailable").length,
      malformed: transactions.filter((item) => item.enrichmentStatus === "malformed").length,
      rpcErrors: transactions.filter((item) => item.enrichmentStatus === "rpc-error").length,
      withCanonicalTransactionIndex: success.filter((item) => item.canonicalTransactionIndex !== null).length,
      withComputeUnitsConsumed: success.filter((item) => item.computeUnitsConsumed !== null).length,
      withExplicitComputeUnitPrice: success.filter(
        (item) => item.computeBudget.requestedComputeUnitPriceMicroLamports !== null,
      ).length,
      withRuntimeDefaultComputeUnitLimit: success.filter(
        (item) => item.computeBudget.computeUnitLimitSource === "runtime-default",
      ).length,
      withObservableJitoTip: success.filter((item) => item.jitoTip.status === "observed-transfer").length,
      observableJitoTipLamports: observableJitoTipLamports.toString(),
    },
    eventCountBySlot: [...countBySlot]
      .sort(([left], [right]) => left - right)
      .map(([slot, count]) => ({ slot, count })),
  };
}

export async function rebuildDerivedResearchStore(
  datasetDirectory: string,
): Promise<DerivedResearchData> {
  const dataset = resolve(datasetDirectory);
  const phase2Root = join(dataset, PHASE2_DIRECTORY);
  const rawDirectory = join(phase2Root, PHASE2_RAW_DIRECTORY);
  const derivedDirectory = join(phase2Root, PHASE2_DERIVED_DIRECTORY);
  const rawTransactionPath = join(rawDirectory, RPC_TRANSACTIONS_FILE);
  const rawBlockPath = join(rawDirectory, RPC_BLOCKS_FILE);
  const rawGapPath = join(rawDirectory, GAP_RECOVERY_FILE);
  const [phase1, gaps] = await Promise.all([
    phase1Evidence(dataset),
    collect<GapRecoveryRecord>(rawGapPath),
  ]);
  const backfilledSlotBySignature = new Map(
    gaps.flatMap((gap) => gap.candidateSignatures.map((item) => [item.signature, item.slot] as const)),
  );
  const expectedFromBlocks = [
    ...[...phase1.observations].map(([signature, observation]) => ({
      signature,
      slot: observation.slot,
      provenance: "live" as const,
    })),
    ...gaps.flatMap((gap) => gap.newlyDiscoveredSignatures.flatMap((signature) => {
      const slot = backfilledSlotBySignature.get(signature);
      return slot === undefined ? [] : [{ signature, slot, provenance: "backfilled" as const }];
    })),
  ].filter((item) => item.slot >= 0);
  const expectedBySlot = new Map<number, typeof expectedFromBlocks>();
  for (const expected of expectedFromBlocks) {
    const group = expectedBySlot.get(expected.slot) ?? [];
    group.push(expected);
    expectedBySlot.set(expected.slot, group);
  }

  // Full blocks can be hundreds of megabytes. Consume one JSONL record at a time and
  // retain only the requested transaction enrichments and compact signature indexes.
  const transactionIndexes = new Map<string, number>();
  const transactionBySignature = new Map<string, TransactionEnrichment>();
  const slotsSeen = new Set<number>();
  for await (const line of readJsonLines<RawRpcRecord>(rawBlockPath)) {
    const record = line.value;
    for (const [signature, index] of transactionIndexesFromBlockRecords([record])) {
      transactionIndexes.set(signature, index);
    }
    const slot = Number(record.request.subject);
    if (!Number.isSafeInteger(slot)) continue;
    slotsSeen.add(slot);
    for (const enrichment of transactionEnrichmentsFromFullBlocks(
      [record],
      expectedBySlot.get(slot) ?? [],
    )) {
      transactionBySignature.set(enrichment.signature, enrichment);
    }
  }
  for (const expected of expectedFromBlocks) {
    if (!slotsSeen.has(expected.slot)) {
      const missing = transactionEnrichmentsFromFullBlocks([], [expected])[0];
      if (missing !== undefined) transactionBySignature.set(expected.signature, missing);
    }
  }
  // Targeted getTransaction is authoritative for the transaction payload and replaces
  // any fallback extraction from a full block while reusing the finalized block index.
  for await (const line of readJsonLines<RawRpcRecord>(rawTransactionPath)) {
    const enrichment = parseTransactionEnrichment(line.value, transactionIndexes);
    transactionBySignature.set(enrichment.signature, enrichment);
  }
  const transactionOrder = [
    ...expectedFromBlocks.map((item) => item.signature),
    ...transactionBySignature.keys(),
  ];
  const transactions = [...new Set(transactionOrder)].flatMap((signature) => {
    const enrichment = transactionBySignature.get(signature);
    return enrichment === undefined ? [] : [enrichment];
  });
  const enrichmentBySignature = new Map(transactions.map((item) => [item.signature, item]));
  const correlatedLocations = new Map(phase1.eventLocations);
  for (const enrichment of transactions) {
    if (enrichment.logMessages === null) continue;
    const outerProgramIds = enrichment.instructions
      .filter((instruction) => instruction.innerInstructionIndex === null)
      .map((instruction) => instruction.programId);
    for (const located of parsePumpProgramLogs(enrichment.logMessages, outerProgramIds).events) {
      const type = located.event.kind === "create" ? "launch" : "trade";
      correlatedLocations.set(`${enrichment.signature}:${located.logIndex}:${type}`, {
        outerInstructionIndex: located.outerInstructionIndex,
        outerInstructionIndexSource: located.outerInstructionIndexSource,
        eventIndex: located.eventIndex,
      });
    }
  }
  const liveEnrichedEvents: VenueEventEnvelope[] = phase1.events.map((event) => {
    const location = correlatedLocations.get(event.eventId);
    return venueEnvelopeFromLiveEvent(
      event,
      enrichmentBySignature.get(event.signature) ?? null,
      location?.outerInstructionIndex ?? null,
      location?.outerInstructionIndexSource ?? null,
      location?.eventIndex ?? 0,
    );
  });
  // Causal stream deliberately excludes every field learned only from finalized RPC.
  const observedVenueEvents: VenueEventEnvelope[] = phase1.events.map((event) => {
    const location = phase1.eventLocations.get(event.eventId);
    return venueEnvelopeFromLiveEvent(
      event,
      null,
      location?.outerInstructionIndex ?? null,
      location?.outerInstructionIndexSource ?? null,
      location?.eventIndex ?? 0,
    );
  }).sort(compareObservedEvents);
  const allVenueEvents = [...liveEnrichedEvents];
  for (const enrichment of transactions) {
    if (
      enrichment.provenance !== "backfilled" ||
      enrichment.enrichmentStatus !== "success" ||
      enrichment.transactionStatus !== "success" ||
      enrichment.logMessages === null
    ) {
      continue;
    }
    const outerProgramIds = enrichment.instructions
      .filter((instruction) => instruction.innerInstructionIndex === null)
      .map((instruction) => instruction.programId);
    const parsed = parsePumpProgramLogs(enrichment.logMessages, outerProgramIds);
    for (const located of parsed.events) {
      allVenueEvents.push(backfilledEnvelope(enrichment.signature, located, enrichment));
    }
  }
  const canonicalVenueEvents = [...new Map(allVenueEvents.map((event) => [event.eventId, event])).values()]
    .sort(compareCanonicalEvents);
  const observedTransactions: ObservedTransactionRecord[] = [...phase1.observations]
    .map(([signature, observation]) => {
      return {
        schemaVersion: 1,
        kind: "observed-transaction",
        signature,
        collectorSequence: observation.sequence,
        observedSlot: observation.slot,
        receivedAtUnixMs: observation.receivedAtUnixMs,
        status: observation.error === null ? "success" : "failed",
        error: observation.error,
      } satisfies ObservedTransactionRecord;
    })
    .sort((left, right) => left.collectorSequence - right.collectorSequence);

  const inputDigests = {
    rawSha256: await digestFile(join(dataset, RAW_FILE_NAME)),
    eventsSha256: await digestFile(join(dataset, EVENTS_FILE_NAME)),
    diagnosticsSha256: await digestFile(join(dataset, DIAGNOSTICS_FILE_NAME)),
    rpcTransactionsSha256: await digestFile(rawTransactionPath),
    rpcBlocksSha256: await digestFile(rawBlockPath),
    gapRecoverySha256: await digestFile(rawGapPath),
  };
  const report = qualityReport({ phase1, transactions, venueEvents: canonicalVenueEvents, gaps, inputDigests });
  await mkdir(derivedDirectory, { recursive: true });
  const transactionsPath = join(derivedDirectory, TRANSACTIONS_FILE);
  const observedVenueEventsPath = join(derivedDirectory, VENUE_EVENTS_FILE);
  const canonicalVenueEventsPath = join(derivedDirectory, CANONICAL_VENUE_EVENTS_FILE);
  const observedTransactionsPath = join(derivedDirectory, OBSERVED_TRANSACTIONS_FILE);
  const gapsPath = join(derivedDirectory, GAPS_FILE);
  const reportPath = join(derivedDirectory, FEED_QUALITY_FILE);
  const [transactionsSha256, observedVenueEventsSha256, canonicalVenueEventsSha256, observedTransactionsSha256, gapsSha256] = await Promise.all([
    writeJsonLines(transactionsPath, transactions),
    writeJsonLines(observedVenueEventsPath, observedVenueEvents),
    writeJsonLines(canonicalVenueEventsPath, canonicalVenueEvents),
    writeJsonLines(observedTransactionsPath, observedTransactions),
    writeJsonLines(gapsPath, gaps),
  ]);
  const reportText = `${JSON.stringify(report, null, 2)}\n`;
  await writeFile(reportPath, reportText, "utf8");
  const feedQualitySha256 = sha256(reportText);
  const manifest: Phase2Manifest = {
    schemaVersion: 1,
    kind: "phase2-derived-manifest",
    sourceSessionId: phase1.manifest.sessionId,
    format: "rebuildable-jsonl",
    files: {
      rawTransactions: `${PHASE2_RAW_DIRECTORY}/${RPC_TRANSACTIONS_FILE}`,
      rawBlocks: `${PHASE2_RAW_DIRECTORY}/${RPC_BLOCKS_FILE}`,
      rawGapQueries: `${PHASE2_RAW_DIRECTORY}/${GAP_RECOVERY_FILE}`,
      transactions: `${PHASE2_DERIVED_DIRECTORY}/${TRANSACTIONS_FILE}`,
      observedVenueEvents: `${PHASE2_DERIVED_DIRECTORY}/${VENUE_EVENTS_FILE}`,
      canonicalVenueEvents: `${PHASE2_DERIVED_DIRECTORY}/${CANONICAL_VENUE_EVENTS_FILE}`,
      observedTransactions: `${PHASE2_DERIVED_DIRECTORY}/${OBSERVED_TRANSACTIONS_FILE}`,
      gaps: `${PHASE2_DERIVED_DIRECTORY}/${GAPS_FILE}`,
      feedQuality: `${PHASE2_DERIVED_DIRECTORY}/${FEED_QUALITY_FILE}`,
    },
    counts: {
      transactionEnrichments: transactions.length,
      observedVenueEvents: observedVenueEvents.length,
      canonicalVenueEvents: canonicalVenueEvents.length,
      observedTransactions: observedTransactions.length,
      gaps: gaps.length,
    },
    outputDigests: {
      transactionsSha256,
      observedVenueEventsSha256,
      canonicalVenueEventsSha256,
      observedTransactionsSha256,
      gapsSha256,
      feedQualitySha256,
    },
    limitations: [
      "Raw Phase 1 JSONL and raw Phase 2 RPC evidence remain the immutable sources; this directory may be rebuilt.",
      "Finalized getTransaction availability proves finality for returned transactions, not completeness of PubSub delivery.",
      "Canonical transaction index comes from signature position in finalized getBlock output.",
      "Observed event and transaction files preserve collector order, exclude backfill, and force finalized-only enrichment to null; canonical events are post-hoc evaluation data and must not be used as causal simulation input.",
      "Outer-instruction indexes are correlated against the authoritative message instruction list when transaction payloads are available; the raw log index is retained.",
      "Failed observed transactions are retained as congestion inputs, but this is not a mempool or leader-ingress trace.",
      "No millisecond latency or execution-timing claim is made from second-resolution blockTime.",
      "Observable Jito tips cover direct transfers in the same transaction only; separate bundle transactions and auction state remain unknown.",
    ],
  };
  await writeFile(join(phase2Root, PHASE2_MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return { transactions, observedTransactions, observedVenueEvents, canonicalVenueEvents, gaps, report, manifest };
}

export async function readFeedQualityReport(datasetDirectory: string): Promise<FeedQualityReport> {
  const path = join(resolve(datasetDirectory), PHASE2_DIRECTORY, PHASE2_DERIVED_DIRECTORY, FEED_QUALITY_FILE);
  return JSON.parse(await readFile(path, "utf8")) as FeedQualityReport;
}
