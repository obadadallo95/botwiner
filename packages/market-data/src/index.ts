export const MARKET_EVENT_SCHEMA_VERSION = 1 as const;
export const RAW_RECORD_SCHEMA_VERSION = 1 as const;
export const VENUE_EVENT_ENVELOPE_SCHEMA_VERSION = 1 as const;

export type Commitment = "processed" | "confirmed" | "finalized";

export interface SolanaLogsNotification {
  readonly jsonrpc: "2.0";
  readonly method: "logsNotification";
  readonly params: {
    readonly result: {
      readonly context: { readonly slot: number };
      readonly value: {
        readonly signature: string;
        readonly err: unknown;
        readonly logs: readonly string[];
      };
    };
    readonly subscription: number;
  };
}

export interface CollectorCaptureTime {
  /** Wall clock from Date.now(); millisecond resolution, not true nanoseconds. */
  readonly receivedAtUnixMs: number;
  readonly receivedAtIso: string;
  /** Process-local monotonic clock for precise interval measurement. */
  readonly receivedMonotonicNs: string;
  readonly parseCompletedAtUnixMs: number;
  readonly parseDurationNs: string;
  /** Standard Solana RPC does not expose a provider-side receive timestamp. */
  readonly rpcProviderReceivedAtUnixMs: null;
}

export interface RawLogRecord {
  readonly schemaVersion: typeof RAW_RECORD_SCHEMA_VERSION;
  readonly kind: "solana.logs-notification";
  readonly sequence: number;
  readonly source: {
    readonly transport: "solana-rpc-websocket";
    readonly programId: string;
    readonly commitment: Commitment;
    readonly endpointLabel: string;
  };
  readonly capture: CollectorCaptureTime;
  /** The complete parsed JSON-RPC notification, including unrecognized fields. */
  readonly rpcPayload: unknown;
}

export interface EventSource {
  readonly transport: "solana-rpc-websocket";
  readonly programId: string;
  readonly commitment: Commitment;
  readonly endpointLabel: string;
}

export interface EventOrdering {
  readonly slot: number;
  readonly collectorSequence: number;
  readonly transactionLogIndex: number;
}

export interface EventTimestamps {
  /** Second-resolution timestamp emitted by the Pump program. */
  readonly chainEventUnixSeconds: string;
  /** Not present in logsSubscribe; a later enrichment stage may supply it. */
  readonly blockTimeUnixSeconds: null;
  readonly collectorReceivedAtUnixMs: number;
  readonly collectorReceivedAtIso: string;
  readonly collectorReceivedMonotonicNs: string;
  readonly collectorParseCompletedAtUnixMs: number;
  readonly collectorParseDurationNs: string;
  readonly rpcProviderReceivedAtUnixMs: null;
}

export interface CommonMarketEvent {
  readonly schemaVersion: typeof MARKET_EVENT_SCHEMA_VERSION;
  readonly kind: "market-event";
  readonly eventId: string;
  readonly parsingVersion: string;
  readonly rawRef: string;
  readonly source: EventSource;
  readonly signature: string;
  readonly ordering: EventOrdering;
  readonly timestamps: EventTimestamps;
  readonly tokenMint: string;
  readonly unparsedTrailingBytes: number;
}

export interface LaunchMarketEvent extends CommonMarketEvent {
  readonly eventType: "launch";
  readonly bondingCurve: string;
  readonly creatorWallet: string;
  readonly submittingWallet: string;
  readonly metadata: {
    readonly name: string;
    readonly symbol: string;
    readonly uri: string;
  };
  readonly tokenProgram: string;
  readonly quoteMint: string;
  readonly reserves: {
    readonly virtualTokenBaseUnits: string;
    readonly virtualSolLamports: string;
    readonly virtualQuoteBaseUnits: string;
    readonly realTokenBaseUnits: string;
    readonly tokenTotalSupplyBaseUnits: string;
  };
  readonly flags: {
    readonly mayhemMode: boolean;
    readonly cashbackEnabled: boolean;
  };
}

export interface TradeMarketEvent extends CommonMarketEvent {
  readonly eventType: "trade";
  readonly side: "buy" | "sell";
  readonly traderWallet: string;
  readonly creatorWallet: string;
  /** TradeEvent does not contain the bonding-curve address. Join by mint. */
  readonly bondingCurve: null;
  readonly instructionName: string;
  readonly quoteMint: string;
  readonly amounts: {
    readonly tokenBaseUnits: string;
    readonly nativeSolLamports: string;
    readonly quoteBaseUnits: string;
  };
  /** Exact average fill ratio (quote amount / token amount); not spot or next executable price. */
  readonly observedPriceRatio: {
    readonly quoteBaseUnits: string;
    readonly tokenBaseUnits: string;
  };
  /** Post-trade reserves emitted by Pump TradeEvent. */
  readonly reserves: {
    readonly virtualTokenBaseUnits: string;
    readonly virtualSolLamports: string;
    readonly virtualQuoteBaseUnits: string;
    readonly realTokenBaseUnits: string;
    readonly realSolLamports: string;
    readonly realQuoteBaseUnits: string;
  };
  readonly fees: {
    readonly protocolRecipient: string;
    readonly protocolBasisPoints: string;
    readonly protocolQuoteBaseUnits: string;
    readonly creatorBasisPoints: string;
    readonly creatorQuoteBaseUnits: string;
    readonly cashbackBasisPoints: string;
    readonly cashbackQuoteBaseUnits: string;
    readonly buybackBasisPoints: string;
    readonly buybackQuoteBaseUnits: string;
  };
  readonly volumeTracking: {
    readonly enabled: boolean;
    readonly totalUnclaimedTokens: string;
    readonly totalClaimedTokens: string;
    readonly currentSolVolumeLamports: string;
    readonly lastUpdateUnixSeconds: string;
  };
  readonly flags: { readonly mayhemMode: boolean };
  readonly shareholders: readonly {
    readonly address: string;
    readonly shareBasisPoints: number;
  }[];
}

export type NormalizedMarketEvent = LaunchMarketEvent | TradeMarketEvent;

/**
 * Small venue-neutral boundary consumed by Phase 2 analytics and, later, simulation.
 * Venue-specific facts remain in venuePayload; no other launchpad is invented here.
 */
export interface VenueEventEnvelope {
  readonly schemaVersion: typeof VENUE_EVENT_ENVELOPE_SCHEMA_VERSION;
  readonly kind: "venue-event";
  readonly eventId: string;
  readonly venue: "pumpfun-bonding-curve";
  readonly chain: "solana-mainnet";
  readonly provenance: "live" | "backfilled";
  readonly instrument: {
    readonly baseMint: string;
    readonly quoteMint: string;
  };
  readonly eventType: "launch" | "trade";
  readonly side: "buy" | "sell" | null;
  readonly signature: string;
  readonly observed: {
    readonly collectorSequence: number | null;
    readonly receivedAtUnixMs: number | null;
    readonly receivedMonotonicNs: string | null;
    readonly parseDurationNs: string | null;
    readonly providerReceivedAtUnixMs: null;
  };
  readonly canonical: {
    readonly slot: number | null;
    readonly transactionIndex: number | null;
    readonly outerInstructionIndex: number | null;
    readonly outerInstructionIndexSource: "message-correlated" | "log-inferred" | null;
    readonly transactionLogIndex: number;
    readonly eventIndex: number;
    readonly blockTimeUnixSeconds: number | null;
    readonly confirmationStatus: "finalized" | null;
  };
  readonly amounts: {
    readonly baseUnits: string | null;
    readonly quoteBaseUnits: string | null;
  };
  readonly transactionCost: {
    readonly feeLamports: string | null;
    readonly computeUnitsConsumed: string | null;
    readonly requestedComputeUnitLimit: string | null;
    readonly effectiveComputeUnitLimit: string | null;
    readonly computeUnitLimitSource: "explicit" | "runtime-default" | "unknown";
    readonly requestedComputeUnitPriceMicroLamports: string | null;
    readonly requestedPriorityFeeLamports: string | null;
    /** Direct System Program transfers to documented Jito tip accounts in this transaction only. */
    readonly observableJitoTipLamports: string | null;
    readonly observableJitoTipStatus:
      | "observed-transfer"
      | "no-transfer-observed"
      | "indeterminate";
  };
  readonly venuePayload: unknown;
}

export interface DiagnosticRecord {
  readonly schemaVersion: 1;
  readonly kind: "diagnostic";
  readonly code:
    | "connection-opened"
    | "connection-closed"
    | "connection-error"
    | "subscription-confirmed"
    | "subscription-error"
    | "clock-offset-sampled"
    | "clock-offset-unavailable"
    | "invalid-rpc-message"
    | "malformed-pump-event"
    | "duplicate-event";
  readonly atUnixMs: number;
  readonly message: string;
  readonly sequence: number | null;
  readonly details: Readonly<Record<string, unknown>>;
}

export type ValidationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isCommitment(value: unknown): value is Commitment {
  return value === "processed" || value === "confirmed" || value === "finalized";
}

export function parseLogsNotification(value: unknown): ValidationResult<SolanaLogsNotification> {
  if (!isRecord(value) || value.jsonrpc !== "2.0" || value.method !== "logsNotification") {
    return { ok: false, error: "message is not a logsNotification JSON-RPC payload" };
  }

  const params = value.params;
  if (!isRecord(params) || !isSafeNonNegativeInteger(params.subscription)) {
    return { ok: false, error: "logsNotification.params is invalid" };
  }

  const result = params.result;
  if (!isRecord(result) || !isRecord(result.context) || !isRecord(result.value)) {
    return { ok: false, error: "logsNotification result/context/value is invalid" };
  }

  const { slot } = result.context;
  const { signature, logs } = result.value;
  if (!isSafeNonNegativeInteger(slot)) {
    return { ok: false, error: "logsNotification slot is not a safe non-negative integer" };
  }
  if (typeof signature !== "string" || signature.length < 64 || signature.length > 96) {
    return { ok: false, error: "logsNotification signature is invalid" };
  }
  if (!Array.isArray(logs) || !logs.every((line) => typeof line === "string")) {
    return { ok: false, error: "logsNotification logs is not a string array" };
  }

  return { ok: true, value: value as unknown as SolanaLogsNotification };
}

export function parseRawLogRecord(value: unknown): ValidationResult<RawLogRecord> {
  if (!isRecord(value) || value.schemaVersion !== 1 || value.kind !== "solana.logs-notification") {
    return { ok: false, error: "record is not a supported raw log record" };
  }
  if (!isSafeNonNegativeInteger(value.sequence) || !isRecord(value.source) || !isRecord(value.capture)) {
    return { ok: false, error: "raw record sequence/source/capture is invalid" };
  }
  const source = value.source;
  if (
    source.transport !== "solana-rpc-websocket" ||
    typeof source.programId !== "string" ||
    !isCommitment(source.commitment) ||
    typeof source.endpointLabel !== "string"
  ) {
    return { ok: false, error: "raw record source is invalid" };
  }
  const capture = value.capture;
  if (
    !isSafeNonNegativeInteger(capture.receivedAtUnixMs) ||
    typeof capture.receivedAtIso !== "string" ||
    typeof capture.receivedMonotonicNs !== "string" ||
    !isSafeNonNegativeInteger(capture.parseCompletedAtUnixMs) ||
    typeof capture.parseDurationNs !== "string" ||
    capture.rpcProviderReceivedAtUnixMs !== null
  ) {
    return { ok: false, error: "raw record capture timestamps are invalid" };
  }
  if (!("rpcPayload" in value)) {
    return { ok: false, error: "raw record is missing rpcPayload" };
  }
  return { ok: true, value: value as unknown as RawLogRecord };
}

export function createDiagnostic(
  code: DiagnosticRecord["code"],
  message: string,
  details: Readonly<Record<string, unknown>> = {},
  sequence: number | null = null,
): DiagnosticRecord {
  return {
    schemaVersion: 1,
    kind: "diagnostic",
    code,
    atUnixMs: Date.now(),
    message,
    sequence,
    details,
  };
}

export function jsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}
