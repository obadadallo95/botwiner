import WebSocket, { type RawData } from "ws";
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
}

export interface SolanaLogsSubscriberOptions {
  readonly url: string;
  readonly programId: string;
  readonly commitment: Commitment;
  readonly signal: AbortSignal;
  readonly onNotification: (message: ReceivedLogsMessage) => Promise<void> | void;
  readonly onDiagnostic: (diagnostic: DiagnosticRecord) => Promise<void> | void;
  readonly initialReconnectDelayMs?: number;
  readonly maximumReconnectDelayMs?: number;
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

async function runConnection(
  options: SolanaLogsSubscriberOptions,
  pending: Set<Promise<void>>,
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
            endpointLabel: endpointLabelFromUrl(options.url),
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
              error: error instanceof Error ? error.message : String(error),
              byteLength: Buffer.byteLength(text),
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
      }
    });

    socket.on("error", (error) => {
      settle(
        options.onDiagnostic(
          createDiagnostic("connection-error", "Solana RPC WebSocket error", {
            error: error.message,
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
            reason: reason.toString("utf8"),
            willReconnect: !options.signal.aborted,
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

  while (!options.signal.aborted) {
    await runConnection(options, pending);
    if (options.signal.aborted) break;
    await delay(reconnectDelay, options.signal);
    reconnectDelay = Math.min(maximumDelay, reconnectDelay * 2);
  }

  await Promise.allSettled([...pending]);
}
