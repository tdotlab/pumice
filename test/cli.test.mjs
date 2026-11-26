import test from 'node:test';
import assert from 'node:assert/strict';
import cli from '../src/main/cli.js';

const { parseArgs } = cli;

test('a normal launch enables neither smoke test nor devtools', () => {
  assert.deepEqual(parseArgs([]), { smokeTest: false, devTools: false });
});

test('--smoke-test selects the automated window smoke run', () => {
  assert.deepEqual(parseArgs(['--smoke-test']), { smokeTest: true, devTools: false });
});

test('--devtools opens developer tools for a development launch', () => {
  assert.deepEqual(parseArgs(['--devtools']), { smokeTest: false, devTools: true });
});

test('unknown arguments are ignored instead of changing startup mode', () => {
  assert.deepEqual(parseArgs(['--unknown', '--smoke-test', 'stray']), {
    smokeTest: true,
    devTools: false,
  });
});
