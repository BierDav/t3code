import type { PrismSocket, PrismSocketFactory } from "./prismStream.ts";

type Listener = (event: { readonly data?: unknown }) => void;

/** A WebSocket the test drives: it opens, answers and closes when told to. */
export class FakePrismSocket implements PrismSocket {
  readyState = 0;
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly protocols: ReadonlyArray<string>;
  readonly sent: Array<Record<string, unknown>> = [];
  /** Answers a JSON-RPC request as it is sent; undefined leaves it unanswered. */
  answer: ((request: Record<string, unknown>) => unknown) | undefined;
  private readonly listeners = new Map<string, Array<Listener>>();

  constructor(
    url: string,
    init: { readonly protocols: ReadonlyArray<string>; readonly headers: Record<string, string> },
  ) {
    this.url = url;
    this.headers = init.headers;
    this.protocols = init.protocols;
  }

  send(data: string): void {
    const request = JSON.parse(data) as Record<string, unknown>;
    this.sent.push(request);
    const reply = this.answer?.(request);
    if (reply !== undefined) this.receive(reply);
  }

  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit("close");
  }

  addEventListener(type: "open" | "message" | "close" | "error", listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  open(): void {
    this.readyState = 1;
    this.emit("open");
  }

  receive(message: unknown): void {
    this.emit("message", { data: JSON.stringify(message) });
  }

  emitRaw(data: string): void {
    this.emit("message", { data });
  }

  private emit(type: string, event: { readonly data?: unknown } = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

/** `created` hears of each socket as the stream opens it. */
export function fakeSocketFactory(created?: (socket: FakePrismSocket) => void): {
  readonly sockets: Array<FakePrismSocket>;
  readonly factory: PrismSocketFactory;
} {
  const sockets: Array<FakePrismSocket> = [];
  return {
    sockets,
    factory: (url, init) => {
      const socket = new FakePrismSocket(url, init);
      sockets.push(socket);
      created?.(socket);
      return socket;
    },
  };
}
