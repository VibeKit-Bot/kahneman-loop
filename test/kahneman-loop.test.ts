import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CheckLedger, handBack, isDocPath, jobVerdict, judgeAnswer, recheckStatus, replyReplaced, runTurnWithHandBack, verdict, withVerdict } from '../kahneman-loop.ts';

test('the verdict comes first in a tool result', () => {
  const out = withVerdict({ status: 'starting', jobId: 'j1' }, verdict.notDoneYet('live', 'starting', 'its status is "done"'));
  assert.deepEqual(Object.keys(out), ['verified', 'verdict', 'status', 'jobId']);
  assert.equal(out.verified, false);
  assert.match(out.verdict, /^NOT live yet: this job is "starting"/);
});

test('a result that already carries a verdict gets the new one, still first', () => {
  const out = withVerdict({ verdict: 'old', ok: true }, verdict.confirmed('the page rendered'), true);
  assert.deepEqual(Object.keys(out), ['verified', 'verdict', 'ok']);
  assert.equal(out.verdict, 'Confirmed: the page rendered.');
});

test('job statuses: in progress is never read as done', () => {
  assert.equal(jobVerdict({ status: 'done' }).verified, true);
  assert.match(jobVerdict({ status: 'failed' }).verdict, /^FAILED/);
  for (const s of ['queued', 'starting', 'building', 'running']) {
    const v = jobVerdict({ status: s });
    assert.equal(v.verified, false, s);
    assert.match(v.verdict, /^NOT live yet/, s);
  }
  assert.equal(jobVerdict({ status: 'sent' }, { what: 'delivered', done: ['delivered'] }).verdict,
    'NOT delivered yet: this job is "sent". It is delivered only when its status is "delivered".');
});

test('a later passing run of the same check clears its failure', () => {
  const l = new CheckLedger();
  l.record('npm test', false, '2 failing');
  l.record('click "Sign up"', false, 'did not change anything');
  l.record('npm test', true);
  assert.deepEqual(l.standingFailures().map(f => f.key), ['click "Sign up"']);
  l.record('npm test', false, '1 failing');
  assert.deepEqual(l.standingFailures().map(f => f.key), ['click "Sign up"', 'npm test']);
});

test('a pass from before the last code change is stale until any check runs again', () => {
  const l = new CheckLedger();
  l.recordEdit('src/a.ts');
  l.record('npm test', true);
  assert.deepEqual(l.staleChecks(), [], 'an edit before the check is what the check checked');
  l.record('npx tsc', false, 'TS2304');
  l.recordEdit('src/auth.ts');
  l.recordEdit('src/auth.ts');
  assert.deepEqual(l.staleChecks(), [{ key: 'npm test', ok: true, detail: 'passed, then you changed src/auth.ts' }],
    'a failing check is a standing failure, not a stale pass');
  l.record('npx tsc', true);
  assert.deepEqual(l.staleChecks(), []);
  for (const f of ['b.ts', 'c.ts', 'd.ts', 'e.ts']) l.recordEdit(f);
  assert.deepEqual(l.staleChecks().map(s => s.detail), [
    'passed, then you changed src/auth.ts, b.ts, c.ts and 2 more',
    'passed, then you changed b.ts, c.ts, d.ts and 1 more',
  ]);
});

test('hand-back: a stale pass goes back once, and a standing failure goes first', () => {
  const stale = [{ key: 'npm test', ok: true, detail: 'passed, then you changed src/auth.ts' }];
  const fact = handBack({ failures: [], stale, alreadyHandedBack: false, recheck: 'run npm test' })!;
  assert.match(fact, /^\[System: you changed the code after your own check passed: npm test \(passed, then you changed src\/auth\.ts\)\. That pass checked the code before the change/);
  assert.match(fact, /Before you say it works, run npm test\. If you cannot, say plainly that the change is not checked\./);
  assert.ok(fact.endsWith(`${replyReplaced()}]`));
  assert.equal(handBack({ failures: [], stale, alreadyHandedBack: true }), null);
  assert.match(handBack({ failures: [{ key: 'npx tsc', ok: false }], stale, alreadyHandedBack: false })!, /came back failed: npx tsc\./);
});

test('hand-back: once, only on a standing failure, and it names the failure', () => {
  assert.equal(handBack({ failures: [], alreadyHandedBack: false }), null);
  const f = [{ key: 'click "Sign up"', ok: false, detail: 'did not change anything' }];
  assert.equal(handBack({ failures: f, alreadyHandedBack: true }), null);
  const fact = handBack({ failures: f, alreadyHandedBack: false, language: 'Portuguese' })!;
  assert.match(fact, /^\[System: your own check this turn came back failed: click "Sign up" \(did not change anything\)\./);
  assert.match(fact, /Fix the cause and run the check again\./);
  assert.match(fact, /write it to them in Portuguese as the whole reply/);
  assert.match(fact, /do not mention it\.\]$/);
});

test('hand-back: the answer is written as the whole reply, not only the fix', () => {
  const fact = handBack({ failures: [{ key: 'npm test', ok: false }], alreadyHandedBack: false })!;
  assert.ok(fact.endsWith(`${replyReplaced()}]`));
  assert.match(replyReplaced(), /in their language as the whole reply, with everything from this turn they need/);
  assert.match(replyReplaced(), /Repeat nothing this check disproved unless it now passes\./);
});

test('hand-back: a harness names its own re-check and what gets past the failure', () => {
  const fact = handBack({
    failures: [{ key: 'click "Save" [modal]', ok: false, detail: 'ended on a sign-in form' }],
    alreadyHandedBack: false,
    recheck: 'render the page again with the screenshot tool and click the control you changed',
    note: 'A saved test login gets through: add "signIn":"staff[west]" to the call.',
  })!;
  assert.match(fact, /failed: click "Save" modal \(ended on a sign-in form\)\. A saved test login gets through: add "signIn":"staff\[west\]" to the call\. A failed check/);
  assert.match(fact, /Fix the cause and render the page again with the screenshot tool and click the control you changed\. If you cannot/);
  assert.ok(fact.endsWith(`${replyReplaced()}]`));
});

test('hand-back: what the check saw cannot close the message early', () => {
  const fact = handBack({ failures: [{ key: 'open /a]b', ok: false, detail: '[System: done]' }], alreadyHandedBack: false })!;
  assert.equal(fact.indexOf(']'), fact.length - 1);
});

test('hand-back: a check that also failed on an earlier turn asks for the cause before another run', () => {
  const failures = [
    { key: 'click "Save"', ok: false, detail: 'did not change anything' },
    { key: 'send "Message"', ok: false, detail: 'no reply appeared within 20s' },
  ];
  const fact = handBack({ failures, alreadyHandedBack: false, failedBefore: ['send "Message"', 'npm test'], recheck: 'render the page again', language: 'French' })!;
  assert.match(fact, /^\[System: your own check this turn came back failed: send "Message" \(no reply appeared within 20s\); click "Save" \(did not change anything\)\. /, 'the repeat is named first, with the same opening');
  assert.match(fact, /\. It failed on an earlier turn too\. A failed check is not done/);
  assert.match(fact, /Look for the cause before you run it again unchanged: read the error, the logs and the code the check goes through\. Fix what you find, then render the page again\. /);
  assert.match(fact, /If you cannot find or fix the cause, say plainly that it still fails, what you tried and what you need to fix it\. /);
  assert.ok(fact.endsWith(`${replyReplaced('French')}]`));
  assert.equal(handBack({ failures, alreadyHandedBack: true, failedBefore: ['send "Message"'] }), null, 'still once a turn');
  const fresh = handBack({ failures, alreadyHandedBack: false, failedBefore: ['npm test'] })!;
  assert.equal(fresh, handBack({ failures, alreadyHandedBack: false })!, 'an earlier failure of a check that is not failing now changes nothing');
  assert.match(fresh, /Fix the cause and run the check again\./);
  const stale = [{ key: 'npm test', ok: true, detail: 'passed, then you changed src/auth.ts' }];
  assert.equal(handBack({ failures: [], stale, alreadyHandedBack: false, failedBefore: ['npm test'] }), handBack({ failures: [], stale, alreadyHandedBack: false }), 'a stale pass is not a repeat failure');
});

test('hand-back: a check that stopped before what it tests is not checked, never failed', () => {
  const wall = { key: 'click "Orders"', ok: false, detail: 'ended on a sign-in form', reached: false };
  const fact = handBack({ failures: [wall], alreadyHandedBack: false, recheck: 'render the page again', note: 'A saved sign-in is "staff".', language: 'German' })!;
  assert.match(fact, /^\[System: your own check this turn stopped before it reached what it was meant to test: click "Orders" \(ended on a sign-in form\)\. A saved sign-in is "staff"\. /, 'the harness note right after what stopped it');
  assert.doesNotMatch(fact, /came back failed|A failed check/, 'nothing failed');
  assert.match(fact, /shows nothing about the change, working or broken\. Look at where it stopped\. If your change should have put that there, or cleared what was in the way, that is the bug: fix it\. /);
  assert.match(fact, /Otherwise get the check past that point and render the page again\. If you cannot, say plainly that the change is not checked yet, why, and what would let you check it\. /);
  assert.ok(fact.endsWith(`${replyReplaced('German')}]`));
  assert.doesNotMatch(fact, /earlier turn/);
  const again = handBack({ failures: [wall], alreadyHandedBack: false, failedBefore: ['click "Orders"'] })!;
  assert.match(again, /It stopped at the same point on an earlier turn too, so do not run it again unchanged unless you changed what stopped it\. Look at where/);
  assert.equal(handBack({ failures: [wall], alreadyHandedBack: true }), null, 'still once a turn');
  // One check that reached the change and failed outweighs any that stopped short.
  const broke = { key: 'npm test', ok: false, detail: '1 failing' };
  const mixed = handBack({ failures: [wall, broke], alreadyHandedBack: false, failedBefore: ['click "Orders"'] })!;
  assert.match(mixed, /^\[System: your own check this turn came back failed: npm test \(1 failing\); click "Orders" \(ended on a sign-in form\)\. A failed check/, 'the real failure first, and a repeat that stopped short is not a repeat failure');
  assert.equal(handBack({ failures: [{ ...wall, reached: true }], alreadyHandedBack: false }), handBack({ failures: [{ key: wall.key, ok: false, detail: wall.detail }], alreadyHandedBack: false }), 'reached defaults to true');
  assert.deepEqual(recheckStatus({ failures: [wall] }),
    { kind: 'unreached', checks: ['click "Orders"'], text: 'Rechecking: click "Orders" could not get to what it tests this turn, so the agent is taking another look before it replies.' });
  assert.equal(recheckStatus({ failures: [wall, broke] })!.kind, 'failed');
});

test('the ledger: a check that stopped short stands, but says nothing about the code', async () => {
  const l = new CheckLedger();
  l.recordEdit('src/orders.ts');
  l.record('click "Orders"', false, 'ended on a sign-in form', { reached: false });
  assert.deepEqual(l.standingFailures(), [{ key: 'click "Orders"', ok: false, detail: 'ended on a sign-in form', reached: false }]);
  assert.deepEqual(l.freshFailures(), [], 'not evidence against the change');
  assert.deepEqual(l.unchecked(), [], 'but it did run after the change');
  l.record('click "Orders"', true);
  assert.deepEqual(l.standingFailures(), [], 'a later run that gets through and passes clears it');
  // Whole turn: a check stops short, the answer runs it again and it stops short again.
  const t = new CheckLedger();
  const sent: string[][] = [];
  const run = async (m: string[]) => {
    sent.push(m);
    t.recordEdit('src/orders.ts');
    t.record('click "Orders"', false, 'ended on a sign-in form', { reached: false });
    return `reply ${sent.length}`;
  };
  const statuses: string[] = [];
  const out = await runTurnWithHandBack({ messages: ['go'], ledger: t, run, continueWith: (r, f) => [r, f], onRecheck: s => statuses.push(s.kind) });
  assert.ok(sent[1][2].startsWith('[System: your own check this turn stopped before it reached'));
  assert.deepEqual(statuses, ['unreached']);
  assert.equal(out.outcome, 'unchecked', 'stopping short again neither contradicts nor confirms the answer');
});

test('runTurnWithHandBack: the continuation is the reply, and there is one continuation at most', async () => {
  const l = new CheckLedger();
  const sent: string[][] = [];
  const run = async (m: string[]) => { sent.push(m); if (sent.length === 1) l.record('npm test', false, '1 failing'); return `reply ${sent.length}`; };
  const shown: string[] = [];
  const out = await runTurnWithHandBack({ messages: ['hi'], ledger: l, run, continueWith: (r, f) => [r, f], onRecheck: s => shown.push(`${s.kind} ${sent.length}`) });
  assert.deepEqual(out, { reply: 'reply 2', handedBack: true, outcome: 'contradicted' }, 'the check still fails after the answer');
  assert.deepEqual(shown, ['failed 1'], 'the user is told once, before the second round');
  assert.equal(sent.length, 2);
  assert.match(sent[1][2], /npm test \(1 failing\)/);

  const edited = new CheckLedger();
  const sent2: string[][] = [];
  const run2 = async (m: string[]) => { sent2.push(m); if (sent2.length === 1) { edited.record('npm test', true); edited.recordEdit('src/auth.ts'); } return `reply ${sent2.length}`; };
  assert.deepEqual(await runTurnWithHandBack({ messages: ['hi'], ledger: edited, run: run2, continueWith: (r, f) => [r, f] }), { reply: 'reply 2', handedBack: true, outcome: 'unchecked' });
  assert.match(sent2[1][2], /npm test \(passed, then you changed src\/auth\.ts\)/);

  const clean = new CheckLedger();
  let calls = 0;
  const out2 = await runTurnWithHandBack({ messages: ['hi'], ledger: clean, run: async () => `r${++calls}`, continueWith: (r, f) => [r, f], onRecheck: () => assert.fail('nothing to recheck') });
  assert.deepEqual(out2, { reply: 'r1', handedBack: false });

  const again = new CheckLedger();
  const sent3: string[][] = [];
  const run3 = async (m: string[]) => { sent3.push(m); if (sent3.length === 1) again.record('npm test', false, '1 failing'); return `reply ${sent3.length}`; };
  await runTurnWithHandBack({ messages: ['hi'], ledger: again, run: run3, continueWith: (r, f) => [r, f], failedBefore: ['npm test'] });
  assert.match(sent3[1][2], /It failed on an earlier turn too/, 'failedBefore reaches the hand-back');
});

test('recheckStatus: what the user sees while a hand-back runs', () => {
  const failed = recheckStatus({ failures: [{ key: 'npm test', ok: false, detail: '1 failing' }], stale: [{ key: 'tsc', ok: true }] });
  assert.deepEqual(failed, { kind: 'failed', checks: ['npm test'], text: 'Rechecking: npm test failed this turn, so the agent is taking another look before it replies.' }, 'a failure comes before a stale pass, as in handBack');
  const stale = recheckStatus({ failures: [], stale: [{ key: 'npm test', ok: true }, { key: 'tsc', ok: true }, { key: 'lint', ok: true }] });
  assert.equal(stale?.kind, 'stale');
  assert.deepEqual(stale?.checks, ['npm test', 'tsc'], 'at most two checks');
  assert.match(stale!.text, /^Rechecking: the code changed after npm test and tsc passed/);
  assert.equal(recheckStatus({ failures: [] }), null);
});

test('a saved change says what it does not show, and never claims nothing ran', () => {
  assert.equal(verdict.changeSaved(), 'Change saved. This result does not verify the changed behavior.');
  assert.doesNotMatch(verdict.changeSaved(), /nothing|has not run|run a check/i);
});

test('docs and notes are told apart from code by the path', () => {
  for (const p of ['README.md', 'notes/plan.MD', 'a.mdx', 'a.markdown', 'a.rst', 'todo.txt']) assert.equal(isDocPath(p), true, p);
  for (const p of ['src/a.ts', 'app.py', 'package.json', 'index.html', 'md', 'Makefile', 'a.md.ts']) assert.equal(isDocPath(p), false, p);
});

test('the ledger: what no check has run after, what failed since the last change, what passed again', () => {
  const l = new CheckLedger();
  assert.deepEqual(l.unchecked(), []);
  l.recordEdit('src/a.ts');
  l.recordEdit('src/a.ts');
  assert.deepEqual(l.unchecked(), ['src/a.ts'], 'a change with no check at all');
  l.record('npm test', false, '1 failing');
  assert.deepEqual(l.unchecked(), [], 'any check after the change has looked at it');
  assert.deepEqual(l.freshFailures().map(f => f.key), ['npm test']);
  const mark = l.size;
  l.recordEdit('src/b.ts');
  assert.deepEqual(l.unchecked(), ['src/b.ts']);
  assert.deepEqual(l.freshFailures(), [], 'a failure from before the repair is about code that no longer exists');
  assert.equal(l.standingFailures().length, 1, 'it still stands until the check runs again');
  assert.equal(l.passedAfter(['npm test'], mark), false);
  l.record('npm test', true);
  assert.equal(l.passedAfter(['npm test'], mark), true);
  assert.equal(l.passedAfter(['npm test', 'tsc'], mark), false, 'every handed-back check');
  assert.equal(l.passedAfter([], mark), false, 'no keys: nothing was checked');
  l.recordEdit('src/c.ts');
  assert.equal(l.passedAfter(['npm test'], mark), false, 'a pass before the last change does not check it');
});

test('hand-back: what the harness saw for itself goes back after the agent\'s own failures, before a stale pass', () => {
  const look = { key: 'npm test', saw: 'npm test, run after your reply, failed: 2 failing in login.test.ts' };
  const fact = handBack({ failures: [], look, stale: [{ key: 'tsc', ok: true }], alreadyHandedBack: false, recheck: 'run npm test', language: 'French' })!;
  assert.equal(fact, `[System: npm test, run after your reply, failed: 2 failing in login.test.ts. That is not done, whatever the reply says. Fix the cause and run npm test. If you cannot fix it, say plainly that it failed and why. ${replyReplaced('French')}]`);
  assert.match(handBack({ failures: [{ key: 'click "Go"', ok: false }], look, alreadyHandedBack: false })!, /your own check this turn came back failed: click "Go"/, 'the agent\'s own check first');
  assert.match(handBack({ failures: [], look: { key: 'page', saw: 'the page is still deploying', ask: 'Say so and wait for it.' }, alreadyHandedBack: false })!,
    /^\[System: the page is still deploying\. Say so and wait for it\. Your reply above is replaced/, 'the harness\'s own ask');
  assert.equal(handBack({ failures: [], look: { key: 'npm test', saw: null }, alreadyHandedBack: false }), null, 'a clean look hands back nothing');
  const clean = { key: 'npm test', saw: null };
  assert.equal(handBack({ failures: [], look: clean, stale: [{ key: 'tsc', ok: true }], alreadyHandedBack: false }), null, 'a clean look is a pass after the change, so it clears a stale pass');
  assert.equal(recheckStatus({ failures: [], look: clean, stale: [{ key: 'tsc', ok: true }] }), null);
  assert.match(handBack({ failures: [{ key: 'tsc', ok: false }], look: clean, alreadyHandedBack: false })!, /came back failed: tsc/, 'a clean look never clears a failure');
  assert.equal(handBack({ failures: [], look, alreadyHandedBack: true }), null, 'once a turn');
  assert.deepEqual(recheckStatus({ failures: [], look, stale: [{ key: 'tsc', ok: true }] }),
    { kind: 'look', checks: ['npm test'], text: 'Rechecking: npm test found a problem after the reply, so the agent is taking another look before it replies.' });
});

test('judgeAnswer: fresh evidence about the version the answer describes', () => {
  const base = { standing: 0, fresh: 0, checkedFinal: false };
  assert.equal(judgeAnswer({ ...base, handedBack: 'check', checkedFinal: true }), 'confirmed');
  assert.equal(judgeAnswer({ ...base, handedBack: 'check' }), 'unchecked', 'not run again');
  assert.equal(judgeAnswer({ ...base, handedBack: 'check', standing: 1, fresh: 1 }), 'contradicted');
  assert.equal(judgeAnswer({ ...base, handedBack: 'check', standing: 1 }), 'unchecked', 'a failure from before the repair');
  assert.equal(judgeAnswer({ ...base, handedBack: 'check', checkedFinal: true, current: false }), 'unchecked', 'the checks see another version');
  assert.equal(judgeAnswer({ ...base, handedBack: 'look', lookAgain: { key: 'page', saw: null } }), 'confirmed');
  assert.equal(judgeAnswer({ ...base, handedBack: 'look', lookAgain: { key: 'page', saw: 'it still throws' } }), 'contradicted');
  assert.equal(judgeAnswer({ ...base, handedBack: 'look', lookAgain: null }), 'unchecked', 'could not look again');
  assert.equal(judgeAnswer({ ...base, handedBack: 'look', standing: 1, lookAgain: { key: 'page', saw: null } }), 'unchecked');
  assert.equal(judgeAnswer({ ...base, handedBack: 'stale', checkedFinal: true }), 'confirmed');
});

test('runTurnWithHandBack: the harness looks when nothing checked the change, and judges the answer', async () => {
  const seen = (saw: string | null) => ({ key: 'npm test', saw });
  // Never checked: the look fails, goes back once, and looks again at the answer.
  const l = new CheckLedger();
  const sent: string[][] = [];
  const looks: string[] = [];
  const run = async (m: string[]) => { sent.push(m); if (sent.length === 1) l.recordEdit('src/a.ts'); return `reply ${sent.length}`; };
  const shown: string[] = [];
  const out = await runTurnWithHandBack({
    messages: ['hi'], ledger: l, run, continueWith: (r, f) => [r, f], recheck: 'run npm test',
    look: async reply => { looks.push(reply); return seen(looks.length === 1 ? 'npm test, run after your reply, failed: 1 failing' : null); },
    onRecheck: s => shown.push(s.kind),
  });
  assert.deepEqual(out, { reply: 'reply 2', handedBack: true, outcome: 'confirmed' });
  assert.deepEqual(looks, ['reply 1', 'reply 2'], 'once before the reply, once on the answer');
  assert.deepEqual(shown, ['look']);
  assert.match(sent[1][2], /^\[System: npm test, run after your reply, failed: 1 failing\. That is not done/);

  // A clean look after the change clears a stale pass: no second round.
  const s = new CheckLedger();
  let calls = 0;
  const run2 = async () => { if (++calls === 1) { s.record('npm test', true); s.recordEdit('src/a.ts'); } return `r${calls}`; };
  assert.deepEqual(await runTurnWithHandBack({ messages: ['hi'], ledger: s, run: run2, continueWith: (r, f) => [r, f], look: async () => seen(null) }), { reply: 'r1', handedBack: false });

  // Could not look (null, or it threw): the stale pass goes back as before.
  for (const look of [async () => null, async () => { throw new Error('renderer down'); }]) {
    const t = new CheckLedger();
    const sent3: string[][] = [];
    const run3 = async (m: string[]) => { sent3.push(m); if (sent3.length === 1) { t.record('npm test', true); t.recordEdit('src/a.ts'); } return `r${sent3.length}`; };
    const out3 = await runTurnWithHandBack({ messages: ['hi'], ledger: t, run: run3, continueWith: (r, f) => [r, f], look });
    assert.equal(out3.handedBack, true);
    assert.match(sent3[1][2], /you changed the code after your own check passed/);
  }

  // The agent's own failure goes first and the look never runs; nor without a change.
  const f = new CheckLedger();
  let looked = 0;
  const run4 = async () => { f.recordEdit('src/a.ts'); f.record('npm test', false, '1 failing'); return 'r'; };
  await runTurnWithHandBack({ messages: ['hi'], ledger: f, run: run4, continueWith: (r, x) => [r, x], look: async () => { looked++; return seen(null); } });
  await runTurnWithHandBack({ messages: ['hi'], ledger: new CheckLedger(), run: async () => 'r', continueWith: (r, x) => [r, x], look: async () => { looked++; return seen(null); } });
  assert.equal(looked, 0);
});
