import {
  MARKET_EVENT_SCHEMA_VERSION,
  type CommonMarketEvent,
  type LaunchMarketEvent,
  type NormalizedMarketEvent,
  type RawLogRecord,
  type TradeMarketEvent,
  parseLogsNotification,
} from "@botwiner/market-data";

export const PUMP_PROGRAM_ID = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
export const WRAPPED_SOL_MINT = "So11111111111111111111111111111111111111112";
export const PUMP_IDL_REVISION = "9c82f61cb711b044a17f770ab8ce9f9bdf78f333";
export const PUMP_PARSING_VERSION = `pump-idl@${PUMP_IDL_REVISION}:phase1-v1`;

const CREATE_EVENT_DISCRIMINATOR = Buffer.from([27, 114, 169, 77, 222, 235, 99, 118]);
const TRADE_EVENT_DISCRIMINATOR = Buffer.from([189, 219, 127, 211, 78, 230, 97, 238]);
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const MAX_BORSH_STRING_BYTES = 1_048_576;
const MAX_VECTOR_ITEMS = 16_384;

export interface PumpShareholder {
  readonly address: string;
  readonly shareBasisPoints: number;
}

export interface PumpCreateEvent {
  readonly kind: "create";
  readonly name: string;
  readonly symbol: string;
  readonly uri: string;
  readonly mint: string;
  readonly bondingCurve: string;
  readonly user: string;
  readonly creator: string;
  readonly timestamp: bigint;
  readonly virtualTokenReserves: bigint;
  readonly virtualSolReserves: bigint;
  readonly realTokenReserves: bigint;
  readonly tokenTotalSupply: bigint;
  readonly tokenProgram: string;
  readonly isMayhemMode: boolean;
  readonly isCashbackEnabled: boolean;
  readonly quoteMint: string;
  readonly virtualQuoteReserves: bigint;
  readonly unparsedTrailingBytes: number;
}

export interface PumpTradeEvent {
  readonly kind: "trade";
  readonly mint: string;
  readonly solAmount: bigint;
  readonly tokenAmount: bigint;
  readonly isBuy: boolean;
  readonly user: string;
  readonly timestamp: bigint;
  readonly virtualSolReserves: bigint;
  readonly virtualTokenReserves: bigint;
  readonly realSolReserves: bigint;
  readonly realTokenReserves: bigint;
  readonly feeRecipient: string;
  readonly feeBasisPoints: bigint;
  readonly fee: bigint;
  readonly creator: string;
  readonly creatorFeeBasisPoints: bigint;
  readonly creatorFee: bigint;
  readonly trackVolume: boolean;
  readonly totalUnclaimedTokens: bigint;
  readonly totalClaimedTokens: bigint;
  readonly currentSolVolume: bigint;
  readonly lastUpdateTimestamp: bigint;
  readonly instructionName: string;
  readonly mayhemMode: boolean;
  readonly cashbackFeeBasisPoints: bigint;
  readonly cashback: bigint;
  readonly buybackFeeBasisPoints: bigint;
  readonly buybackFee: bigint;
  readonly shareholders: readonly PumpShareholder[];
  readonly quoteMint: string;
  readonly quoteAmount: bigint;
  readonly virtualQuoteReserves: bigint;
  readonly realQuoteReserves: bigint;
  readonly unparsedTrailingBytes: number;
}

export type PumpEvent = PumpCreateEvent | PumpTradeEvent;

export interface LocatedPumpEvent {
  readonly logIndex: number;
  readonly discriminatorHex: string;
  readonly event: PumpEvent;
}

export interface PumpParseFailure {
  readonly logIndex: number;
  readonly discriminatorHex: string;
  readonly message: string;
}

export interface PumpLogParseResult {
  readonly events: readonly LocatedPumpEvent[];
  readonly failures: readonly PumpParseFailure[];
}

class BorshReader {
  private offset = 0;

  public constructor(private readonly bytes: Buffer) {}

  public get remaining(): number {
    return this.bytes.length - this.offset;
  }

  private take(length: number, label: string): Buffer {
    if (!Number.isSafeInteger(length) || length < 0 || this.offset + length > this.bytes.length) {
      throw new Error(
        `truncated ${label}: need ${length} bytes at offset ${this.offset}, have ${this.remaining}`,
      );
    }
    const value = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }

  public u8(label: string): number {
    return this.take(1, label).readUInt8(0);
  }

  public bool(label: string): boolean {
    const value = this.u8(label);
    if (value !== 0 && value !== 1) {
      throw new Error(`invalid ${label}: expected Borsh bool 0 or 1, received ${value}`);
    }
    return value === 1;
  }

  public u16(label: string): number {
    return this.take(2, label).readUInt16LE(0);
  }

  public u32(label: string): number {
    return this.take(4, label).readUInt32LE(0);
  }

  public u64(label: string): bigint {
    return this.take(8, label).readBigUInt64LE(0);
  }

  public i64(label: string): bigint {
    return this.take(8, label).readBigInt64LE(0);
  }

  public string(label: string): string {
    const length = this.u32(`${label}.length`);
    if (length > MAX_BORSH_STRING_BYTES) {
      throw new Error(`invalid ${label}: ${length} bytes exceeds safety limit`);
    }
    const bytes = this.take(length, label);
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new Error(`invalid ${label}: not valid UTF-8`);
    }
  }

  public pubkey(label: string): string {
    return encodeBase58(this.take(32, label));
  }
}

export function encodeBase58(bytes: Uint8Array): string {
  if (bytes.length === 0) return "";

  let leadingZeroes = 0;
  while (leadingZeroes < bytes.length && bytes[leadingZeroes] === 0) leadingZeroes += 1;
  if (leadingZeroes === bytes.length) return "1".repeat(leadingZeroes);

  const digits: number[] = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let index = 0; index < digits.length; index += 1) {
      const value = (digits[index] ?? 0) * 256 + carry;
      digits[index] = value % 58;
      carry = Math.floor(value / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }

  let result = "1".repeat(leadingZeroes);
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    result += BASE58_ALPHABET[digits[index] ?? 0];
  }
  return result;
}

function decodeCreateEvent(body: Buffer): PumpCreateEvent {
  const reader = new BorshReader(body);
  const partial = {
    kind: "create" as const,
    name: reader.string("name"),
    symbol: reader.string("symbol"),
    uri: reader.string("uri"),
    mint: reader.pubkey("mint"),
    bondingCurve: reader.pubkey("bonding_curve"),
    user: reader.pubkey("user"),
    creator: reader.pubkey("creator"),
    timestamp: reader.i64("timestamp"),
    virtualTokenReserves: reader.u64("virtual_token_reserves"),
    virtualSolReserves: reader.u64("virtual_sol_reserves"),
    realTokenReserves: reader.u64("real_token_reserves"),
    tokenTotalSupply: reader.u64("token_total_supply"),
    tokenProgram: reader.pubkey("token_program"),
    isMayhemMode: reader.bool("is_mayhem_mode"),
    isCashbackEnabled: reader.bool("is_cashback_enabled"),
    quoteMint: reader.pubkey("quote_mint"),
    virtualQuoteReserves: reader.u64("virtual_quote_reserves"),
  };
  return { ...partial, unparsedTrailingBytes: reader.remaining };
}

function decodeTradeEvent(body: Buffer): PumpTradeEvent {
  const reader = new BorshReader(body);
  const partial = {
    kind: "trade" as const,
    mint: reader.pubkey("mint"),
    solAmount: reader.u64("sol_amount"),
    tokenAmount: reader.u64("token_amount"),
    isBuy: reader.bool("is_buy"),
    user: reader.pubkey("user"),
    timestamp: reader.i64("timestamp"),
    virtualSolReserves: reader.u64("virtual_sol_reserves"),
    virtualTokenReserves: reader.u64("virtual_token_reserves"),
    realSolReserves: reader.u64("real_sol_reserves"),
    realTokenReserves: reader.u64("real_token_reserves"),
    feeRecipient: reader.pubkey("fee_recipient"),
    feeBasisPoints: reader.u64("fee_basis_points"),
    fee: reader.u64("fee"),
    creator: reader.pubkey("creator"),
    creatorFeeBasisPoints: reader.u64("creator_fee_basis_points"),
    creatorFee: reader.u64("creator_fee"),
    trackVolume: reader.bool("track_volume"),
    totalUnclaimedTokens: reader.u64("total_unclaimed_tokens"),
    totalClaimedTokens: reader.u64("total_claimed_tokens"),
    currentSolVolume: reader.u64("current_sol_volume"),
    lastUpdateTimestamp: reader.i64("last_update_timestamp"),
    instructionName: reader.string("ix_name"),
    mayhemMode: reader.bool("mayhem_mode"),
    cashbackFeeBasisPoints: reader.u64("cashback_fee_basis_points"),
    cashback: reader.u64("cashback"),
    buybackFeeBasisPoints: reader.u64("buyback_fee_basis_points"),
    buybackFee: reader.u64("buyback_fee"),
  };

  const shareholderCount = reader.u32("shareholders.length");
  if (shareholderCount > MAX_VECTOR_ITEMS) {
    throw new Error(`invalid shareholders: ${shareholderCount} items exceeds safety limit`);
  }
  const shareholders: PumpShareholder[] = [];
  for (let index = 0; index < shareholderCount; index += 1) {
    shareholders.push({
      address: reader.pubkey(`shareholders[${index}].address`),
      shareBasisPoints: reader.u16(`shareholders[${index}].share_bps`),
    });
  }

  const quoteMint = reader.pubkey("quote_mint");
  const quoteAmount = reader.u64("quote_amount");
  const virtualQuoteReserves = reader.u64("virtual_quote_reserves");
  const realQuoteReserves = reader.u64("real_quote_reserves");

  return {
    ...partial,
    shareholders,
    quoteMint,
    quoteAmount,
    virtualQuoteReserves,
    realQuoteReserves,
    unparsedTrailingBytes: reader.remaining,
  };
}

function isStrictBase64(value: string): boolean {
  if (value.length === 0 || value.length % 4 !== 0) return false;
  return /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value);
}

function removeProgramFromStack(stack: string[], programId: string): void {
  if (stack.at(-1) === programId) {
    stack.pop();
    return;
  }
  const index = stack.lastIndexOf(programId);
  if (index >= 0) stack.splice(index);
}

export function parsePumpProgramLogs(logs: readonly string[]): PumpLogParseResult {
  const events: LocatedPumpEvent[] = [];
  const failures: PumpParseFailure[] = [];
  const programStack: string[] = [];

  for (let logIndex = 0; logIndex < logs.length; logIndex += 1) {
    const line = logs[logIndex] ?? "";
    const invocation = /^Program (\S+) invoke \[(\d+)]$/.exec(line);
    if (invocation) {
      const programId = invocation[1] ?? "";
      const depth = Number(invocation[2]);
      if (Number.isSafeInteger(depth) && depth > 0) {
        programStack.length = Math.min(programStack.length, depth - 1);
        programStack[depth - 1] = programId;
      }
      continue;
    }

    const completion = /^Program (\S+) (?:success|failed:.*)$/.exec(line);
    if (completion) {
      removeProgramFromStack(programStack, completion[1] ?? "");
      continue;
    }

    if (programStack.at(-1) !== PUMP_PROGRAM_ID) continue;
    const dataMatch = /^Program (?:data|log): (\S+)$/.exec(line);
    const encoded = dataMatch?.[1];
    if (encoded === undefined || !isStrictBase64(encoded)) continue;

    const bytes = Buffer.from(encoded, "base64");
    if (bytes.length < 8) continue;
    const discriminator = bytes.subarray(0, 8);
    const discriminatorHex = discriminator.toString("hex");
    let decoder: ((body: Buffer) => PumpEvent) | undefined;
    if (discriminator.equals(CREATE_EVENT_DISCRIMINATOR)) decoder = decodeCreateEvent;
    if (discriminator.equals(TRADE_EVENT_DISCRIMINATOR)) decoder = decodeTradeEvent;
    if (decoder === undefined) continue;

    try {
      events.push({
        logIndex,
        discriminatorHex,
        event: decoder(bytes.subarray(8)),
      });
    } catch (error) {
      failures.push({
        logIndex,
        discriminatorHex,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { events, failures };
}

function commonFields(
  raw: RawLogRecord,
  signature: string,
  slot: number,
  located: LocatedPumpEvent,
): CommonMarketEvent {
  const type = located.event.kind === "create" ? "launch" : "trade";
  return {
    schemaVersion: MARKET_EVENT_SCHEMA_VERSION,
    kind: "market-event",
    eventId: `${signature}:${located.logIndex}:${type}`,
    parsingVersion: PUMP_PARSING_VERSION,
    rawRef: `raw.jsonl:${raw.sequence}`,
    source: raw.source,
    signature,
    ordering: {
      slot,
      collectorSequence: raw.sequence,
      transactionLogIndex: located.logIndex,
    },
    timestamps: {
      chainEventUnixSeconds: located.event.timestamp.toString(),
      blockTimeUnixSeconds: null,
      collectorReceivedAtUnixMs: raw.capture.receivedAtUnixMs,
      collectorReceivedAtIso: raw.capture.receivedAtIso,
      collectorReceivedMonotonicNs: raw.capture.receivedMonotonicNs,
      collectorParseCompletedAtUnixMs: raw.capture.parseCompletedAtUnixMs,
      collectorParseDurationNs: raw.capture.parseDurationNs,
      rpcProviderReceivedAtUnixMs: null,
    },
    tokenMint: located.event.mint,
    unparsedTrailingBytes: located.event.unparsedTrailingBytes,
  };
}

function normalizeCreate(
  raw: RawLogRecord,
  signature: string,
  slot: number,
  located: LocatedPumpEvent & { readonly event: PumpCreateEvent },
): LaunchMarketEvent {
  const event = located.event;
  return {
    ...commonFields(raw, signature, slot, located),
    eventType: "launch",
    bondingCurve: event.bondingCurve,
    creatorWallet: event.creator,
    submittingWallet: event.user,
    metadata: { name: event.name, symbol: event.symbol, uri: event.uri },
    tokenProgram: event.tokenProgram,
    quoteMint: event.quoteMint,
    reserves: {
      virtualTokenBaseUnits: event.virtualTokenReserves.toString(),
      virtualSolLamports: event.virtualSolReserves.toString(),
      virtualQuoteBaseUnits: event.virtualQuoteReserves.toString(),
      realTokenBaseUnits: event.realTokenReserves.toString(),
      tokenTotalSupplyBaseUnits: event.tokenTotalSupply.toString(),
    },
    flags: {
      mayhemMode: event.isMayhemMode,
      cashbackEnabled: event.isCashbackEnabled,
    },
  };
}

function normalizeTrade(
  raw: RawLogRecord,
  signature: string,
  slot: number,
  located: LocatedPumpEvent & { readonly event: PumpTradeEvent },
): TradeMarketEvent {
  const event = located.event;
  return {
    ...commonFields(raw, signature, slot, located),
    eventType: "trade",
    side: event.isBuy ? "buy" : "sell",
    traderWallet: event.user,
    creatorWallet: event.creator,
    bondingCurve: null,
    instructionName: event.instructionName,
    quoteMint: event.quoteMint,
    amounts: {
      tokenBaseUnits: event.tokenAmount.toString(),
      nativeSolLamports: event.solAmount.toString(),
      quoteBaseUnits: event.quoteAmount.toString(),
    },
    observedPriceRatio: {
      quoteBaseUnits: event.quoteAmount.toString(),
      tokenBaseUnits: event.tokenAmount.toString(),
    },
    reserves: {
      virtualTokenBaseUnits: event.virtualTokenReserves.toString(),
      virtualSolLamports: event.virtualSolReserves.toString(),
      virtualQuoteBaseUnits: event.virtualQuoteReserves.toString(),
      realTokenBaseUnits: event.realTokenReserves.toString(),
      realSolLamports: event.realSolReserves.toString(),
      realQuoteBaseUnits: event.realQuoteReserves.toString(),
    },
    fees: {
      protocolRecipient: event.feeRecipient,
      protocolBasisPoints: event.feeBasisPoints.toString(),
      protocolQuoteBaseUnits: event.fee.toString(),
      creatorBasisPoints: event.creatorFeeBasisPoints.toString(),
      creatorQuoteBaseUnits: event.creatorFee.toString(),
      cashbackBasisPoints: event.cashbackFeeBasisPoints.toString(),
      cashbackQuoteBaseUnits: event.cashback.toString(),
      buybackBasisPoints: event.buybackFeeBasisPoints.toString(),
      buybackQuoteBaseUnits: event.buybackFee.toString(),
    },
    volumeTracking: {
      enabled: event.trackVolume,
      totalUnclaimedTokens: event.totalUnclaimedTokens.toString(),
      totalClaimedTokens: event.totalClaimedTokens.toString(),
      currentSolVolumeLamports: event.currentSolVolume.toString(),
      lastUpdateUnixSeconds: event.lastUpdateTimestamp.toString(),
    },
    flags: { mayhemMode: event.mayhemMode },
    shareholders: event.shareholders,
  };
}

export interface NormalizeRawResult {
  readonly events: readonly NormalizedMarketEvent[];
  readonly failures: readonly PumpParseFailure[];
  readonly invalidNotification: string | null;
  readonly transactionFailed: boolean;
}

export function normalizeRawLogRecord(raw: RawLogRecord): NormalizeRawResult {
  const notification = parseLogsNotification(raw.rpcPayload);
  if (!notification.ok) {
    return {
      events: [],
      failures: [],
      invalidNotification: notification.error,
      transactionFailed: false,
    };
  }

  if (notification.value.params.result.value.err !== null) {
    return { events: [], failures: [], invalidNotification: null, transactionFailed: true };
  }

  const { context, value } = notification.value.params.result;
  const parsed = parsePumpProgramLogs(value.logs);
  const events = parsed.events.map((located): NormalizedMarketEvent => {
    if (located.event.kind === "create") {
      return normalizeCreate(raw, value.signature, context.slot, {
        ...located,
        event: located.event,
      });
    }
    return normalizeTrade(raw, value.signature, context.slot, {
      ...located,
      event: located.event,
    });
  });

  return {
    events,
    failures: parsed.failures,
    invalidNotification: null,
    transactionFailed: false,
  };
}
