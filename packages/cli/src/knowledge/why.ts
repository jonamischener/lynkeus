/**
 * The screen, the last requests and the trace after a failure, read the way a
 * person would: a dead navigator, a gone session, a 5xx, a covered target, a
 * wording difference, a screen still loading. Each rule names what to do next.
 */
import type { Element, RequestRecord, Screen, TraceEvent } from 'lynkeus-protocol';

import { pathOf } from './problems.js';

export type Evidence = {
  screen: Screen;
  requests: RequestRecord[];
  inFlight: number;
  trace?: TraceEvent[];
  /** What the failed command was looking for. */
  target?: { testId?: string; text?: string; route?: string };
};

export type Finding = { rule: string; message: string };

const fold = (t: string): string =>
  t
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();

const distance = (a: string, b: string): number => {
  const m = a.length;
  const n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n]!;
};
const similar = (a: string, b: string): boolean => {
  if (a.includes(b) || b.includes(a)) return true;
  if (a.length > 200 || b.length > 200) return false;
  return distance(a, b) <= Math.max(2, Math.floor(Math.max(a.length, b.length) * 0.25));
};

export const explain = (e: Evidence): Finding[] => {
  const out: Finding[] = [];
  const els = e.screen.elements;
  const done = e.requests.filter((r) => r.status !== undefined || r.error);
  const status = (n: number) => done.filter((r) => r.status === n);

  if (!e.screen.route && els.length === 0) {
    const crash = e.trace
      ?.slice()
      .reverse()
      .find((t) => t.kind === 'crash');
    out.push(
      crash && crash.kind === 'crash'
        ? {
            rule: 'dead-navigator',
            message: `the screen is empty and has no route: a component threw and took the tree with it — ${crash.message}${crash.stack ? `\n    ${crash.stack.split('\n').slice(1, 4).join('\n    ')}` : ''}`,
          }
        : {
            rule: 'dead-navigator',
            message: 'the screen is empty and has no route: a component threw while rendering. Reset the app and look for the render error in the host log.',
          },
    );
  }

  if (done.length && done.every((r) => r.status === 401))
    out.push({
      rule: 'session-gone',
      message: 'every request answered 401: the session is gone (a logout, a reset, or a key revoked elsewhere). Log in again.',
    });

  const forbidden = status(403);
  if (forbidden.length >= 2)
    out.push({
      rule: 'forbidden',
      message: `the backend refuses ${[...new Set(forbidden.map((r) => pathOf(r.url)))].slice(0, 3).join(', ')} with 403: an account state or a permission, not the screen. Check what the case expects of this user.`,
    });

  const five = done.find((r) => (r.status ?? 0) >= 500);
  if (five)
    out.push({
      rule: 'backend-error',
      message: `the backend answered ${five.status} on ${five.method} ${pathOf(five.url)}: a server error, not the app. Reproduce it with curl before touching the case.`,
    });

  if (status(429).length)
    out.push({
      rule: 'rate-limited',
      message: 'a request answered 429: the backend is rate limiting this client. Space the runs out or raise the limit locally.',
    });

  const stall = e.trace
    ?.slice()
    .reverse()
    .find((t) => t.kind === 'stall');
  if (stall && stall.kind === 'stall')
    out.push({
      rule: 'render-loop',
      message: `the host broke a render loop${stall.component ? ` in ${stall.component}` : ''} (${stall.renders} updates in ${stall.windowMs}ms): the screen is dead until a reset. A component whose effect and store feed each other.`,
    });

  if (e.target) {
    const { testId, text, route } = e.target;
    const match = (el: Element) => (testId && el.testId === testId) || (text && (el.text === text || el.accessibilityLabel === text));
    const found = els.find(match);
    if (found?.hidden) {
      out.push({
        rule: 'hidden',
        message: `${testId ? `#${testId}` : JSON.stringify(text)} is in the tree but not presented (${found.hidden}): it belongs to a screen the app is not showing. Close what is open, or target something inside it.`,
      });
    }
    if (found?.covered)
      out.push({
        rule: 'covered',
        message: `${testId ? `#${testId}` : JSON.stringify(text)} is on the screen but covered: a sheet or overlay is over it. Close it, or press what covers it.`,
      });
    if (found && !found.enabled)
      out.push({
        rule: 'disabled',
        message: `${testId ? `#${testId}` : JSON.stringify(text)} is on the screen but disabled: a form is not valid yet, or a request it depends on is in flight.`,
      });
    if (!found && text) {
      const want = fold(text);
      const near = els
        .map((el) => el.text ?? el.accessibilityLabel)
        .filter((t): t is string => !!t)
        .find((t) => similar(fold(t), want));
      if (near && near !== text)
        out.push({ rule: 'near-match', message: `the text is not there, but ${JSON.stringify(near)} is: a wording, accent or case difference?` });
      const listed = els.filter((el) => el.testId && /-\d+-item$/.test(el.testId));
      const prefix = want.slice(0, 4);
      if (listed.length >= 10 && prefix && listed.filter((el) => fold(el.text ?? '').includes(prefix)).length >= listed.length / 2)
        out.push({
          rule: 'capped-list',
          message: `the list shows ${listed.length} near matches and yours is not among them: the data has accumulated look-alikes and the list is capped. Search by something unique, or reset the data.`,
        });
    }
    if (route && e.screen.route && e.screen.route !== route) {
      const recent =
        e.trace
          ?.filter((t) => t.kind === 'route')
          .slice(-3)
          .map((t) => (t.kind === 'route' ? t.route : undefined))
          .filter(Boolean) ?? [];
      if (recent.includes(route))
        out.push({
          rule: 'route-left',
          message: `the app was on ${route} and moved to ${e.screen.route}: something navigated after the step (a redirect, a gate, a modal). The trace shows the order.`,
        });
    }
  }

  if (e.inFlight > 0)
    out.push({
      rule: 'in-flight',
      message: `${e.inFlight} request(s) still in flight when the command gave up: the screen had not finished loading. A longer timeout, or wait for the request it needs.`,
    });

  if (done.length === 0 && e.inFlight === 0 && e.target?.route)
    out.push({
      rule: 'no-requests',
      message: 'no request left the app while this ran: nothing was fetched. Is the user logged in, and is the app talking to the backend it should?',
    });

  // Hosts the sandbox refuses are usually third parties nobody needs: named only when nothing else explains it.
  const refused = done.filter((r) => r.status === 0 && r.error && /networkHosts|is off/.test(r.error));
  if (refused.length && e.target && out.length === 0)
    out.push({
      rule: 'host-refused',
      message: `${refused.length} request(s) were refused by the host (${[...new Set(refused.map((r) => r.url.replace(/^https?:\/\//, '').split('/')[0]))].slice(0, 3).join(', ')}): if the screen needs one of them, allow the host in networkHosts or mock it.`,
    });

  const lastCommand = e.trace
    ?.slice()
    .reverse()
    .find((t) => t.kind === 'command' && t.error);
  if (lastCommand && lastCommand.kind === 'command' && out.length === 0)
    out.push({ rule: 'last-error', message: `the last command that failed was ${lastCommand.method}: ${lastCommand.error}` });

  return out;
};

export const describeWhy = (findings: Finding[]): string =>
  findings.length
    ? findings.map((f) => `  • ${f.message}`).join('\n')
    : '  (nothing in the evidence explains it: the screen, requests and trace look ordinary)';
