/**
 * The driver end of the link. The app dials in and keeps redialing, so the
 * server is the stable side: start it once, and every app launch reattaches.
 */
import { EventEmitter } from 'node:events';

import { WebSocket, WebSocketServer } from 'ws';

import type { AgentEvent, CoreMethods, HelloEvent, Response } from 'lynkeus-protocol';

export type { AgentEvent, CoreMethods, Element, HelloEvent, Screen, Target, RequestRecord } from 'lynkeus-protocol';

export type AgentServerOptions = {
  port?: number;
  host?: string;
  /** Must match the app's `token`; sent as the first message. */
  token?: string;
  /** How long in-flight calls wait for the app to reconnect before failing (default 2500 ms). */
  reconnectGraceMs?: number;
};

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  request: string;
};

export class AgentError extends Error {
  code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.code = code;
  }
}

export class AgentServer extends EventEmitter {
  readonly port: number;
  readonly host: string;

  #token?: string;
  #session = Math.random().toString(36).slice(2) + Date.now().toString(36);
  #server: WebSocketServer | null = null;
  #socket: WebSocket | null = null;
  #pending = new Map<number, Pending>();
  #nextId = 1;
  #hello: HelloEvent | null = null;
  #graceTimer: ReturnType<typeof setTimeout> | null = null;
  #reconnectGraceMs: number;

  constructor(options: AgentServerOptions = {}) {
    super();
    this.port = options.port ?? 8123;
    this.host = options.host ?? '127.0.0.1';
    this.#token = options.token;
    this.#reconnectGraceMs = options.reconnectGraceMs ?? 2500;
  }

  get connected(): boolean {
    return this.#socket?.readyState === WebSocket.OPEN && this.#hello !== null;
  }

  /** What the app said about itself when it attached. */
  get hello(): HelloEvent | null {
    return this.#hello;
  }

  async listen(): Promise<void> {
    if (this.#server) return;
    const server = new WebSocketServer({ port: this.port, host: this.host });
    this.#server = server;
    server.on('connection', (socket) => this.#attach(socket));
    await new Promise<void>((resolve, reject) => {
      server.once('listening', () => resolve());
      server.once('error', reject);
    });
  }

  async close(): Promise<void> {
    this.#cancelGrace();
    this.#failPending(new AgentError('Agent server closed'));
    this.#socket?.close();
    this.#socket = null;
    this.#hello = null;
    await new Promise<void>((resolve) => (this.#server ? this.#server.close(() => resolve()) : resolve()));
    this.#server = null;
  }

  async waitForApp(timeoutMs = 15_000): Promise<HelloEvent> {
    if (this.connected && this.#hello) return this.#hello;
    return new Promise<HelloEvent>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off('hello', onHello);
        reject(new AgentError(`No app attached on ${this.host}:${this.port} within ${timeoutMs}ms. Is a dev build running with <Lynkeus>?`));
      }, timeoutMs);
      const onHello = (hello: HelloEvent) => {
        clearTimeout(timer);
        resolve(hello);
      };
      this.once('hello', onHello);
    });
  }

  /** A core method, typed. */
  async call<M extends keyof CoreMethods>(method: M, params?: CoreMethods[M]['params'], timeoutMs?: number): Promise<CoreMethods[M]['result']>;
  /** An app command registered with `qa.register`. */
  async call<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T>;
  // The deadline keeps running across a reconnect: a resent request gets only the time that is left.
  async call(method: string, params?: unknown, timeoutMs = 20_000): Promise<unknown> {
    const socket = this.#socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new AgentError('No app attached');
    const id = this.#nextId++;
    const request = JSON.stringify({ id, method, params });
    const result = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new AgentError(`${method} timed out after ${timeoutMs}ms`, 'timeout'));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer, request });
    });
    socket.send(request);
    return result;
  }

  #cancelGrace(): void {
    if (this.#graceTimer) clearTimeout(this.#graceTimer);
    this.#graceTimer = null;
  }

  #failPending(error: AgentError): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }

  #attach(socket: WebSocket): void {
    // A relaunch reconnects before the old socket notices; the newest wins.
    this.#socket?.close();
    this.#socket = socket;
    this.#hello = null;
    this.#cancelGrace();
    socket.send(JSON.stringify({ event: 'auth', session: this.#session, token: this.#token }));

    socket.on('message', (data) => {
      let message: Response | AgentEvent;
      try {
        message = JSON.parse(String(data));
      } catch {
        return;
      }
      if ('event' in message) {
        if (message.event === 'hello') {
          this.#hello = message;
          // Resend what the previous socket may have dropped, but only once this one has spoken the
          // protocol: a bare local connection could be any process.
          if (socket.readyState === WebSocket.OPEN) {
            for (const pending of this.#pending.values()) socket.send(pending.request);
          }
        }
        this.emit(message.event, message);
        return;
      }
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      clearTimeout(pending.timer);
      if ('error' in message) pending.reject(new AgentError(message.error.message, message.error.code));
      else pending.resolve(message.result);
    });

    socket.on('close', () => {
      if (this.#socket !== socket) return;
      this.#socket = null;
      this.#hello = null;
      this.emit('disconnected');
      // Dev builds redial within moments: hold in-flight calls for the next hello to resend.
      if (this.#pending.size === 0) return;
      this.#graceTimer = setTimeout(() => {
        this.#graceTimer = null;
        this.#failPending(new AgentError('App disconnected mid-call', 'disconnected'));
      }, this.#reconnectGraceMs);
    });
  }
}
