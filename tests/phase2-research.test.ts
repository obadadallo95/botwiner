import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { DiagnosticRecord } from "@botwiner/market-data";
import {
  PUMP_IDL_REVISION,
  PUMP_PARSING_VERSION,
  PUMP_PROGRAM_ID,
  encodeBase58,
  normalizeRawLogRecord,
  parsePumpProgramLogs,
  pumpTradeReserveSemantics,
} from "@botwiner/pumpfun";
import {
  COMPUTE_BUDGET_PROGRAM_ID,
  JITO_TIP_ACCOUNTS,
  GAP_RECOVERY_FILE,
  PHASE2_DIRECTORY,
  PHASE2_DERIVED_DIRECTORY,
  PHASE2_RAW_DIRECTORY,
  RPC_BLOCKS_FILE,
  RPC_TRANSACTIONS_FILE,
  VENUE_EVENTS_FILE,
  compareCanonicalEvents,
  callSolanaRpc,
  captureRpcEvidence,
  detectGaps,
  parseComputeBudget,
  parseJitoTipEvidence,
  parseTransactionEnrichment,
  rebuildDerivedResearchStore,
  recoverGap,
  transactionIndexesFromBlockRecords,
  type GapRecoveryRecord,
  type RawRpcRecord,
  type InstructionRecord,
} from "@botwiner/research";
import {
  DatasetWriter,
  EVENTS_FILE_NAME,
  digestFile,
  writeJsonLines,
} from "@botwiner/storage";
import { replayDataset } from "../apps/replay/src/replay.js";
import {
  TEST_SIGNATURE,
  createEventData,
  logsFor,
  rawRecord,
  tradeEventData,
} from "./fixtures/pump-events.js";

const BACKFILLED_SIGNATURE = "4".repeat(88);

function u32Instruction(tag: number, value: number): string {
  const bytes = Buffer.alloc(5);
  bytes[0] = tag;
  bytes.writeUInt32LE(value, 1);
  return encodeBase58(bytes);
}

function u64Instruction(tag: number, value: bigint): string {
  const bytes = Buffer.alloc(9);
  bytes[0] = tag;
  bytes.writeBigUInt64LE(value, 1);
  return encodeBase58(bytes);
}

function transactionRecord(options: {
  readonly signature?: string;
  readonly provenance?: "live" | "backfilled";
  readonly logs?: readonly string[];
  readonly result?: unknown;
} = {}): RawRpcRecord {
  const signature = options.signature ?? TEST_SIGNATURE;
  return {
    schemaVersion: 1,
    kind: "solana-rpc-response",
    request: {
      method: "getTransaction",
      subject: signature,
      params: [signature, { commitment: "finalized" }],
      commitment: "finalized",
    },
    provenance: options.provenance ?? "live",
    endpointLabel: "https://api.mainnet-beta.solana.com",
    capture: {
      requestedAtUnixMs: 1_780_000_003_000,
      completedAtUnixMs: 1_780_000_004_000,
      durationNs: "1000000000",
      attempts: 1,
    },
    response: options.result ?? {
      jsonrpc: "2.0",
      id: 1,
      result: {
        slot: 400_000_000,
        blockTime: 1_780_000_001,
        version: 0,
        transaction: {
          signatures: [signature],
          message: {
            accountKeys: ["payer", COMPUTE_BUDGET_PROGRAM_ID, PUMP_PROGRAM_ID],
            recentBlockhash: "blockhash",
            instructions: [
              { programIdIndex: 1, accounts: [], data: u32Instruction(2, 300_000) },
              { programIdIndex: 1, accounts: [], data: u64Instruction(3, 2_500n) },
              { programIdIndex: 2, accounts: [0], data: "1" },
            ],
          },
        },
        meta: {
          err: null,
          fee: 5_750,
          computeUnitsConsumed: 123_456,
          loadedAddresses: { writable: ["loaded-writable"], readonly: ["loaded-readonly"] },
          preBalances: [1_000_000, 0, 0, 0, 0],
          postBalances: [994_250, 0, 0, 0, 0],
          preTokenBalances: [],
          postTokenBalances: [
            {
              accountIndex: 0,
              mint: "mint",
              owner: "payer",
              programId: "token-program",
              uiTokenAmount: { amount: "123456789012345", decimals: 6 },
            },
          ],
          innerInstructions: [{ index: 2, instructions: [{ programIdIndex: 2, accounts: [0], data: "1", stackHeight: 2 }] }],
          logMessages: options.logs ?? logsFor(createEventData(), tradeEventData()),
          returnData: null,
          rewards: [],
        },
      },
    },
  };
}

function blockRecord(signatures: readonly string[] = ["other", TEST_SIGNATURE]): RawRpcRecord {
  return {
    schemaVersion: 1,
    kind: "solana-rpc-response",
    request: {
      method: "getBlock",
      subject: "400000000",
      params: [400_000_000, { commitment: "finalized", transactionDetails: "signatures" }],
      commitment: "finalized",
    },
    provenance: "canonical-order",
    endpointLabel: "https://api.mainnet-beta.solana.com",
    capture: {
      requestedAtUnixMs: 1_780_000_004_000,
      completedAtUnixMs: 1_780_000_004_100,
      durationNs: "100000000",
      attempts: 1,
    },
    response: { jsonrpc: "2.0", id: 1, result: { signatures } },
  };
}

test("extracts finalized metadata, canonical index, fees, loaded addresses, and compute budget", () => {
  const block = blockRecord();
  const indexes = transactionIndexesFromBlockRecords([block]);
  const enrichment = parseTransactionEnrichment(transactionRecord(), indexes);
  assert.equal(enrichment.enrichmentStatus, "success");
  assert.equal(enrichment.confirmationStatus, "finalized");
  assert.equal(enrichment.canonicalTransactionIndex, 1);
  assert.equal(enrichment.feeLamports, "5750");
  assert.equal(enrichment.computeUnitsConsumed, "123456");
  assert.equal(enrichment.computeBudget.requestedComputeUnitLimit, "300000");
  assert.equal(enrichment.computeBudget.effectiveComputeUnitLimit, "300000");
  assert.equal(enrichment.computeBudget.computeUnitLimitSource, "explicit");
  assert.equal(enrichment.computeBudget.requestedComputeUnitPriceMicroLamports, "2500");
  assert.equal(enrichment.computeBudget.requestedPriorityFeeLamports, "750");
  assert.deepEqual(enrichment.loadedAddresses, {
    writable: ["loaded-writable"],
    readonly: ["loaded-readonly"],
  });
  assert.equal(enrichment.postTokenBalances?.[0]?.amountBaseUnits, "123456789012345");
  assert.equal(enrichment.instructions.length, 4);
});

test("calculates priority fee from the runtime default CU limit when SetComputeUnitLimit is omitted", () => {
  const instructions: InstructionRecord[] = [
    { outerInstructionIndex: 0, innerInstructionIndex: null, parentOuterInstructionIndex: null, stackHeight: null, programId: COMPUTE_BUDGET_PROGRAM_ID, accountIndexes: [], accountKeys: [], dataBase58: u64Instruction(3, 2_500n), parsed: null },
    { outerInstructionIndex: 1, innerInstructionIndex: null, parentOuterInstructionIndex: null, stackHeight: null, programId: PUMP_PROGRAM_ID, accountIndexes: [], accountKeys: [], dataBase58: "1", parsed: null },
  ];
  const budget = parseComputeBudget(instructions);
  assert.equal(budget.requestedComputeUnitLimit, null);
  assert.equal(budget.effectiveComputeUnitLimit, "203000");
  assert.equal(budget.computeUnitLimitSource, "runtime-default");
  assert.equal(budget.requestedPriorityFeeLamports, "508");
});

test("detects direct top-level and CPI Jito tips without claiming bundle completeness", () => {
  const transfer = Buffer.alloc(12);
  transfer.writeUInt32LE(2, 0);
  transfer.writeBigUInt64LE(1_000_000n, 4);
  const evidence = parseJitoTipEvidence([
    { outerInstructionIndex: 2, innerInstructionIndex: null, parentOuterInstructionIndex: null, stackHeight: null, programId: "11111111111111111111111111111111", accountIndexes: [0, 1], accountKeys: ["payer", JITO_TIP_ACCOUNTS[0]], dataBase58: encodeBase58(transfer), parsed: null },
    { outerInstructionIndex: 3, innerInstructionIndex: 0, parentOuterInstructionIndex: 3, stackHeight: 2, programId: "11111111111111111111111111111111", accountIndexes: [0, 1], accountKeys: ["payer", JITO_TIP_ACCOUNTS[1]], dataBase58: null, parsed: { type: "transfer", info: { source: "payer", destination: JITO_TIP_ACCOUNTS[1], lamports: 2_000 } } },
  ]);
  assert.equal(evidence.status, "observed-transfer");
  assert.equal(evidence.totalLamports, "1002000");
  assert.equal(evidence.transfers.length, 2);
  assert.match(evidence.caveat, /another transaction/);
});

test("correlates event outer index to message instructions when earlier invoke logs are absent", () => {
  const parsed = parsePumpProgramLogs(logsFor(createEventData()), [COMPUTE_BUDGET_PROGRAM_ID, PUMP_PROGRAM_ID]);
  assert.equal(parsed.events[0]?.outerInstructionIndex, 1);
  assert.equal(parsed.events[0]?.outerInstructionIndexSource, "message-correlated");
});

test("documents post-trade reserves and refuses one-event mayhem pre-state reconstruction", () => {
  const trade = parsePumpProgramLogs(logsFor(tradeEventData())).events[0]?.event;
  assert.equal(trade?.kind, "trade");
  if (trade?.kind !== "trade") return;
  const standard = pumpTradeReserveSemantics(trade);
  assert.equal(standard.status, "exact-standard-bonding-curve");
  assert.equal(
    standard.preTrade?.virtualTokenReserves,
    trade.virtualTokenReserves + (trade.isBuy ? trade.tokenAmount : -trade.tokenAmount),
  );
  const mayhem = pumpTradeReserveSemantics({ ...trade, mayhemMode: true });
  assert.equal(mayhem.status, "unsupported-mayhem-mode");
  assert.equal(mayhem.preTrade, null);
});

test("represents null and malformed RPC enrichment explicitly", () => {
  const unavailable = parseTransactionEnrichment(
    transactionRecord({ result: { jsonrpc: "2.0", id: 1, result: null } }),
    new Map(),
  );
  assert.equal(unavailable.enrichmentStatus, "unavailable");
  assert.equal(unavailable.slot, null);
  assert.equal(unavailable.feeLamports, null);

  const malformed = parseTransactionEnrichment(
    transactionRecord({ result: { jsonrpc: "2.0", id: 1, result: { slot: 1 } } }),
    new Map(),
  );
  assert.equal(malformed.enrichmentStatus, "malformed");
  assert.match(malformed.enrichmentError ?? "", /structure/);
});

test("canonical comparison uses slot, block transaction index, then instruction/log/event indexes", () => {
  const enrichment = parseTransactionEnrichment(transactionRecord(), new Map([[TEST_SIGNATURE, 2]]));
  const event = normalizeRawLogRecord(rawRecord()).events[0];
  assert.ok(event);
  const base = {
    schemaVersion: 1 as const,
    kind: "venue-event" as const,
    eventId: "a",
    venue: "pumpfun-bonding-curve" as const,
    chain: "solana-mainnet" as const,
    provenance: "live" as const,
    instrument: { baseMint: event.tokenMint, quoteMint: event.quoteMint },
    eventType: event.eventType,
    side: null,
    signature: TEST_SIGNATURE,
    observed: {
      collectorSequence: 1,
      receivedAtUnixMs: 1,
      receivedMonotonicNs: "1",
      parseDurationNs: "1",
      providerReceivedAtUnixMs: null,
    },
    canonical: {
      slot: enrichment.slot,
      transactionIndex: 2,
      outerInstructionIndex: 0,
      outerInstructionIndexSource: "message-correlated" as const,
      transactionLogIndex: 3,
      eventIndex: 0,
      blockTimeUnixSeconds: enrichment.blockTimeUnixSeconds,
      confirmationStatus: enrichment.confirmationStatus,
    },
    amounts: { baseUnits: null, quoteBaseUnits: null },
    transactionCost: {
      feeLamports: null,
      computeUnitsConsumed: null,
      requestedComputeUnitLimit: null,
      effectiveComputeUnitLimit: null,
      computeUnitLimitSource: "unknown" as const,
      requestedComputeUnitPriceMicroLamports: null,
      requestedPriorityFeeLamports: null,
      observableJitoTipLamports: null,
      observableJitoTipStatus: "indeterminate" as const,
    },
    venuePayload: {},
  };
  const later = { ...base, eventId: "b", canonical: { ...base.canonical, transactionIndex: 3 } };
  assert.ok(compareCanonicalEvents(base, later) < 0);
  assert.ok(compareCanonicalEvents(later, base) > 0);
  const missingCanonicalEarlierObserved = {
    ...later,
    eventId: "z",
    observed: { ...later.observed, collectorSequence: 0 },
    canonical: { ...later.canonical, transactionIndex: null },
  };
  const missingCanonicalLaterObserved = {
    ...base,
    eventId: "a",
    observed: { ...base.observed, collectorSequence: 2 },
    canonical: { ...base.canonical, transactionIndex: null },
  };
  assert.ok(compareCanonicalEvents(missingCanonicalEarlierObserved, missingCanonicalLaterObserved) < 0);
});

test("detects reconnect gaps and preserves boundary evidence", () => {
  const diagnostics: DiagnosticRecord[] = [
    { schemaVersion: 1, kind: "diagnostic", code: "connection-closed", atUnixMs: 200, message: "closed", sequence: null, details: { willReconnect: true } },
    { schemaVersion: 1, kind: "diagnostic", code: "connection-opened", atUnixMs: 500, message: "open", sequence: null, details: {} },
  ];
  const gaps = detectGaps(diagnostics, [
    { signature: "before", slot: 1, receivedAtUnixMs: 100, sequence: 1 },
    { signature: "after", slot: 2, receivedAtUnixMs: 600, sequence: 2 },
  ]);
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0]?.estimatedDurationMs, 300);
  assert.equal(gaps[0]?.beforeGap?.signature, "before");
  assert.equal(gaps[0]?.afterGap?.signature, "after");
});

test("RPC retry honors a zero Retry-After and records attempt evidence", async () => {
  let calls = 0;
  const fetchImplementation: typeof fetch = () => {
    calls += 1;
    return Promise.resolve(calls === 1
      ? new Response("rate limited", { status: 429, headers: { "retry-after": "0" } })
      : Response.json({ jsonrpc: "2.0", id: 1, result: null }));
  };
  const record = await callSolanaRpc(
    { rpcUrl: "https://rpc.example", fetchImplementation, maximumAttempts: 2, baseRetryDelayMs: 0 },
    "getTransaction",
    TEST_SIGNATURE,
    [TEST_SIGNATURE],
    "live",
  );
  assert.equal(record.capture.attempts, 2);
  assert.equal(calls, 2);
});

test("gap recovery validates finalized boundaries, paginates within slots, and enforces the cap", async () => {
  const detected = detectGaps(
    [
      { schemaVersion: 1, kind: "diagnostic", code: "connection-closed", atUnixMs: 200, message: "closed", sequence: null, details: { willReconnect: true } },
      { schemaVersion: 1, kind: "diagnostic", code: "connection-opened", atUnixMs: 500, message: "open", sequence: null, details: {} },
    ],
    [
      { signature: "before", slot: 10, receivedAtUnixMs: 100, sequence: 1 },
      { signature: "after", slot: 12, receivedAtUnixMs: 600, sequence: 2 },
    ],
  )[0];
  assert.ok(detected);
  let calls = 0;
  const fetchImplementation: typeof fetch = (_input, init) => {
    calls += 1;
    if (typeof init?.body !== "string") throw new Error("expected string request body");
    const request = JSON.parse(init.body) as { method: string };
    if (request.method === "getSignatureStatuses") {
      return Promise.resolve(Response.json({ jsonrpc: "2.0", id: 1, result: { value: [
        { slot: 10, confirmationStatus: "finalized" },
        { slot: 12, confirmationStatus: "finalized" },
      ] } }));
    }
    return Promise.resolve(Response.json({ jsonrpc: "2.0", id: 1, result: [
      { signature: "new-1", slot: 12, blockTime: 1, err: null, confirmationStatus: "finalized" },
      { signature: "new-2", slot: 11, blockTime: 1, err: null, confirmationStatus: "finalized" },
    ] }));
  };
  const recovered = await recoverGap(
    { rpcUrl: "https://rpc.example", fetchImplementation, maximumAttempts: 1 },
    detected,
    new Set(["before", "after"]),
    2,
  );
  assert.equal(calls, 2);
  assert.equal(recovered.boundaryValidation?.beforeGapFinalizedAtExpectedSlot, true);
  assert.equal(recovered.queryTruncatedByBound, true);
  assert.deepEqual(recovered.newlyDiscoveredSignatures, ["new-1", "new-2"]);
});

test("captureRpcEvidence uses bounded targeted transaction batches and signature-only blocks by default", async () => {
  const directory = await mkdtemp(join(tmpdir(), "botwiner-capture-"));
  try {
    const writer = await DatasetWriter.create({
      directory,
      sessionId: "capture-test",
      endpointLabel: "wss://example.invalid",
      commitment: "processed",
      programId: PUMP_PROGRAM_ID,
      parsingVersion: PUMP_PARSING_VERSION,
      officialIdlRevision: PUMP_IDL_REVISION,
    });
    const raw = rawRecord();
    const normalized = normalizeRawLogRecord(raw);
    await writer.recordRaw({ raw, events: normalized.events, parseFailures: normalized.failures, invalidNotification: normalized.invalidNotification, transactionFailed: normalized.transactionFailed });
    await writer.close();
    const fetchImplementation: typeof fetch = (_input, init) => {
      if (typeof init?.body !== "string") throw new Error("expected string request body");
      const request = JSON.parse(init.body) as { method: string };
      return Promise.resolve(Response.json(request.method === "getTransaction" ? transactionRecord().response : blockRecord().response));
    };
    const summary = await captureRpcEvidence({
      datasetDirectory: directory,
      rpcUrl: "https://rpc.example",
      concurrency: 1,
      maximumAttempts: 1,
      fetchImplementation,
    });
    assert.equal(summary.transactionRequests, 1);
    assert.equal(summary.blockRequests, 1);
    const rawDirectory = join(directory, PHASE2_DIRECTORY, PHASE2_RAW_DIRECTORY);
    const transactionText = await readFile(join(rawDirectory, RPC_TRANSACTIONS_FILE), "utf8");
    const blockText = await readFile(join(rawDirectory, RPC_BLOCKS_FILE), "utf8");
    assert.match(transactionText, /getTransaction/);
    assert.match(blockText, /transactionDetails.*signatures/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("derived store rebuild is deterministic, carries provenance, and leaves Phase 1 replay intact", async () => {
  const directory = await mkdtemp(join(tmpdir(), "botwiner-phase2-"));
  try {
    const writer = await DatasetWriter.create({
      directory,
      sessionId: "phase2-test",
      endpointLabel: "wss://example.invalid",
      commitment: "processed",
      programId: PUMP_PROGRAM_ID,
      parsingVersion: PUMP_PARSING_VERSION,
      officialIdlRevision: PUMP_IDL_REVISION,
    });
    const raw = rawRecord({ logs: logsFor(createEventData(), tradeEventData()) });
    const normalized = normalizeRawLogRecord(raw);
    await writer.recordRaw({
      raw,
      events: normalized.events,
      parseFailures: normalized.failures,
      invalidNotification: normalized.invalidNotification,
      transactionFailed: normalized.transactionFailed,
    });
    const failedRaw = rawRecord({ sequence: 2, signature: "5".repeat(88), error: { InstructionError: [2, "Custom"] } });
    const failedNormalized = normalizeRawLogRecord(failedRaw);
    await writer.recordRaw({
      raw: failedRaw,
      events: failedNormalized.events,
      parseFailures: failedNormalized.failures,
      invalidNotification: failedNormalized.invalidNotification,
      transactionFailed: failedNormalized.transactionFailed,
    });
    await writer.close();

    const phase2Raw = join(directory, PHASE2_DIRECTORY, PHASE2_RAW_DIRECTORY);
    const gaps: GapRecoveryRecord[] = [{
      schemaVersion: 1,
      kind: "gap-recovery",
      gapId: "gap-1",
      closedAtUnixMs: 1,
      reopenedAtUnixMs: 2,
      estimatedDurationMs: 1,
      beforeGap: null,
      afterGap: null,
      rpcEvidence: [],
      boundaryValidation: null,
      queryCompleted: true,
      queryTruncatedByBound: false,
      candidateSignatures: [],
      newlyDiscoveredSignatures: [BACKFILLED_SIGNATURE],
      limitation: "test evidence",
      error: null,
    }];
    await Promise.all([
      writeJsonLines(join(phase2Raw, RPC_TRANSACTIONS_FILE), [
        transactionRecord(),
        transactionRecord({
          signature: BACKFILLED_SIGNATURE,
          provenance: "backfilled",
          logs: logsFor(tradeEventData()),
        }),
      ]),
      writeJsonLines(join(phase2Raw, RPC_BLOCKS_FILE), [blockRecord([TEST_SIGNATURE, BACKFILLED_SIGNATURE, "5".repeat(88)])]),
      writeJsonLines(join(phase2Raw, GAP_RECOVERY_FILE), gaps),
    ]);

    const phase1DigestBefore = await digestFile(join(directory, EVENTS_FILE_NAME));
    const first = await rebuildDerivedResearchStore(directory);
    const venuePath = join(directory, PHASE2_DIRECTORY, PHASE2_DERIVED_DIRECTORY, VENUE_EVENTS_FILE);
    const firstBytes = await readFile(venuePath, "utf8");
    const second = await rebuildDerivedResearchStore(directory);
    const secondBytes = await readFile(venuePath, "utf8");
    const replay = await replayDataset(directory);

    assert.equal(firstBytes, secondBytes);
    assert.deepEqual(first.report, second.report);
    assert.equal(first.observedVenueEvents.length, 2);
    assert.equal(first.observedVenueEvents[0]?.canonical.transactionIndex, null);
    assert.equal(first.observedVenueEvents[0]?.transactionCost.feeLamports, null);
    const canonicalLive = first.canonicalVenueEvents.find((event) => event.provenance === "live");
    assert.equal(canonicalLive?.canonical.outerInstructionIndex, 2);
    assert.equal(canonicalLive?.canonical.outerInstructionIndexSource, "message-correlated");
    assert.equal(first.canonicalVenueEvents.filter((event) => event.provenance === "backfilled").length, 1);
    assert.equal(first.manifest.files.observedVenueEvents.endsWith(VENUE_EVENTS_FILE), true);
    assert.equal(first.report.congestion.failedTransactions, 1);
    assert.equal(first.observedTransactions.find((item) => item.signature === "5".repeat(88))?.status, "failed");
    assert.equal(first.report.counts.backfilledEvents, 1);
    assert.equal(first.report.gaps.completenessClaim, false);
    assert.equal(await digestFile(join(directory, EVENTS_FILE_NAME)), phase1DigestBefore);
    assert.equal(replay.deterministicMatch, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
