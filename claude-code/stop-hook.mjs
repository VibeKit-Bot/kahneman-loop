#!/usr/bin/env node
// The Kahneman Loop's hand-back for Claude Code: a Stop hook.
//
// When Claude is about to end its turn and a check it ran this turn (tests,
// build, typecheck, lint, `curl -f`) is still failing, the turn is not over:
// the failure goes back to Claude once, and it fixes the cause or says plainly
// that it failed. The same goes when Claude edited code after its last check
// passed and ran no check since: that pass checked code that no longer exists.
// Never a loop: Claude Code sets `stop_hook_active` on the stop that follows a
// hook's block, this hook lets that one through, and it reads the turn from
// after its own last hand-back, so nothing is handed back twice.
//
// A check's outcome is read only where the transcript settles it. The exit
// code counts when it is the check's own: `npm test | tail` exits with tail's
// status, so there the hook reads what the test runner printed instead
// ("2 failing", "error TS2304", npm's failure lines), but only when nothing
// else in the command printed. A run nothing settles counts as unknown and is
// never handed back, and so does a trial: a run on code the same command puts
// back afterwards, or on a copy in a temp directory, which shows the test
// catches the old bug rather than that the code fails. A check started in the
// background counts as a recheck when it starts, and its outcome is read from
// Claude Code's notice when it finishes.
//
// Register in .claude/settings.json (or ~/.claude/settings.json):
//   { "hooks": { "Stop": [ { "hooks": [ { "type": "command",
//       "command": "node /path/to/kahneman-loop/claude-code/stop-hook.mjs" } ] } ] } }
//
// Zero dependencies. Reads the session transcript only; runs nothing.
// eval/claude-code-scan.mjs replays it over your own past sessions.
import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// ---------------------------------------------------------------------------
// Which commands are checks
// ---------------------------------------------------------------------------

// What can come before the command itself: `CI=1`, `time`, `timeout 600`, `uv run`.
const PREFIX_RE = /^(?:[A-Za-z_]\w*=(?:'[^']*'|"[^"]*"|\S*)\s+|(?:if|elif|then|else|do|while|until|time|command|exec|nice|nohup|env|caffeinate(?:\s+-\w+)*|timeout(?:\s+-\S+)*\s+\d+[smhd]?|(?:uv|poetry|pipenv)\s+run|bundle\s+exec)\s+)+/;
const JS_RUNNER = String.raw`(?:(?:npx|bunx|pnpm\s+(?:exec|dlx)|yarn(?:\s+exec)?)\s+(?:-\S+\s+)*|(?:\.\/)?node_modules\/\.bin\/)?`;
// A package.json script that checks: `npm test`, `pnpm -C web build`, `npm run -s check:links`.
const PM = String.raw`(?:npm|pnpm|yarn|bun)(?:\s+(?:--prefix|-C|--dir|--cwd|--filter|-F|--workspace|-w)[ =]\S+|\s+-\S+)*\s+(?:run(?:-script)?\s+(?:-\S+\s+)*[\w:.@/-]*(?:test|build|lint|typecheck|type-check|check|verify)|(?:test|t|build|lint|typecheck|check)\b)`;
const PM_RE = new RegExp(`^${PM}`);
const TSC_RE = new RegExp(`^${JS_RUNNER}(?:vue-)?tsc\\b`);
const CURL_RE = /^curl\s+(?:\S+\s+)*?(?:-[A-Za-z]*f[A-Za-z]*|--fail(?:-with-body)?)(?:\s|$)/;

/** A command that checks something, matched at the start of one simple command. */
export const CHECK_RE = new RegExp('^(?:' + [
  PM,
  `${JS_RUNNER}(?:vue-tsc|tsc|vitest|jest|mocha|ava|playwright\\s+test|eslint|biome\\s+(?:check|lint|ci)|prettier\\s+(?:--check|-c))\\b`,
  String.raw`(?:pytest|mypy|pyright|flake8|rspec|phpunit)\b`,
  String.raw`xcodebuild\b(?!.*\s-(?:version|list|showsdks|showBuildSettings|showdestinations|help|usage)\b)`,
  String.raw`python3?\s+-m\s+(?:pytest|unittest|mypy)\b`,
  String.raw`ruff\s+check\b`,
  String.raw`go\s+(?:test|build|vet)\b`,
  String.raw`cargo\s+(?:test|build|check|clippy)\b`,
  String.raw`make\b(?:\s+\S+)*?\s+(?:test|tests|check|build)\b`,
  String.raw`node\s+(?:-\S+\s+)*--test\b`,
  String.raw`deno\s+(?:test|check|lint)\b`,
  String.raw`swift\s+(?:test|build)\b`,
  String.raw`(?:\.\/gradlew|gradle)\b(?:\s+\S+)*?\s+(?:test|build|check)\b`,
  String.raw`mvn\b(?:\s+\S+)*?\s+(?:test|verify|package)\b`,
  String.raw`dotnet\s+(?:test|build)\b`,
  String.raw`(?:rails|rake)\s+test\b`,
  CURL_RE.source.slice(1),
].join('|') + ')');

// A script whose name says it checks: `npx tsx scripts/test-login.ts`, `./check-links.sh`.
// `bash -n verify.sh` only parses the script, so it is not a run of it.
const SCRIPT_RE = /^(?:(?:npx\s+)?(?:tsx|ts-node|node|bun|deno\s+run|python3?|bash|sh|zsh)\s+(?:(?!-n\s|-c\s|--check\s)-\S+\s+)*)?(?:\S*\/)?([\w.-]+)\.(?:[cm]?[jt]sx?|py|sh)(?:\s|$)/;
const SCRIPT_FILE_RE = /\.(?:[cm]?[jt]sx?|py|sh)$/;
const CHECK_NAME_RE = /(?:^|[._-])(?:tests?|checks?|specs?|verify)(?:[._-]|$)/i;

// Which code a check covers, so a Swift edit does not make `npm test` stale.
// A check or a file outside these (a Makefile target, a .json, a .sh) goes with everything.
const ECOSYSTEMS = [
  ['python', /\.(?:py|pyi|ipynb)$/i, /^(?:pytest|mypy|pyright|flake8|ruff|python)/],
  ['rust', /\.rs$/i, /^cargo\b/],
  ['go', /\.go$/i, /^go\b/],
  ['swift', /\.(?:swift|mm?)$/i, /^(?:swift|xcodebuild)\b/],
  ['jvm', /\.(?:java|kt|kts|scala|gradle)$/i, /^(?:\.\/gradlew|gradle|mvn)\b/],
  ['dotnet', /\.(?:cs|fs|vb)$/i, /^dotnet\b/],
  ['ruby', /\.(?:rb|erb|rake)$/i, /^(?:rspec|rails|rake)\b/],
  ['js', /\.(?:[cm]?[jt]sx?|vue|svelte|astro)$/i, /^(?:npm|pnpm|yarn|bunx?|npx|node|tsx|ts-node|deno|(?:\.\/)?node_modules|vue-tsc|tsc|vitest|jest|mocha|ava|eslint|biome|prettier|playwright)\b/],
];
const ecoOfFile = path => (ECOSYSTEMS.find(([, file]) => file.test(path)) || [])[0] || null;

/** What kind of check a simple command is, or null when it is not one. */
function checkOf(head) {
  if (!CHECK_RE.test(head)) {
    const m = SCRIPT_RE.exec(head);
    return m && CHECK_NAME_RE.test(m[1]) ? { family: 'other', script: true, eco: ecoOfFile(head.split(/\s+/).find(t => /\.\w+$/.test(t)) || '') } : null;
  }
  const family = TSC_RE.test(head) ? 'tsc' : PM_RE.test(head) ? 'pm' : CURL_RE.test(head) ? 'live' : 'other';
  return { family, eco: (ECOSYSTEMS.find(([, , cmd]) => cmd.test(head)) || [])[0] || null };
}

// ---------------------------------------------------------------------------
// Reading a shell command
// ---------------------------------------------------------------------------

/**
 * A shell command as simple commands, each with the operator after it ('|',
 * '&&', '||', ';', or '' at the end). Quotes, `$(...)` and comments are
 * respected and heredoc bodies dropped, so `grep "npm test" notes` or a script
 * written with `cat <<EOF` is not mistaken for running a check.
 */
export function splitShell(cmd) {
  const segs = [];
  const stack = []; // open quotes, `$(` and `(` inside it
  const heredocs = [];
  let cur = '';
  const end = op => { const text = cur.trim(); cur = ''; if (text) segs.push({ text, op }); };
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i], top = stack[stack.length - 1];
    if (top === "'") { cur += ch; if (ch === "'") stack.pop(); continue; }
    if (ch === '\\') { cur += ch + (cmd[i + 1] ?? ''); i++; continue; }
    if (top === '"' || top === '`') {
      cur += ch;
      if (ch === top) stack.pop();
      else if (ch === '$' && cmd[i + 1] === '(') { stack.push('$('); cur += '('; i++; }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { stack.push(ch); cur += ch; continue; }
    if (ch === '$' && cmd[i + 1] === '(') { stack.push('$('); cur += '$('; i++; continue; }
    if (stack.length && (ch === '(' || ch === ')')) { if (ch === '(') stack.push('('); else stack.pop(); cur += ch; continue; }
    if (ch === '#' && /(?:^|\s)$/.test(cur)) { const nl = cmd.indexOf('\n', i); i = (nl < 0 ? cmd.length : nl) - 1; continue; }
    if (ch === '<' && cmd[i + 1] === '<' && cmd[i + 2] !== '<') {
      const m = /^<<-?\s*(['"]?)([\w.-]+)\1/.exec(cmd.slice(i));
      if (m) { heredocs.push(m[2]); cur += m[0]; i += m[0].length - 1; continue; }
    }
    if (ch === '\n') {
      if (stack.length) cur += ' '; else end(';');
      for (const tag of heredocs.splice(0)) { // the body starts on the next line
        while (i + 1 < cmd.length) {
          const nl = cmd.indexOf('\n', i + 1), line = cmd.slice(i + 1, nl < 0 ? cmd.length : nl);
          i = nl < 0 ? cmd.length : nl;
          if (line.replace(/^\t+/, '') === tag) break;
        }
      }
      continue;
    }
    if (!stack.length) {
      const two = cmd.slice(i, i + 2);
      if (two === '&&' || two === '||') { end(two); i++; continue; }
      if (ch === '|') { end('|'); if (cmd[i + 1] === '&') i++; continue; }
      if (ch === ';') { end(';'); continue; }
      if (ch === '&' && !cur.endsWith('>') && cmd[i + 1] !== '>') { end(';'); continue; } // a background job
    }
    cur += ch;
  }
  end('');
  if (segs.length) segs[segs.length - 1].op = '';
  return segs;
}

const headOf = text => {
  let h = text.replace(/\\\n/g, ' ').replace(/^[\s({!]+/, '').replace(PREFIX_RE, '');
  while (/[)}]\s*$/.test(h) && (h.match(/[({]/g) || []).length < (h.match(/[)}]/g) || []).length) h = h.replace(/\s*[)}]\s*$/, '');
  return h.trim();
};
const REDIRECT_RE = /\s+(?:&>>?|\d*>>?)\s*\S+/g;
const redirected = head => REDIRECT_RE.test(head.replace(/\s+\d*>&\d/g, '')) && !(REDIRECT_RE.lastIndex = 0);
const STDOUT_TO_RE = /(?:^|\s)(?:&>>?|1?>>?)(?!&)\s*\S/;
const REDIRECT_TO_RE = /(?:^|\s)(?:&>>?|\d*>>?)(?!&)\s*((?:'[^']*'|"[^"]*"|[^\s;&|<>'"])+)/g;
const shortDir = dir => {
  const d = dir.replace(/^(['"])(.*)\1$/, '$2');
  return d.length > 32 && d.includes('/') ? `…/${d.split('/').filter(Boolean).slice(-2).join('/')}` : d;
};

/** One simple command's words, with quotes and `$(...)` kept whole. */
function tokens(text) {
  const out = [];
  let cur = '', depth = 0, quote = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) { cur += ch; if (ch === quote) quote = ''; continue; }
    if (ch === "'" || ch === '"') { quote = ch; cur += ch; continue; }
    if (ch === '\\') { cur += ch + (text[i + 1] ?? ''); i++; continue; }
    if (ch === '$' && text[i + 1] === '(') { depth++; cur += '$('; i++; continue; }
    if (depth && (ch === '(' || ch === ')')) { depth += ch === '(' ? 1 : -1; cur += ch; continue; }
    if (!depth && /\s/.test(ch)) { if (cur) out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}
const unquote = word => word.replace(/'([^']*)'|"([^"]*)"/g, '$1$2');
const ASSIGN_RE = /^[A-Za-z_]\w*=/;

/**
 * What a check is called. A later passing run with the same id clears an
 * earlier failure, so the name keeps what changes the check (its script, its
 * project, its directory) and drops what only shapes the output.
 */
function keyOf(head) {
  return head
    .replace(/\s+\d*>&\d/g, '')
    .replace(REDIRECT_RE, '')
    .replace(/\s+(?:-s|-q|-v+|--silent|--quiet|--verbose|--no-color|--colors?|--reporter[= ]\S+|--pretty(?:[ =](?:true|false))?)(?=\s|$)/g, '')
    .replace(/\s+--$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}
/** A directory as the hand-back names it: nothing for the project, else relative to it or shortened. */
function place(dir, project) {
  if (!project || dir === project) return project ? '' : shortDir(dir);
  const rel = relative(project, dir);
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : shortDir(dir);
}

// Files a simple command writes, copies it takes first and directories it
// deletes, so a run between a change and its undo, or in a copy thrown away
// after, can be told from a run on the code as it stands. `at` is where it runs.
// `edits` are the writes that change a file in place (a redirect, `sed -i`, a
// copy onto it), as full paths; `copyTo` is a copy's target and `taken` its sources.
function fileOps(text, expand, at = '') {
  // A `>` in quotes is text (`git commit -m "A > B"`), and in `[[ ]]` a comparison.
  const bare = text.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, q => q[0] + '_'.repeat(q.length - 2) + q[0]);
  const writes = /^[\s({!]*\[\[\s/.test(text) ? [] : [...bare.matchAll(REDIRECT_TO_RE)]
    .map(m => expand(text.slice(m.index + m[0].length - m[1].length, m.index + m[0].length)));
  const words = tokens(text.replace(REDIRECT_TO_RE, ' ').replace(/(?:^|\s)\d*>&\d/g, ' ')).map(expand).filter(Boolean);
  while (words.length && ASSIGN_RE.test(words[0])) words.shift();
  const [cmd = '', sub = ''] = words, args = words.slice(1).filter(a => !a.startsWith('-'));
  const copies = [];
  let stash = '';
  if (/^(?:cp|mv|install|rsync)$/.test(cmd) && args.length > 1) { writes.push(args[args.length - 1]); copies.push(...args.slice(0, -1)); }
  if (/^(?:sed|perl)$/.test(cmd) && words.some(w => /^-\w*i/.test(w)) && args.length) writes.push(args[args.length - 1]);
  const abs = (p, base = at) => (/[$*?`]/.test(p) ? '' : isAbsolute(p) ? resolve(p) : base ? resolve(base, p) : '');
  const edits = writes.map(f => abs(f)).filter(Boolean); // not git's: a checkout puts code back
  const copying = /^(?:cp|mv|install|rsync)$/.test(cmd) && args.length > 1;
  const copyTo = copying ? abs(args[args.length - 1]) : '', taken = copying ? copies.map(f => abs(f)).filter(Boolean) : [];
  if (cmd === 'git' && /^(?:checkout|restore)$/.test(sub)) { const at = words.indexOf('--'); writes.push(...(at > 0 ? words.slice(at + 1) : args.slice(1))); }
  if (cmd === 'git' && sub === 'stash') { const act = words.slice(2).find(w => !w.startsWith('-')) || 'push'; stash = /^(?:push|save)$/.test(act) ? 'push' : /^(?:pop|apply)$/.test(act) ? 'pop' : ''; }
  const removes = cmd === 'rm' && words.some(w => /^-\w*[rR]/.test(w)) ? args.map(a => abs(a)) : [];
  if (cmd === 'git') { // `git -C repo worktree remove --force wt`
    let k = 1, base = at;
    while (k < words.length && words[k].startsWith('-')) k += words[k] === '-C' ? (base = abs(words[k + 1] || '', base), 2) : 1;
    const rest = words.slice(k + 2).filter(w => !w.startsWith('-'));
    if (words[k] === 'worktree' && words[k + 1] === 'remove' && rest.length) removes.push(abs(rest[rest.length - 1], base));
  }
  return { writes, copies, stash, removes: removes.filter(Boolean), edits, copyTo, taken };
}

// ---------------------------------------------------------------------------
// Reading a check's outcome
// ---------------------------------------------------------------------------

// Commands before a check that do not fail in practice, so an exit code
// after `cd web && npm test` is still the test's.
const SETUP_RE = /^(?:cd|pushd|popd|export|unset|source|\.|set|nvm|ulimit|true|:|mkdir|rm|sleep)(?:\s|$)/;
// Commands that print nothing a check's verdict could be mistaken for.
const QUIET_RE = /^(?:cd|pushd|popd|export|unset|source|\.|set|nvm|ulimit|true|false|:|mkdir|rm|sleep|wait|cp|mv|ln|touch|chmod|trap|echo|printf)(?:\s|$)|^git\s(?:.*\s)?(?:-q|--quiet)(?:\s|$)|^sed\s+-i/;
// Commands that read a file: in `npm test > log; tail -20 log`, tail prints the test's output.
const READER_RE = /^(?:tail|cat|head|grep|rg|sed|awk|less|wc|cut)$/;
// Where temporary copies live. A run against one checks the copy, not the project.
const TEMP_RE = /(?:^|[\s"'=(:])(?:\/private)?\/(?:tmp|var\/folders)\//;
// A shell's "command not found" and "cannot execute": the check never ran.
const NEVER_RAN = new Set([126, 127]);
// Pipes that pass the output through. `head` cuts the end, where npm and
// most runners print their verdict, so only tsc (errors first) reads through it.
const TAIL_PIPES = new Set(['tail', 'cat', 'tee']);
const ALL_PIPES = new Set(['tail', 'cat', 'tee', 'head', 'less', 'more']);

const TS_FAIL = [/\berror TS\d+\b.*/, /This is not the tsc command you are looking for/];
// Node prints its version last when an uncaught error ends the process.
const crashed = text => /^Node\.js v\d+\.\d+\.\d+\s*$/m.test(text) && /^\s+at \S/m.test(text)
  ? (/^\w*Error\b.*$/m.exec(text) || ['crashed'])[0] : null;
// What a failed check prints: test runner summaries, compilers, crashes, and
// last, the line npm, pnpm, yarn and bun print when a script exits non-zero.
// The first one found is what the hand-back quotes.
const FAIL_SIGNS = [
  /\b[1-9]\d* (?:failed|failing|failures?|errors?)\b.*/, /(?:ℹ|#) fail [1-9].*/, /^(?:FAIL|FAILED)\b.*/m, /^--- FAIL\b.*/m, /^not ok \d+.*/m,
  /\*\* (?:BUILD|TEST) FAILED \*\*/, /^BUILD FAIL(?:ED|URE)\b.*/m, /\bBuild FAILED\./, /^Failed to compile\b.*/m, /^Type error: .*/m,
  /^error(?:\[E\d+\])?: .*/m, /\bAssertionError\b.*/, /^Traceback \(most recent call last\):/m, crashed, /^curl: \(\d+\).*/m,
  /^npm (?:ERR!|error) .*/m, /\bELIFECYCLE\b.*/, /^error Command failed with exit code [1-9].*/m, /^error: script ".*" exited with code [1-9].*/m,
];
const PASS_SIGNS = [
  /\b\d+ (?:passed|passing)\b/, /(?:ℹ|#) pass \d+/, /\btest result: ok\./, /^ok\s+(?:\d+ - |\S+\s+(?:[\d.]+m?s|\(cached\)))/m, /^PASS\b/m,
  /\*\* (?:BUILD|TEST) SUCCEEDED \*\*/, /\bBUILD SUCCESS(?:FUL)?\b/, /\bBuild succeeded\./, /\bAll checks passed!/, /\bSuccess: no issues found/,
  /\bwith 0 failures\b/, /\bCompiled successfully\b/, /\b0 errors?\b/,
];
const firstMatch = (signs, text) => {
  for (const sign of signs) { const m = typeof sign === 'function' ? sign(text) : (sign.exec(text) || [])[0]; if (m) return m; }
  return null;
};
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const STATUS_RE = /\$\{PIPESTATUS\[0\]\}|\$\{?pipestatus\[1\]\}?|\$\?/;

/**
 * The checks one Bash command ran and what each showed: `ok` is true, false,
 * or null when nothing settles it. `output` is what the command printed and
 * `code` its exit code (null when unknown). `dir` is where the command started
 * and `project` the project's directory, when known. A check after one that
 * failed in the same `&&` chain never ran and is left out.
 */
export const checkRuns = (...args) => readCommand(...args).runs;

/** checkRuns, and the code files the command changed outside its checks: `{ full, at }`, `at` the segment. */
function readCommand(command, output = '', code = null, { dir = '', project = '' } = {}) {
  const segs = splitShell(command);
  const heads = segs.map(s => headOf(s.text));
  const pipefail = /\bpipefail\b/.test(command);
  output = output.replace(/^(?:Shell cwd was reset to .*|\[exited with code \d+\])[ \t]*$/gm, '').trimEnd(); // Claude Code's notes
  const vars = new Map();
  const expand = word => unquote(word).replace(/^~(?=\/|$)/, homedir()).replace(/\$\{?([A-Za-z_]\w*)\}?/g, (m, n) => (vars.has(n) ? vars.get(n) : m));
  const ops = [], printing = [], checks = [];
  let at = dir ? resolve(dir) : '', cdText = '';
  heads.forEach((head, i) => {
    const words = tokens(segs[i].text.replace(/^[\s({!]+/, ''));
    const env = [];
    while (words.length && ASSIGN_RE.test(words[0])) env.push(words.shift());
    ops[i] = fileOps(segs[i].text, expand, at);
    if (!words.length) { // `S=/tmp/x` alone: a variable for the rest of the command
      for (const a of env) {
        const name = a.slice(0, a.indexOf('=')), value = a.slice(a.indexOf('=') + 1);
        vars.set(name, /^["']?\$\(mktemp\b/.test(value) ? `/tmp/${name}.mktemp` : expand(value));
      }
      return;
    }
    printing[i] = segs[i].op !== '|' && !(QUIET_RE.test(head) && !head.includes('$(')) && !STDOUT_TO_RE.test(head.replace(/\s\d*>&\d/g, ''));
    if (i && segs[i - 1].op === '|') return; // reads another command's output
    const to = /^cd\s+(\S+)$/.exec(head);
    if (to) {
      const d = expand(to[1]);
      at = /\$|^-$/.test(d) ? '' : isAbsolute(d) ? resolve(d) : at ? resolve(at, d) : '';
      cdText = to[1];
      return;
    }
    const kind = checkOf(head);
    if (!kind) return;
    let p = i;
    while (segs[p].op === '|') p++;
    const name = keyOf(head), where = at ? place(at, project || dir) : cdText && shortDir(cdText);
    checks.push({ ...kind, i, p, head, env, abs: at, id:`${at || cdText}\n${name}`, key: where ? `cd ${where} && ${name}` : name, pipes: heads.slice(i + 1, p + 1).map(h => h.split(/\s+/)[0]) });
  });
  const inCheck = new Set(checks.flatMap(c => heads.slice(c.i, c.p + 1).map((_, k) => c.i + k)));
  const decided = new Map();

  // A run between a change and its undo, or on a copy in a temp directory: it
  // shows whether the check catches the old code, not whether the code works.
  const trial = c => {
    const touched = new Set();
    let stashed = false;
    const isFile = f => f && f !== '/dev/null' && !NOT_CODE_RE.test(f);
    for (let j = 0; j < c.i; j++) {
      if (inCheck.has(j)) continue;
      [...ops[j].writes, ...ops[j].copies].filter(isFile).forEach(f => touched.add(f));
      stashed ||= ops[j].stash === 'push';
    }
    for (let j = c.p + 1; j < segs.length; j++) {
      if (!inCheck.has(j) && (ops[j].writes.some(f => touched.has(f)) || (stashed && ops[j].stash === 'pop'))) return true;
    }
    if (c.abs && ops.slice(c.p + 1).some(o => o.removes.some(d => c.abs === d || c.abs.startsWith(`${d}/`)))) return true;
    if (c.env.some(a => { const v = expand(a.slice(a.indexOf('=') + 1)); return TEMP_RE.test(v) && SCRIPT_FILE_RE.test(v); })) return true;
    if (!c.script) return false;
    const words = tokens(c.head.replace(REDIRECT_TO_RE, ' ')).map(expand);
    return words.slice(words.findIndex(w => SCRIPT_FILE_RE.test(w)) + 1).some(w => !w.startsWith('-') && TEMP_RE.test(w));
  };
  // Commands after the check that print its log: `npm test > log; tail -20 log`.
  const readersOf = c => {
    const logs = new Set(ops.slice(c.i, c.p + 1).flatMap(o => o.writes).filter(f => f !== '/dev/null'));
    return heads.flatMap((h, j) => (j > c.p && !(segs[j - 1].op === '|') && READER_RE.test(h.split(/\s+/)[0])
      && tokens(h).slice(1).some(w => logs.has(expand(w))) ? [j] : []));
  };
  // Whether all the output is this check's: nothing else in the command printed.
  const own = c => {
    const readers = new Set(readersOf(c));
    let reading = false;
    return segs.every((s, j) => {
      if (j >= c.i && j <= c.p) return true;
      if (!(j && segs[j - 1].op === '|')) reading = readers.has(j);
      return reading || !printing[j];
    });
  };

  // tsc's errors and xcodebuild's `** BUILD FAILED **` say whose they are, so
  // other output cannot pass for them. Only the same tool again, or a command
  // printing a file, could print some.
  const signed = c => (c.family === 'tsc' ? 'tsc' : /^xcodebuild\b/.test(c.head) ? 'xcodebuild' : '');
  const signedAlone = c => {
    const readers = new Set(readersOf(c));
    const start = j => { while (j && segs[j - 1].op === '|') j--; return j; }; // `tail` in `npm test | tail` reads no file
    return !!signed(c) && checks.every(d => d === c || signed(d) !== signed(c))
      && heads.every((h, j) => !printing[j] || readers.has(start(j)) || start(j) === c.i || !READER_RE.test(heads[start(j)].split(/\s+/)[0]));
  };
  // The exit code is the check's when nothing after it could change it.
  const exitSays = c => {
    if (code === null || NEVER_RAN.has(code)) return null;
    if (c.pipes.length && !(pipefail && c.pipes.every(t => TAIL_PIPES.has(t)))) return null;
    const before = [];
    for (let j = c.i - 1; j >= 0 && segs[j].op !== ';'; j--) before.push(j);
    const after = segs.slice(c.p, -1).map(s => s.op);
    if (code === 0) return after.every(op => op === '&&') && before.every(j => segs[j].op !== '||') ? true : null;
    const ranFirst = before.every(j => segs[j].op === '&&' && (SETUP_RE.test(heads[j]) || decided.get(j) === true));
    return after.length === 0 && ranFirst ? false : null;
  };
  // `; echo "exit=$?"`, `; echo "${PIPESTATUS[0]}"`, `&& echo OK || echo FAIL`.
  // Each echo is matched to its own line, so two `exit=` lines are not mixed up.
  const statusEchoes = heads.flatMap((h, j) => {
    const arg = h.replace(/^(?:echo|printf)\s+(?:-[neE]+\s+)*/, '');
    const tok = arg !== h && STATUS_RE.exec(arg);
    if (!tok) return [];
    const before = arg.slice(0, tok.index), bare = before.replace(/^.*\$(?:\{[^}]*\}|\w+)/, '');
    return [{ j, tok: tok[0], label: bare.replace(/['"]/g, '').trim(), anchored: bare === before }];
  });
  const echoSays = c => {
    const quiet = !c.pipes.length || (pipefail && c.pipes.every(t => TAIL_PIPES.has(t)));
    for (let j = c.p + 1, prev = segs[c.p].op; j < segs.length && /^(?:echo|printf)\s/.test(heads[j]); prev = segs[j].op, j++) {
      const status = statusEchoes.find(e => e.j === j);
      if (status) {
        if (j !== c.p + 1 || (status.tok === '$?' && !quiet)) return null;
        let n;
        if (!status.label) { // `npm test; echo $?`: only as the last line printed
          const last = /^\s*(\d+)\s*$/.exec(output.split('\n').pop());
          if (j !== segs.length - 1 || !last) return null;
          n = Number(last[1]);
        } else {
          const same = statusEchoes.filter(e => e.label === status.label && e.anchored === status.anchored);
          const all = [...output.matchAll(new RegExp(`${status.anchored ? '^[ \\t]*' : ''}${escapeRe(status.label)}[ \\t]*(\\d+)`, 'gm'))];
          if (all.length !== same.length) return null; // printed in a loop, or not at all
          n = Number(all[same.indexOf(status)][1]);
        }
        return NEVER_RAN.has(n) ? null : n === 0;
      }
      const text = heads[j].replace(/^(?:echo|printf)\s+(?:-[neE]+\s+)*/, '').replace(/^(['"])(.*)\1$/, '$2').trim();
      if (!quiet || !text || text.includes('$') || (prev !== '&&' && prev !== '||')) continue;
      if (output.split('\n').some(l => l.trim() === text)) return prev === '&&';
    }
    return null;
  };
  // What it printed, when all of the output is its own.
  const outputSays = c => {
    const alone = own(c);
    if (!alone && !signedAlone(c)) return null;
    const readers = readersOf(c).map(j => heads[j].split(/\s+/)[0]);
    // Silence counts as a pass only when the command did not end in an error.
    const kept = (!redirected(c.head) || readers.length > 0) && !(code && c.p === segs.length - 1);
    const via = [...c.pipes, ...readers];
    if (c.family === 'tsc') {
      const bad = firstMatch(TS_FAIL, output);
      if (bad) return [false, bad];
      return kept && via.every(t => ALL_PIPES.has(t)) ? [true, ''] : null; // tsc prints nothing when it passes
    }
    if (!alone) {
      const marker = /\*\* (?:BUILD|TEST|ARCHIVE|ANALYZE) (FAILED|SUCCEEDED) \*\*/.exec(output);
      return marker ? [marker[1] === 'SUCCEEDED', marker[1] === 'FAILED' ? marker[0] : ''] : null;
    }
    const bad = firstMatch(FAIL_SIGNS, output);
    if (bad) return [false, bad];
    if (c.family !== 'live' && firstMatch(PASS_SIGNS, output)) return [true, ''];
    // npm and friends print a failure line last whenever a script fails.
    const loud = !/\s(?:-s|--silent|--loglevel)\b/.test(c.head);
    return c.family === 'pm' && kept && loud && output.trim() && via.every(t => TAIL_PIPES.has(t)) ? [true, ''] : null;
  };

  // `node scripts/test-a.ts` with no such file, or xcodebuild with no such
  // project: like exit 127, the check never ran.
  const missing = c => {
    if (/^xcodebuild\b/.test(c.head)) return /^xcodebuild: error: '[^']+' does not exist/m.test(output);
    const file = c.script && tokens(c.head).map(unquote).find(w => SCRIPT_FILE_RE.test(w));
    return !!file && [...output.matchAll(/Cannot find module '([^']+)'|can't open file '([^']+)'|url: 'file:\/\/([^']+)'|^(?:\S+: )?(\S+): No such file or directory/gm)]
      .some(m => basename(m[1] || m[2] || m[3] || m[4]) === basename(file));
  };

  const lastLines = output.split('\n').filter(l => l.trim()).slice(-2).join(' ');
  const runs = [];
  let stopped = -1;
  for (const c of checks) {
    if (stopped >= 0 && segs.slice(stopped, c.i).every(s => s.op === '&&' || s.op === '|')) continue;
    stopped = -1;
    const run = { key: c.key, id: c.id, at: c.i, dir: c.abs, eco: c.eco, family: c.family, live: c.family === 'live' };
    if (trial(c)) { runs.push({ ...run, ok: null, detail: '', source: 'trial' }); continue; }
    if (missing(c)) { runs.push({ ...run, ok: null, detail: '', source: 'unknown' }); stopped = c.p; continue; }
    let ok = exitSays(c), source = 'exit', detail = '';
    if (ok === null) { ok = echoSays(c); source = 'echo'; }
    if (ok === null) { const said = outputSays(c); if (said) { [ok, detail] = said; source = 'output'; } }
    if (ok === null) source = 'unknown';
    if (ok === false && !detail) detail = (own(c) && firstMatch([...TS_FAIL, ...FAIL_SIGNS], output)) || lastLines;
    decided.set(c.i, ok);
    if (ok === false) stopped = c.p;
    runs.push({ ...run, ok, detail, source });
  }
  // A copy back onto a file the command copied away first is an undo, not a change.
  const taken = new Set(), edits = [];
  ops.forEach((o, j) => {
    if (inCheck.has(j)) return;
    for (const f of o.edits) if (!(f === o.copyTo && taken.has(f))) edits.push({ full: f, at: j });
    o.taken.forEach(f => taken.add(f));
  });
  return { runs, edits };
}

// ---------------------------------------------------------------------------
// Reading the turn
// ---------------------------------------------------------------------------

// Tools that change code. Notes, logs and data rarely affect a check, and a
// file outside the project (a script in /tmp) is scratch, not the code.
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);
const NOT_CODE_RE = /\.(?:md|mdx|markdown|txt|rst|log|out|tmp|csv|tsv|jsonl|patch|diff|orig|bak)$/i;
const gitRoots = new Map();
const gitRoot = dir => {
  if (!gitRoots.has(dir)) gitRoots.set(dir, existsSync(join(dir, '.git')) ? dir : dirname(dir) !== dir ? gitRoot(dirname(dir)) : '');
  return gitRoots.get(dir);
};
const under = (path, dir) => path.startsWith(dir.endsWith('/') ? dir : `${dir}/`);
const isCode = (path, dirs) => !NOT_CODE_RE.test(path) && (dirs.some(d => d && under(path, d)) || !!gitRoot(dirname(path)));
// A change reaches a check when it is in the same repository (or, outside
// one, under the check's directory) and in code the check reads: tsc reads
// only TypeScript, JavaScript and its JSON config.
const touches = (run, edit) => (!run.dir || under(edit.full, gitRoot(run.dir) || run.dir))
  && (run.family === 'tsc' ? edit.eco === 'js' || /\.json$/i.test(edit.path) : !run.eco || !edit.eco || run.eco === edit.eco);

const textOf = c => typeof c === 'string' ? c
  : Array.isArray(c) ? c.map(x => (x && x.type === 'text' ? x.text || '' : '')).join('\n') : '';
const clip = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
const hasToolResult = o => Array.isArray(o.message?.content) && o.message.content.some(x => x && x.type === 'tool_result');

const parse = lines => lines.flatMap(line => {
  if (!line.trim()) return [];
  try { return [JSON.parse(line)]; } catch { return []; /* partial line */ }
});

/**
 * The person's prompt: a user entry with text and no tool results. A notice
 * that a background task finished is not one; the turn goes on through it.
 */
export function isPrompt(o) {
  if (o.type !== 'user' || o.isMeta || o.isSidechain || hasToolResult(o)) return false;
  if (o.origin && o.origin.kind && o.origin.kind !== 'human') return false;
  const text = textOf(o.message && o.message.content);
  return !!text.trim() && !text.trimStart().startsWith('<task-notification>');
}

/** This hook's own hand-back, as Claude Code records it. */
function isHandBack(o) {
  const text = o.type === 'attachment' && /hook/.test(String(o.attachment && o.attachment.type)) ? JSON.stringify(o.attachment)
    : o.type === 'system' && /hook/.test(String(o.subtype)) ? JSON.stringify(o)
    : o.type === 'user' && !hasToolResult(o) ? textOf(o.message && o.message.content) : '';
  return text.includes('[Kahneman Loop: ');
}

/** Claude Code's notices that background commands finished. */
function notices(o) {
  const a = o.type === 'attachment' && o.attachment && o.attachment.type === 'queued_command' ? o.attachment.prompt : null;
  const text = o.type === 'user' && !hasToolResult(o) ? textOf(o.message && o.message.content) : typeof a === 'string' ? a : textOf(a);
  if (!text.includes('<task-notification>')) return [];
  return [...text.matchAll(/<task-notification>([\s\S]*?)<\/task-notification>/g)].map(([, body]) => {
    const tag = t => (new RegExp(`<${t}>([\\s\\S]*?)</${t}>`).exec(body) || [])[1] || '';
    const code = /exit code (\d+)/.exec(tag('summary'));
    return { id: tag('tool-use-id'), code: code ? Number(code[1]) : null, file: tag('output-file') };
  });
}

/** The end of a background command's output file, where verdicts are. */
function readTail(path, max = 64 * 1024) {
  if (!path) return '';
  let fd;
  try {
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size, n = Math.min(size, max), buf = Buffer.alloc(n);
    readSync(fd, buf, 0, n, size - n);
    return buf.toString('utf8');
  } catch { return ''; } finally { if (fd !== undefined) closeSync(fd); }
}

/**
 * The current turn's checks: `failures` whose latest run failed, and `stale`
 * ones that passed before Claude last edited code, when no check ran since.
 * `runs` is every check run, for measuring the hook (eval/claude-code-scan.mjs).
 * `cwd` is the project directory; `readOutput` reads a background command's output file.
 * Each entry's own `cwd` is where the shell was when Claude ran the command.
 */
export function readTurn(lines, { cwd = '', readOutput = readTail } = {}) {
  const entries = parse(lines);
  let start = 0;
  entries.forEach((o, i) => { if (isPrompt(o) || isHandBack(o)) start = i; });
  const calls = new Map();
  const editCalls = new Map();
  const background = new Map();
  const runs = [];
  const edits = []; // each code change, with how many checks had run before it
  for (const o of entries.slice(start)) {
    if (o.isSidechain) continue;
    for (const n of notices(o)) {
      const bg = background.get(n.id);
      if (!bg) continue;
      const judged = checkRuns(bg.command, readOutput(n.file), n.code, { dir: bg.dir, project: cwd });
      for (const run of bg.runs) Object.assign(run, judged.find(r => r.at === run.at) || {}, { source: 'background' });
    }
    const c = o.message && o.message.content;
    if (!Array.isArray(c)) continue;
    for (const x of c) {
      if (!x) continue;
      if (o.type === 'assistant' && x.type === 'tool_use' && x.name === 'Bash') {
        calls.set(x.id, { command: String((x.input && x.input.command) || ''), background: !!(x.input && x.input.run_in_background), dir: o.cwd || '' });
      } else if (o.type === 'assistant' && x.type === 'tool_use' && EDIT_TOOLS.has(x.name)) {
        const path = String((x.input && (x.input.file_path || x.input.notebook_path)) || '');
        if (path && isCode(path, [cwd])) editCalls.set(x.id, path);
      } else if (o.type === 'user' && x.type === 'tool_result' && calls.has(x.tool_use_id)) {
        const { command, background: bg, dir } = calls.get(x.tool_use_id);
        const out = textOf(x.content);
        // A failed command reads "Exit code N" first. Any other error (a
        // denied permission, a blocked call, a timeout) is not the check's outcome.
        if (x.is_error && !/^Exit code \d+/.test(out)) continue;
        const started = bg || /^Command running in background\b/.test(out);
        const code = started ? null : x.is_error ? Number(/^Exit code (\d+)/.exec(out)[1]) : 0;
        const read = readCommand(command, started ? '' : out.replace(/^Exit code \d+\n?/, ''), code, { dir, project: cwd });
        // `sed -i`, a redirect or a copy onto code changes it as an edit does.
        for (const w of read.edits) {
          if (isCode(w.full, [cwd])) edits.push({ path: basename(w.full), full: w.full, eco: ecoOfFile(w.full), after: runs.length + read.runs.filter(r => r.at < w.at).length });
        }
        if (started) {
          const runsNow = read.runs.map(r => ({ ...r, ok: null, source: 'background', command }));
          if (runsNow.length) background.set(x.tool_use_id, { command, dir, runs: runsNow });
          runs.push(...runsNow);
          continue;
        }
        runs.push(...read.runs.map(r => ({ ...r, command })));
      } else if (o.type === 'user' && x.type === 'tool_result' && editCalls.has(x.tool_use_id) && !x.is_error) {
        const path = editCalls.get(x.tool_use_id);
        edits.push({ path: basename(path), full: path, eco: ecoOfFile(path), after: runs.length });
      }
    }
  }
  const latest = new Map();
  runs.forEach((r, i) => { latest.delete(r.id); latest.set(r.id, i); });
  const failures = [...latest.values()].map(i => runs[i]).filter(r => r.ok === false);
  const last = edits[edits.length - 1];
  const stale = !last || last.after < runs.length ? [] : [...latest.values()].filter(i => runs[i].ok === true && !runs[i].live).flatMap(i => {
    const changed = [...new Set(edits.filter(e => e.after > i && touches(runs[i], e)).map(e => e.path))];
    if (!changed.length) return [];
    const more = changed.length > 3 ? ` and ${changed.length - 3} more` : '';
    return [{ key: runs[i].key, ok: true, detail: `passed, then you changed ${changed.slice(0, 3).join(', ')}${more}` }];
  });
  return { failures, stale, runs };
}

/** The checks of the current turn whose latest run failed. */
export const standingFailures = (lines, opts) => readTurn(lines, opts).failures;

const name = runs => runs.slice(0, 2).map(f => `\`${clip(f.key, 60)}\` (${clip(f.detail, 160)})`).join('; ');

export function handBackReason(failures) {
  return `[Kahneman Loop: your own check this turn is still failing: ${name(failures)}. A failed check is not done, whatever your last message said. `
    + 'Fix the cause and run it again. If you cannot fix it, tell the user plainly that it failed and why.]';
}

export function staleReason(stale) {
  return `[Kahneman Loop: you changed the code after your own check passed: ${name(stale)}. That pass checked the code before the change, so it does not show the change works. `
    + 'Run it again before you say it works. If you cannot, tell the user plainly that the change is not checked.]';
}

/**
 * The line the user sees (Claude Code shows a hook's `systemMessage`). Claude
 * seemed to be done and is working again; this says why.
 */
export function statusLine({ failures, stale }) {
  const named = runs => runs.slice(0, 2).map(f => `\`${clip(f.key, 60)}\``).join(' and ');
  if (failures.length) return `Kahneman Loop: ${named(failures)} failed this turn, so Claude is taking another look before it finishes.`;
  if (stale.length) return `Kahneman Loop: the code changed after ${named(stale)} passed, so Claude is checking again before it finishes.`;
  return '';
}

/**
 * The transcript's last lines, enough to hold the current turn. Long sessions
 * grow past what one string can hold, so read back from the end until the
 * turn's start is in view.
 */
export function readTurnLines(path, maxBytes = 256 * 2 ** 20) {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    for (let want = 2 ** 20; ; want *= 4) {
      const n = Math.min(size, want, maxBytes);
      const buf = Buffer.alloc(n);
      readSync(fd, buf, 0, n, size - n);
      const lines = buf.toString('utf8').split('\n');
      if (n < size) lines.shift(); // starts mid-line
      if (n === size || n === maxBytes || parse(lines).some(o => isPrompt(o) || isHandBack(o))) return lines;
    }
  } finally {
    closeSync(fd);
  }
}

function main() {
  let input = {};
  try { input = JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { return; }
  if (input.stop_hook_active || !input.transcript_path) return;
  let lines;
  try { lines = readTurnLines(input.transcript_path); } catch { return; }
  // Claude Code gives hooks the project's directory; `cwd` follows the shell's `cd`.
  const turn = readTurn(lines, { cwd: process.env.CLAUDE_PROJECT_DIR || input.cwd });
  const { failures, stale } = turn;
  const reason = failures.length ? handBackReason(failures) : stale.length ? staleReason(stale) : '';
  if (reason) process.stdout.write(JSON.stringify({ decision: 'block', reason, systemMessage: statusLine(turn) }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
