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
 * And one for what neither can see, not in the replay: when the code changed
 * and nothing the agent ran checked it since, the harness looks for itself
 * (`look`: loads the page, runs the tests) and a failure goes back the same
 * way, once. The answer a hand-back buys is judged on fresh evidence
 * (`judgeAnswer`), with no model call.
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
  /**
   * A code change that saved. "Successfully replaced the text" reads as
   * evidence the change works, and with no check after it that is the last
   * thing the agent saw before it says "done". This says what the result does
   * not show, and only that: a hook on one result can't know whether anything
   * has run since, so it doesn't say so, and it doesn't ask for a check,
   * which would buy one after every edit. Not yet measured (README.md).
   */
  changeSaved: (): string => 'Change saved. This result does not verify the changed behavior.',
};

/** A file whose change rarely affects a check: leave it out of `recordEdit` and `verdict.changeSaved`. */
export function isDocPath(path: string): boolean {
  return /\.(md|mdx|markdown|rst|txt)$/i.test(path);
}

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

  /** How many check runs are recorded: a mark for `passedAfter`, taken when you hand back. */
  get size(): number {
    return this.runs.length;
  }

  /** The agent changed code (an edit, a patch, a write). Leave out docs and notes (`isDocPath`), which rarely affect a check. */
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

  /**
   * The code changes no check has run after: every change when no check ran
   * at all. Nothing the agent saw says anything about them, so this is when a
   * harness that can look for itself should (`look` in runTurnWithHandBack).
   */
  unchecked(): string[] {
    return [...new Set(this.edits.filter(e => e.after === this.runs.length).map(e => e.what))];
  }

  /**
   * Standing failures whose latest run came after the last code change. Only
   * these speak about the code as it is now: a failure from before a repair
   * is about a version that no longer exists.
   */
  freshFailures(): CheckRun[] {
    const since = this.edits[this.edits.length - 1]?.after ?? 0;
    const latest = new Map<string, number>();
    this.runs.forEach((run, i) => latest.set(run.key, i));
    return [...latest.values()].filter(i => i >= since && !this.runs[i].ok).map(i => this.runs[i]);
  }

  /**
   * Did every one of `keys` run again at or after `mark` (`size` when you
   * handed back) and after the last code change, and pass? False for no keys:
   * nothing was checked.
   */
  passedAfter(keys: readonly string[], mark: number): boolean {
    const since = Math.max(mark, this.edits[this.edits.length - 1]?.after ?? 0);
    const latest = new Map<string, number>();
    this.runs.forEach((run, i) => latest.set(run.key, i));
    return keys.length > 0 && keys.every(k => {
      const i = latest.get(k);
      return i !== undefined && i >= since && this.runs[i].ok;
    });
  }
}

/**
 * What your harness saw when it looked for itself: loaded the page, ran the
 * test suite, parsed the files the turn wrote. The agent's own checks only
 * cover what it chose to run, and an agent that ran nothing has nothing to be
 * surprised by. Your harness can look anyway.
 */
export interface Look {
  /** What the harness ran, as a subject: "npm test", "a render of the live page". */
  key: string;
  /**
   * Hard evidence the reply is false, as one sentence with no final period,
   * saying what the harness did and what it saw ("npm test, run after your
   * reply, failed: 2 failing in login.test.ts"). It goes in exactly as given,
   * so clip it and strip brackets from anything the check read off the page.
   * Null when the harness looked and found nothing wrong.
   */
  saw: string | null;
  /**
   * What the agent should do about it, in place of the default ("That is not
   * done ... Fix the cause and <recheck> ..."), when your harness knows
   * better (a deploy still running: say so and wait for it).
   */
  ask?: string;
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
  /** What your harness saw when it looked for itself (Look). Handed back when the agent's own checks are not failing. A clean look (`saw: null`) is a check after the change that passed, so it hands back nothing and clears `stale`. */
  look?: Look;
  /** `ledger.staleChecks()`. Handed back only when nothing is failing and no clean look ran. */
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
      'It failed on an earlier turn too. A failed check is not done, whatever the reply says. ' +
      `Look for the cause before you run it again unchanged: read the error, the logs and the code the check goes through. Fix what you find, then ${input.recheck || 'run the check again'}. ` +
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
  if (input.look?.saw) {
    const ask = input.look.ask?.trim() ||
      `That is not done, whatever the reply says. Fix the cause and ${input.recheck || 'run the check again'}. If you cannot fix it, say plainly that it failed and why.`;
    return `[System: ${input.look.saw}.${note} ${ask} ${replyReplaced(input.language)}]`;
  }
  if (input.stale?.length && input.look?.saw !== null) {
    return (
      `[System: you changed the code after your own check passed: ${named(input.stale)}.${note} That pass checked the code before the change, so it does not show the change works. ` +
      `Before you say it works, ${input.recheck || 'run the check again'}. If you cannot, say plainly that the change is not checked. ` +
      `${replyReplaced(input.language)}]`
    );
  }
  return null;
}

/**
 * What fresh evidence says about the answer a hand-back bought. Nothing
 * looked at that answer at first, and in our first backtest (2026-10-26) one
 * still carried the claim the hand-back had disproved. No model call and no
 * rewrite: use the outcome to decide what the next turn starts from, or what
 * to show under the reply.
 *
 * Fresh means about the code the answer describes. A failure recorded before
 * the agent's last change is about a version that no longer exists, so it
 * never contradicts the repair: it leaves the answer unchecked. A check
 * hand-back is confirmed only when the handed-back checks ran again after the
 * last change and passed (`ledger.passedAfter`); a look hand-back only when
 * the harness looked again and found nothing.
 */
export type AnswerOutcome = 'confirmed' | 'contradicted' | 'unchecked';
export function judgeAnswer(input: {
  /** What the hand-back was about: a failed check of the agent's, a stale pass, or your harness's look. */
  handedBack: 'check' | 'stale' | 'look';
  /** False when what your checks see is not the version the answer describes (a change still waiting to deploy). Default true. */
  current?: boolean;
  /** Failed checks standing after the answer (`ledger.standingFailures()`), and how many of them ran after the last change (`ledger.freshFailures()`). */
  standing: number;
  fresh: number;
  /** `ledger.passedAfter(<the handed-back keys>, <ledger.size when you handed back>)`. */
  checkedFinal: boolean;
  /** Your harness's look after the answer, when it looked again; null or left out when it could not. */
  lookAgain?: Look | null;
}): AnswerOutcome {
  if (input.current === false) return 'unchecked';
  if (input.fresh > 0 || input.lookAgain?.saw) return 'contradicted';
  if (input.standing > 0) return 'unchecked';
  if (input.handedBack !== 'look') return input.checkedFinal ? 'confirmed' : 'unchecked';
  return input.lookAgain && input.lookAgain.saw === null ? 'confirmed' : 'unchecked';
}

export interface RecheckStatus {
  kind: 'failed' | 'look' | 'stale';
  /** The checks being looked at again, at most two. */
  checks: string[];
  /** A plain English line to show the user. */
  text: string;
}

/**
 * What to show the user while a hand-back runs. The agent seemed to be done
 * and is working again; without a word, that reads as a stall or a second
 * answer nobody asked for. Same order as handBack: a failure, then a look,
 * then a stale pass. `kind` and `checks` are there for a harness that writes
 * its own copy or shows it in the user's language. Null when there is
 * nothing to hand back.
 */
export function recheckStatus(input: { failures: CheckRun[]; look?: Look; stale?: CheckRun[] }): RecheckStatus | null {
  if (!input.failures.length && input.look?.saw) {
    const checks = [clip(input.look.key, 60)];
    return { kind: 'look', checks, text: `Rechecking: ${checks[0]} found a problem after the reply, so the agent is taking another look before it replies.` };
  }
  const failed = input.failures.length > 0;
  const runs = failed ? input.failures : input.look?.saw === null ? [] : input.stale ?? [];
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
 * text the user should read and, after a hand-back, what fresh evidence says
 * about it (judgeAnswer).
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
  /** How your harness runs a check again (see handBack). */
  recheck?: string;
  /**
   * Your harness's own look (Look), for a turn whose code changed with no
   * check after it (`ledger.unchecked()`) and no check of the agent's still
   * failing. Return null when it could not look. A clean look is a check after
   * the change like any other, so it clears a stale pass: make it one that
   * catches a broken change (the test suite), not only a page load. After a
   * look hand-back it runs once more, on the answer, to judge it.
   */
  look?: (reply: string) => Promise<Look | null>;
  /** Show the user that the agent is rechecking (recheckStatus), before the second round starts. */
  onRecheck?: (status: RecheckStatus) => void;
}): Promise<{ reply: string; handedBack: boolean; outcome?: AnswerOutcome }> {
  const { ledger } = opts;
  // A look that throws is a look that could not run: it never breaks the turn.
  const lookAt = async (text: string): Promise<Look | null> => {
    try {
      return opts.look ? await opts.look(text) : null;
    } catch {
      return null;
    }
  };
  const reply = await opts.run(opts.messages);
  const failures = ledger.standingFailures();
  let stale = ledger.staleChecks();
  let look: Look | undefined;
  if (!failures.length && opts.look && ledger.unchecked().length) {
    const seen = await lookAt(reply);
    if (seen?.saw) look = seen;
    else if (seen) stale = [];
  }
  const fact = handBack({ failures, look, stale, alreadyHandedBack: false, language: opts.language, failedBefore: opts.failedBefore, recheck: opts.recheck });
  if (!fact) return { reply, handedBack: false };
  const status = recheckStatus({ failures, look, stale });
  if (status) opts.onRecheck?.(status);
  const mark = ledger.size;
  const answer = await opts.run([...opts.messages, ...opts.continueWith(reply, fact)]);
  const handedBack = failures.length ? 'check' : look ? 'look' : 'stale';
  const keys = (failures.length ? failures : stale).map(f => f.key);
  const outcome = judgeAnswer({
    handedBack,
    standing: ledger.standingFailures().length,
    fresh: ledger.freshFailures().length,
    checkedFinal: handedBack !== 'look' && ledger.passedAfter(keys, mark),
    lookAgain: handedBack === 'look' ? await lookAt(answer) : undefined,
  });
  return { reply: answer, handedBack: true, outcome };
}
