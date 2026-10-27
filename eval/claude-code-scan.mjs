#!/usr/bin/env node
// Replay the Claude Code Stop hook over your own past sessions, for free: no
// model calls, nothing leaves your machine. At every point where Claude ended
// a turn, it runs the hook's own logic on the transcript as it stood then and
// records whether the hook would have handed back, and why.
//
//   node eval/claude-code-scan.mjs                     # every session in ~/.claude/projects
//   node eval/claude-code-scan.mjs --out fires.jsonl ~/.claude/projects/-Users-me-code-app
//
// Prints totals. Writes each would-be hand-back to the --out file (default
// claude-code-fires.jsonl) with the prompt, the checks and Claude's reply, so
// you can read them and judge: did the hand-back catch a reply that said done
// when the check said otherwise, or was it noise?
//
// Sessions are read as they are. After a would-be hand-back the real session
// went on as if none happened, so the scan counts each failure once and reads
// the turn from that point, as the hook does after a real one.
import { createReadStream, readdirSync, statSync, writeFileSync, appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { isPrompt, readTurn, statusLine } from '../claude-code/stop-hook.mjs';

const args = process.argv.slice(2);
const outAt = args.indexOf('--out');
const out = outAt >= 0 ? args.splice(outAt, 2)[1] : 'claude-code-fires.jsonl';
const roots = args.length ? args : [join(homedir(), '.claude', 'projects')];

const sessions = [];
const walk = p => {
  const s = statSync(p);
  if (s.isFile()) { if (p.endsWith('.jsonl')) sessions.push(p); return; }
  for (const name of readdirSync(p)) if (name !== 'subagents') walk(join(p, name));
};
roots.forEach(walk);

const textOf = c => typeof c === 'string' ? c
  : Array.isArray(c) ? c.map(x => (x && x.type === 'text' ? x.text || '' : '')).join('\n') : '';
const isNotice = o => o.type === 'user' && !isPrompt(o) && textOf(o.message && o.message.content).includes('<task-notification>');
// Stands in for the hook's own hand-back, so the turn is read from after it.
const HANDED_BACK = JSON.stringify({ type: 'attachment', attachment: { type: 'hook_blocking_error', hookEvent: 'Stop', blockingError: { blockingError: '[Kahneman Loop: (scan)]' } } });

const totals = { sessions: sessions.length, turns: 0, stops: 0, stopsWithCheck: 0, failed: 0, stale: 0 };
const runs = { exit: 0, echo: 0, output: 0, background: 0, trial: 0, unknown: 0, passed: 0, failed: 0 };
const seen = new Set(); // resumed sessions write the same entries again
writeFileSync(out, '');

for (const file of sessions) {
  let turn = null; // the lines since the person's prompt, and what the scan needs to report
  let cwd = '';
  const stop = () => {
    if (!turn || !turn.ended) return;
    turn.ended = false;
    totals.stops++;
    const { failures, stale, runs: all } = readTurn(turn.lines, { cwd });
    const fresh = all.slice(turn.counted);
    turn.counted = all.length;
    for (const r of fresh) { runs[r.source]++; if (r.ok === true) runs.passed++; if (r.ok === false) runs.failed++; }
    if (!all.length) return;
    totals.stopsWithCheck++;
    const kind = failures.length ? 'failed' : stale.length ? 'stale' : '';
    if (!kind) return;
    totals[kind]++;
    appendFileSync(out, JSON.stringify({
      session: basename(file, '.jsonl'), at: turn.at, kind,
      checks: (kind === 'failed' ? failures : stale).map(r => ({ key: r.key, detail: r.detail, read: r.source, command: r.command })),
      status: statusLine({ failures, stale }),
      prompt: turn.prompt.slice(0, 300), reply: turn.reply.slice(-1200),
    }) + '\n');
    turn.lines.push(HANDED_BACK);
    turn.counted = 0; // the next read starts after the hand-back
  };
  const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (o.uuid) { if (seen.has(o.uuid)) continue; seen.add(o.uuid); }
    if (!cwd && o.cwd) cwd = o.cwd;
    if (isPrompt(o) || isNotice(o)) stop();
    if (isPrompt(o)) {
      totals.turns++;
      turn = { lines: [], counted: 0, ended: false, at: o.timestamp || '', prompt: textOf(o.message.content).replace(/\s+/g, ' '), reply: '' };
    }
    if (!turn) continue;
    turn.lines.push(line);
    if (o.type !== 'assistant' || o.isSidechain) continue;
    const said = textOf(o.message && o.message.content);
    if (said.trim()) turn.reply = said;
    const reason = o.message && o.message.stop_reason;
    if (reason) turn.ended = reason === 'end_turn' || reason === 'stop_sequence';
  }
  stop();
}

const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : '-');
const judged = runs.passed + runs.failed;
const all = runs.exit + runs.echo + runs.output + runs.background + runs.trial + runs.unknown;
console.log(`${totals.sessions} sessions, ${totals.turns} turns, ${totals.stops} stops.`);
console.log(`${totals.stopsWithCheck} stops had a check in their turn. The hook would hand back at ${totals.failed + totals.stale}: ${totals.failed} failed, ${totals.stale} stale.`);
console.log(`Check runs: ${all}. Outcome read for ${judged} (${pct(judged, all)}): ${runs.passed} passed, ${runs.failed} failed.`);
console.log(`  read from: exit code ${runs.exit}, echoed status ${runs.echo}, output ${runs.output}; background ${runs.background}; trials on old or temp code ${runs.trial}; unknown ${runs.unknown}.`);
console.log(`Each would-be hand-back is in ${out}. Read them: a catch is a reply that says done while its own check says otherwise.`);
