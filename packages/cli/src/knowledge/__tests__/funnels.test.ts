import assert from 'node:assert/strict';
import { test } from 'node:test';

import { checkFunnel, diffEvents, funnelCoverage, type Funnel } from '../funnels.js';

const signup: Funnel = {
  name: 'signup',
  steps: [
    { event: 'signup_started', props: { source: 'string', step: 'number' } },
    { event: 'signup_completed', props: { method: 'email' } },
  ],
};

test('a run that produced every step in order, with the right shapes, passes', () => {
  const result = checkFunnel(signup, [
    { name: 'app_opened', step: 1 },
    { name: 'signup_started', props: { source: 'ad', step: 2 }, step: 2 },
    { name: 'signup_completed', props: { method: 'email' }, step: 4 },
  ]);
  assert.equal(result.ok, true);
  assert.deepEqual(
    result.steps.map((s) => s.at),
    [2, 4],
  );
});

test('a missing step, a step out of order and a property of the wrong type each say so', () => {
  assert.equal(checkFunnel(signup, [{ name: 'signup_started', props: { source: 'ad', step: 2 } }]).steps[1]?.problem, 'never happened');
  assert.equal(
    checkFunnel(signup, [
      { name: 'signup_completed', props: { method: 'email' } },
      { name: 'signup_started', props: { source: 'ad', step: 2 } },
    ]).steps[1]?.problem,
    'happened, but before the step it should follow',
  );
  assert.equal(
    checkFunnel(signup, [
      { name: 'signup_started', props: { source: 'ad', step: '2' } },
      { name: 'signup_completed', props: { method: 'phone' } },
    ])
      .steps.map((s) => s.problem)
      .join(' | '),
    'step is string, the funnel needs number | method is "phone", the funnel filters on "email"',
  );
});

test('between two builds: an event that appeared, one that was lost, one whose properties changed', () => {
  const diff = diffEvents([{ name: 'a', props: { step: 1 } }, { name: 'gone' }], [{ name: 'a', props: { step: '1', ref: 'x' } }, { name: 'new' }]);
  assert.deepEqual(diff, { added: ['new'], lost: ['gone'], changed: [{ event: 'a', changes: ['+ref', 'step number→string'] }] });
});

test('coverage names the funnel steps no run produces', () => {
  const coverage = funnelCoverage([signup], [{ run: 'signup/1', events: [{ name: 'signup_started' }] }]);
  assert.deepEqual(
    coverage[0]?.steps.map((s) => s.runs.length),
    [1, 0],
  );
});
