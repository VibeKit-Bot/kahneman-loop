# Method: replay real turns, change one thing, judge blind

The question: when an agent ends a turn, does putting the missing fact in front of it (a verdict
on a tool result, or a hand-back of its own failed check) change how often its reply needs a
correction? Synthetic benchmarks don't answer this, because the failure only shows up in long,
messy, real turns. So we replayed real ones.

## 1. Find the affected turns

A turn is affected when the Kahneman loop would change something the agent saw **before** it wrote its final
reply:
- a tool result that would get a verdict: a job that hadn't finished, a call that was refused, or
  a check that couldn't run; or
- a check of its own that was still failing when the turn ended, so the hand-back would fire.

On VibeKit, about 6% of agent turns over three weeks in October 2026 were affected. We left out:
- turns whose tool result the platform no longer produces, since its behavior changed after the turn;
- turns where every changed result came after the reply;
- turns that an existing mechanism had already handed back once (counting them would credit the Kahneman loop
  for work already being done);
- the few the judge couldn't score.

That leaves about 70% of the affected turns.

## 2. Rebuild each turn's context

For each turn, rebuild the exact request the model got just before its final reply: the system
prompt, the tool definitions, and the conversation. After a context compaction, that means the
summary plus the entries the harness kept. Use the same model and reasoning setting as the
original turn. This is the hard part and depends on your harness's transcript format.
`ab_replay.py` takes the rebuilt turns as JSONL:

```json
{"id": "t1",
 "model": "provider/model-name",
 "messages": [ ...OpenAI chat messages up to, not including, the final reply, as recorded... ],
 "tools": [ ...OpenAI tool definitions, optional... ],
 "b_results": {"call_7": "the Kahneman loop version of that tool result"},
 "hand_back": "[System: your own check this turn came back failed: ...]",
 "original_reply": "what the agent really said, optional: used for the fidelity check",
 "judge_view": {"user": "...", "steps": [{"t": "tool", "a": "args", "s": "ok|err|pending", "r": "result"}]}}
```

`judge_view` is optional. Without it, the script builds one from `messages`.

## 3. Two arms, same model

- **Arm A (today):** the context as recorded.
- **Arm B (Kahneman loop):** the same context with each changed tool result replaced by its new
  version. If the turn gets a hand-back and arm B's sample ends in a plain reply, the reply and the
  hand-back message are appended and the model is sampled again. That answer is arm B's output.

Each arm gets two samples per turn.

## 4. Judge blind

Every reply (arm A, arm B, and the original) is judged on its own, in shuffled order, by a model
that doesn't know which arm wrote it. The judge scores it against what the tools really did (the
original steps, redacted and truncated) using [rubric.md](rubric.md). The output we score is
`correction_warranted`: the reply contains a material claim that a tool step contradicts, or that
no tool step supports.

A sample that calls a tool instead of replying has **acted**. It hasn't told the user anything
yet, so it can't need a correction. We count it as not needing one and report the acted rate
separately, along with the rate among samples that replied, so nobody has to take this choice on
faith.

Judge: Claude Sonnet 5.5, temperature 0, with the turn cached across that turn's replies.

## 5. Score per turn

For each turn, take the share of arm A samples that need a correction, and the same for arm B. Report the
mean over turns, the per-turn difference, and a 95% bootstrap confidence interval (4,000 resamples
of turns).

**Fidelity check:** does arm A reproduce the original reply's verdict? It did on 80% of turns. A fresh sample
doesn't always repeat the original even with identical context, so some disagreement is expected;
80% says the rebuilt context is close to what the model saw.

## Cost and privacy

Our run cost tens of dollars in API calls: four samples per turn, the hand-back continuations,
and one judge call per reply. `ab_replay.py` dry-runs by default: it prints how many
calls and roughly how many tokens it would send, and it stops at `CAP_USD`.

Transcripts are your customers' data. Keep them on your own infrastructure, and redact before
anything goes to a judge (the script does basic redaction of emails, keys and long tokens). We
publish aggregates only.

## Running it

```bash
export OPENAI_API_KEY=...            # any OpenAI-compatible endpoint (OPENAI_BASE_URL, default OpenRouter)
python3 ab_replay.py generate turns.jsonl replies.jsonl              # dry run: counts calls
python3 ab_replay.py generate turns.jsonl replies.jsonl --run        # spends, up to CAP_USD
python3 ab_replay.py judge replies.jsonl judged.jsonl --model anthropic/claude-sonnet-5.5 --run
python3 ab_replay.py score judged.jsonl
```
