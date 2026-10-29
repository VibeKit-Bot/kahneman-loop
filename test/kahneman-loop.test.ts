import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CheckLedger, handBack, jobVerdict, recheckStatus, replyReplaced, runTurnWithHandBack, verdict, withVerdict } from '../kahneman-loop.ts';

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

test('hand-back: a check that also failed on an earlier turn asks for the cause, not another run', () => {
  const failures = [
    { key: 'click "Save"', ok: false, detail: 'did not change anything' },
    { key: 'send "Message"', ok: false, detail: 'no reply appeared within 20s' },
  ];
  const fact = handBack({ failures, alreadyHandedBack: false, failedBefore: ['send "Message"', 'npm test'], recheck: 'render the page again', language: 'French' })!;
  assert.match(fact, /^\[System: your own check this turn came back failed: send "Message" \(no reply appeared within 20s\); click "Save" \(did not change anything\)\. /, 'the repeat is named first, with the same opening');
  assert.match(fact, /It also failed on an earlier turn, so running it again before you change anything will fail again\. A failed check is not done/);
  assert.match(fact, /Find the cause first: read the error, the logs and the code the check goes through\. Fix it, then render the page again\. /);
  assert.match(fact, /If you cannot find or fix the cause, say plainly that it still fails, what you tried and what you need to fix it\. /);
  assert.ok(fact.endsWith(`${replyReplaced('French')}]`));
  assert.equal(handBack({ failures, alreadyHandedBack: true, failedBefore: ['send "Message"'] }), null, 'still once a turn');
  const fresh = handBack({ failures, alreadyHandedBack: false, failedBefore: ['npm test'] })!;
  assert.equal(fresh, handBack({ failures, alreadyHandedBack: false })!, 'an earlier failure of a check that is not failing now changes nothing');
  assert.match(fresh, /Fix the cause and run the check again\./);
  const stale = [{ key: 'npm test', ok: true, detail: 'passed, then you changed src/auth.ts' }];
  assert.equal(handBack({ failures: [], stale, alreadyHandedBack: false, failedBefore: ['npm test'] }), handBack({ failures: [], stale, alreadyHandedBack: false }), 'a stale pass is not a repeat failure');
});

test('runTurnWithHandBack: the continuation is the reply, and there is one continuation at most', async () => {
  const l = new CheckLedger();
  const sent: string[][] = [];
  const run = async (m: string[]) => { sent.push(m); if (sent.length === 1) l.record('npm test', false, '1 failing'); return `reply ${sent.length}`; };
  const shown: string[] = [];
  const out = await runTurnWithHandBack({ messages: ['hi'], ledger: l, run, continueWith: (r, f) => [r, f], onRecheck: s => shown.push(`${s.kind} ${sent.length}`) });
  assert.deepEqual(out, { reply: 'reply 2', handedBack: true });
  assert.deepEqual(shown, ['failed 1'], 'the user is told once, before the second round');
  assert.equal(sent.length, 2);
  assert.match(sent[1][2], /npm test \(1 failing\)/);

  const edited = new CheckLedger();
  const sent2: string[][] = [];
  const run2 = async (m: string[]) => { sent2.push(m); if (sent2.length === 1) { edited.record('npm test', true); edited.recordEdit('src/auth.ts'); } return `reply ${sent2.length}`; };
  assert.deepEqual(await runTurnWithHandBack({ messages: ['hi'], ledger: edited, run: run2, continueWith: (r, f) => [r, f] }), { reply: 'reply 2', handedBack: true });
  assert.match(sent2[1][2], /npm test \(passed, then you changed src\/auth\.ts\)/);

  const clean = new CheckLedger();
  let calls = 0;
  const out2 = await runTurnWithHandBack({ messages: ['hi'], ledger: clean, run: async () => `r${++calls}`, continueWith: (r, f) => [r, f], onRecheck: () => assert.fail('nothing to recheck') });
  assert.deepEqual(out2, { reply: 'r1', handedBack: false });

  const again = new CheckLedger();
  const sent3: string[][] = [];
  const run3 = async (m: string[]) => { sent3.push(m); if (sent3.length === 1) again.record('npm test', false, '1 failing'); return `reply ${sent3.length}`; };
  await runTurnWithHandBack({ messages: ['hi'], ledger: again, run: run3, continueWith: (r, f) => [r, f], failedBefore: ['npm test'] });
  assert.match(sent3[1][2], /It also failed on an earlier turn/, 'failedBefore reaches the hand-back');
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
