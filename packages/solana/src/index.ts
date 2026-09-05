import WebSocket, { type RawData } from "ws";
import { createHash } from "node:crypto";
import { createSocket, type Socket } from "node:dgram";
import {
  createDiagnostic,
  type Commitment,
  type DiagnosticRecord,
} from "@botwiner/market-data";

export interface ReceiveClock {
  readonly receivedAtUnixMs: number;
  readonly receivedAtIso: string;
  readonly receivedMonotonicNs: bigint;
  readonly transportParseCompletedAtUnixMs: number;
  readonly transportParseDurationNs: bigint;
}

export interface ReceivedLogsMessage {
  readonly payload: unknown;
  readonly clock: ReceiveClock;
  readonly connectionEpoch: number;
}

export interface SolanaLogsSubscriberOptions {
  readonly url: string;
  readonly programId: string;
  readonly commitment: Commitment;
  readonly signal: AbortSignal;
  readonly onNotification: (message: ReceivedLogsMessage) => Promise<void> | void;
  readonly onDiagnostic: (diagnostic: DiagnosticRecord) => Promise<void> | void;
  /** Sanitized label used in diagnostics; never the credential-bearing URL. */
  readonly endpointLabel?: string;
  readonly redactSecrets?: readonly string[];
  readonly initialReconnectDelayMs?: number;
  readonly maximumReconnectDelayMs?: number;
}

export interface ClockOffsetSample {
  readonly host: string;
  readonly requestedAtUnixMs: number;
  readonly completedAtUnixMs: number;
  readonly offsetMs: number;
  readonly roundTripMs: number;
  readonly stratum: number;
  readonly leapIndicator: number;
  readonly version: number;
}

const NTP_UNIX_EPOCH_SECONDS = 2_208_988_800;

export function decodeNtpUnixMs(bytes: Buffer, offset: number): number {
  if (bytes.length < offset + 8) throw new Error("truncated NTP timestamp");
  const seconds = bytes.readUInt32BE(offset) - NTP_UNIX_EPOCH_SECONDS;
  const fraction = bytes.readUInt32BE(offset + 4) / 2 ** 32;
  return (seconds + fraction) * 1_000;
}

/** One lightweight SNTP sample. It is evidence of offset, not a synchronization guarantee. */
export async function sampleSntpClock(
  host = "time.cloudflare.com",
  timeoutMs = 2_000,
): Promise<ClockOffsetSample> {
  const request = Buffer.alloc(48);
  request[0] = 0x23; // LI=0, VN=4, client mode=3
  const requestedAtUnixMs = Date.now();
  const requestedAtMonotonicNs = process.hrtime.bigint();

  return new Promise((resolvePromise, reject) => {
    let socket: Socket | undefined = createSocket("udp4");
    let settled = false;
    const finish = (): Socket | undefined => {
      const current = socket;
      socket = undefined;
      if (current !== undefined) current.close();
      clearTimeout(timer);
      return current;
    };
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      finish();
      reject(error);
    };
    const timer = setTimeout(() => fail(new Error(`NTP sample timed out after ${timeoutMs}ms`)), timeoutMs);

    socket.once("error", fail);
    socket.once("message", (message) => {
      if (settled) return;
      try {
        if (message.length < 48) throw new Error("NTP response is shorter than 48 bytes");
        const completedAtUnixMs = Date.now();
        const elapsedMs = Number(process.hrtime.bigint() - requestedAtMonotonicNs) / 1_000_000;
        const serverReceivedAtUnixMs = decodeNtpUnixMs(message, 32);
        const serverTransmittedAtUnixMs = decodeNtpUnixMs(message, 40);
        const offsetMs =
          ((serverReceivedAtUnixMs - requestedAtUnixMs) +
            (serverTransmittedAtUnixMs - completedAtUnixMs)) /
          2;
        const roundTripMs = elapsedMs - (serverTransmittedAtUnixMs - serverReceivedAtUnixMs);
        const header = message[0] ?? 0;
        settled = true;
        finish();
        resolvePromise({
          host,
          requestedAtUnixMs,
          completedAtUnixMs,
          offsetMs,
          roundTripMs,
          stratum: message[1] ?? 0,
          leapIndicator: header >> 6,
          version: (header >> 3) & 0x07,
        });
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
    socket.send(request, 123, host, (error) => {
      if (error !== null) fail(error);
    });
  });
}

interface JsonRpcReply {
  readonly jsonrpc?: unknown;
  readonly id?: unknown;
  readonly result?: unknown;
  readonly error?: unknown;
  readonly method?: unknown;
}

function rawDataToUtf8(data: RawData): string {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return data.toString("utf8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolvePromise) => {
    const timeout = setTimeout(finish, ms);
    function finish(): void {
      clearTimeout(timeout);
      signal.removeEventListener("abort", finish);
      resolvePromise();
    }
    signal.addEventListener("abort", finish, { once: true });
  });
}

function settle(callbackResult: Promise<void> | void, pending: Set<Promise<void>>): void {
  if (!(callbackResult instanceof Promise)) return;
  pending.add(callbackResult);
  void callbackResult.finally(() => pending.delete(callbackResult));
}

export function endpointLabelFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return "invalid-endpoint";
  }
}

export function redactSecrets(text: string, secrets: readonly string[] = []): string {
  let redacted = text;
  for (const secret of secrets) {
    if (secret.length > 0) redacted = redacted.replaceAll(secret, "[REDACTED]");
  }
  return redacted;
}

async function runConnection(
  options: SolanaLogsSubscriberOptions,
  pending: Set<Promise<void>>,
  connectionEpoch: number,
): Promise<void> {
  return new Promise((resolvePromise) => {
    const socket = new WebSocket(options.url, {
      handshakeTimeout: 10_000,
      maxPayload: 16 * 1024 * 1024,
      perMessageDeflate: false,
    });
    let settled = false;
    const requestId = 1;

    function finish(): void {
      if (settled) return;
      settled = true;
      options.signal.removeEventListener("abort", abort);
      resolvePromise();
    }

    function abort(): void {
      if (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN) {
        socket.close(1000, "collector stopped");
      } else {
        finish();
      }
    }

    options.signal.addEventListener("abort", abort, { once: true });

    socket.on("open", () => {
      settle(
        options.onDiagnostic(
          createDiagnostic("connection-opened", "Solana RPC WebSocket connection opened", {
            endpointLabel: options.endpointLabel ?? endpointLabelFromUrl(options.url),
            connectionEpoch,
          }),
        ),
        pending,
      );
      socket.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: requestId,
          method: "logsSubscribe",
          params: [
            { mentions: [options.programId] },
            { commitment: options.commitment },
          ],
        }),
      );
    });

    socket.on("message", (data) => {
      const receivedAtUnixMs = Date.now();
      const receivedAtIso = new Date(receivedAtUnixMs).toISOString();
      const receivedMonotonicNs = process.hrtime.bigint();
      const text = rawDataToUtf8(data);
      let payload: unknown;
      try {
        payload = JSON.parse(text) as unknown;
      } catch (error) {
        settle(
          options.onDiagnostic(
            createDiagnostic("invalid-rpc-message", "WebSocket frame was not valid JSON", {
              error: redactSecrets(error instanceof Error ? error.message : String(error), options.redactSecrets),
              byteLength: Buffer.byteLength(text),
              redactedFrameBase64: Buffer.from(redactSecrets(text, options.redactSecrets), "utf8").toString("base64"),
              connectionEpoch,
            }),
          ),
          pending,
        );
        return;
      }
      const parseCompletedAtUnixMs = Date.now();
      const parseCompletedMonotonicNs = process.hrtime.bigint();
      const reply = payload as JsonRpcReply;

      if (isRecord(reply) && reply.id === requestId) {
        if (typeof reply.result === "number") {
          settle(
            options.onDiagnostic(
              createDiagnostic("subscription-confirmed", "Pump program log subscription confirmed", {
                subscriptionId: reply.result,
                commitment: options.commitment,
                programId: options.programId,
              }),
            ),
            pending,
          );
        } else {
          settle(
            options.onDiagnostic(
              createDiagnostic("subscription-error", "RPC rejected the log subscription", {
                error: reply.error ?? "missing numeric subscription id",
              }),
            ),
            pending,
          );
          socket.close(1011, "subscription rejected");
        }
        return;
      }

      if (isRecord(reply) && reply.method === "logsNotification") {
        settle(
          options.onNotification({
            payload,
            connectionEpoch,
            clock: {
              receivedAtUnixMs,
              receivedAtIso,
              receivedMonotonicNs,
              transportParseCompletedAtUnixMs: parseCompletedAtUnixMs,
              transportParseDurationNs: parseCompletedMonotonicNs - receivedMonotonicNs,
            },
          }),
          pending,
        );
        return;
      }

      if (isRecord(reply)) {
        settle(
          options.onDiagnostic(
            createDiagnostic("unexpected-rpc-message", "WebSocket JSON-RPC message was not a logs notification", {
              method: typeof reply.method === "string" ? reply.method : null,
              hasId: "id" in reply,
              byteLength: Buffer.byteLength(text),
              payloadSha256: createHash("sha256").update(text).digest("hex"),
              rawPayload: JSON.parse(redactSecrets(text, options.redactSecrets)) as unknown,
              connectionEpoch,
            }),
          ),
          pending,
        );
      }
    });

    socket.on("error", (error) => {
      settle(
        options.onDiagnostic(
          createDiagnostic("connection-error", "Solana RPC WebSocket error", {
            error: redactSecrets(error.message, options.redactSecrets),
            connectionEpoch,
          }),
        ),
        pending,
      );
    });

    socket.on("close", (code, reason) => {
      settle(
        options.onDiagnostic(
          createDiagnostic("connection-closed", "Solana RPC WebSocket connection closed", {
            code,
            reason: redactSecrets(reason.toString("utf8"), options.redactSecrets),
            willReconnect: !options.signal.aborted,
            connectionEpoch,
          }),
        ),
        pending,
      );
      finish();
    });
  });
}

export async function subscribeToProgramLogs(options: SolanaLogsSubscriberOptions): Promise<void> {
  const initialDelay = options.initialReconnectDelayMs ?? 500;
  const maximumDelay = options.maximumReconnectDelayMs ?? 15_000;
  let reconnectDelay = initialDelay;
  const pending = new Set<Promise<void>>();
  let connectionEpoch = 0;

  while (!options.signal.aborted) {
    await runConnection(options, pending, connectionEpoch);
    if (options.signal.aborted) break;
    await delay(reconnectDelay, options.signal);
    reconnectDelay = Math.min(maximumDelay, reconnectDelay * 2);
    connectionEpoch += 1;
  }

  await Promise.allSettled([...pending]);
}
