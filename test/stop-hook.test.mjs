import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { standingFailures } from '../claude-code/stop-hook.mjs';

const HOOK = fileURLToPath(new URL('../claude-code/stop-hook.mjs', import.meta.url));
let n = 0;
const prompt = text => ({ type: 'user', message: { role: 'user', content: text } });
const call = command => { const id = `t${++n}`; return [id, { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } }]; };
const result = (id, text, isError) => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content: text }] } });
const say = text => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
const edit = (file_path, name = 'Edit') => { const id = `t${++n}`; return [id, { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input: { file_path } }] } }]; };
const lines = entries => entries.map(e => JSON.stringify(e));

function runHook(entries, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'kahneman-loop-'));
  const path = join(dir, 'session.jsonl');
  writeFileSync(path, lines(entries).join('\n'));
  return execFileSync('node', [HOOK], { input: JSON.stringify({ transcript_path: path, stop_hook_active: false, ...extra }) }).toString();
}

test('a failing test left standing blocks the stop, once', () => {
  const [a, ca] = call('npm test 2>&1 | tail -20');
  const entries = [prompt('fix the login bug'), ca, result(a, 'Exit code 1\n  ✗ login rejects bad password\n1 failing', true), say('Fixed, all good.')];
  const out = JSON.parse(runHook(entries));
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /`npm test` \(.*1 failing\)/);
  assert.equal(runHook(entries, { stop_hook_active: true }), '', 'the stop after a block goes through');
});

test('a later passing run of the same check clears it', () => {
  const [a, ca] = call('npm test');
  const [b, cb] = call('npm test -- --silent');
  assert.deepEqual(standingFailures(lines([prompt('go'), ca, result(a, 'Exit code 1\n1 failing', true), cb, result(b, '12 passing', false)])), []);
});

test('only the current turn counts', () => {
  const [a, ca] = call('pytest');
  assert.equal(runHook([prompt('first'), ca, result(a, 'Exit code 1\nFAILED', true), say('it fails'), prompt('ok thanks, rename the button'), say('Renamed.')]), '');
});

test('a denied or blocked call is not a failed check, and non-check commands are ignored', () => {
  const [a, ca] = call('npm run build');
  const [b, cb] = call('grep -r foo src');
  assert.deepEqual(standingFailures(lines([prompt('go'), ca, result(a, 'Permission for this action was denied.', true), cb, result(b, 'Exit code 1', true)])), []);
});

test('typecheck, cargo and curl -f are checks', () => {
  for (const cmd of ['npx tsc --noEmit', 'cargo test', 'curl -fsS https://example.com/health']) {
    const [a, ca] = call(cmd);
    assert.equal(standingFailures(lines([prompt('go'), ca, result(a, 'Exit code 2\nerror', true)])).length, 1, cmd);
  }
});

test('a code edit after the last passing check blocks the stop, once', () => {
  const [a, ca] = call('npm test');
  const [e, ce] = edit('/repo/src/auth.ts');
  const entries = [prompt('fix the login bug'), ca, result(a, '12 passing', false), ce, result(e, 'The file has been updated.', false), say('Fixed.')];
  const out = JSON.parse(runHook(entries));
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /you changed the code after your own check passed: `npm test` \(passed, then you changed auth\.ts\)/);
  assert.equal(runHook(entries, { stop_hook_active: true }), '');
});

test('a check after the edit, a docs edit or a failed edit: no stale pass', () => {
  const [a, ca] = call('npm test');
  const [b, cb] = call('npx tsc --noEmit');
  const [e, ce] = edit('/repo/src/auth.ts');
  const [d, cd] = edit('/repo/README.md', 'Write');
  const [f, cf] = edit('/repo/src/auth.ts');
  assert.equal(runHook([prompt('go'), ca, result(a, '12 passing', false), ce, result(e, 'ok', false), cb, result(b, '', false), say('Done.')]), '');
  assert.equal(runHook([prompt('go'), ca, result(a, '12 passing', false), cd, result(d, 'ok', false), say('Done.')]), '');
  assert.equal(runHook([prompt('go'), ca, result(a, '12 passing', false), cf, result(f, 'String to replace not found in file.', true), say('Done.')]), '');
});

test('a notebook edit counts; a subagent edit does not', () => {
  const [a, ca] = call('pytest');
  const [e, ce] = edit('/repo/analysis.ipynb', 'NotebookEdit');
  ce.message.content[0].input = { notebook_path: '/repo/analysis.ipynb' };
  const [s, cs] = edit('/repo/src/auth.ts');
  const side = [{ ...cs, isSidechain: true }, { ...result(s, 'ok', false), isSidechain: true }];
  assert.match(JSON.parse(runHook([prompt('go'), ca, result(a, '3 passed', false), ce, result(e, 'ok', false), say('Done.')])).reason, /`pytest` \(passed, then you changed analysis\.ipynb\)/);
  assert.equal(runHook([prompt('go'), ca, result(a, '3 passed', false), ...side, say('Done.')]), '');
});

test('a standing failure is handed back before a stale pass', () => {
  const [a, ca] = call('npm test');
  const [b, cb] = call('npx tsc --noEmit');
  const [e, ce] = edit('/repo/src/auth.ts');
  const out = JSON.parse(runHook([prompt('go'), ca, result(a, '12 passing', false), cb, result(b, 'Exit code 2\nerror TS2304', true), ce, result(e, 'ok', false), say('Done.')]));
  assert.match(out.reason, /still failing: `npx tsc`/);
});

test('no transcript, bad input or a clean turn: the hook stays silent', () => {
  assert.equal(execFileSync('node', [HOOK], { input: 'not json' }).toString(), '');
  assert.equal(execFileSync('node', [HOOK], { input: JSON.stringify({ transcript_path: '/nonexistent' }) }).toString(), '');
  const [a, ca] = call('npm test');
  assert.equal(runHook([prompt('go'), ca, result(a, '3 passing', false), say('Done, tests pass.')]), '');
});

test('a long session: the turn is read back from the end of the transcript', () => {
  const old = Array.from({ length: 40 }, (_, i) => say(`earlier ${i} ${'x'.repeat(100_000)}`));
  const [a, ca] = call('npm run build');
  const big = result('t-big', 'y'.repeat(3_000_000), false); // a 3 MB entry inside the turn forces the window to grow
  const out = JSON.parse(runHook([...old, prompt('ship it'), ca, big, result(a, 'Exit code 2\nerror TS2304', true), say('Shipped.')]));
  assert.match(out.reason, /`npm run build` \(.*TS2304\)/);
});
