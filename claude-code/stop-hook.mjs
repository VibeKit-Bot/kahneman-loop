#!/usr/bin/env node
// The Kahneman Loop's hand-back for Claude Code: a Stop hook.
//
// When Claude is about to end its turn and a check it ran this turn (tests,
// build, typecheck, lint, `curl -f`) is still failing, the turn is not over:
// the failure goes back to Claude once, and it fixes the cause or says plainly
// that it failed. Never a loop: Claude Code sets `stop_hook_active` on the
// stop that follows a hook's block, and this hook lets that one through.
//
// Register in .claude/settings.json (or ~/.claude/settings.json):
//   { "hooks": { "Stop": [ { "hooks": [ { "type": "command",
//       "command": "node /path/to/kahneman-loop/claude-code/stop-hook.mjs" } ] } ] } }
//
// Zero dependencies. Reads the session transcript only; runs nothing.
import { closeSync, fstatSync, openSync, readFileSync, readSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// A command that checks something. A later passing run with the same key
// clears an earlier failure.
export const CHECK_RE = /\b(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|build|lint|typecheck|type-check|check)\b|npx\s+(?:tsc|vitest|jest|playwright\s+test|eslint)\b|tsc\b|pytest\b|python3?\s+-m\s+(?:pytest|unittest|mypy)\b|go\s+(?:test|build|vet)\b|cargo\s+(?:test|build|check|clippy)\b|make\s+(?:test|check)\b|mypy\b|ruff\s+check\b|node\s+--test\b|deno\s+test\b|curl\s+-[A-Za-z]*f[A-Za-z]*\b)/;

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

/** The checks of the current turn whose latest run failed. */
export function standingFailures(lines) {
  const entries = parse(lines);
  let start = 0;
  entries.forEach((o, i) => { if (isPrompt(o)) start = i; });
  const calls = new Map();
  const latest = new Map();
  for (const o of entries.slice(start)) {
    if (o.isSidechain) continue;
    const c = o.message && o.message.content;
    if (!Array.isArray(c)) continue;
    for (const x of c) {
      if (!x) continue;
      if (o.type === 'assistant' && x.type === 'tool_use' && x.name === 'Bash') {
        const m = String((x.input && x.input.command) || '').match(CHECK_RE);
        if (m) calls.set(x.id, m[0].replace(/\s+/g, ' '));
      } else if (o.type === 'user' && x.type === 'tool_result' && calls.has(x.tool_use_id)) {
        const out = textOf(x.content);
        // A failed command reads "Exit code N" first. Any other error (a
        // denied permission, a blocked call) is not the check's outcome.
        if (x.is_error && !/^Exit code \d+/.test(out)) continue;
        const key = calls.get(x.tool_use_id);
        latest.delete(key);
        latest.set(key, { key, ok: !x.is_error, detail: out.split('\n').filter(l => l.trim()).slice(-2).join(' ') });
      }
    }
  }
  return [...latest.values()].filter(r => !r.ok);
}

export function handBackReason(failures) {
  const named = failures.slice(0, 2).map(f => `\`${clip(f.key, 60)}\` (${clip(f.detail, 160)})`).join('; ');
  return `[Kahneman Loop: your own check this turn is still failing: ${named}. A failed check is not done, whatever your last message said. `
    + 'Fix the cause and run it again. If you cannot fix it, tell the user plainly that it failed and why.]';
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
  const failures = standingFailures(lines);
  if (failures.length) process.stdout.write(JSON.stringify({ decision: 'block', reason: handBackReason(failures) }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
