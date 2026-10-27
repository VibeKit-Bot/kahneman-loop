#!/usr/bin/env node
// The Kahneman Loop's hand-back for Claude Code: a Stop hook.
//
// When Claude is about to end its turn and a check it ran this turn (tests,
// build, typecheck, lint, `curl -f`) is still failing, the turn is not over:
// the failure goes back to Claude once, and it fixes the cause or says plainly
// that it failed. The same goes when Claude edited code after its last check
// passed and ran no check since: that pass checked code that no longer exists.
// Never a loop: Claude Code sets `stop_hook_active` on the stop that follows a
// hook's block, and this hook lets that one through.
//
// Register in .claude/settings.json (or ~/.claude/settings.json):
//   { "hooks": { "Stop": [ { "hooks": [ { "type": "command",
//       "command": "node /path/to/kahneman-loop/claude-code/stop-hook.mjs" } ] } ] } }
//
// Zero dependencies. Reads the session transcript only; runs nothing.
import { closeSync, fstatSync, openSync, readFileSync, readSync } from 'node:fs';
import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';

// A command that checks something. A later passing run with the same key
// clears an earlier failure.
export const CHECK_RE = /\b(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|build|lint|typecheck|type-check|check)\b|npx\s+(?:tsc|vitest|jest|playwright\s+test|eslint)\b|tsc\b|pytest\b|python3?\s+-m\s+(?:pytest|unittest|mypy)\b|go\s+(?:test|build|vet)\b|cargo\s+(?:test|build|check|clippy)\b|make\s+(?:test|check)\b|mypy\b|ruff\s+check\b|node\s+--test\b|deno\s+test\b|curl\s+-[A-Za-z]*f[A-Za-z]*\b)/;

// Tools that change code. Docs and notes rarely affect a check, so they don't
// count. A heuristic: a page written in .mdx, or a requirements.txt, slips by.
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);
const NOT_CODE_RE = /\.(?:md|mdx|markdown|txt|rst)$/i;

const textOf = c => typeof c === 'string' ? c
  : Array.isArray(c) ? c.map(x => (x && x.type === 'text' ? x.text || '' : '')).join('\n') : '';
const clip = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);

const parse = lines => lines.flatMap(line => {
  if (!line.trim()) return [];
  try { return [JSON.parse(line)]; } catch { return []; /* partial line */ }
});

// The turn starts at the person's prompt: a user entry with text and no tool results.
function isPrompt(o) {
  if (o.type !== 'user' || o.isMeta || o.isSidechain) return false;
  const c = o.message && o.message.content;
  return !(Array.isArray(c) && c.some(x => x && x.type === 'tool_result')) && !!textOf(c).trim();
}

/**
 * The current turn's checks: `failures` whose latest run failed, and `stale`
 * ones that passed before Claude last edited code, when no check ran since.
 */
export function readTurn(lines) {
  const entries = parse(lines);
  let start = 0;
  entries.forEach((o, i) => { if (isPrompt(o)) start = i; });
  const calls = new Map();
  const editCalls = new Map();
  const runs = [];
  const edits = []; // each code change, with how many checks had run before it
  for (const o of entries.slice(start)) {
    if (o.isSidechain) continue;
    const c = o.message && o.message.content;
    if (!Array.isArray(c)) continue;
    for (const x of c) {
      if (!x) continue;
      if (o.type === 'assistant' && x.type === 'tool_use' && x.name === 'Bash') {
        const m = String((x.input && x.input.command) || '').match(CHECK_RE);
        if (m) calls.set(x.id, m[0].replace(/\s+/g, ' '));
      } else if (o.type === 'assistant' && x.type === 'tool_use' && EDIT_TOOLS.has(x.name)) {
        const path = String((x.input && (x.input.file_path || x.input.notebook_path)) || '');
        if (path && !NOT_CODE_RE.test(path)) editCalls.set(x.id, basename(path));
      } else if (o.type === 'user' && x.type === 'tool_result' && calls.has(x.tool_use_id)) {
        const out = textOf(x.content);
        // A failed command reads "Exit code N" first. Any other error (a
        // denied permission, a blocked call) is not the check's outcome.
        if (x.is_error && !/^Exit code \d+/.test(out)) continue;
        runs.push({ key: calls.get(x.tool_use_id), ok: !x.is_error, detail: out.split('\n').filter(l => l.trim()).slice(-2).join(' ') });
      } else if (o.type === 'user' && x.type === 'tool_result' && editCalls.has(x.tool_use_id) && !x.is_error) {
        edits.push({ path: editCalls.get(x.tool_use_id), after: runs.length });
      }
    }
  }
  const latest = new Map();
  runs.forEach((r, i) => { latest.delete(r.key); latest.set(r.key, i); });
  const failures = [...latest.values()].map(i => runs[i]).filter(r => !r.ok);
  const last = edits[edits.length - 1];
  const stale = !last || last.after < runs.length ? [] : [...latest.values()].filter(i => runs[i].ok).map(i => {
    const changed = [...new Set(edits.filter(e => e.after > i).map(e => e.path))];
    const more = changed.length > 3 ? ` and ${changed.length - 3} more` : '';
    return { key: runs[i].key, ok: true, detail: `passed, then you changed ${changed.slice(0, 3).join(', ')}${more}` };
  });
  return { failures, stale };
}

/** The checks of the current turn whose latest run failed. */
export const standingFailures = lines => readTurn(lines).failures;

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
 * The transcript's last lines, enough to hold the current turn. Long sessions
 * grow past what one string can hold, so read back from the end until the
 * turn's prompt is in view.
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
      if (n === size || n === maxBytes || parse(lines).some(isPrompt)) return lines;
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
  const { failures, stale } = readTurn(lines);
  const reason = failures.length ? handBackReason(failures) : stale.length ? staleReason(stale) : '';
  if (reason) process.stdout.write(JSON.stringify({ decision: 'block', reason }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
