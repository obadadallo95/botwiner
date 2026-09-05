import type { NormalizedMarketEvent, VenueEventEnvelope } from "@botwiner/market-data";
import type {
  ComputeBudgetEvidence,
  InstructionRecord,
  JitoTipEvidence,
  RawRpcRecord,
  TokenBalanceRecord,
  TransactionEnrichment,
} from "./types.js";

export const COMPUTE_BUDGET_PROGRAM_ID = "ComputeBudget111111111111111111111111111111";
export const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";
export const JITO_TIP_ACCOUNTS = [
  "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
  "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
  "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
  "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49",
  "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh",
  "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
  "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL",
  "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT",
] as const;
const JITO_TIP_ACCOUNT_SET = new Set<string>(JITO_TIP_ACCOUNTS);
const MAX_COMPUTE_UNIT_LIMIT = 1_400_000n;
const DEFAULT_NON_BUILTIN_COMPUTE_UNIT_LIMIT = 200_000n;
const DEFAULT_BUILTIN_COMPUTE_UNIT_LIMIT = 3_000n;
const NON_MIGRATING_BUILTIN_PROGRAM_IDS = new Set([
  SYSTEM_PROGRAM_ID,
  COMPUTE_BUDGET_PROGRAM_ID,
  "BPFLoaderUpgradeab1e11111111111111111111111",
  "BPFLoader1111111111111111111111111111111111",
  "BPFLoader2111111111111111111111111111111111",
  "LoaderV411111111111111111111111111111111111",
  "KeccakSecp256k11111111111111111111111111111",
  "Ed25519SigVerify111111111111111111111111111",
]);
const VOTE_PROGRAM_ID = "Vote111111111111111111111111111111111111111";
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BASE58_INDEX = new Map([...BASE58_ALPHABET].map((character, index) => [character, index]));

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function integer(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function string(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function unknownArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function integerStrings(value: unknown): string[] | null {
  if (!Array.isArray(value) || !value.every((item) => Number.isSafeInteger(item))) return null;
  return value.map((item) => String(item));
}

export function decodeBase58(value: string): Buffer {
  if (value.length === 0) return Buffer.alloc(0);
  const bytes: number[] = [0];
  for (const character of value) {
    const digit = BASE58_INDEX.get(character);
    if (digit === undefined) throw new Error("invalid base58 character");
    let carry = digit;
    for (let index = 0; index < bytes.length; index += 1) {
      const next = (bytes[index] ?? 0) * 58 + carry;
      bytes[index] = next & 0xff;
      carry = next >> 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  let leadingZeroes = 0;
  while (leadingZeroes < value.length && value[leadingZeroes] === "1") leadingZeroes += 1;
  const significantLength = bytes.length === 1 && bytes[0] === 0 ? 0 : bytes.length;
  const result = Buffer.alloc(leadingZeroes + significantLength);
  for (let index = 0; index < significantLength; index += 1) {
    result[result.length - 1 - index] = bytes[index] ?? 0;
  }
  return result;
}

function readU32(bytes: Buffer, offset: number): string | null {
  return bytes.length >= offset + 4 ? bytes.readUInt32LE(offset).toString() : null;
}

function readU64(bytes: Buffer, offset: number): string | null {
  return bytes.length >= offset + 8 ? bytes.readBigUInt64LE(offset).toString() : null;
}

export function parseComputeBudget(
  instructions: readonly InstructionRecord[],
): ComputeBudgetEvidence {
  const decoded: ComputeBudgetEvidence["instructions"][number][] = [];
  let requestedComputeUnitLimit: string | null = null;
  let requestedComputeUnitPriceMicroLamports: string | null = null;
  let deprecatedAdditionalFee: string | null = null;

  for (const instruction of instructions) {
    if (
      instruction.innerInstructionIndex !== null ||
      instruction.programId !== COMPUTE_BUDGET_PROGRAM_ID ||
      instruction.dataBase58 === null
    ) {
      continue;
    }
    let bytes: Buffer;
    try {
      bytes = decodeBase58(instruction.dataBase58);
    } catch {
      bytes = Buffer.alloc(0);
    }
    const tag = bytes[0];
    const base = {
      outerInstructionIndex: instruction.outerInstructionIndex,
      units: null,
      additionalFeeLamports: null,
      bytes: null,
      microLamports: null,
      rawDataBase58: instruction.dataBase58,
    };
    if (tag === 0) {
      const units = readU32(bytes, 1);
      const additionalFeeLamports = readU32(bytes, 5);
      decoded.push({ ...base, type: "request-units-deprecated", units, additionalFeeLamports });
      if (units !== null) requestedComputeUnitLimit = units;
      if (additionalFeeLamports !== null) deprecatedAdditionalFee = additionalFeeLamports;
    } else if (tag === 1) {
      decoded.push({ ...base, type: "request-heap-frame", bytes: readU32(bytes, 1) });
    } else if (tag === 2) {
      const units = readU32(bytes, 1);
      decoded.push({ ...base, type: "set-compute-unit-limit", units });
      if (units !== null) requestedComputeUnitLimit = units;
    } else if (tag === 3) {
      const microLamports = readU64(bytes, 1);
      decoded.push({ ...base, type: "set-compute-unit-price", microLamports });
      if (microLamports !== null) requestedComputeUnitPriceMicroLamports = microLamports;
    } else if (tag === 4) {
      decoded.push({
        ...base,
        type: "set-loaded-accounts-data-size-limit",
        bytes: readU32(bytes, 1),
      });
    } else {
      decoded.push({ ...base, type: "unknown" });
    }
  }

  let requestedPriorityFeeLamports: string | null = null;
  let priorityFeeFormula: string | null = null;
  let effectiveComputeUnitLimit: string | null = null;
  let computeUnitLimitSource: ComputeBudgetEvidence["computeUnitLimitSource"] = "unknown";
  if (requestedComputeUnitLimit !== null) {
    effectiveComputeUnitLimit = (
      BigInt(requestedComputeUnitLimit) > MAX_COMPUTE_UNIT_LIMIT
        ? MAX_COMPUTE_UNIT_LIMIT
        : BigInt(requestedComputeUnitLimit)
    ).toString();
    computeUnitLimitSource = "explicit";
  } else {
    const outerProgramIds = instructions
      .filter((instruction) => instruction.innerInstructionIndex === null)
      .map((instruction) => instruction.programId);
    // Vote is feature-gated in current Agave. Without the bank feature set its 3k/200k
    // classification cannot be reconstructed authoritatively from transaction JSON alone.
    if (!outerProgramIds.includes(null) && !outerProgramIds.includes(VOTE_PROGRAM_ID)) {
      let total = 0n;
      for (const programId of outerProgramIds) {
        total += programId !== null && NON_MIGRATING_BUILTIN_PROGRAM_IDS.has(programId)
          ? DEFAULT_BUILTIN_COMPUTE_UNIT_LIMIT
          : DEFAULT_NON_BUILTIN_COMPUTE_UNIT_LIMIT;
      }
      effectiveComputeUnitLimit = (total > MAX_COMPUTE_UNIT_LIMIT ? MAX_COMPUTE_UNIT_LIMIT : total).toString();
      computeUnitLimitSource = "runtime-default";
    }
  }
  if (effectiveComputeUnitLimit !== null && requestedComputeUnitPriceMicroLamports !== null) {
    const numerator =
      BigInt(effectiveComputeUnitLimit) * BigInt(requestedComputeUnitPriceMicroLamports);
    requestedPriorityFeeLamports = ((numerator + 999_999n) / 1_000_000n).toString();
    priorityFeeFormula =
      "ceil(effective_compute_unit_limit * micro_lamports_per_cu / 1_000_000)";
  } else if (deprecatedAdditionalFee !== null) {
    requestedPriorityFeeLamports = deprecatedAdditionalFee;
    priorityFeeFormula = "RequestUnitsDeprecated.additional_fee_lamports";
  }

  return {
    instructions: decoded,
    requestedComputeUnitLimit,
    effectiveComputeUnitLimit,
    computeUnitLimitSource,
    requestedComputeUnitPriceMicroLamports,
    requestedPriorityFeeLamports,
    priorityFeeFormula,
  };
}

function parsedTransfer(instruction: InstructionRecord): { source: string | null; destination: string; lamports: string } | null {
  if (
    !isRecord(instruction.parsed) ||
    (instruction.parsed.type !== "transfer" && instruction.parsed.type !== "transferWithSeed") ||
    !isRecord(instruction.parsed.info)
  ) return null;
  const destination = string(instruction.parsed.info.destination);
  const lamportsValue = instruction.parsed.info.lamports;
  const lamports = integer(lamportsValue) === null
    ? typeof lamportsValue === "string" && /^\d+$/.test(lamportsValue) ? lamportsValue : null
    : String(lamportsValue);
  if (destination === null || lamports === null) return null;
  return { source: string(instruction.parsed.info.source), destination, lamports };
}

/** Detect only directly observable System Program transfers in this transaction. */
export function parseJitoTipEvidence(instructions: readonly InstructionRecord[]): JitoTipEvidence {
  const transfers: JitoTipEvidence["transfers"][number][] = [];
  let indeterminateSystemInstruction = false;
  for (const instruction of instructions) {
    if (instruction.programId !== SYSTEM_PROGRAM_ID) continue;
    let transfer = parsedTransfer(instruction);
    if (transfer === null && instruction.dataBase58 !== null) {
      try {
        const bytes = decodeBase58(instruction.dataBase58);
        const tag = bytes.length >= 4 ? bytes.readUInt32LE(0) : null;
        if (bytes.length >= 12 && (tag === 2 || tag === 11)) {
          const destination = instruction.accountKeys[tag === 2 ? 1 : 2] ?? null;
          if (destination !== null) {
            transfer = {
              source: instruction.accountKeys[0] ?? null,
              destination,
              lamports: bytes.readBigUInt64LE(4).toString(),
            };
          }
        }
      } catch {
        indeterminateSystemInstruction = true;
      }
    }
    if (transfer !== null && JITO_TIP_ACCOUNT_SET.has(transfer.destination)) {
      transfers.push({
        outerInstructionIndex: instruction.outerInstructionIndex,
        innerInstructionIndex: instruction.innerInstructionIndex,
        ...transfer,
      });
    }
  }
  const total = transfers.reduce((sum, transfer) => sum + BigInt(transfer.lamports), 0n);
  return {
    status: transfers.length > 0
      ? "observed-transfer"
      : indeterminateSystemInstruction ? "indeterminate" : "no-transfer-observed",
    totalLamports: transfers.length > 0 ? total.toString() : indeterminateSystemInstruction ? null : "0",
    transfers,
    caveat:
      "Covers direct System Program transfers to the eight documented Jito tip accounts in this transaction. A tip in another transaction of the same bundle and bundle-auction state are not observable here.",
  };
}

function accountKey(value: unknown): string | null {
  if (typeof value === "string") return value;
  return isRecord(value) ? string(value.pubkey) : null;
}

function parseTokenBalances(value: unknown): TokenBalanceRecord[] | null {
  if (!Array.isArray(value)) return null;
  const balances: TokenBalanceRecord[] = [];
  for (const item of value) {
    if (!isRecord(item) || !isRecord(item.uiTokenAmount)) continue;
    const accountIndex = integer(item.accountIndex);
    const mint = string(item.mint);
    const amountBaseUnits = string(item.uiTokenAmount.amount);
    const decimals = integer(item.uiTokenAmount.decimals);
    if (accountIndex === null || mint === null || amountBaseUnits === null || decimals === null) continue;
    balances.push({
      accountIndex,
      mint,
      owner: string(item.owner),
      programId: string(item.programId),
      amountBaseUnits,
      decimals,
    });
  }
  return balances;
}

function parseInstruction(
  value: unknown,
  accountKeys: readonly string[],
  outerInstructionIndex: number,
  innerInstructionIndex: number | null,
  parentOuterInstructionIndex: number | null,
): InstructionRecord {
  if (!isRecord(value)) {
    return {
      outerInstructionIndex,
      innerInstructionIndex,
      parentOuterInstructionIndex,
      stackHeight: null,
      programId: null,
      accountIndexes: [],
      accountKeys: [],
      dataBase58: null,
      parsed: null,
    };
  }
  const programIdIndex = integer(value.programIdIndex);
  const indexes = Array.isArray(value.accounts)
    ? value.accounts.filter((item): item is number => Number.isSafeInteger(item))
    : [];
  const directAccounts = Array.isArray(value.accounts)
    ? value.accounts.filter((item): item is string => typeof item === "string")
    : [];
  const resolvedAccounts =
    indexes.length > 0 ? indexes.map((index) => accountKeys[index] ?? null) : directAccounts;
  return {
    outerInstructionIndex,
    innerInstructionIndex,
    parentOuterInstructionIndex,
    stackHeight: integer(value.stackHeight),
    programId: string(value.programId) ?? (programIdIndex === null ? null : accountKeys[programIdIndex] ?? null),
    accountIndexes: indexes,
    accountKeys: resolvedAccounts,
    dataBase58: string(value.data),
    parsed: "parsed" in value ? value.parsed : null,
  };
}

function parseInstructions(message: Record<string, unknown>, meta: Record<string, unknown>): InstructionRecord[] {
  const staticKeys = Array.isArray(message.accountKeys)
    ? message.accountKeys.map(accountKey).filter((value): value is string => value !== null)
    : [];
  const loaded = isRecord(meta.loadedAddresses) ? meta.loadedAddresses : {};
  const accountKeys = [
    ...staticKeys,
    ...stringArray(loaded.writable),
    ...stringArray(loaded.readonly),
  ];
  const result: InstructionRecord[] = [];
  if (Array.isArray(message.instructions)) {
    message.instructions.forEach((instruction, outerIndex) => {
      result.push(parseInstruction(instruction, accountKeys, outerIndex, null, null));
    });
  }
  if (Array.isArray(meta.innerInstructions)) {
    for (const group of meta.innerInstructions) {
      if (!isRecord(group) || !Array.isArray(group.instructions)) continue;
      const parentIndex = integer(group.index);
      if (parentIndex === null) continue;
      group.instructions.forEach((instruction, innerIndex) => {
        result.push(parseInstruction(instruction, accountKeys, parentIndex, innerIndex, parentIndex));
      });
    }
  }
  return result;
}

function emptyComputeBudget(): ComputeBudgetEvidence {
  return {
    instructions: [],
    requestedComputeUnitLimit: null,
    effectiveComputeUnitLimit: null,
    computeUnitLimitSource: "unknown",
    requestedComputeUnitPriceMicroLamports: null,
    requestedPriorityFeeLamports: null,
    priorityFeeFormula: null,
  };
}

function unavailableJitoTip(): JitoTipEvidence {
  return {
    status: "indeterminate",
    totalLamports: null,
    transfers: [],
    caveat: "Transaction instructions were unavailable, so direct Jito tip transfers could not be inspected.",
  };
}

function failedEnrichment(
  record: RawRpcRecord,
  status: TransactionEnrichment["enrichmentStatus"],
  error: string,
): TransactionEnrichment {
  return {
    schemaVersion: 1,
    kind: "solana-transaction-enrichment",
    signature: record.request.subject,
    provenance: record.provenance === "backfilled" ? "backfilled" : "live",
    endpointLabel: record.endpointLabel,
    requestedCommitment: "finalized",
    confirmationStatus: null,
    enrichmentStatus: status,
    enrichmentError: error,
    fetchedAtUnixMs: record.capture.completedAtUnixMs,
    fetchDurationNs: record.capture.durationNs,
    slot: null,
    blockTimeUnixSeconds: null,
    canonicalTransactionIndex: null,
    transactionVersion: null,
    transactionStatus: null,
    transactionError: null,
    feeLamports: null,
    computeUnitsConsumed: null,
    computeBudget: emptyComputeBudget(),
    jitoTip: unavailableJitoTip(),
    signatures: [],
    recentBlockhash: null,
    accountKeys: [],
    loadedAddresses: { writable: [], readonly: [] },
    preSolBalancesLamports: null,
    postSolBalancesLamports: null,
    preTokenBalances: null,
    postTokenBalances: null,
    instructions: [],
    logMessages: null,
    returnData: null,
    rewards: null,
  };
}

export function transactionIndexesFromBlockRecords(
  records: readonly RawRpcRecord[],
): ReadonlyMap<string, number> {
  const indexes = new Map<string, number>();
  for (const record of records) {
    if (record.request.method !== "getBlock" || !isRecord(record.response)) continue;
    const result = record.response.result;
    if (!isRecord(result)) continue;
    let signatures = stringArray(result.signatures);
    if (signatures.length === 0 && Array.isArray(result.transactions)) {
      signatures = result.transactions.map((entry) => {
        if (!isRecord(entry) || !isRecord(entry.transaction)) return "";
        return stringArray(entry.transaction.signatures)[0] ?? "";
      });
    }
    signatures.forEach((signature, index) => {
      if (signature !== "") indexes.set(signature, index);
    });
  }
  return indexes;
}

export interface ExpectedTransaction {
  readonly signature: string;
  readonly slot: number;
  readonly provenance: "live" | "backfilled";
}

/** Extract requested transactions from immutable full-block RPC evidence. */
export function transactionEnrichmentsFromFullBlocks(
  records: readonly RawRpcRecord[],
  expectedTransactions: readonly ExpectedTransaction[],
): TransactionEnrichment[] {
  const indexes = transactionIndexesFromBlockRecords(records);
  const recordsBySlot = new Map(records.map((record) => [Number(record.request.subject), record]));
  return expectedTransactions.map((expected) => {
    const blockRecord = recordsBySlot.get(expected.slot);
    let response: unknown;
    if (blockRecord === undefined) {
      response = { transportError: `no full-block RPC evidence for slot ${expected.slot}` };
    } else if (!isRecord(blockRecord.response) || blockRecord.response.error !== undefined) {
      response = blockRecord.response;
    } else if (!isRecord(blockRecord.response.result)) {
      response = { jsonrpc: "2.0", id: 1, result: null };
    } else {
      const block = blockRecord.response.result;
      const transactions = unknownArray(block.transactions);
      const entry = transactions.find((candidate) => {
        if (!isRecord(candidate) || !isRecord(candidate.transaction)) return false;
        return stringArray(candidate.transaction.signatures)[0] === expected.signature;
      });
      response = isRecord(entry)
        ? {
            jsonrpc: "2.0",
            id: 1,
            result: {
              slot: expected.slot,
              blockTime: block.blockTime ?? null,
              version: entry.version ?? null,
              transaction: entry.transaction,
              meta: entry.meta,
            },
          }
        : { jsonrpc: "2.0", id: 1, result: null };
    }
    const source = blockRecord;
    const syntheticRecord: RawRpcRecord = {
      schemaVersion: 1,
      kind: "solana-rpc-response",
      request: {
        method: "getTransaction",
        subject: expected.signature,
        params: [expected.signature, { commitment: "finalized", source: "getBlock" }],
        commitment: "finalized",
      },
      provenance: expected.provenance,
      endpointLabel: source?.endpointLabel ?? "unknown",
      capture: source?.capture ?? {
        requestedAtUnixMs: 0,
        completedAtUnixMs: 0,
        durationNs: "0",
        attempts: 0,
      },
      response,
    };
    return parseTransactionEnrichment(syntheticRecord, indexes);
  });
}

export function parseTransactionEnrichment(
  record: RawRpcRecord,
  transactionIndexes: ReadonlyMap<string, number>,
): TransactionEnrichment {
  if (record.request.method !== "getTransaction") {
    return failedEnrichment(record, "malformed", "raw RPC record is not getTransaction");
  }
  if (!isRecord(record.response)) {
    return failedEnrichment(record, "malformed", "RPC response is not an object");
  }
  if ("transportError" in record.response) {
    return failedEnrichment(record, "rpc-error", String(record.response.transportError));
  }
  if (record.response.error !== undefined) {
    return failedEnrichment(record, "rpc-error", JSON.stringify(record.response.error));
  }
  if (record.response.result === null) {
    return failedEnrichment(record, "unavailable", "getTransaction returned null at finalized commitment");
  }
  if (!isRecord(record.response.result)) {
    return failedEnrichment(record, "malformed", "getTransaction result is not an object or null");
  }
  const result = record.response.result;
  if (!isRecord(result.transaction) || !isRecord(result.meta)) {
    return failedEnrichment(record, "malformed", "transaction/message/meta structure is missing");
  }
  const transaction = result.transaction;
  if (!isRecord(transaction.message)) {
    return failedEnrichment(record, "malformed", "transaction/message/meta structure is missing");
  }
  const message = transaction.message;
  const meta = result.meta;
  const staticKeys = Array.isArray(message.accountKeys)
    ? message.accountKeys.map(accountKey).filter((value): value is string => value !== null)
    : [];
  const loaded = isRecord(meta.loadedAddresses) ? meta.loadedAddresses : {};
  const loadedAddresses = {
    writable: stringArray(loaded.writable),
    readonly: stringArray(loaded.readonly),
  };
  const instructions = parseInstructions(message, meta);
  const version = result.version;
  const transactionVersion: "legacy" | number | null =
    version === "legacy" ? "legacy" : Number.isSafeInteger(version) ? (version as number) : null;
  const slot = integer(result.slot);
  const fee = integer(meta.fee);
  const computeUnitsConsumed = integer(meta.computeUnitsConsumed);
  const logMessages = meta.logMessages === null ? null : stringArray(meta.logMessages);

  return {
    schemaVersion: 1,
    kind: "solana-transaction-enrichment",
    signature: record.request.subject,
    provenance: record.provenance === "backfilled" ? "backfilled" : "live",
    endpointLabel: record.endpointLabel,
    requestedCommitment: "finalized",
    confirmationStatus: "finalized",
    enrichmentStatus: "success",
    enrichmentError: null,
    fetchedAtUnixMs: record.capture.completedAtUnixMs,
    fetchDurationNs: record.capture.durationNs,
    slot,
    blockTimeUnixSeconds: integer(result.blockTime),
    canonicalTransactionIndex: transactionIndexes.get(record.request.subject) ?? null,
    transactionVersion,
    transactionStatus: meta.err === null ? "success" : "failed",
    transactionError: meta.err ?? null,
    feeLamports: fee === null ? null : String(fee),
    computeUnitsConsumed: computeUnitsConsumed === null ? null : String(computeUnitsConsumed),
    computeBudget: parseComputeBudget(instructions),
    jitoTip: parseJitoTipEvidence(instructions),
    signatures: stringArray(transaction.signatures),
    recentBlockhash: string(message.recentBlockhash),
    accountKeys: [...staticKeys, ...loadedAddresses.writable, ...loadedAddresses.readonly],
    loadedAddresses,
    preSolBalancesLamports: integerStrings(meta.preBalances),
    postSolBalancesLamports: integerStrings(meta.postBalances),
    preTokenBalances: parseTokenBalances(meta.preTokenBalances),
    postTokenBalances: parseTokenBalances(meta.postTokenBalances),
    instructions,
    logMessages,
    returnData: meta.returnData ?? null,
    rewards: meta.rewards ?? null,
  };
}

export function venueEnvelopeFromLiveEvent(
  event: NormalizedMarketEvent,
  enrichment: TransactionEnrichment | null,
  outerInstructionIndex: number | null,
  outerInstructionIndexSource: VenueEventEnvelope["canonical"]["outerInstructionIndexSource"],
  eventIndex: number,
): VenueEventEnvelope {
  const trade = event.eventType === "trade" ? event : null;
  return {
    schemaVersion: 1,
    kind: "venue-event",
    eventId: event.eventId,
    venue: "pumpfun-bonding-curve",
    chain: "solana-mainnet",
    provenance: "live",
    instrument: { baseMint: event.tokenMint, quoteMint: event.quoteMint },
    eventType: event.eventType,
    side: trade?.side ?? null,
    signature: event.signature,
    observed: {
      collectorSequence: event.ordering.collectorSequence,
      receivedAtUnixMs: event.timestamps.collectorReceivedAtUnixMs,
      receivedMonotonicNs: event.timestamps.collectorReceivedMonotonicNs,
      parseDurationNs: event.timestamps.collectorParseDurationNs,
      providerReceivedAtUnixMs: null,
    },
    canonical: {
      slot: enrichment?.slot ?? event.ordering.slot,
      transactionIndex: enrichment?.canonicalTransactionIndex ?? null,
      outerInstructionIndex,
      outerInstructionIndexSource,
      transactionLogIndex: event.ordering.transactionLogIndex,
      eventIndex,
      blockTimeUnixSeconds: enrichment?.blockTimeUnixSeconds ?? null,
      confirmationStatus: enrichment?.confirmationStatus ?? null,
    },
    amounts: {
      baseUnits: trade?.amounts.tokenBaseUnits ?? null,
      quoteBaseUnits: trade?.amounts.quoteBaseUnits ?? null,
    },
    transactionCost: {
      feeLamports: enrichment?.feeLamports ?? null,
      computeUnitsConsumed: enrichment?.computeUnitsConsumed ?? null,
      requestedComputeUnitLimit: enrichment?.computeBudget.requestedComputeUnitLimit ?? null,
      effectiveComputeUnitLimit: enrichment?.computeBudget.effectiveComputeUnitLimit ?? null,
      computeUnitLimitSource: enrichment?.computeBudget.computeUnitLimitSource ?? "unknown",
      requestedComputeUnitPriceMicroLamports:
        enrichment?.computeBudget.requestedComputeUnitPriceMicroLamports ?? null,
      requestedPriorityFeeLamports:
        enrichment?.computeBudget.requestedPriorityFeeLamports ?? null,
      observableJitoTipLamports: enrichment?.jitoTip.totalLamports ?? null,
      observableJitoTipStatus: enrichment?.jitoTip.status ?? "indeterminate",
    },
    venuePayload: event,
  };
}

export function compareCanonicalEvents(left: VenueEventEnvelope, right: VenueEventEnvelope): number {
  const slot = compareNullable(left.canonical.slot, right.canonical.slot);
  if (slot !== 0) return slot;
  if (left.canonical.transactionIndex === null || right.canonical.transactionIndex === null) {
    return compareObservedEvents(left, right);
  }
  const transaction = left.canonical.transactionIndex - right.canonical.transactionIndex;
  if (transaction !== 0) return transaction;
  const fields: readonly [number | null, number | null][] = [
    [left.canonical.outerInstructionIndex, right.canonical.outerInstructionIndex],
    [left.canonical.transactionLogIndex, right.canonical.transactionLogIndex],
    [left.canonical.eventIndex, right.canonical.eventIndex],
  ];
  for (const [a, b] of fields) {
    if (a === b) continue;
    if (a === null) return 1;
    if (b === null) return -1;
    return a - b;
  }
  return compareObservedEvents(left, right);
}

function compareNullable(left: number | null, right: number | null): number {
  if (left === right) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return left - right;
}

/** Safe causal fallback: live collector order precedes deterministic non-live tie-breaking. */
export function compareObservedEvents(left: VenueEventEnvelope, right: VenueEventEnvelope): number {
  const sequence = compareNullable(left.observed.collectorSequence, right.observed.collectorSequence);
  if (sequence !== 0) return sequence;
  const log = left.canonical.transactionLogIndex - right.canonical.transactionLogIndex;
  return log !== 0 ? log : left.eventId.localeCompare(right.eventId);
}
