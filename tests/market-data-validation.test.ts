import assert from "node:assert/strict";
import test from "node:test";
import { parseLogsNotification, parseRawLogRecord } from "@botwiner/market-data";
import { rawRecord } from "./fixtures/pump-events.js";

test("accepts a valid raw envelope and notification", () => {
  const raw = rawRecord();
  assert.equal(parseRawLogRecord(raw).ok, true);
  assert.equal(parseLogsNotification(raw.rpcPayload).ok, true);
});

test("rejects malformed and unexpected notification shapes", () => {
  const missingLogs = {
    jsonrpc: "2.0",
    method: "logsNotification",
    params: {
      subscription: 1,
      result: { context: { slot: 1 }, value: { signature: "x".repeat(88) } },
    },
  };
  const result = parseLogsNotification(missingLogs);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /logs/);
  assert.equal(parseLogsNotification({ method: "other" }).ok, false);
});
