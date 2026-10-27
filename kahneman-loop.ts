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
 *      own checks from this turn is still failing, the turn is not over: the
 *      failure goes back to the agent as one message, once, and the answer to
 *      that message is the reply the user reads. Never a loop.
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
 * executor; start a new ledger per turn.
 */
export class CheckLedger {
  private runs: CheckRun[] = [];

  record(key: string, ok: boolean, detail?: string): void {
    this.runs.push({ key, ok, detail });
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
 * The one message that hands a failed check back. Null when there is nothing
 * to hand back, or when this turn already used its hand-back (one round,
 * never a loop).
 *
 * Deliberately NOT gated on what the reply says. A regex for "it's done"
 * misses other languages and other phrasings, and on our traffic no text rule
 * we tried separated bad replies from fine ones (eval/RESULTS.md). An honest
 * reply that already says the check failed costs one continuation, which is
 * cheaper than the user finding the failure and typing it back.
 */
export function handBack(input: {
  failures: CheckRun[];
  alreadyHandedBack: boolean;
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
  if (input.alreadyHandedBack || input.failures.length === 0) return null;
  const named = input.failures
    .slice(0, 2)
    .map(f => `${clip(f.key, 120)}${f.detail ? ` (${clip(f.detail, 160)})` : ''}`)
    .join('; ');
  const note = input.note?.trim() ? ` ${input.note.trim()}` : '';
  return (
    `[System: your own check this turn came back failed: ${named}.${note} A failed check is not done, whatever the reply says. ` +
    `Fix the cause and ${input.recheck || 'run the check again'}. If you cannot fix it, say plainly that it failed and why. ` +
    `${replyReplaced(input.language)}]`
  );
}

/**
 * The whole pattern for a harness that runs a turn as a function. `run` sends
 * messages to your model and returns its final text (running tools as it
 * goes, and recording checks into `ledger`). Returns the text the user should
 * read.
 */
export async function runTurnWithHandBack<M>(opts: {
  messages: M[];
  ledger: CheckLedger;
  run: (messages: M[]) => Promise<string>;
  /** Build the two messages that carry the hand-back in your message format. */
  continueWith: (reply: string, fact: string) => M[];
  language?: string;
}): Promise<{ reply: string; handedBack: boolean }> {
  const reply = await opts.run(opts.messages);
  const fact = handBack({ failures: opts.ledger.standingFailures(), alreadyHandedBack: false, language: opts.language });
  if (!fact) return { reply, handedBack: false };
  const answer = await opts.run([...opts.messages, ...opts.continueWith(reply, fact)]);
  return { reply: answer, handedBack: true };
}
