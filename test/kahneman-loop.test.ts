import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CheckLedger, handBack, jobVerdict, runTurnWithHandBack, verdict, withVerdict } from '../kahneman-loop.ts';

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

test('hand-back: once, only on a standing failure, and it names the failure', () => {
  assert.equal(handBack({ failures: [], alreadyHandedBack: false }), null);
  const f = [{ key: 'click "Sign up"', ok: false, detail: 'did not change anything' }];
  assert.equal(handBack({ failures: f, alreadyHandedBack: true }), null);
  const fact = handBack({ failures: f, alreadyHandedBack: false, language: 'Portuguese' })!;
  assert.match(fact, /^\[System: your own check this turn came back failed: click "Sign up" \(did not change anything\)\./);
  assert.match(fact, /Reply in Portuguese\.\]$/);
});

test('runTurnWithHandBack: the continuation is the reply, and there is one continuation at most', async () => {
  const l = new CheckLedger();
  const sent: string[][] = [];
  const run = async (m: string[]) => { sent.push(m); if (sent.length === 1) l.record('npm test', false, '1 failing'); return `reply ${sent.length}`; };
  const out = await runTurnWithHandBack({ messages: ['hi'], ledger: l, run, continueWith: (r, f) => [r, f] });
  assert.deepEqual(out, { reply: 'reply 2', handedBack: true });
  assert.equal(sent.length, 2);
  assert.match(sent[1][2], /npm test \(1 failing\)/);

  const clean = new CheckLedger();
  let calls = 0;
  const out2 = await runTurnWithHandBack({ messages: ['hi'], ledger: clean, run: async () => `r${++calls}`, continueWith: (r, f) => [r, f] });
  assert.deepEqual(out2, { reply: 'r1', handedBack: false });
});
