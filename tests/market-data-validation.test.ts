import assert from "node:assert/strict";
import test from "node:test";
import {
  bigintSafeJsonStringify,
  bigintSafeReplacer,
  jsonLine,
  parseLogsNotification,
  parseRawLogRecord,
  toBigIntSafeObject,
} from "@botwiner/market-data";
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

test("bigintSafeJsonStringify and toBigIntSafeObject handle nested BigInt values cleanly", () => {
  const payload = {
    plainNumber: 42,
    bigValue: 50_000_000_000n,
    nested: {
      deepBig: 100_000_000_000_000n,
      arrayWithBigInt: [1n, 2n, 3],
    },
  };

  // Standard JSON.stringify fails on BigInt
  assert.throws(() => JSON.stringify(payload), { name: "TypeError" });

  // bigintSafeJsonStringify succeeds
  const serialized = bigintSafeJsonStringify(payload, 2);
  assert.ok(serialized.includes('"bigValue": "50000000000"'));
  assert.ok(serialized.includes('"deepBig": "100000000000000"'));
  assert.ok(serialized.includes('"1"'));
  assert.ok(serialized.includes('"2"'));

  // toBigIntSafeObject returns clean plain object without BigInts
  const safeObj = toBigIntSafeObject<typeof payload>(payload);
  assert.equal(safeObj.bigValue, "50000000000");
  assert.equal(safeObj.nested.deepBig, "100000000000000");
  assert.deepEqual(safeObj.nested.arrayWithBigInt, ["1", "2", 3]);
  assert.doesNotThrow(() => JSON.stringify(safeObj));

  // jsonLine also handles BigInt
  const line = jsonLine(payload);
  assert.ok(line.endsWith("\n"));
  assert.ok(line.includes('"bigValue":"50000000000"'));

  // bigintSafeReplacer works directly with standard JSON.stringify
  const customStr = JSON.stringify(payload, bigintSafeReplacer);
  assert.ok(customStr.includes('"bigValue":"50000000000"'));
});

