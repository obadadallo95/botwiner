import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { replayDataset } from "../apps/replay/src/replay.js";
import {
  PUMP_IDL_REVISION,
  PUMP_PARSING_VERSION,
  PUMP_PROGRAM_ID,
  normalizeRawLogRecord,
} from "@botwiner/pumpfun";
import {
  DatasetWriter,
  EVENTS_FILE_NAME,
  RAW_FILE_NAME,
  readJsonLines,
  readManifest,
} from "@botwiner/storage";
import { createEventData, logsFor, rawRecord, tradeEventData } from "./fixtures/pump-events.js";

async function collectLines(path: string): Promise<unknown[]> {
  const values: unknown[] = [];
  for await (const line of readJsonLines<unknown>(path)) values.push(line.value);
  return values;
}

test("append-only storage preserves duplicate raw input but de-duplicates events", async () => {
  const directory = await mkdtemp(join(tmpdir(), "botwiner-storage-"));
  try {
    const writer = await DatasetWriter.create({
      directory,
      sessionId: "duplicate-test",
      endpointLabel: "wss://example.invalid",
      commitment: "processed",
      programId: PUMP_PROGRAM_ID,
      parsingVersion: PUMP_PARSING_VERSION,
      officialIdlRevision: PUMP_IDL_REVISION,
    });
    for (const sequence of [1, 2]) {
      const raw = rawRecord({ sequence });
      const result = normalizeRawLogRecord(raw);
      await writer.recordRaw({
        raw,
        events: result.events,
        parseFailures: result.failures,
        invalidNotification: result.invalidNotification,
        transactionFailed: result.transactionFailed,
      });
    }
    await writer.close();

    assert.equal((await collectLines(join(directory, RAW_FILE_NAME))).length, 2);
    assert.equal((await collectLines(join(directory, EVENTS_FILE_NAME))).length, 1);
    const manifest = await readManifest(directory);
    assert.equal(manifest.status, "complete");
    assert.equal(manifest.counts.rawNotifications, 2);
    assert.equal(manifest.counts.normalizedEvents, 1);
    assert.equal(manifest.counts.duplicateEvents, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("dataset creation refuses to append to existing session files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "botwiner-existing-"));
  try {
    await writeFile(join(directory, RAW_FILE_NAME), "existing\n", "utf8");
    await assert.rejects(
      DatasetWriter.create({
        directory,
        sessionId: "existing-test",
        endpointLabel: "wss://example.invalid",
        commitment: "processed",
        programId: PUMP_PROGRAM_ID,
        parsingVersion: PUMP_PARSING_VERSION,
        officialIdlRevision: PUMP_IDL_REVISION,
      }),
      /already contains session files: raw\.jsonl/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("raw data deterministically replays to byte-identical normalized events", async () => {
  const directory = await mkdtemp(join(tmpdir(), "botwiner-replay-"));
  try {
    const writer = await DatasetWriter.create({
      directory,
      sessionId: "replay-test",
      endpointLabel: "wss://example.invalid",
      commitment: "processed",
      programId: PUMP_PROGRAM_ID,
      parsingVersion: PUMP_PARSING_VERSION,
      officialIdlRevision: PUMP_IDL_REVISION,
    });
    const raw = rawRecord({ logs: logsFor(createEventData(), tradeEventData()) });
    const result = normalizeRawLogRecord(raw);
    await writer.recordRaw({
      raw,
      events: result.events,
      parseFailures: result.failures,
      invalidNotification: result.invalidNotification,
      transactionFailed: result.transactionFailed,
    });
    await writer.close();

    const summary = await replayDataset(directory);
    assert.equal(summary.rawRecords, 1);
    assert.equal(summary.emittedEvents, 2);
    assert.equal(summary.deterministicMatch, true);
    const expected = await readFile(join(directory, EVENTS_FILE_NAME), "utf8");
    const replayed = await readFile(summary.output, "utf8");
    assert.equal(replayed, expected);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("replay rejects malformed raw-record envelopes with the line number", async () => {
  const directory = await mkdtemp(join(tmpdir(), "botwiner-malformed-"));
  try {
    await Promise.all([
      writeFile(join(directory, RAW_FILE_NAME), '{"kind":"wrong"}\n', "utf8"),
      writeFile(join(directory, EVENTS_FILE_NAME), "", "utf8"),
    ]);
    await assert.rejects(replayDataset(directory), /invalid raw record at line 1/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
