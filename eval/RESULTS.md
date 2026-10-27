# Results: VibeKit production, October 2026

[VibeKit](https://vibekit.bot) is a hosted agent that builds, deploys and runs apps for people,
mostly from their phones. The agent edits code, deploys, renders the live app and clicks through
it to check its work. Several models were in use. This is the replay described in
[METHOD.md](METHOD.md), over three weeks of production traffic. Percentages are rounded.

## Scope

- About 6% of agent turns were affected: the Kahneman loop would have changed something the agent saw before
  its final reply.
- We scored about 70% of those. The rest were left out because the platform no longer gives that
  tool result, the change came after the reply, an existing mechanism had already handed the turn
  back, or the judge couldn't score it.

## Replies needing correction

Arm A gets today's tool results, and arm B gets the Kahneman loop ones. The drop is A minus B, in
percentage points. The CI is a 95% bootstrap over turns.

| Subset | Original reply | Arm A | Arm B | Drop (95% CI) | Acted A / B |
|---|---:|---:|---:|---:|---:|
| **All affected** | 35% | **25%** | **15%** | **10 (4 to 18)** | 21% / 41% |
| Verdict text only | 35% | 23% | 18% | 5 (-2 to 13) | 23% / 28% |
| Hand-back only | 35% | 30% | 0% | 30 (15 to 46) | 13% / 100% |
| Turns with a deploy-job verdict | 36% | 24% | 17% | 6 (-2 to 15) | 24% / 31% |
| Turns with a "could not render" verdict | 33% | 25% | 17% | 8 (-13 to 33) | 4% / 21% |
| Turns with a refused-call verdict | 33% | 28% | 17% | 11 (-17 to 44) | 22% / 22% |
| Original reply was wrong | 100% | 57% | 29% | 28 (12 to 43) | 22% / 53% |
| Original reply was already right (no harm) | 0% | 8% | 7% | 1 (-4 to 7) | 20% / 35% |

Some turns have more than one kind of verdict, so the verdict rows overlap. The verdict-specific
rows are small samples, which is why their intervals are wide.

**Among samples that replied** (acted samples left out): 28% in arm A and 17% in arm B.

The "original reply" column is above arm A because the affected turns were selected partly *for*
having a failed check, and a fresh sample doesn't always repeat the original's mistake. Arm A,
not the original, is the fair baseline. That's why both arms are replayed.

## The hand-back

- It fired on about 0.7% of all turns.
- In every continuation, the agent went back to work (a tool call) instead of replying. What it
  said after that wasn't replayed.
- On about 60% of the turns where it fired, the judge had rated the original reply fine, but the
  check had really failed. That's the price of not gating on wording: an honest reply still costs
  one more round.

### Why it isn't gated on what the reply says

On the turns where the hand-back fired, we tested two text rules against the judge's verdict on the
original reply:

| Rule | Share of bad replies it matched | Share of fine replies it matched |
|---|---:|---:|
| Reply claims success ("it's live", "fixed", ...) | 63% | 63% |
| Reply already admits a failure ("couldn't", "not verified", ...) | 63% | 19% |

Neither rule separates bad replies from fine ones. A rule that skips the hand-back when the reply
admits a failure would have skipped most of the bad replies, because a reply that admits one failure
often still claims the rest is done. So the trigger is the failed check alone.

## Cost

- **Tokens:** about 86 extra prompt tokens on average per affected tool result, measured as the
  prompt-size difference between arms. The hand-back adds one model round, and the work it
  triggers, on about 0.7% of turns (1 in 140). Averaged over every turn, that's under 1% more tokens.
- **Latency:** verdicts add no calls. Averaged over every turn, the hand-back adds about 0.3 seconds,
  under 1% of the average turn's time.
- **How the hand-back's cost was measured:** VibeKit already runs the same hand-back message in
  production for other failed checks. We took the real tokens and wall-clock time of those
  continuation turns over the same three weeks and scaled them by how often the Kahneman loop's hand-back
  fired. On average a continuation took slightly more tokens than an ordinary turn, almost all of
  them cached reads of the context the agent already had.
- **Population effect:** about 0.5% of all agent turns end in a reply that no longer needs
  correcting, roughly 1 in 200.

## Judge and fidelity

- About three quarters of samples were replies the judge scored. The rest acted (called a tool),
  plus a handful that came back empty.
- The judge was Claude Sonnet 5.5 at temperature 0, blind and shuffled, using [rubric.md](rubric.md).
- Arm A's majority verdict matched the original reply's verdict on 80% of turns.

## What we'd still like to know

- What the agent says after a hand-back. Replaying the full continuation, tools included, is the
  next measurement.
- Whether this holds on other harnesses and task mixes, coding agents in particular. The Claude Code
  hook in this repo is a port and hasn't been measured there. If you run [the method](METHOD.md) on
  your agent, open an issue with your numbers, good or bad.
