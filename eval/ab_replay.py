#!/usr/bin/env python3
"""A/B replay of real agent turns, judged blind. Stdlib only; any OpenAI-compatible endpoint.

  python3 ab_replay.py generate turns.jsonl replies.jsonl [--samples 2] [--run]
  python3 ab_replay.py judge    replies.jsonl judged.jsonl --model MODEL [--run]
  python3 ab_replay.py score    judged.jsonl

generate and judge only print what they WOULD send (calls, rough tokens) unless you pass --run.
Env: OPENAI_BASE_URL (default https://openrouter.ai/api/v1), OPENAI_API_KEY, CAP_USD (default 5),
and PRICE_IN / PRICE_OUT (USD per million tokens) for the spend cap when the endpoint does not
report a cost per call. METHOD.md describes turns.jsonl.
"""
import json, os, random, re, sys, threading, time, urllib.request, concurrent.futures as cf

BASE = os.environ.get('OPENAI_BASE_URL', 'https://openrouter.ai/api/v1').rstrip('/')
CAP = float(os.environ.get('CAP_USD', '5'))
PRICE_IN, PRICE_OUT = float(os.environ.get('PRICE_IN', '0')), float(os.environ.get('PRICE_OUT', '0'))
HERE = os.path.dirname(os.path.abspath(__file__))
lock, spent = threading.Lock(), [0.0]


def arg(flag, default=None):
    return sys.argv[sys.argv.index(flag) + 1] if flag in sys.argv else default


def read_jsonl(path):
    return [json.loads(l) for l in open(path) if l.strip()]


def chat(body):
    """One completion. Returns {text, tool_calls, cost} or {error}. Stops the run at the spend cap."""
    if spent[0] >= CAP:
        print(f'spend cap ${CAP} reached', flush=True); os._exit(2)
    data = json.dumps({**body, 'usage': {'include': True}}).encode()
    err = ''
    for attempt in range(4):
        try:
            req = urllib.request.Request(BASE + '/chat/completions', data=data, headers={
                'Authorization': 'Bearer ' + os.environ['OPENAI_API_KEY'], 'Content-Type': 'application/json'})
            res = json.load(urllib.request.urlopen(req, timeout=300))
            msg, usage = res['choices'][0]['message'], res.get('usage') or {}
            cost = usage.get('cost')
            if cost is None:
                cost = (usage.get('prompt_tokens', 0) * PRICE_IN + usage.get('completion_tokens', 0) * PRICE_OUT) / 1e6
            with lock:
                spent[0] += float(cost)
            return {'text': msg.get('content') or '', 'cost': float(cost),
                    'tool_calls': [t['function']['name'] for t in (msg.get('tool_calls') or [])]}
        except Exception as e:
            err = repr(e)[:300]
            time.sleep(4 * (attempt + 1))
    return {'error': err}


def rough_tokens(obj):
    return len(json.dumps(obj, ensure_ascii=False)) // 4


def arm_b(messages, b_results):
    """The same context with the wysiati version of each changed tool result."""
    return [{**m, 'content': b_results[m['tool_call_id']]} if m.get('role') == 'tool' and m.get('tool_call_id') in b_results else m
            for m in messages]


def generate(turns, out_path, samples, run):
    jobs = []
    for t in turns:
        body = {'model': t['model'], 'max_tokens': 6000, **({'tools': t['tools']} if t.get('tools') else {})}
        jobs += [(t, 'A', k, {**body, 'messages': t['messages']}) for k in range(samples)]
        jobs += [(t, 'B', k, {**body, 'messages': arm_b(t['messages'], t.get('b_results') or {})}) for k in range(samples)]
    hb = sum(samples for t in turns if t.get('hand_back'))
    print(f'{len(turns)} turns, {len(jobs)} calls plus up to {hb} hand-back continuations, '
          f'~{sum(rough_tokens(j[3]["messages"]) for j in jobs) / 1e6:.1f}M prompt tokens')
    if not run:
        print('dry run: pass --run to send these calls'); return

    def work(job):
        t, arm, k, body = job
        r = chat(body)
        if arm == 'B' and t.get('hand_back'):
            if r.get('error') or r.get('tool_calls') or not r.get('text', '').strip():
                r['hand_back'] = 'not reached (no plain reply)'
            else:
                cont = body['messages'] + [{'role': 'assistant', 'content': r['text']}, {'role': 'user', 'content': t['hand_back']}]
                r = {**chat({**body, 'messages': cont}), 'first': r, 'hand_back': 'continued'}
        return {'id': t['id'], 'arm': arm, 'k': k, **r}

    by_id = {t['id']: {'id': t['id'], 'A': [None] * samples, 'B': [None] * samples} for t in turns}
    with cf.ThreadPoolExecutor(int(os.environ.get('CONC', '6'))) as ex:
        for f in cf.as_completed([ex.submit(work, j) for j in jobs]):
            o = f.result()
            by_id[o['id']][o['arm']][o['k']] = {k: v for k, v in o.items() if k not in ('id', 'arm', 'k')}
    with open(out_path, 'w') as out:
        for t in turns:
            out.write(json.dumps({**by_id[t['id']], 'judge_view': judge_view(t), 'original_reply': t.get('original_reply')},
                                 ensure_ascii=False) + '\n')
    print(f'done, spent ${spent[0]:.2f}')


REDACT = [(re.compile(r'[\w.+-]+@[\w-]+\.[\w.-]+'), '<email>'),
          (re.compile(r'\b(?:sk|pk|rk|ghp|gho|xox[abp]|AKIA)[-_]?[A-Za-z0-9_-]{12,}'), '<key>'),
          (re.compile(r'eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{5,}'), '<jwt>'),
          (re.compile(r'\b[\w-]{40,}\b'), '<token>')]


def redact(s):
    s = str(s or '')
    for r, t in REDACT:
        s = r.sub(t, s)
    return s


def clip(s, n, tail=False):
    s = redact(s)
    return s if len(s) <= n else (('...' + s[-n:]) if tail else (s[:n] + '...'))


def text_of(c):
    return c if isinstance(c, str) else '\n'.join(x.get('text', '') for x in (c or []) if isinstance(x, dict) and x.get('type') == 'text')


def judge_view(t):
    """What really happened in the turn: the person's message and every tool step, as recorded (arm A)."""
    if t.get('judge_view'):
        return t['judge_view']
    msgs = t['messages']
    start = max(i for i, m in enumerate(msgs) if m.get('role') == 'user')
    steps, calls = [], {}
    for m in msgs[start + 1:]:
        for tc in m.get('tool_calls') or []:
            st = {'t': tc['function']['name'], 'a': clip(tc['function'].get('arguments'), 260), 's': 'pending', 'r': ''}
            steps.append(st); calls[tc['id']] = st
        if m.get('role') == 'tool' and m.get('tool_call_id') in calls:
            st, txt = calls[m['tool_call_id']], text_of(m.get('content'))
            st['s'] = 'err' if re.match(r'(?i)\s*(error|exit code [1-9])', txt) else 'ok'
            st['r'] = clip(txt, 500, tail=True) if st['s'] == 'err' else clip(txt, 180)
    return {'user': clip(text_of(msgs[start].get('content')), 900, tail=True), 'steps': steps}


def judge(replies, out_path, model, run):
    rubric = open(os.path.join(HERE, 'rubric.md')).read()
    items = []
    for r in replies:
        cands = [('A', k, x) for k, x in enumerate(r['A'])] + [('B', k, x) for k, x in enumerate(r['B'])]
        if r.get('original_reply'):
            cands.append(('O', 0, {'text': r['original_reply']}))
        for arm, k, x in cands:
            it = {'id': r['id'], 'arm': arm, 'k': k, 'view': r['judge_view']}
            if not x or x.get('error'): it['state'] = 'error'
            elif x.get('tool_calls'): it['state'] = 'acted'
            elif not x.get('text', '').strip(): it['state'] = 'empty'
            else: it['state'] = 'reply'; it['reply'] = clip(x['text'], 2600, tail=True)
            items.append(it)
    random.seed(7); random.shuffle(items)  # blind and shuffled: the judge never sees the arm
    todo = [i for i in items if i['state'] == 'reply']
    print(f'{len(items)} samples, {len(todo)} replies to judge (~{sum(rough_tokens(i) for i in todo) / 1e6 + len(todo) * len(rubric) / 4e6:.1f}M prompt tokens)')
    if not run:
        print('dry run: pass --run to send these calls'); return

    def work(it):
        out = {k: it[k] for k in ('id', 'arm', 'k', 'state')}
        if it['state'] == 'reply':
            turn = json.dumps({'user': it['view']['user'], 'steps': it['view']['steps']}, ensure_ascii=False)
            r = chat({'model': model, 'max_tokens': 1500, 'temperature': 0, 'messages': [
                {'role': 'system', 'content': rubric},
                {'role': 'user', 'content': f'Turn (user and steps):\n{turn}\n\nreply:\n{it["reply"]}'}]})
            try:
                txt = r['text']; out['j'] = json.loads(txt[txt.find('{'):txt.rfind('}') + 1])
            except Exception:
                out['j'] = {'error': r.get('error') or 'unparseable judge output'}
        return out

    with cf.ThreadPoolExecutor(int(os.environ.get('CONC', '6'))) as ex, open(out_path, 'w') as out:
        for f in cf.as_completed([ex.submit(work, i) for i in items]):
            out.write(json.dumps(f.result(), ensure_ascii=False) + '\n')
    print(f'done, spent ${spent[0]:.2f}')


def score(judged):
    cells = {}
    for o in judged:
        if o['state'] == 'acted': c = 'acted'
        elif o['state'] != 'reply' or 'error' in o.get('j', {'error': 1}): continue
        else: c = 'bad' if o['j'].get('correction_warranted') else 'good'
        cells.setdefault(o['id'], {}).setdefault(o['arm'], []).append(c)
    rows = []
    for id_, arms in cells.items():
        A, B = arms.get('A'), arms.get('B')
        if not A or not B: continue
        share = lambda xs, v: xs.count(v) / len(xs)
        replied = lambda xs: xs.count('bad') / max(1, len(xs) - xs.count('acted'))
        rows.append({'A': share(A, 'bad'), 'B': share(B, 'bad'), 'Aact': share(A, 'acted'), 'Bact': share(B, 'acted'),
                     'Ar': replied(A), 'Br': replied(B), 'O': (arms.get('O') or [None])[0]})
    if not rows:
        print('nothing scored'); return
    mean = lambda xs: sum(xs) / len(xs)
    random.seed(1)
    boots = sorted(mean([x['A'] - x['B'] for x in (random.choice(rows) for _ in rows)]) for _ in range(4000))
    print(f'turns: {len(rows)}')
    print(f'replies needing correction: A {mean([x["A"] for x in rows]):.1%}  B {mean([x["B"] for x in rows]):.1%}  '
          f'drop {mean([x["A"] - x["B"] for x in rows]):+.1%} (95% CI {boots[100]:+.1%} to {boots[3899]:+.1%})')
    print(f'went back to work instead of replying: A {mean([x["Aact"] for x in rows]):.1%}  B {mean([x["Bact"] for x in rows]):.1%}')
    print(f'needing correction, of samples that replied: A {mean([x["Ar"] for x in rows]):.1%}  B {mean([x["Br"] for x in rows]):.1%}')
    fid = [x for x in rows if x['O'] in ('bad', 'good')]
    if fid:
        print(f'fidelity: arm A majority matches the original reply on {mean([(x["A"] >= .5) == (x["O"] == "bad") for x in fid]):.0%} of turns')


if __name__ == '__main__':
    cmd = sys.argv[1] if len(sys.argv) > 1 else ''
    if cmd == 'generate' and len(sys.argv) >= 4:
        generate(read_jsonl(sys.argv[2]), sys.argv[3], int(arg('--samples', '2')), '--run' in sys.argv)
    elif cmd == 'judge' and len(sys.argv) >= 4 and arg('--model'):
        judge(read_jsonl(sys.argv[2]), sys.argv[3], arg('--model'), '--run' in sys.argv)
    elif cmd == 'score' and len(sys.argv) >= 3:
        score(read_jsonl(sys.argv[2]))
    else:
        print(__doc__); sys.exit(1)
