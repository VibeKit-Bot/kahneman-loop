import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkRuns, readTurn, splitShell, standingFailures } from '../claude-code/stop-hook.mjs';

const HOOK = fileURLToPath(new URL('../claude-code/stop-hook.mjs', import.meta.url));
let n = 0;
const prompt = text => ({ type: 'user', message: { role: 'user', content: text } });
const call = (command, input = {}) => { const id = `t${++n}`; return [id, { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command, ...input } }] } }]; };
const result = (id, text, isError) => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content: text }] } });
const say = text => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
const edit = (file_path, name = 'Edit') => { const id = `t${++n}`; return [id, { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input: { file_path } }] } }]; };
const notice = (id, summary, file = '') => ({ type: 'user', origin: { kind: 'task-notification' }, message: { role: 'user', content: `<task-notification>\n<tool-use-id>${id}</tool-use-id>\n<output-file>${file}</output-file>\n<status>completed</status>\n<summary>${summary}</summary>\n</task-notification>` } });
const lines = entries => entries.map(e => JSON.stringify(e));
const outcome = (command, output, code) => checkRuns(command, output, code).map(r => [r.key, r.ok]);

function runHook(entries, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'kahneman-loop-'));
  const path = join(dir, 'session.jsonl');
  writeFileSync(path, lines(entries).join('\n'));
  return execFileSync('node', [HOOK], { input: JSON.stringify({ transcript_path: path, stop_hook_active: false, cwd: '/repo', ...extra }) }).toString();
}

test('a failing test left standing blocks the stop, once', () => {
  const [a, ca] = call('npm test 2>&1 | tail -20');
  const entries = [prompt('fix the login bug'), ca, result(a, '  ✗ login rejects bad password\n1 failing', false), say('Fixed, all good.')];
  const out = JSON.parse(runHook(entries));
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /`npm test` \(1 failing\)/);
  assert.equal(out.systemMessage, 'Kahneman Loop: `npm test` failed this turn, so Claude is taking another look before it finishes.', 'the user sees why Claude is working again');
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

test('a check named in text is not a run: quotes, greps, heredocs, comments', () => {
  for (const cmd of [
    'grep -rn "npm test" docs',
    'git commit -m "fix: npm test passes; npx tsc clean"',
    "cat > /tmp/run.sh <<'EOF'\nnpm test\nnpx tsc --noEmit\nEOF",
    'git commit -m "$(cat <<\'EOF\'\nRun npm test (it\'s "fine")\nEOF\n)"',
    '# then npm test\nls',
    'echo "npm run build failed"',
  ]) assert.deepEqual(checkRuns(cmd, 'Exit code 1', 1), [], cmd);
  assert.deepEqual(splitShell('cd web && npm test 2>&1 | tail -5; echo "x|y"').map(s => [s.text, s.op]),
    [['cd web', '&&'], ['npm test 2>&1', '|'], ['tail -5', ';'], ['echo "x|y"', '']]);
});

test('the exit code counts only when it is the check\'s own', () => {
  assert.deepEqual(outcome('npm test', '', 1), [['npm test', false]]);
  assert.deepEqual(outcome('cd web && npm test', '', 1), [['cd web && npm test', false]], 'a cd before it does not change whose exit it is');
  assert.deepEqual(outcome('npx vitest run && echo done', '', 0), [['npx vitest run', true]]);
  assert.deepEqual(outcome('npx vitest run | grep -v skip', '', 0), [['npx vitest run', null]], 'a pipe: the exit is grep\'s');
  assert.deepEqual(outcome('npx vitest run; echo done', '', 0), [['npx vitest run', null]]);
  assert.deepEqual(outcome('git pull && npx vitest run', '', 1), [['npx vitest run', null]], 'git pull may be what failed');
  assert.deepEqual(outcome('set -o pipefail; npx vitest run | tail -5', '', 1), [['npx vitest run', false]]);
});

test('a piped check is read from what it printed', () => {
  assert.deepEqual(outcome('npx tsc --noEmit 2>&1 | head -30', 'src/a.ts(3,1): error TS2304: Cannot find name', 0), [['npx tsc --noEmit', false]]);
  assert.deepEqual(outcome('npx tsc --noEmit 2>&1 | head -30', '', 0), [['npx tsc --noEmit', true]], 'tsc prints nothing when it passes');
  assert.deepEqual(outcome('npx tsc --noEmit 2>&1 | grep -c error', '0', 0), [['npx tsc --noEmit', null]]);
  assert.deepEqual(outcome('npm run build 2>&1 | tail -5', 'npm error Lifecycle script `build` failed with error:\nnpm error code 2', 0), [['npm run build', false]]);
  assert.deepEqual(outcome('npm run build 2>&1 | tail -5', '✓ Generating static pages (12/12)\nDone in 41s', 0), [['npm run build', true]], 'npm prints a failure line whenever a script fails');
  assert.deepEqual(outcome('npm run -s build 2>&1 | tail -5', 'Done', 0), [['npm run build', null]], '-s silences that line');
  assert.deepEqual(outcome('pytest -q 2>&1 | tail -3', '=== 1 failed, 40 passed in 2.1s ===', 0), [['pytest', false]]);
  assert.deepEqual(outcome('npx tsx scripts/test-login.ts | tail -3', 'ok\n', 0), [['npx tsx scripts/test-login.ts', null]], 'nothing settles it: unknown');
});

test('an echoed exit status is read', () => {
  assert.deepEqual(outcome('npx tsc --noEmit; echo "TSC=$?"', 'TSC=2', 0), [['npx tsc --noEmit', false]]);
  assert.deepEqual(outcome('npm test 2>&1 | tail -3; echo "exit ${PIPESTATUS[0]}"', 'lines\nexit 0', 0), [['npm test', true]]);
  assert.deepEqual(outcome('cargo test && echo OK || echo FAIL', 'FAIL', 0), [['cargo test', false]]);
});

test('each check keeps its own key, and a check after a failed one in an && chain never ran', () => {
  assert.deepEqual(outcome('npm run check:links && npm run check:copy', 'Exit 0', 0), [['npm run check:links', true], ['npm run check:copy', true]]);
  assert.deepEqual(outcome('npx tsc --noEmit && npm test > test.log 2>&1', 'src/a.ts(1,1): error TS2322: x', 2), [['npx tsc --noEmit', false]]);
  assert.deepEqual(outcome('npm test && npm run build', '1 failing', 1), [['npm test', null], ['npm run build', null]],
    'two checks printed into one output: it is neither one\'s alone');
  assert.deepEqual(outcome('npx tsc --noEmit && npm test', 'src/a.ts(1,1): error TS2322: x', 2), [['npx tsc --noEmit', false]], 'unless it is tsc\'s');
  assert.deepEqual(outcome('npx tsx scripts/test-a.ts 2>&1 | tail -1; npx tsc --noEmit 2>&1 | head -3', 'AssertionError: x', 0), [['npx tsx scripts/test-a.ts', null], ['npx tsc --noEmit', true]]);
  assert.deepEqual(outcome('cat tsc.log; npx tsc --noEmit 2>&1 | head -3', 'src/a.ts(1,1): error TS2322: x', 0), [['npx tsc --noEmit', null]], 'an old log could have printed it');
  const build = "python3 - <<'EOF'\nprint('1 failed replacement skipped')\nEOF\nxcodebuild -scheme App build 2>&1 | tail -1";
  assert.deepEqual(outcome(build, '1 failed replacement skipped\n** BUILD SUCCEEDED **', 0), [['xcodebuild -scheme App build', true]], 'xcodebuild names its own result');
  assert.deepEqual(outcome(build, '1 failed replacement skipped\nld: error', 0), [['xcodebuild -scheme App build', null]]);
  assert.deepEqual(outcome('npx tsc -p dashboard --noEmit', '', 0), [['npx tsc -p dashboard --noEmit', true]]);
  assert.deepEqual(outcome('cd /Users/me/code/projects/website/frontend && npm test', '', 1), [['cd …/website/frontend && npm test', false]]);
  assert.deepEqual(outcome('CI=1 timeout 600 npx tsx scripts/check-links.ts', '', 0), [['npx tsx scripts/check-links.ts', true]]);
  assert.deepEqual(outcome('node scripts/build-sitemap.mjs', '', 0), [], 'a script is a check only when its name says so');
});

test('a trial is not a failure: a run the command undoes, or a run on a temp copy', () => {
  const read = (command, output, code = 0) => checkRuns(command, output, code).map(r => [r.key, r.ok, r.source]);
  assert.deepEqual(read('cp src/a.ts /tmp/a.new; git show HEAD:src/a.ts > src/a.ts; npx tsx scripts/test-a.ts 2>&1 | tail -3; cp /tmp/a.new src/a.ts', 'AssertionError: the old bug'),
    [['npx tsx scripts/test-a.ts', null, 'trial']], 'run on the old code, then put back');
  assert.deepEqual(read("F=src/a.sql && cp $F /tmp/a.bak && sed -i '' 's/x/y/' $F && node scripts/test-a.cjs 2>&1 | head -3; cp /tmp/a.bak $F", 'AssertionError'),
    [['node scripts/test-a.cjs', null, 'trial']]);
  assert.deepEqual(read('git stash push -q -- src && npm test; git stash pop -q', '', 1), [['npm test', null, 'trial']]);
  assert.deepEqual(read('S=/private/tmp/x; node scripts/test-a.cjs $S/old-a.ts 2>&1 | tail -2', 'AssertionError'), [['node scripts/test-a.cjs $S/old-a.ts', null, 'trial']]);
  assert.deepEqual(read('M=/tmp/mut; SRC=$M/flip.ts npx tsx scripts/test-a.ts >/dev/null 2>&1 && echo SURVIVED || echo caught', 'caught'), [['npx tsx scripts/test-a.ts', null, 'trial']]);
  assert.deepEqual(read('cp src/a.ts /tmp/backup.ts; npm test 2>&1 | tail -3', '1 failing'), [['npm test', false, 'output']], 'a backup alone is not a trial');
  assert.deepEqual(read("T=$(mktemp); python3 - src/a.sh $T <<'EOF'\nimport sys\nEOF\nbash scripts/test-a.sh $T", 'buggy rc=1', 1), [['bash scripts/test-a.sh $T', null, 'trial']], 'a mutant in a mktemp file');
  const old = 'git worktree add -q --detach /repo/.wt/old origin/main && cd /repo/.wt/old && npm test 2>&1 | tail -3; cd /repo && git worktree remove --force .wt/old';
  assert.deepEqual(checkRuns(old, '1 failing', 0, { dir: '/repo', project: '/repo' }).map(r => r.source), ['trial'], 'a copy the command throws away');
});

test('output is read only when it is all the check\'s own', () => {
  assert.deepEqual(outcome('cat build.log; npm test 2>&1 | tail -1', '3 failed\n12 passing', 0), [['npm test', null]], 'cat printed too');
  assert.deepEqual(outcome("python3 - <<'EOF'\nassert ok\nEOF\nnpx tsx scripts/test-a.ts 2>&1 | tail -3", 'AssertionError', 0), [['npx tsx scripts/test-a.ts', null]]);
  assert.deepEqual(outcome('npm test > t.log 2>&1; tail -20 t.log', '1 failing', 0), [['npm test', false]], 'tail of its own log');
  assert.deepEqual(outcome('mkdir -p out && echo "--- tests" && npm test 2>&1 | tail -3', '--- tests\n3 passing', 0), [['npm test', true]], 'a label is not output');
  assert.deepEqual(outcome('npx tsc --noEmit 2>&1 | head', 'Shell cwd was reset to /repo', 0), [['npx tsc --noEmit', true]], 'Claude Code\'s note is not tsc\'s');
});

test('each echoed status is matched to its own line, and 127 means the check never ran', () => {
  assert.deepEqual(outcome('npx tsc --noEmit > a.log 2>&1; echo "tsc exit=$?"; npm test > b.log 2>&1; echo "exit=$?"', 'tsc exit=0\nexit=1', 0),
    [['npx tsc --noEmit', true], ['npm test', false]]);
  assert.deepEqual(outcome('npm test > a.log; echo "rc=$?"; npm run build > b.log; echo "rc=$?"', 'rc=0\nrc=2', 0), [['npm test', true], ['npm run build', false]]);
  assert.deepEqual(outcome('for f in a b; do npm test > a.log; echo "rc=$?"; done', 'rc=0\nrc=1', 0), [['npm test', null]], 'printed in a loop');
  assert.deepEqual(outcome('npm test; echo $?; grep -c x f', '0\n3', 0), [['npm test', null]], 'a bare number only as the last line');
  assert.deepEqual(outcome('timeout 60 npx tsx scripts/test-a.ts >/dev/null 2>&1; echo exit=$?', 'zsh: command not found: timeout\nexit=127', 0), [['npx tsx scripts/test-a.ts', null]]);
  assert.deepEqual(outcome('npm test', 'sh: jest: command not found', 127), [['npm test', null]]);
  assert.deepEqual(outcome('xcodebuild -version | head -2', 'Xcode 26.1', 0), [], 'not a build');
  assert.deepEqual(outcome('bash -n scripts/verify.sh', '', 0), [], 'only parses it');
  assert.deepEqual(outcome('node --check scripts/check-a.cjs', '', 0), [], 'so does this');
  assert.deepEqual(outcome('npx tsx scripts/test-a.ts 2>&1 | tail -3', "  code: 'ERR_MODULE_NOT_FOUND',\n  url: 'file:///repo/scripts/test-a.ts'\n}", 0), [['npx tsx scripts/test-a.ts', null]], 'no such script');
  assert.deepEqual(outcome('python3 scripts/test_a.py', "python3: can't open file '/repo/scripts/test_a.py': [Errno 2] No such file or directory", 2), [['python3 scripts/test_a.py', null]]);
  assert.deepEqual(outcome('bash scripts/test-a.sh', 'bash: scripts/test-a.sh: No such file or directory', 127), [['bash scripts/test-a.sh', null]]);
  assert.deepEqual(outcome("xcodebuild -workspace App.xcworkspace -scheme App build 2>&1 | grep -E 'error:|BUILD'", "xcodebuild: error: 'App.xcworkspace' does not exist.", 0), [['xcodebuild -workspace App.xcworkspace -scheme App build', null]]);
  assert.deepEqual(outcome('npx tsx scripts/test-a.ts', "Error: Cannot find module '../src/b' imported from /repo/scripts/test-a.ts", 1), [['npx tsx scripts/test-a.ts', false]], 'a missing import is a failure');
});

test('a check is the same check from wherever it was run', () => {
  const [a, ca] = call('npm run prebuild > p.log 2>&1; echo "exit=$?"');
  const [b, cb] = call('cd /repo/wt && npm run prebuild 2>&1 | tail -3; echo "exit=${PIPESTATUS[0]}"');
  const failed = [prompt('go'), { ...ca, cwd: '/repo/wt' }, result(a, 'exit=1', false)];
  const turn = readTurn(lines(failed), { cwd: '/repo' });
  assert.deepEqual(turn.failures.map(f => f.key), ['cd wt && npm run prebuild'], 'named from the project');
  assert.deepEqual(readTurn(lines([...failed, { ...cb, cwd: '/repo' }, result(b, 'exit=0', false)]), { cwd: '/repo' }).failures, [], 'the same check passed');
});

test('a code edit after the last passing check blocks the stop, once', () => {
  const [a, ca] = call('npm test');
  const [e, ce] = edit('/repo/src/auth.ts');
  const entries = [prompt('fix the login bug'), ca, result(a, '12 passing', false), ce, result(e, 'The file has been updated.', false), say('Fixed.')];
  const out = JSON.parse(runHook(entries));
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /you changed the code after your own check passed: `npm test` \(passed, then you changed auth\.ts\)/);
  assert.equal(out.systemMessage, 'Kahneman Loop: the code changed after `npm test` passed, so Claude is checking again before it finishes.');
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

test('scratch files and other languages do not make a pass stale', () => {
  const [a, ca] = call('npm test');
  const [s, cs] = edit('/tmp/try.sh', 'Write');
  const [w, cw] = edit('/repo/ios/LoginView.swift');
  const [p, cp] = edit('/repo/tools/seed.py');
  assert.equal(runHook([prompt('go'), ca, result(a, '12 passing', false), cs, result(s, 'ok', false), say('Done.')]), '', 'outside the project');
  assert.equal(runHook([prompt('go'), ca, result(a, '12 passing', false), cw, result(w, 'ok', false), cp, result(p, 'ok', false), say('Done.')]), '', 'npm test does not cover Swift or Python');
  const [t, ct] = call('npx tsc --noEmit');
  const [h, ch] = edit('/repo/scripts/deploy.sh');
  assert.equal(runHook([prompt('go'), ct, result(t, '', false), ch, result(h, 'ok', false), say('Done.')]), '', 'tsc does not read shell scripts');
  const root = mkdtempSync(join(tmpdir(), 'kahneman-loop-'));
  for (const r of ['app', 'rig']) mkdirSync(join(root, r, '.git'), { recursive: true });
  const [x, cx] = edit(join(root, 'rig', 'src', 'run.ts'));
  const [y, cy] = edit(join(root, 'app', 'src', 'run.ts'));
  const passed = [prompt('go'), { ...ca, cwd: join(root, 'app') }, result(a, '12 passing', false)];
  assert.deepEqual(readTurn(lines([...passed, cx, result(x, 'ok', false)]), { cwd: join(root, 'app') }).stale, [], 'another repository');
  assert.equal(readTurn(lines([...passed, cy, result(y, 'ok', false)]), { cwd: join(root, 'app') }).stale.length, 1, 'its own');
});

test('a shell edit counts as an edit: sed -i, perl -i, a redirect, a copy onto code', () => {
  const [a, ca] = call('npm test');
  const passed = [prompt('go'), { ...ca, cwd: '/repo' }, result(a, '12 passing', false)];
  const stale = (command, out = '', isError = false) => {
    const [b, cb] = call(command);
    return readTurn(lines([...passed, { ...cb, cwd: '/repo' }, result(b, out, isError), say('Done.')]), { cwd: '/repo' }).stale.map(s => s.detail);
  };
  assert.deepEqual(stale("sed -i '' 's/==/===/' src/auth.ts"), ['passed, then you changed auth.ts']);
  assert.deepEqual(stale("cd src && perl -pi -e 's/a/b/' auth.ts"), ['passed, then you changed auth.ts'], 'resolved from the cd');
  assert.deepEqual(stale("cat > src/auth.ts <<'EOF'\nexport const ok = true;\nEOF"), ['passed, then you changed auth.ts']);
  assert.deepEqual(stale('cp /tmp/auth.ts src/auth.ts'), ['passed, then you changed auth.ts']);
  assert.deepEqual(stale("sed -i 's/a/b/' src/auth.ts", 'Exit code 1\nsed: no match', true), ['passed, then you changed auth.ts'], 'a failed command may still have written');
  const [e, ce] = edit('/repo/src/auth.ts');
  const out = JSON.parse(runHook([...passed, ce, result(e, 'ok', false), ...(() => {
    const [b, cb] = call("sed -i '' 's/x/y/' src/auth.ts");
    return [{ ...cb, cwd: '/repo' }, result(b, '', false)];
  })(), say('Done.')]));
  assert.match(out.reason, /passed, then you changed auth\.ts\)/, 'named once');
});

test('a shell edit is not a change when a check follows it, it undoes itself, or it writes no code', () => {
  const [a, ca] = call('npm test');
  const passed = [prompt('go'), { ...ca, cwd: '/repo' }, result(a, '12 passing', false)];
  const stale = (command, out = '') => {
    const [b, cb] = call(command);
    return readTurn(lines([...passed, { ...cb, cwd: '/repo' }, result(b, out, false), say('Done.')]), { cwd: '/repo' }).stale;
  };
  assert.deepEqual(stale("sed -i '' 's/x/y/' src/auth.ts && npm test", '12 passing'), [], 'rechecked in the same command');
  assert.equal(stale("npm test && sed -i '' 's/x/y/' src/auth.ts", '12 passing').length, 1, 'changed after the check in the same command');
  assert.deepEqual(stale("F=src/a.ts && cp $F /tmp/a.bak && sed -i '' 's/x/y/' $F && npm test; cp /tmp/a.bak $F", 'Tests: 1 failed'), [], 'a trial put back');
  assert.deepEqual(stale('npm run build > build.log 2>&1; tail build.log', 'done'), [], 'a log');
  assert.deepEqual(stale('echo hi > /tmp/note.ts; sed -n 1,5p src/auth.ts', 'x'), [], 'scratch, and a read');
  assert.deepEqual(stale('git checkout -- src/auth.ts'), [], 'a checkout puts code back');
  assert.deepEqual(stale('sed -i "s/a/b/" $FILE'), [], 'an unknown file');
  assert.deepEqual(stale('git commit -qm "Settings > Build an app" && echo \'a > b.ts\''), [], 'a > in quotes');
  assert.deepEqual(stale('[[ "$G" > "18:40:36" ]] && echo newer'), [], 'a comparison');
});

test('a notebook edit counts; a subagent edit does not', () => {
  const [a, ca] = call('pytest');
  const [e, ce] = edit('/repo/analysis.ipynb', 'NotebookEdit');
  ce.message.content[0].input = { notebook_path: '/repo/analysis.ipynb' };
  const [s, cs] = edit('/repo/src/auth.py');
  const side = [{ ...cs, isSidechain: true }, { ...result(s, 'ok', false), isSidechain: true }];
  assert.match(JSON.parse(runHook([prompt('go'), ca, result(a, '3 passed', false), ce, result(e, 'ok', false), say('Done.')])).reason, /`pytest` \(passed, then you changed analysis\.ipynb\)/);
  assert.equal(runHook([prompt('go'), ca, result(a, '3 passed', false), ...side, say('Done.')]), '');
});

test('a background check counts as a recheck when it starts, and its result is read when it finishes', () => {
  const [a, ca] = call('npm test');
  const [e, ce] = edit('/repo/src/auth.ts');
  const [b, cb] = call('npm test 2>&1 | tail -20', { run_in_background: true });
  const started = [prompt('go'), ca, result(a, '12 passing', false), ce, result(e, 'ok', false), cb, result(b, 'Command running in background with ID: b1', false), say('Tests are running.')];
  assert.equal(runHook(started), '', 'started after the edit: not stale, not judged yet');
  const dir = mkdtempSync(join(tmpdir(), 'kahneman-loop-'));
  writeFileSync(join(dir, 'b1.output'), '  ✗ login rejects bad password\n1 failing\nnpm error code 1');
  const out = JSON.parse(runHook([...started, notice(b, 'Background command "npm test" failed with exit code 1', join(dir, 'b1.output')), say('Tests pass.')]));
  assert.match(out.reason, /`npm test` \(1 failing\)/, 'the notice does not start a new turn');
  const turn = readTurn(lines([...started, notice(b, 'Background command "npm test" completed (exit code 0)'), say('Tests pass.')]), { cwd: '/repo' });
  assert.deepEqual([turn.failures, turn.stale], [[], []]);
});

test('a failure is handed back once: the turn is read from after the hand-back', () => {
  const [a, ca] = call('npx tsc --noEmit');
  const handedBack = { type: 'attachment', attachment: { type: 'hook_blocking_error', hookEvent: 'Stop', blockingError: { blockingError: '[Kahneman Loop: your own check this turn is still failing: ...]' } } };
  assert.equal(runHook([prompt('go'), ca, result(a, 'Exit code 2\nerror TS2304', true), say('Done.'), handedBack, say('It still fails: TS2304 in a.ts.'), notice('x', 'Agent "y" finished'), say('The agent finished.')]), '');
});

test('a standing failure is handed back before a stale pass', () => {
  const [a, ca] = call('npm test');
  const [b, cb] = call('npx tsc --noEmit');
  const [e, ce] = edit('/repo/src/auth.ts');
  const out = JSON.parse(runHook([prompt('go'), ca, result(a, '12 passing', false), cb, result(b, 'Exit code 2\nerror TS2304', true), ce, result(e, 'ok', false), say('Done.')]));
  assert.match(out.reason, /still failing: `npx tsc --noEmit`/);
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
