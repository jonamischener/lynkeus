# lynkeus-client

Node driver for apps running [lynkeus-agent](../agent).

```ts
import { AgentServer } from 'lynkeus-client';

const agent = new AgentServer({ port: 8123 });
await agent.listen();
await agent.waitForApp();

await agent.call('press', { testId: 'get-started-button' });
await agent.call('waitFor', { route: 'Auth.Login' });
console.log((await agent.call('screen')).elements.length);
```

`call` is typed for the core methods and open for app commands
(`agent.call('reset')`). See [docs/PROTOCOL.md](../../docs/PROTOCOL.md).
