import { join, resolve } from "node:path";
import {
  parseRawLogRecord,
  type NormalizedMarketEvent,
} from "@botwiner/market-data";
import { normalizeRawLogRecord } from "@botwiner/pumpfun";
import {
  EVENTS_FILE_NAME,
  RAW_FILE_NAME,
  digestFile,
  readJsonLines,
  writeJsonLines,
} from "@botwiner/storage";

export interface ReplaySummary {
  readonly dataset: string;
  readonly output: string;
  readonly rawRecords: number;
  readonly emittedEvents: number;
  readonly duplicateEvents: number;
  readonly malformedEvents: number;
  readonly invalidNotifications: number;
  readonly failedTransactions: number;
  readonly expectedDigest: string;
  readonly replayDigest: string;
  readonly deterministicMatch: boolean;
}

export async function replayDataset(
  datasetDirectory: string,
  outputPath = join(resolve(datasetDirectory), "replay", EVENTS_FILE_NAME),
): Promise<ReplaySummary> {
  const dataset = resolve(datasetDirectory);
  const rawPath = join(dataset, RAW_FILE_NAME);
  const expectedPath = join(dataset, EVENTS_FILE_NAME);
  const events: NormalizedMarketEvent[] = [];
  const eventIds = new Set<string>();
  let rawRecords = 0;
  let duplicateEvents = 0;
  let malformedEvents = 0;
  let invalidNotifications = 0;
  let failedTransactions = 0;

  for await (const line of readJsonLines<unknown>(rawPath)) {
    const validated = parseRawLogRecord(line.value);
    if (!validated.ok) {
      throw new Error(`invalid raw record at line ${line.lineNumber}: ${validated.error}`);
    }
    rawRecords += 1;
    const result = normalizeRawLogRecord(validated.value);
    malformedEvents += result.failures.length;
    if (result.invalidNotification !== null) invalidNotifications += 1;
    if (result.transactionFailed) failedTransactions += 1;
    for (const event of result.events) {
      if (eventIds.has(event.eventId)) {
        duplicateEvents += 1;
        continue;
      }
      eventIds.add(event.eventId);
      events.push(event);
    }
  }

  const replayDigest = await writeJsonLines(outputPath, events);
  const expectedDigest = await digestFile(expectedPath);
  return {
    dataset,
    output: resolve(outputPath),
    rawRecords,
    emittedEvents: events.length,
    duplicateEvents,
    malformedEvents,
    invalidNotifications,
    failedTransactions,
    expectedDigest,
    replayDigest,
    deterministicMatch: replayDigest === expectedDigest,
  };
}
