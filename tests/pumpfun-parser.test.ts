import assert from "node:assert/strict";
import test from "node:test";
import {
  PUMP_PROGRAM_ID,
  encodeBase58,
  normalizeRawLogRecord,
  parsePumpProgramLogs,
} from "@botwiner/pumpfun";
import {
  CREATE_DISCRIMINATOR,
  createEventData,
  logsFor,
  rawRecord,
  tradeEventData,
} from "./fixtures/pump-events.js";

test("decodes and normalizes the official CreateEvent layout", () => {
  const parsed = parsePumpProgramLogs(logsFor(createEventData(Buffer.from([9, 8]))));
  assert.equal(parsed.failures.length, 0);
  assert.equal(parsed.events.length, 1);
  const located = parsed.events[0];
  assert.ok(located);
  assert.equal(located.event.kind, "create");
  if (located.event.kind !== "create") return;
  assert.equal(located.event.name, "Research Token");
  assert.equal(located.event.symbol, "RSRCH");
  assert.equal(located.event.virtualSolReserves, 30_000_000_000n);
  assert.equal(located.event.unparsedTrailingBytes, 2);

  const normalized = normalizeRawLogRecord(
    rawRecord({ logs: logsFor(createEventData(Buffer.from([9, 8]))) }),
  );
  assert.equal(normalized.events.length, 1);
  const launch = normalized.events[0];
  assert.ok(launch);
  assert.equal(launch.eventType, "launch");
  if (launch.eventType !== "launch") return;
  assert.equal(launch.reserves.virtualSolLamports, "30000000000");
  assert.equal(launch.unparsedTrailingBytes, 2);
  assert.equal(launch.timestamps.rpcProviderReceivedAtUnixMs, null);
  assert.equal(launch.timestamps.blockTimeUnixSeconds, null);
});

test("decodes and normalizes the official TradeEvent layout without number loss", () => {
  const normalized = normalizeRawLogRecord(rawRecord({ logs: logsFor(tradeEventData()) }));
  assert.equal(normalized.failures.length, 0);
  assert.equal(normalized.events.length, 1);
  const trade = normalized.events[0];
  assert.ok(trade);
  assert.equal(trade.eventType, "trade");
  if (trade.eventType !== "trade") return;
  assert.equal(trade.side, "buy");
  assert.equal(trade.instructionName, "buy_v2");
  assert.deepEqual(trade.observedPriceRatio, {
    quoteBaseUnits: "100000000",
    tokenBaseUnits: "3000000000",
  });
  assert.equal(trade.fees.protocolQuoteBaseUnits, "1000000");
  assert.equal(trade.shareholders.length, 1);
  assert.equal(trade.shareholders[0]?.shareBasisPoints, 1_000);
  assert.equal(trade.bondingCurve, null);
});

test("reports a known but truncated event and ignores unknown program data", () => {
  const truncated = Buffer.concat([CREATE_DISCRIMINATOR, Buffer.from([4, 0, 0])]);
  const unknown = Buffer.alloc(24, 255);
  const parsed = parsePumpProgramLogs(logsFor(unknown, truncated));
  assert.equal(parsed.events.length, 0);
  assert.equal(parsed.failures.length, 1);
  assert.match(parsed.failures[0]?.message ?? "", /truncated/);
});

test("does not decode matching bytes emitted while another program is active", () => {
  const otherProgram = "11111111111111111111111111111111";
  const logs = [
    `Program ${PUMP_PROGRAM_ID} invoke [1]`,
    `Program ${otherProgram} invoke [2]`,
    `Program data: ${createEventData().toString("base64")}`,
    `Program ${otherProgram} success`,
    `Program ${PUMP_PROGRAM_ID} success`,
  ];
  assert.equal(parsePumpProgramLogs(logs).events.length, 0);
});

test("failed transactions remain raw candidates but produce no market events", () => {
  const normalized = normalizeRawLogRecord(
    rawRecord({ error: { InstructionError: [0, "Custom"] } }),
  );
  assert.equal(normalized.transactionFailed, true);
  assert.equal(normalized.events.length, 0);
});

test("base58 encoding preserves leading zero public-key bytes", () => {
  assert.equal(encodeBase58(Buffer.alloc(32)), "1".repeat(32));
  assert.equal(encodeBase58(Buffer.from([0, 1])), "12");
});
