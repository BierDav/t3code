/**
 * Placement sync over a WebSocket to Prism (`GET /v1/placement/stream`), JSON-RPC 2.0:
 * `placement.sync` is the POST's body and answer; Prism pushes a changed answer as
 * `placement.update`. While the connection is down, `call` fails and the worker uses HTTP.
 */
import * as NodeModule from "node:module";

import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import type * as Undici from "undici";

// undici is external to the CLI bundle; Node single-executables can load it from disk only with require.
const requireUndici = NodeModule.createRequire(import.meta.url);

export const PRISM_STREAM_SUBPROTOCOL = "jsonrpc-2.0";
export const PRISM_METHOD_SYNC = "placement.sync";
export const PRISM_METHOD_UPDATE = "placement.update";

const CALL_TIMEOUT = Duration.seconds(20);
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const OPEN = 1;

export class PrismStreamError extends Schema.TaggedError<PrismStreamError>()("PrismStreamError", {
  message: Schema.String,
  code: Schema.optional(Schema.Number),
}) {}

/** The part of a WebSocket the stream uses; undici's (and the browser's) fits. */
export interface PrismSocket {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(
    type: "open" | "message" | "close" | "error",
    listener: (event: { readonly data?: unknown }) => void,
  ): void;
}

export type PrismSocketFactory = (
  url: string,
  init: { readonly protocols: ReadonlyArray<string>; readonly headers: Record<string, string> },
) => PrismSocket;

const undiciSocket: PrismSocketFactory = (url, init) =>
  new (requireUndici("undici") as typeof Undici).WebSocket(url, {
    protocols: [...init.protocols],
    headers: init.headers,
  }) as unknown as PrismSocket;

export function prismStreamUrl(baseUrl: string): string {
  const url = new URL(`${baseUrl.replace(/\/+$/, "")}/v1/placement/stream`);
  if (url.protocol === "https:") url.protocol = "wss:";
  else if (url.protocol === "http:") url.protocol = "ws:";
  return url.toString();
}

/** 1 s, 2 s, 4 s … up to 30 s between attempts. */
const defaultReconnectDelay = (attempt: number) =>
  Duration.millis(Math.min(30_000, 1_000 * 2 ** attempt));

export interface PrismStream {
  readonly isOpen: () => boolean;
  /** `placement.sync`: Prism's answer, or a failure while the connection is down. */
  readonly call: (params: unknown) => Effect.Effect<unknown, PrismStreamError>;
}

export interface PrismStreamOptions {
  /** Prism's base URL, as `placementSource.url` (`https://…`). */
  readonly baseUrl: string;
  /** The machine token, read again for every connection. */
  readonly token: Effect.Effect<string, PrismStreamError>;
  /** Prism's answer changed: the `params` of `placement.update`. */
  readonly onUpdate: (response: unknown) => Effect.Effect<void>;
  /** A connection opened; Prism knows nothing of this host until the next sync. */
  readonly onOpen: Effect.Effect<void>;
  readonly onError: (cause: unknown) => Effect.Effect<void>;
  readonly socketFactory?: PrismSocketFactory | undefined;
  readonly reconnectDelay?: ((attempt: number) => Duration.Duration) | undefined;
}

type SocketEvent =
  | { readonly type: "open" }
  | { readonly type: "message"; readonly data: unknown }
  | { readonly type: "closed"; readonly failed: boolean };

interface RpcMessage {
  readonly id?: unknown;
  readonly method?: unknown;
  readonly params?: unknown;
  readonly result?: unknown;
  readonly error?: { readonly code?: unknown; readonly message?: unknown };
}

function parseMessage(data: unknown): RpcMessage | null {
  try {
    const value: unknown = JSON.parse(typeof data === "string" ? data : String(data));
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as RpcMessage)
      : null;
  } catch {
    return null;
  }
}

/** Connects to Prism in the current scope; closing the scope closes the connection. */
export const openPrismStream = Effect.fn("placement.openPrismStream")(function* (
  options: PrismStreamOptions,
): Effect.fn.Return<PrismStream, never, Scope.Scope> {
  let connection: {
    readonly socket: PrismSocket;
    readonly events: Queue.Queue<SocketEvent>;
  } | null = null;
  let nextId = 1;
  const calls = new Map<number, Deferred.Deferred<unknown, PrismStreamError>>();
  const failCalls = (message: string) =>
    Effect.forEach(
      [...calls.entries()],
      ([id, deferred]) => {
        calls.delete(id);
        return Deferred.fail(deferred, new PrismStreamError({ message }));
      },
      { discard: true },
    );
  const isOpen = () => connection?.socket.readyState === OPEN;

  const receive = Effect.fnUntraced(function* (data: unknown) {
    const message = parseMessage(data);
    if (message === null) return;
    if (message.method === PRISM_METHOD_UPDATE && message.id === undefined) {
      yield* options.onUpdate(message.params);
      return;
    }
    if (typeof message.id !== "number") return;
    const deferred = calls.get(message.id);
    if (deferred === undefined) return;
    calls.delete(message.id);
    const error = message.error;
    if (error !== undefined) {
      yield* Deferred.fail(
        deferred,
        new PrismStreamError({
          message: typeof error.message === "string" ? error.message : "Prism refused the sync.",
          ...(typeof error.code === "number" ? { code: error.code } : {}),
        }),
      );
    } else {
      yield* Deferred.succeed(deferred, message.result);
    }
  });

  /** One connection, until it closes. True when it opened. */
  const connectOnce = Effect.fnUntraced(function* () {
    const token = (yield* options.token).trim();
    const events = yield* Queue.unbounded<SocketEvent>();
    const opened = yield* Effect.try({
      try: () =>
        (options.socketFactory ?? undiciSocket)(prismStreamUrl(options.baseUrl), {
          protocols: [PRISM_STREAM_SUBPROTOCOL],
          headers: token.length > 0 ? { authorization: `Bearer ${token}` } : {},
        }),
      catch: (cause) =>
        new PrismStreamError({ message: `Connecting to Prism failed: ${String(cause)}` }),
    });
    opened.addEventListener("open", () => {
      Queue.offerUnsafe(events, { type: "open" });
    });
    opened.addEventListener("message", (event) => {
      Queue.offerUnsafe(events, { type: "message", data: event.data });
    });
    opened.addEventListener("close", () => {
      Queue.offerUnsafe(events, { type: "closed", failed: false });
    });
    opened.addEventListener("error", () => {
      Queue.offerUnsafe(events, { type: "closed", failed: true });
    });
    connection = { socket: opened, events };
    let wasOpen = false;
    return yield* Effect.gen(function* () {
      for (;;) {
        const event = yield* wasOpen
          ? Queue.take(events)
          : Queue.take(events).pipe(
              Effect.timeoutOrElse({
                duration: CALL_TIMEOUT,
                orElse: () =>
                  Effect.fail(
                    new PrismStreamError({ message: "Prism did not open the stream in time." }),
                  ),
              }),
            );
        if (event.type === "open") {
          wasOpen = true;
          yield* options.onOpen;
        } else if (event.type === "message") {
          yield* receive(event.data);
        } else {
          connection = null;
          yield* options.onError(
            new PrismStreamError({
              message: event.failed ? "The Prism stream failed." : "The Prism stream closed.",
            }),
          );
          return wasOpen;
        }
      }
    }).pipe(
      Effect.ensuring(
        Effect.suspend(() => {
          connection = null;
          try {
            opened.close(1000, "closing");
          } catch {
            // Already closed.
          }
          return failCalls("The Prism stream closed.");
        }),
      ),
    );
  });

  const reconnectDelay = options.reconnectDelay ?? defaultReconnectDelay;
  let attempt = 0;
  yield* Effect.forkScoped(
    Effect.forever(
      Effect.gen(function* () {
        const wasOpen = yield* connectOnce().pipe(
          Effect.catchCause((cause) => options.onError(cause).pipe(Effect.as(false))),
        );
        attempt = wasOpen ? 0 : attempt + 1;
        yield* Effect.sleep(reconnectDelay(attempt));
      }),
    ),
  );

  const call = Effect.fn("PrismStream.call")(function* (params: unknown) {
    const current = connection;
    if (current === null || current.socket.readyState !== OPEN) {
      return yield* new PrismStreamError({ message: "The Prism stream is not connected." });
    }
    const id = nextId++;
    const deferred = yield* Deferred.make<unknown, PrismStreamError>();
    calls.set(id, deferred);
    return yield* encodeJson({ jsonrpc: "2.0", id, method: PRISM_METHOD_SYNC, params }).pipe(
      Effect.mapError(
        (cause) => new PrismStreamError({ message: `Encoding the sync failed: ${cause.message}` }),
      ),
      Effect.flatMap((frame) =>
        Effect.try({
          try: () => current.socket.send(frame),
          catch: (cause) =>
            new PrismStreamError({ message: `Sending to Prism failed: ${String(cause)}` }),
        }).pipe(
          Effect.tapError(() => Queue.offer(current.events, { type: "closed", failed: true })),
        ),
      ),
      Effect.andThen(Deferred.await(deferred)),
      Effect.timeoutOrElse({
        duration: CALL_TIMEOUT,
        orElse: () =>
          Queue.offer(current.events, { type: "closed", failed: true }).pipe(
            Effect.andThen(
              Effect.fail(
                new PrismStreamError({ message: "Prism did not answer the sync in time." }),
              ),
            ),
          ),
      }),
      Effect.ensuring(Effect.sync(() => calls.delete(id))),
    );
  });

  return { isOpen, call };
});
