import type { RequestRecord, Screen } from 'lynkeus-protocol';

export const withoutHost = (url: string) => url.replace(/^https?:\/\/[^/]+/, '');

export const pathOf = (url: string) => withoutHost(url).split('?')[0]!;

/** What a person would call broken on a screen: nothing on it, the app's own error copy, a request that failed. */
export const problemsOf = (screen: Screen, requests: RequestRecord[], errorCopy?: RegExp): string[] => [
  ...(screen.elements.length === 0 ? ['blank screen'] : []),
  ...screen.elements.flatMap((e) => (errorCopy && e.kind === 'text' && e.text && errorCopy.test(e.text) ? [`copy: ${e.text.slice(0, 80)}`] : [])),
  ...requests.filter((r) => (r.status ?? 0) >= 500 || r.error).map((r) => `${r.status ?? 'ERR'} ${r.method} ${withoutHost(r.url)}`),
];
