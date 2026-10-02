import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import { WebSocket } from 'ws';

import { AgentError, AgentServer } from '../index.js';

let port = 18_500;
const servers: AgentServer[] = [];
after(async () => {
  for (const s of servers) await s.close();
});

const serve = async (options: ConstructorParameters<typeof AgentServer>[0] = {}) => {
  const server = new AgentServer({ port: port++, ...options });
  servers.push(server);
  await server.listen();
  return server;
};

type Message = { event?: string; token?: string; id?: number; method?: string };

const fakeApp = async (server: AgentServer, answer: (m: Message) => unknown = () => ({ ok: true })) => {
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}`);
  const seen: Message[] = [];
  socket.on('message', (data) => {
    const m = JSON.parse(String(data)) as Message;
    seen.push(m);
    if (m.event === 'auth') socket.send(JSON.stringify({ event: 'hello', protocolVersion: 1, platform: 'ios', native: false, commands: [] }));
    else if (m.id !== undefined) {
      const reply = answer(m);
      if (reply !== undefined) socket.send(JSON.stringify({ id: m.id, ...(reply as object) }));
    }
  });
  await new Promise((r) => socket.once('open', r));
  return { socket, seen };
};

test('an app that dials in is sent the token first and is ready once it says hello', async () => {
  const server = await serve({ token: 'secret' });
  const app = await fakeApp(server);
  const hello = await server.waitForApp(2000);
  assert.equal(hello.platform, 'ios');
  assert.equal(server.connected, true);
  assert.equal(app.seen[0]?.event, 'auth');
  assert.equal(app.seen[0]?.token, 'secret');
  app.socket.close();
});

test('a call gets the result the app sends back, and an error as an AgentError with its code', async () => {
  const server = await serve();
  const app = await fakeApp(server, (m) => (m.method === 'ping' ? { result: { pong: true } } : { error: { message: 'Unknown method', code: 'unknown' } }));
  await server.waitForApp(2000);
  assert.deepEqual(await server.call('ping'), { pong: true });
  await assert.rejects(server.call('nope'), (e: unknown) => e instanceof AgentError && e.code === 'unknown');
  app.socket.close();
});

test('a call the app never answers times out with the timeout code', async () => {
  const server = await serve();
  const app = await fakeApp(server, () => undefined);
  await server.waitForApp(2000);
  await assert.rejects(server.call('screen', undefined, 100), (e: unknown) => e instanceof AgentError && e.code === 'timeout');
  app.socket.close();
});

test('with no app attached, waiting says so and a call refuses at once', async () => {
  const server = await serve();
  await assert.rejects(server.waitForApp(50), /No app attached/);
  await assert.rejects(server.call('ping'), /No app attached/);
});

test('a call in flight when the app drops is resent to the app that comes back', async () => {
  const server = await serve({ reconnectGraceMs: 1000 });
  const first = await fakeApp(server, () => undefined);
  await server.waitForApp(2000);
  const pending = server.call('screen', undefined, 3000);
  await new Promise((r) => setTimeout(r, 50));
  first.socket.close();
  const second = await fakeApp(server, () => ({ result: { route: 'Settings.Main' } }));
  assert.deepEqual(await pending, { route: 'Settings.Main' });
  second.socket.close();
});

test('a call in flight fails as disconnected when the app does not come back in time', async () => {
  const server = await serve({ reconnectGraceMs: 100 });
  const app = await fakeApp(server, () => undefined);
  await server.waitForApp(2000);
  const pending = server.call('screen', undefined, 3000);
  await new Promise((r) => setTimeout(r, 50));
  app.socket.close();
  await assert.rejects(pending, (e: unknown) => e instanceof AgentError && e.code === 'disconnected');
});
