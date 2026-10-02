import type { Target } from 'lynkeus-protocol';

import type { Device } from '../device/driver.js';
import { runFlow } from '../flow/runner.js';
import type { Flow } from '../flow/types.js';

/** An overlay the app raises on its own (a lock screen, a rating prompt, a forced-update wall) and the flow that clears it. */
export type Overlay = { when: Target; flow: Flow };

const matches = (e: { testId?: string; text?: string; accessibilityLabel?: string }, t: Target): boolean =>
  ('testId' in t && t.testId !== undefined && e.testId === t.testId) ||
  ('text' in t && t.text !== undefined && (e.text?.includes(t.text) || e.accessibilityLabel?.includes(t.text)) === true);

export const clearOverlayIfShown = async (device: Device, overlay: Overlay | undefined): Promise<boolean> => {
  if (!overlay) return false;
  const screen = await device.screen();
  if (!screen.elements.some((e) => matches(e, overlay.when))) return false;
  await runFlow(overlay.flow, { device, vars: {} });
  return true;
};
