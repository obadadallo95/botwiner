import YellowstoneClientModule, {
  CommitmentLevel,
  type SubscribeRequest,
  type SubscribeUpdate,
  txErrDecode,
} from "@triton-one/yellowstone-grpc";
import { encodeBase58 } from "@botwiner/pumpfun";
import {
  createDiagnostic,
  type Commitment,
  type DiagnosticRecord,
} from "@botwiner/market-data";
import { redactSecrets, type ReceiveClock } from "./index.js";

const YellowstoneClient = YellowstoneClientModule as unknown as new (
  endpoint: string,
  token: string | undefined,
) => YellowstoneClientLike;

export interface ReceivedGrpcMessage {
  readonly payload: {
    readonly slot: number;
    readonly signature: string;
    readonly isVote: boolean;
    readonly err: unknown;
    readonly logs: readonly string[];
    readonly accountKeys?: readonly string[] | undefined;
    readonly index?: number | undefined;
  };
  readonly clock: ReceiveClock;
  readonly connectionEpoch: number;
}

export interface YellowstoneDuplexStreamLike {
  on(event: "data", listener: (chunk: unknown) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: "end", listener: () => void): this;
  on(event: "close", listener: () => void): this;
  pause(): this;
  resume(): this;
  end(): void;
  destroy(error?: Error): this;
}

export interface YellowstoneClientLike {
  connect(): Promise<void>;
  subscribe(request?: SubscribeRequest): Promise<YellowstoneDuplexStreamLike>;
}

export interface YellowstoneSubscriberOptions {
  readonly endpoint: string;
  readonly token?: string | undefined;
  readonly programId: string;
  readonly commitment: Commitment;
  readonly signal: AbortSignal;
  readonly onNotification: (message: ReceivedGrpcMessage) => Promise<void> | void;
  readonly onDiagnostic: (diagnostic: DiagnosticRecord) => Promise<void> | void;
  readonly endpointLabel?: string | undefined;
  readonly redactSecrets?: readonly string[] | undefined;
  readonly initialReconnectDelayMs?: number | undefined;
  readonly maximumReconnectDelayMs?: number | undefined;
  readonly maxInFlight?: number | undefined;
  readonly resumeThreshold?: number | undefined;
  readonly clientFactory?: ((endpoint: string, token: string | undefined) => YellowstoneClientLike) | undefined;
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

function commitmentToYellowstone(commitment: Commitment): CommitmentLevel {
  switch (commitment) {
    case "confirmed":
      return CommitmentLevel.CONFIRMED;
    case "finalized":
      return CommitmentLevel.FINALIZED;
    case "processed":
    default:
      return CommitmentLevel.PROCESSED;
  }
}

function safeDecodeError(err: unknown): unknown {
  if (err === null || err === undefined) return null;
  try {
    const decoded = txErrDecode.decode(err as Parameters<typeof txErrDecode.decode>[0]);
    return decoded ?? err;
  } catch {
    return err;
  }
}

async function runYellowstoneConnection(
  options: YellowstoneSubscriberOptions,
  pending: Set<Promise<void>>,
  connectionEpoch: number,
): Promise<void> {
  const endpointLabel = options.endpointLabel ?? "yellowstone-grpc";
  const secrets = options.redactSecrets ?? [];
  const maxInFlight = options.maxInFlight ?? 200;
  const resumeThreshold = options.resumeThreshold ?? 50;

  const client: YellowstoneClientLike =
    options.clientFactory !== undefined
      ? options.clientFactory(options.endpoint, options.token)
      : new YellowstoneClient(options.endpoint, options.token);

  try {
    await client.connect();
  } catch (error) {
    settle(
      options.onDiagnostic(
        createDiagnostic("connection-error", "Yellowstone gRPC client connect failed", {
          error: redactSecrets(error instanceof Error ? error.message : String(error), secrets),
          endpointLabel,
          connectionEpoch,
        }),
      ),
      pending,
    );
    return;
  }

  if (options.signal.aborted) return;

  const subscribeRequest: SubscribeRequest = {
    accounts: {},
    slots: {},
    transactions: {
      pumpfun: {
        vote: false,
        failed: true,
        signature: undefined,
        accountInclude: [options.programId],
        accountExclude: [],
        accountRequired: [],
      },
    },
    transactionsStatus: {},
    blocks: {},
    blocksMeta: {},
    entry: {},
    commitment: commitmentToYellowstone(options.commitment),
    accountsDataSlice: [],
  };

  let stream: YellowstoneDuplexStreamLike;
  try {
    stream = await client.subscribe(subscribeRequest);
  } catch (error) {
    settle(
      options.onDiagnostic(
        createDiagnostic("subscription-error", "Yellowstone gRPC subscribe call failed", {
          error: redactSecrets(error instanceof Error ? error.message : String(error), secrets),
          endpointLabel,
          connectionEpoch,
        }),
      ),
      pending,
    );
    return;
  }

  settle(
    options.onDiagnostic(
      createDiagnostic("connection-opened", "Yellowstone gRPC stream opened", {
        endpointLabel,
        connectionEpoch,
      }),
    ),
    pending,
  );

  settle(
    options.onDiagnostic(
      createDiagnostic("subscription-confirmed", "Yellowstone Pump.fun transaction filter subscription active", {
        commitment: options.commitment,
        programId: options.programId,
        includeFailed: true,
        excludeVote: true,
        connectionEpoch,
      }),
    ),
    pending,
  );

  return new Promise<void>((resolvePromise) => {
    let settled = false;
    let inFlight = 0;
    let isPaused = false;

    function finish(): void {
      if (settled) return;
      settled = true;
      options.signal.removeEventListener("abort", abort);
      resolvePromise();
    }

    function abort(): void {
      try {
        stream.end();
        stream.destroy();
      } catch {
        // Stream already destroyed
      }
      finish();
    }

    if (options.signal.aborted) {
      abort();
      return;
    }

    options.signal.addEventListener("abort", abort, { once: true });

    stream.on("data", (data: unknown) => {
      // 1. IMMEDIATE ARRIVAL TIMING AT CALLBACK BOUNDARY BEFORE ANY PARSING
      const receivedAtUnixMs = Date.now();
      const receivedAtIso = new Date(receivedAtUnixMs).toISOString();
      const receivedMonotonicNs = process.hrtime.bigint();

      const update = data as SubscribeUpdate | undefined;
      if (update === undefined || update === null) return;

      if (update.transaction === undefined || update.transaction.transaction === undefined) {
        // Other stream update type (ping/pong, slot, blockMeta, etc.)
        return;
      }

      const txRecord = update.transaction;
      const txInfo = txRecord.transaction;
      if (txInfo === undefined) return;

      const slot = Number(txRecord.slot);
      const isVote = txInfo.isVote;
      const signature =
        typeof txInfo.signature === "string"
          ? txInfo.signature
          : encodeBase58(txInfo.signature);

      const err = safeDecodeError(txInfo.meta?.err);
      const logs = txInfo.meta?.logMessages ?? [];
      const index = txInfo.index !== undefined && txInfo.index !== "" ? Number(txInfo.index) : undefined;

      const accountKeys: string[] = [];
      if (txInfo.transaction?.message?.accountKeys) {
        for (const key of txInfo.transaction.message.accountKeys) {
          accountKeys.push(encodeBase58(key));
        }
      }
      if (txInfo.meta?.loadedWritableAddresses) {
        for (const key of txInfo.meta.loadedWritableAddresses) {
          accountKeys.push(encodeBase58(key));
        }
      }
      if (txInfo.meta?.loadedReadonlyAddresses) {
        for (const key of txInfo.meta.loadedReadonlyAddresses) {
          accountKeys.push(encodeBase58(key));
        }
      }

      const transportParseCompletedAtUnixMs = Date.now();
      const transportParseDurationNs = process.hrtime.bigint() - receivedMonotonicNs;

      const clock: ReceiveClock = {
        receivedAtUnixMs,
        receivedAtIso,
        receivedMonotonicNs,
        transportParseCompletedAtUnixMs,
        transportParseDurationNs,
      };

      inFlight += 1;
      if (inFlight >= maxInFlight && !isPaused) {
        isPaused = true;
        stream.pause();
        settle(
          options.onDiagnostic(
            createDiagnostic("grpc-backpressure-warning", "Yellowstone stream paused: write backlog above threshold", {
              action: "pause",
              inFlight,
              threshold: maxInFlight,
              connectionEpoch,
            }),
          ),
          pending,
        );
      }

      const notificationPromise = Promise.resolve(
        options.onNotification({
          payload: {
            slot,
            signature,
            isVote,
            err,
            logs,
            accountKeys: accountKeys.length > 0 ? accountKeys : undefined,
            index,
          },
          clock,
          connectionEpoch,
        }),
      ).finally(() => {
        inFlight = Math.max(0, inFlight - 1);
        if (isPaused && inFlight <= resumeThreshold) {
          isPaused = false;
          stream.resume();
          settle(
            options.onDiagnostic(
              createDiagnostic("grpc-backpressure-warning", "Yellowstone stream resumed: write backlog drained", {
                action: "resume",
                inFlight,
                resumeThreshold,
                connectionEpoch,
              }),
            ),
            pending,
          );
        }
      });

      settle(notificationPromise, pending);
    });

    stream.on("error", (error: Error) => {
      settle(
        options.onDiagnostic(
          createDiagnostic("grpc-stream-error", "Yellowstone gRPC stream error", {
            error: redactSecrets(error.message, secrets),
            connectionEpoch,
          }),
        ),
        pending,
      );
    });

    stream.on("end", () => {
      settle(
        options.onDiagnostic(
          createDiagnostic("connection-closed", "Yellowstone gRPC stream ended", {
            reason: "stream end event",
            willReconnect: !options.signal.aborted,
            connectionEpoch,
          }),
        ),
        pending,
      );
      finish();
    });

    stream.on("close", () => {
      settle(
        options.onDiagnostic(
          createDiagnostic("connection-closed", "Yellowstone gRPC stream closed", {
            reason: "stream close event",
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

export async function subscribeToYellowstone(options: YellowstoneSubscriberOptions): Promise<void> {
  const initialDelay = options.initialReconnectDelayMs ?? 500;
  const maximumDelay = options.maximumReconnectDelayMs ?? 15_000;
  let reconnectDelay = initialDelay;
  const pending = new Set<Promise<void>>();
  let connectionEpoch = 0;

  while (!options.signal.aborted) {
    await runYellowstoneConnection(options, pending, connectionEpoch);
    if (options.signal.aborted) break;
    await delay(reconnectDelay, options.signal);
    reconnectDelay = Math.min(maximumDelay, reconnectDelay * 2);
    connectionEpoch += 1;
  }

  await Promise.allSettled([...pending]);
}
