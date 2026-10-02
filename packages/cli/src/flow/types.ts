import type { PressOptions, Screen, Target } from 'lynkeus-protocol';

import type { AppEvent } from '../knowledge/events.js';

/** A step's values may reference the run's variables (`{{phone}}`) or what an earlier `call` saved (`{{user.pin}}`). */
export type FlowStep =
  /** `clean` runs the app's `reset` command first, if it registered one. */
  | { launch: { appId?: string; fresh?: boolean; clean?: boolean } }
  | { press: Target & PressOptions }
  /** Taps the target only if it is on screen. */
  | { pressIf: Target & { timeoutMs?: number } }
  | { type: { text: string; target?: Target; clear?: boolean; paste?: boolean } }
  | { swipe: { direction: 'up' | 'down' | 'left' | 'right' } }
  | { back: true }
  | { navigate: { name: string; params?: object } }
  | { deepLink: { url: string } }
  | { dismissKeyboard: true }
  | { waitFor: { route?: string; target?: Target; anyOf?: Target[]; gone?: boolean; timeoutMs?: number } }
  | { idle: { quietMs?: number; timeoutMs?: number } }
  | { assert: { route?: string; target?: Target; gone?: boolean } }
  /** Presses one button per digit, e.g. a code on `digit-{d}-button`. */
  | { keypad: { digits: string; pattern: string; mode?: 'native' | 'js' } }
  /** An app command registered with `qa.register`; the result is saved under `as`. */
  | { call: { method: string; params?: unknown; as?: string } }
  | { note: string };

export type Flow = {
  name: string;
  appId?: string;
  /** The variables the run must supply. */
  vars?: string[];
  steps: FlowStep[];
};

export type StepReport = {
  step: FlowStep;
  ok: boolean;
  ms: number;
  error?: string;
  route?: string;
  /** The screen after the step, when the step touched the app. */
  screen?: Screen;
  artifact?: { screen: string; screenshot?: string };
  /** What the app told its analytics while this step ran. */
  events?: AppEvent[];
};

export type FlowReport = {
  name: string;
  ok: boolean;
  totalMs: number;
  steps: StepReport[];
  vars: Record<string, unknown>;
  dir?: string;
};
