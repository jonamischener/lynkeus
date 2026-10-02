/** What a person would flag in review, read off one screen: not accessibility certification, the usual suspects. */
import type { Screen } from 'lynkeus-protocol';

export type Finding = { rule: string; severity: 'warn' | 'info'; element: number; message: string };

const DEFAULT_I18N_KEY_PATTERNS = [/^[a-z][a-z0-9]*(\.[a-z0-9]+){2,}$/i, /^[a-z0-9]+(_[a-z0-9]+){2,}$/i];

const looksLikeI18nKey = (t: string, patterns: RegExp[]): boolean => {
  const s = t.trim();
  if (patterns.length === 0) return false;
  if (s.length < 4 || /\s/.test(s)) return false;
  if (/^https?:|^[@#$]|^\+?\d[\d\s.,-]*$/.test(s)) return false;
  return patterns.some((p) => p.test(s));
};

// Points: what both platforms' guidelines ask for.
const MIN_TOUCH = 44;
const label = (e: Screen['elements'][number]) => e.testId ?? e.text ?? e.accessibilityLabel;

type LintOptions = {
  /** What an untranslated key looks like (default `a.b.c` and `snake_case_key`); `[]` turns the rule off. */
  i18nKeyPatterns?: RegExp[];
  minTouchTarget?: number;
};

export const lintScreen = (screen: Screen, options: LintOptions = {}): Finding[] => {
  const minTouch = options.minTouchTarget ?? MIN_TOUCH;
  const out: Finding[] = [];
  const els = (screen.elements ?? []).filter((e) => !e.hidden);
  const win = screen.window ?? { w: 0, h: 0 };
  for (const e of els) {
    const named = e.text ?? e.accessibilityLabel;
    if ((e.kind === 'button' || e.kind === 'switch') && named === undefined && e.testId === undefined) {
      out.push({ rule: 'unlabeled-control', severity: 'warn', element: e.i, message: `${e.kind} with no text, label or testId` });
    }
    if ((e.kind === 'button' || e.kind === 'switch') && e.enabled !== false && e.frame) {
      const { w, h } = e.frame;
      // A control with text is usually measured at its label, not its touchable area (a tab bar item): only info.
      if (w > 0 && h > 0 && (w < minTouch || h < minTouch)) {
        const iconOnly = e.text === undefined && e.accessibilityLabel === undefined;
        out.push({
          rule: 'small-target',
          severity: iconOnly ? 'warn' : 'info',
          element: e.i,
          message: `${Math.round(w)}×${Math.round(h)}pt target (< ${minTouch}) ${label(e) ?? ''}`.trim(),
        });
      }
    }
    if (e.kind === 'text' && e.text && looksLikeI18nKey(e.text, options.i18nKeyPatterns ?? DEFAULT_I18N_KEY_PATTERNS)) {
      out.push({ rule: 'untranslated', severity: 'warn', element: e.i, message: `"${e.text}" looks like an i18n key, not copy` });
    }
    if ((e.kind === 'button' || e.kind === 'input' || e.kind === 'switch') && e.covered && e.enabled !== false) {
      out.push({
        rule: 'covered-control',
        severity: 'info',
        element: e.i,
        message: `${e.kind} ${label(e) ?? ''} is covered; a tap would not reach it`.replace('  ', ' ').trim(),
      });
    }
    if (e.frame && win.w > 0 && label(e) !== undefined) {
      const { x, y, w, h } = e.frame;
      if (x + w > win.w + 1 || y + h > win.h + 1 || x < -1 || y < -1) {
        out.push({
          rule: 'offscreen',
          severity: 'info',
          element: e.i,
          message: `${label(e)} extends past the ${win.w}×${win.h} window (x${Math.round(x)} y${Math.round(y)} ${Math.round(w)}×${Math.round(h)})`,
        });
      }
    }
    if (e.text && e.frame && (e.frame.w === 0 || e.frame.h === 0)) {
      out.push({
        rule: 'zero-size',
        severity: 'info',
        element: e.i,
        message: `"${e.text.slice(0, 30)}" has ${Math.round(e.frame.w)}×${Math.round(e.frame.h)} size`,
      });
    }
  }
  const byTestId = new Map<string, number[]>();
  for (const e of els) {
    if (!e.testId) continue;
    const list = byTestId.get(e.testId) ?? [];
    list.push(e.i);
    byTestId.set(e.testId, list);
  }
  for (const [id, at] of byTestId)
    if (at.length > 1)
      out.push({ rule: 'duplicate-testid', severity: 'info', element: at[0]!, message: `testId "${id}" is on ${at.length} elements (${at.join(', ')})` });
  return out;
};

export const describeFindings = (findings: Finding[], route?: string): string => {
  if (findings.length === 0) return `${route ?? 'screen'}: clean`;
  const order = { warn: 0, info: 1 } as const;
  const sorted = [...findings].sort((a, b) => order[a.severity] - order[b.severity]);
  const head = `${route ?? 'screen'}: ${findings.filter((f) => f.severity === 'warn').length} warn, ${findings.filter((f) => f.severity === 'info').length} info`;
  return [head, ...sorted.map((f) => `  ${f.severity === 'warn' ? '⚠' : '·'} [${f.rule}] #${f.element} ${f.message}`)].join('\n');
};
