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
  type Phase2Manifest,
  type RawRpcRecord,
  type TransactionEnrichment,
} from "./types.js";

export const PHASE2_DERIVED_DIRECTORY = "derived";
export const TRANSACTIONS_FILE = "transactions.jsonl";
export const VENUE_EVENTS_FILE = "venue-events.jsonl";
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
      requestedComputeUnitPriceMicroLamports:
        enrichment.computeBudget.requestedComputeUnitPriceMicroLamports,
      requestedPriorityFeeLamports: enrichment.computeBudget.requestedPriorityFeeLamports,
    },
    venuePayload: jsonSafe(event),
  };
}

async function phase1Evidence(dataset: string): Promise<{
  readonly manifest: DatasetManifest;
  readonly rawRecords: RawLogRecord[];
  readonly events: NormalizedMarketEvent[];
  readonly diagnostics: DiagnosticRecord[];
  readonly observations: ReadonlyMap<string, LiveObservation>;
  readonly eventLocations: ReadonlyMap<string, { outerInstructionIndex: number | null; eventIndex: number }>;
}> {
  const [manifestText, rawRecords, events, diagnostics] = await Promise.all([
    readFile(join(dataset, MANIFEST_FILE_NAME), "utf8"),
    collect<RawLogRecord>(join(dataset, RAW_FILE_NAME)),
    collect<NormalizedMarketEvent>(join(dataset, EVENTS_FILE_NAME)),
    collect<DiagnosticRecord>(join(dataset, DIAGNOSTICS_FILE_NAME)),
  ]);
  const observations = new Map<string, LiveObservation>();
  const eventLocations = new Map<string, { outerInstructionIndex: number | null; eventIndex: number }>();
  for (const raw of rawRecords) {
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
      });
    }
    const parsed = parsePumpProgramLogs(notification.value.params.result.value.logs);
    for (const located of parsed.events) {
      const type = located.event.kind === "create" ? "launch" : "trade";
      eventLocations.set(`${signature}:${located.logIndex}:${type}`, {
        outerInstructionIndex: located.outerInstructionIndex,
        eventIndex: located.eventIndex,
      });
    }
  }
  return {
    manifest: JSON.parse(manifestText) as DatasetManifest,
    rawRecords,
    events,
    diagnostics,
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
  const parseMicroseconds = phase1.rawRecords.flatMap((record) => {
    try {
      return [Number(BigInt(record.capture.parseDurationNs)) / 1_000];
    } catch {
      return [];
    }
  });

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
    },
    latency: {
      collectorReceiveMinusBlockTimeMs: distribution(receiveMinusBlock),
      collectorReceiveMinusBlockTimeCaveat:
        "Block time is validator-estimated and second-resolution. This value mixes block timestamp coarseness, provider delivery, network transit, and local wall-clock offset; it is not millisecond network latency.",
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
  const [phase1, transactionRecords, blockRecords, gaps] = await Promise.all([
    phase1Evidence(dataset),
    collect<RawRpcRecord>(rawTransactionPath),
    collect<RawRpcRecord>(rawBlockPath),
    collect<GapRecoveryRecord>(rawGapPath),
  ]);
  const transactionIndexes = transactionIndexesFromBlockRecords(blockRecords);
  const directTransactions = transactionRecords.map((record) =>
    parseTransactionEnrichment(record, transactionIndexes),
  );
  const directSignatures = new Set(directTransactions.map((item) => item.signature));
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
  ].filter((item) => item.slot >= 0 && !directSignatures.has(item.signature));
  const transactions = [
    ...directTransactions,
    ...transactionEnrichmentsFromFullBlocks(blockRecords, expectedFromBlocks),
  ];
  const enrichmentBySignature = new Map(transactions.map((item) => [item.signature, item]));
  const venueEvents: VenueEventEnvelope[] = phase1.events.map((event) => {
    const location = phase1.eventLocations.get(event.eventId);
    return venueEnvelopeFromLiveEvent(
      event,
      enrichmentBySignature.get(event.signature) ?? null,
      location?.outerInstructionIndex ?? null,
      location?.eventIndex ?? 0,
    );
  });
  for (const enrichment of transactions) {
    if (
      enrichment.provenance !== "backfilled" ||
      enrichment.enrichmentStatus !== "success" ||
      enrichment.transactionStatus !== "success" ||
      enrichment.logMessages === null
    ) {
      continue;
    }
    const parsed = parsePumpProgramLogs(enrichment.logMessages);
    for (const located of parsed.events) {
      venueEvents.push(backfilledEnvelope(enrichment.signature, located, enrichment));
    }
  }
  const uniqueVenueEvents = [...new Map(venueEvents.map((event) => [event.eventId, event])).values()]
    .sort(compareCanonicalEvents);

  const inputDigests = {
    rawSha256: await digestFile(join(dataset, RAW_FILE_NAME)),
    eventsSha256: await digestFile(join(dataset, EVENTS_FILE_NAME)),
    diagnosticsSha256: await digestFile(join(dataset, DIAGNOSTICS_FILE_NAME)),
    rpcTransactionsSha256: await digestFile(rawTransactionPath),
    rpcBlocksSha256: await digestFile(rawBlockPath),
    gapRecoverySha256: await digestFile(rawGapPath),
  };
  const report = qualityReport({ phase1, transactions, venueEvents: uniqueVenueEvents, gaps, inputDigests });
  await mkdir(derivedDirectory, { recursive: true });
  const transactionsPath = join(derivedDirectory, TRANSACTIONS_FILE);
  const venueEventsPath = join(derivedDirectory, VENUE_EVENTS_FILE);
  const gapsPath = join(derivedDirectory, GAPS_FILE);
  const reportPath = join(derivedDirectory, FEED_QUALITY_FILE);
  const [transactionsSha256, venueEventsSha256, gapsSha256] = await Promise.all([
    writeJsonLines(transactionsPath, transactions),
    writeJsonLines(venueEventsPath, uniqueVenueEvents),
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
      venueEvents: `${PHASE2_DERIVED_DIRECTORY}/${VENUE_EVENTS_FILE}`,
      gaps: `${PHASE2_DERIVED_DIRECTORY}/${GAPS_FILE}`,
      feedQuality: `${PHASE2_DERIVED_DIRECTORY}/${FEED_QUALITY_FILE}`,
    },
    counts: {
      transactionEnrichments: transactions.length,
      venueEvents: uniqueVenueEvents.length,
      gaps: gaps.length,
    },
    outputDigests: { transactionsSha256, venueEventsSha256, gapsSha256, feedQualitySha256 },
    limitations: [
      "Raw Phase 1 JSONL and raw Phase 2 RPC evidence remain the immutable sources; this directory may be rebuilt.",
      "Finalized getTransaction availability proves finality for returned transactions, not completeness of PubSub delivery.",
      "Canonical transaction index comes from signature position in finalized getBlock output.",
      "An inferred outer-instruction index depends on complete runtime invoke logs; the raw log index is retained.",
      "No millisecond latency claim is made from second-resolution blockTime.",
    ],
  };
  await writeFile(join(phase2Root, PHASE2_MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return { transactions, venueEvents: uniqueVenueEvents, gaps, report, manifest };
}

export async function readFeedQualityReport(datasetDirectory: string): Promise<FeedQualityReport> {
  const path = join(resolve(datasetDirectory), PHASE2_DIRECTORY, PHASE2_DERIVED_DIRECTORY, FEED_QUALITY_FILE);
  return JSON.parse(await readFile(path, "utf8")) as FeedQualityReport;
}
