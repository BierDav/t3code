import { describe, expect, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";

import {
  openPrismStream,
  PRISM_METHOD_SYNC,
  PRISM_METHOD_UPDATE,
  PRISM_STREAM_SUBPROTOCOL,
  type PrismStreamError,
  prismStreamUrl,
} from "./prismStream.ts";
import { type FakePrismSocket, fakeSocketFactory } from "./prismStream.testkit.ts";

type StreamEvent =
  | { readonly kind: "open" | "error" }
  | { readonly kind: "update"; readonly value: unknown };

/** The call's failure, or null when it answered. */
const failureOf = <A>(effect: Effect.Effect<A, PrismStreamError>) =>
  effect.pipe(Effect.match({ onFailure: (error) => error, onSuccess: () => null }));

const open = Effect.gen(function* () {
  const created = yield* Queue.unbounded<FakePrismSocket>();
  const events = yield* Queue.unbounded<StreamEvent>();
  const { factory } = fakeSocketFactory((socket) => {
    Queue.offerUnsafe(created, socket);
  });
  const scope = yield* Scope.make();
  const stream = yield* openPrismStream({
    baseUrl: "https://prism.example.test/",
    token: Effect.succeed(" machine-token\n"),
    onUpdate: (value) => Queue.offer(events, { kind: "update", value }).pipe(Effect.asVoid),
    onOpen: Queue.offer(events, { kind: "open" }).pipe(Effect.asVoid),
    onError: () => Queue.offer(events, { kind: "error" }).pipe(Effect.asVoid),
    socketFactory: factory,
    reconnectDelay: () => Duration.seconds(1),
  }).pipe(Scope.provide(scope));
  const socket = yield* Queue.take(created);
  return { created, events, scope, socket, stream };
});

describe("prismStreamUrl", () => {
  it("speaks WebSocket on Prism's own origin", () => {
    expect(prismStreamUrl("https://prism-events.example.test/")).toBe(
      "wss://prism-events.example.test/v1/placement/stream",
    );
    expect(prismStreamUrl("http://127.0.0.1:8080")).toBe("ws://127.0.0.1:8080/v1/placement/stream");
  });
});

describe("openPrismStream", () => {
  it.effect("connects with the machine token and answers a sync over JSON-RPC", () =>
    Effect.gen(function* () {
      const { events, scope, socket, stream } = yield* open;
      expect(socket.url).toBe("wss://prism.example.test/v1/placement/stream");
      expect(socket.protocols).toEqual([PRISM_STREAM_SUBPROTOCOL]);
      expect(socket.headers).toEqual({ authorization: "Bearer machine-token" });

      // Not connected yet: the caller falls back to HTTP at once.
      const early = yield* failureOf(stream.call({ v: 1 }));
      expect(early?.message).toBe("The Prism stream is not connected.");

      socket.answer = (request) => ({ jsonrpc: "2.0", id: request.id, result: { v: 1, ok: true } });
      socket.open();
      expect(yield* Queue.take(events)).toEqual({ kind: "open" });
      expect(stream.isOpen()).toBe(true);
      const result = yield* stream.call({ v: 1, threads: [] });
      expect(result).toEqual({ v: 1, ok: true });
      expect(socket.sent[0]).toMatchObject({
        jsonrpc: "2.0",
        method: PRISM_METHOD_SYNC,
        params: { v: 1, threads: [] },
      });

      socket.answer = (request) => ({
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32000, message: "Placement sync failed; try again." },
      });
      const refused = yield* failureOf(stream.call({ v: 1 }));
      expect(refused).toMatchObject({ message: "Placement sync failed; try again.", code: -32000 });

      yield* Scope.close(scope, Exit.void);
      expect(socket.readyState).toBe(3);
    }),
  );

  it.effect("hands Prism's pushed updates on and ignores what it cannot read", () =>
    Effect.gen(function* () {
      const { events, scope, socket } = yield* open;
      socket.open();
      expect(yield* Queue.take(events)).toEqual({ kind: "open" });
      socket.emitRaw("not json");
      socket.receive({ jsonrpc: "2.0", id: 99, result: {} });
      socket.receive({ jsonrpc: "2.0", method: PRISM_METHOD_UPDATE, params: { v: 1, moves: [] } });
      expect(yield* Queue.take(events)).toEqual({ kind: "update", value: { v: 1, moves: [] } });
      yield* Scope.close(scope, Exit.void);
    }),
  );

  it.effect("fails a call that is waiting when the connection drops, then reconnects", () =>
    Effect.gen(function* () {
      const { created, events, scope, socket, stream } = yield* open;
      socket.open();
      expect(yield* Queue.take(events)).toEqual({ kind: "open" });
      const sent = yield* Queue.unbounded<unknown>();
      socket.answer = (request) => {
        Queue.offerUnsafe(sent, request);
        return undefined;
      };
      const waiting = yield* Effect.forkChild(failureOf(stream.call({ v: 1 })));
      yield* Queue.take(sent);
      socket.close();
      const lost = yield* Fiber.join(waiting);
      expect(lost?.message).toBe("The Prism stream closed.");
      expect(stream.isOpen()).toBe(false);
      expect(yield* Queue.take(events)).toEqual({ kind: "error" });

      yield* TestClock.adjust(Duration.seconds(1));
      const again = yield* Queue.take(created);
      again.open();
      expect(yield* Queue.take(events)).toEqual({ kind: "open" });
      expect(stream.isOpen()).toBe(true);
      yield* Scope.close(scope, Exit.void);
    }),
  );

  it.effect("replaces a socket that stays open without answering a sync", () =>
    Effect.gen(function* () {
      const { created, events, scope, socket, stream } = yield* open;
      socket.open();
      expect(yield* Queue.take(events)).toEqual({ kind: "open" });

      const sent = yield* Queue.unbounded<unknown>();
      socket.answer = (request) => {
        Queue.offerUnsafe(sent, request);
        return undefined;
      };
      const waiting = yield* Effect.forkChild(failureOf(stream.call({ v: 1 })));
      yield* Queue.take(sent);
      yield* TestClock.adjust(Duration.seconds(20));
      expect((yield* Fiber.join(waiting))?.message).toBe("Prism did not answer the sync in time.");
      expect(yield* Queue.take(events)).toEqual({ kind: "error" });
      expect(stream.isOpen()).toBe(false);

      yield* TestClock.adjust(Duration.seconds(1));
      const again = yield* Queue.take(created);
      again.open();
      expect(yield* Queue.take(events)).toEqual({ kind: "open" });
      again.answer = (request) => ({ jsonrpc: "2.0", id: request.id, result: { v: 1 } });
      expect(yield* stream.call({ v: 1 })).toEqual({ v: 1 });
      yield* Scope.close(scope, Exit.void);
    }),
  );
});
