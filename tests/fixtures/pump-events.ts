import type { Commitment, RawLogRecord } from "@botwiner/market-data";
import { PUMP_PROGRAM_ID } from "@botwiner/pumpfun";

export const CREATE_DISCRIMINATOR = Buffer.from([27, 114, 169, 77, 222, 235, 99, 118]);
export const TRADE_DISCRIMINATOR = Buffer.from([189, 219, 127, 211, 78, 230, 97, 238]);
export const TEST_SIGNATURE = "3".repeat(88);

function u16(value: number): Buffer {
  const bytes = Buffer.alloc(2);
  bytes.writeUInt16LE(value);
  return bytes;
}

function u32(value: number): Buffer {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(value);
  return bytes;
}

function u64(value: bigint): Buffer {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64LE(value);
  return bytes;
}

function i64(value: bigint): Buffer {
  const bytes = Buffer.alloc(8);
  bytes.writeBigInt64LE(value);
  return bytes;
}

function bool(value: boolean): Buffer {
  return Buffer.from([value ? 1 : 0]);
}

function string(value: string): Buffer {
  const bytes = Buffer.from(value, "utf8");
  return Buffer.concat([u32(bytes.length), bytes]);
}

function pubkey(seed: number): Buffer {
  return Buffer.alloc(32, seed);
}

export function createEventData(trailingBytes = Buffer.alloc(0)): Buffer {
  return Buffer.concat([
    CREATE_DISCRIMINATOR,
    string("Research Token"),
    string("RSRCH"),
    string("https://example.invalid/metadata.json"),
    pubkey(1),
    pubkey(2),
    pubkey(3),
    pubkey(4),
    i64(1_780_000_000n),
    u64(1_073_000_000_000_000n),
    u64(30_000_000_000n),
    u64(793_100_000_000_000n),
    u64(1_000_000_000_000_000n),
    pubkey(5),
    bool(false),
    bool(true),
    pubkey(6),
    u64(30_000_000_000n),
    trailingBytes,
  ]);
}

export function tradeEventData(): Buffer {
  return Buffer.concat([
    TRADE_DISCRIMINATOR,
    pubkey(1),
    u64(100_000_000n),
    u64(3_000_000_000n),
    bool(true),
    pubkey(7),
    i64(1_780_000_001n),
    u64(30_100_000_000n),
    u64(1_069_500_000_000_000n),
    u64(100_000_000n),
    u64(790_100_000_000_000n),
    pubkey(8),
    u64(100n),
    u64(1_000_000n),
    pubkey(4),
    u64(50n),
    u64(500_000n),
    bool(true),
    u64(10n),
    u64(20n),
    u64(100_000_000n),
    i64(1_780_000_001n),
    string("buy_v2"),
    bool(false),
    u64(25n),
    u64(250_000n),
    u64(10n),
    u64(100_000n),
    u32(1),
    pubkey(9),
    u16(1_000),
    pubkey(6),
    u64(100_000_000n),
    u64(30_100_000_000n),
    u64(100_000_000n),
  ]);
}

export function logsFor(...eventData: readonly Buffer[]): string[] {
  return [
    `Program ${PUMP_PROGRAM_ID} invoke [1]`,
    ...eventData.map((data) => `Program data: ${data.toString("base64")}`),
    `Program ${PUMP_PROGRAM_ID} success`,
  ];
}

export function rawRecord(options: {
  readonly sequence?: number;
  readonly logs?: readonly string[];
  readonly error?: unknown;
  readonly signature?: string;
  readonly commitment?: Commitment;
} = {}): RawLogRecord {
  const receivedAtUnixMs = 1_780_000_002_123;
  return {
    schemaVersion: 1,
    kind: "solana.logs-notification",
    sequence: options.sequence ?? 1,
    source: {
      transport: "solana-rpc-websocket",
      programId: PUMP_PROGRAM_ID,
      commitment: options.commitment ?? "processed",
      endpointLabel: "wss://api.mainnet-beta.solana.com",
    },
    capture: {
      receivedAtUnixMs,
      receivedAtIso: new Date(receivedAtUnixMs).toISOString(),
      receivedMonotonicNs: "1000000000",
      parseCompletedAtUnixMs: receivedAtUnixMs,
      parseDurationNs: "42000",
      rpcProviderReceivedAtUnixMs: null,
    },
    rpcPayload: {
      jsonrpc: "2.0",
      method: "logsNotification",
      params: {
        result: {
          context: { slot: 400_000_000 },
          value: {
            signature: options.signature ?? TEST_SIGNATURE,
            err: options.error ?? null,
            logs: options.logs ?? logsFor(createEventData()),
          },
        },
        subscription: 42,
      },
    },
  };
}
