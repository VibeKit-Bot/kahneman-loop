/**
 * The Kahneman Loop, after Kahneman's WYSIATI ("What You See Is All There
 * Is"). An agent judges only from what is in its context. When a tool result
 * says "deploy started", the agent tells the user "it's live", because
 * nothing in front of it says otherwise. When its own check fails, it still
 * writes "verified", because the failure sits twenty steps back and the plan
 * sits right here.
 *
 * Two fixes, both measured on production traffic (README.md, eval/RESULTS.md):
 *
 *   1. Verdict-first tool results. Every result that does NOT establish the
 *      outcome says so in its first field, in plain words: "NOT checked",
 *      "NOT live yet". Cheap (about 86 prompt tokens per affected result).
 *
 *   2. Hand-back once. When the agent is about to end its turn and one of its
 *      own checks from this turn is still failing, or it changed the code
 *      after its last check passed, the turn is not over: the fact goes back
 *      to the agent as one message, once, and the answer to that message is
 *      the reply the user reads. Never a loop.
 *
 * Zero dependencies. Copy this file into your harness. Node 22.6+ runs it as
 * is (type stripping); any TypeScript toolchain compiles it.
 */

// ---------------------------------------------------------------------------
// 1. Verdict-first tool results
// ---------------------------------------------------------------------------

/** The sentences a verdict is made of. Keep them short, literal and first. */
export const verdict = {
  /** The tool ran but could not look, or was refused before it ran. */
  notChecked: (why: string): string => `NOT checked: ${why}`,
  /** The call was refused before anything ran (bad arguments, policy, auth). */
  refused: (error: string): string => `NOT checked: the call was refused before anything ran: ${error}`,
  /** An async job that has not reached its terminal state. */
  notDoneYet: (what: string, status: string, doneWhen: string): string =>
    `NOT ${what} yet: this job is "${status}". It is ${what} only when ${doneWhen}.`,
  /** An async job that ended badly. */
  failed: (what: string, detail?: string): string => `FAILED: ${what}${detail ? `: ${detail}` : ''}. Not verified.`,
  /** The outcome was observed directly. */
  confirmed: (what: string): string => `Confirmed: ${what}.`,
};

/**
 * Put the verdict in front of a JSON tool result, so it is the first thing
 * the model reads. Keys already on the result keep their values but come
 * after `verified` and `verdict`.
 */
export function withVerdict<T extends Record<string, unknown>>(
  result: T,
  text: string,
  verified = false,
): { verified: boolean; verdict: string } & T {
  const { verified: _v, verdict: _d, ...rest } = result as Record<string, unknown>;
  return { verified, verdict: text, ...rest } as { verified: boolean; verdict: string } & T;
}

/**
 * The verdict for an async job status (deploys, builds, sends, payments).
 * `done` and `failed` list your system's terminal statuses; anything else is
 * still in progress, which is exactly the state agents misreport as done.
 */
export function jobVerdict(
  job: { status: string },
  opts: { what?: string; done?: string[]; failed?: string[] } = {},
): { verified: boolean; verdict: string } {
  const what = opts.what ?? 'live';
  const done = opts.done ?? ['done', 'succeeded', 'success', 'completed'];
  const failed = opts.failed ?? ['failed', 'error', 'errored', 'cancelled', 'canceled'];
  if (done.includes(job.status)) return { verified: true, verdict: verdict.confirmed(`this job finished (status "${job.status}")`) };
  if (failed.includes(job.status)) return { verified: false, verdict: verdict.failed(`this job ended with status "${job.status}"`) };
  return { verified: false, verdict: verdict.notDoneYet(what, job.status, `its status is "${done[0]}"`) };
}

// ---------------------------------------------------------------------------
// 2. Hand-back once
// ---------------------------------------------------------------------------

export interface CheckRun {
  /** Which check this was. A later passing run with the same key clears an earlier failure. */
  key: string;
  ok: boolean;
  /** What failed, in a few words. Goes into the hand-back verbatim. */
  detail?: string;
}

/**
 * The checks the agent ran this turn: tests, a build, a screenshot that
 * clicked something, a curl of the live URL. Record each run from your tool
 * executor, and each code change; start a new ledger per turn.
 */
export class CheckLedger {
  private runs: CheckRun[] = [];
  /** Each code change, with how many checks had run before it. */
  private edits: { what: string; after: number }[] = [];

  record(key: string, ok: boolean, detail?: string): void {
    this.runs.push({ key, ok, detail });
  }

  /** The agent changed code (an edit, a patch, a write). Leave out docs and notes, which rarely affect a check. */
  recordEdit(what: string): void {
    this.edits.push({ what, after: this.runs.length });
  }

  /** Checks whose most recent run failed. */
  standingFailures(): CheckRun[] {
    const latest = new Map<string, CheckRun>();
    for (const run of this.runs) {
      latest.delete(run.key);
      latest.set(run.key, run);
    }
    return [...latest.values()].filter(run => !run.ok);
  }

  /**
   * Checks that passed before the code last changed, when nothing checked it
   * since. The pass is still in the agent's context and still reads as
   * evidence, but it checked code that no longer exists. Each comes back with
   * what changed after it as its detail. Any check after the last change
   * clears them all: the agent looked again.
   */
  staleChecks(): CheckRun[] {
    const last = this.edits[this.edits.length - 1];
    if (!last || last.after < this.runs.length) return [];
    const latest = new Map<string, number>();
    this.runs.forEach((run, i) => {
      latest.delete(run.key);
      latest.set(run.key, i);
    });
    return [...latest.entries()]
      .filter(([, i]) => this.runs[i].ok)
      .map(([key, i]) => {
        const changed = [...new Set(this.edits.filter(e => e.after > i).map(e => e.what))];
        const more = changed.length > 3 ? ` and ${changed.length - 3} more` : '';
        return { key, ok: true, detail: `passed, then you changed ${changed.slice(0, 3).join(', ')}${more}` };
      });
  }
}

// Brackets are stripped because the hand-back is itself one bracketed message.
const clip = (s: string, n: number): string => s.replace(/\s+/g, ' ').replace(/[[\]]/g, '').trim().slice(0, n);

/**
 * How the answer to any hand-back is written. The answer replaces the reply
 * it corrects, so it is the only reply the user reads, and it has to be the
 * whole reply. Told only to say what it changed, the agent says only that: the
 * first hand-back of a first build on our traffic (2026-10-27) answered with
 * one line about the button it fixed, and the person never got the list of
 * what was built. The agent's earlier failure was answering the hand-back
 * instead of the user ("you're right, the previous check failed"), hence the
 * last sentence. Use it in hand-backs of your own too (a page your harness
 * loaded, a build it ran), so every answer is written the same way.
 */
export function replyReplaced(language?: string): string {
  return (
    `Your reply above is replaced by the one you write now, so it is the only reply the user reads: write it to them ${language ? `in ${clip(language, 40)}` : 'in their language'} as the whole reply, ` +
    'with everything from this turn they need, what you changed and what is true now. Repeat nothing this check disproved unless it now passes. ' +
    'They never saw this check, so do not mention it.'
  );
}

/**
 * The one message that hands a failed check, or a pass the code has since
 * moved past, back. Null when there is nothing to hand back, or when this
 * turn already used its hand-back (one round, never a loop).
 *
 * Deliberately NOT gated on what the reply says. A regex for "it's done"
 * misses other languages and other phrasings, and on our traffic no text rule
 * we tried separated bad replies from fine ones (eval/RESULTS.md). An honest
 * reply that already says the check failed costs one continuation, which is
 * cheaper than the user finding the failure and typing it back.
 *
 * A failure that already came back on an earlier turn asks for the cause
 * instead of another run. Told "fix the cause and run the check again" turn
 * after turn, the agent runs the check again: on our traffic (2026-10-28) a
 * chat check whose reply never came failed on six turns of one day, and each
 * hand-back bought one more run of it, one more honest "still failing", and
 * no look at why.
 */
export function handBack(input: {
  failures: CheckRun[];
  /** `ledger.staleChecks()`. Handed back only when nothing is failing. */
  stale?: CheckRun[];
  alreadyHandedBack: boolean;
  /**
   * Keys of checks still failing at the end of an earlier turn. The ledger
   * starts fresh each turn, so keep these yourself, per session: add the
   * turn's `standingFailures()` when it ends, and drop a key when a later run
   * of its check passes.
   */
  failedBefore?: readonly string[];
  /** The language the user writes in, if you know it. */
  language?: string;
  /** How to run the check again in your harness, e.g. "render the page again and click the control you changed". */
  recheck?: string;
  /**
   * Anything your harness knows that gets the check through, said right after
   * the failures (a saved test login, why it stopped). It is your own text and
   * goes in exactly as given: a saved login named `staff[west]` must reach the
   * agent as that name, or the agent asks for a login that does not exist.
   */
  note?: string;
}): string | null {
  if (input.alreadyHandedBack) return null;
  const named = (runs: CheckRun[]): string =>
    runs
      .slice(0, 2)
      .map(f => `${clip(f.key, 120)}${f.detail ? ` (${clip(f.detail, 160)})` : ''}`)
      .join('; ');
  const note = input.note?.trim() ? ` ${input.note.trim()}` : '';
  const before = new Set(input.failedBefore ?? []);
  const repeated = input.failures.filter(f => before.has(f.key));
  if (repeated.length) {
    return (
      `[System: your own check this turn came back failed: ${named([...repeated, ...input.failures.filter(f => !before.has(f.key))])}.${note} ` +
      'It also failed on an earlier turn, so running it again before you change anything will fail again. A failed check is not done, whatever the reply says. ' +
      `Find the cause first: read the error, the logs and the code the check goes through. Fix it, then ${input.recheck || 'run the check again'}. ` +
      `If you cannot find or fix the cause, say plainly that it still fails, what you tried and what you need to fix it. ` +
      `${replyReplaced(input.language)}]`
    );
  }
  if (input.failures.length) {
    return (
      `[System: your own check this turn came back failed: ${named(input.failures)}.${note} A failed check is not done, whatever the reply says. ` +
      `Fix the cause and ${input.recheck || 'run the check again'}. If you cannot fix it, say plainly that it failed and why. ` +
      `${replyReplaced(input.language)}]`
    );
  }
  if (input.stale?.length) {
    return (
      `[System: you changed the code after your own check passed: ${named(input.stale)}.${note} That pass checked the code before the change, so it does not show the change works. ` +
      `Before you say it works, ${input.recheck || 'run the check again'}. If you cannot, say plainly that the change is not checked. ` +
      `${replyReplaced(input.language)}]`
    );
  }
  return null;
}

export interface RecheckStatus {
  kind: 'failed' | 'stale';
  /** The checks being looked at again, at most two. */
  checks: string[];
  /** A plain English line to show the user. */
  text: string;
}

/**
 * What to show the user while a hand-back runs. The agent seemed to be done
 * and is working again; without a word, that reads as a stall or a second
 * answer nobody asked for. Same order as handBack: a failure before a stale
 * pass. `kind` and `checks` are there for a harness that writes its own copy
 * or shows it in the user's language. Null when there is nothing to hand back.
 */
export function recheckStatus(input: { failures: CheckRun[]; stale?: CheckRun[] }): RecheckStatus | null {
  const failed = input.failures.length > 0;
  const runs = failed ? input.failures : input.stale ?? [];
  if (!runs.length) return null;
  const checks = runs.slice(0, 2).map(r => clip(r.key, 60));
  const named = checks.join(' and ');
  return failed
    ? { kind: 'failed', checks, text: `Rechecking: ${named} failed this turn, so the agent is taking another look before it replies.` }
    : { kind: 'stale', checks, text: `Rechecking: the code changed after ${named} passed, so the agent is checking again before it replies.` };
}

/**
 * The whole pattern for a harness that runs a turn as a function. `run` sends
 * messages to your model and returns its final text (running tools as it
 * goes, and recording checks and code changes into `ledger`). Returns the
 * text the user should read.
 */
export async function runTurnWithHandBack<M>(opts: {
  messages: M[];
  ledger: CheckLedger;
  run: (messages: M[]) => Promise<string>;
  /** Build the two messages that carry the hand-back in your message format. */
  continueWith: (reply: string, fact: string) => M[];
  language?: string;
  /** Keys of checks still failing at the end of an earlier turn (see handBack). */
  failedBefore?: readonly string[];
  /** Show the user that the agent is rechecking (recheckStatus), before the second round starts. */
  onRecheck?: (status: RecheckStatus) => void;
}): Promise<{ reply: string; handedBack: boolean }> {
  const reply = await opts.run(opts.messages);
  const failures = opts.ledger.standingFailures();
  const stale = opts.ledger.staleChecks();
  const fact = handBack({ failures, stale, alreadyHandedBack: false, language: opts.language, failedBefore: opts.failedBefore });
  if (!fact) return { reply, handedBack: false };
  const status = recheckStatus({ failures, stale });
  if (status) opts.onRecheck?.(status);
  const answer = await opts.run([...opts.messages, ...opts.continueWith(reply, fact)]);
  return { reply: answer, handedBack: true };
}
