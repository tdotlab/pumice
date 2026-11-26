import test from 'node:test';
import assert from 'node:assert/strict';
import { createDirtyReporter } from '../src/dirty-reporter.ts';

test('dirty reports are serialized so stale clean reports cannot overtake edits', async () => {
  const calls = []; let release;
  const report = createDirtyReporter(async dirty => { calls.push(dirty); if (calls.length === 1) await new Promise(resolve => { release = resolve; }); });
  report(false); report(true);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, [false]);
  release(); await report.flush();
  assert.deepEqual(calls, [false, true]);
});
