# Model A: The Deterministic / LLM Split

The most consequential design choice in the factory is where the line between
deterministic code and LLM judgment falls. Model A puts the **brain in code** and
the **hands in the LLM**, with one seam between them.

## The problem

Autonomous delivery needs two different kinds of work:

1. **Judgment**: writing a spec from a PRD, writing tests and code, reviewing code,
   judging acceptance. These need an LLM.
2. **Bookkeeping**: choosing the next stage, running a gate, deciding whether a
   result is valid, counting repair passes, writing state, opening a PR. These must
   be exactly right every time.

An agent following prose instructions does so unreliably. If bookkeeping lived in
agent instructions, some runs would skip a gate, miscount a budget or write
inconsistent state, and do it silently. For an unattended pipeline whose value is
trust, that is unacceptable.

## The split

- **The CLI is the brain.** `factory` (`src/feature/`) is a deterministic, tested
  engine. It owns every transition, gate, repair budget, delivery step and state
  write. It never spawns an agent.
- **One seam.** `factory next-action` returns exactly one action: `execute`,
  `wait`, `park` or `terminal`. All transition logic sits behind it.
- **The runner is the hands.** The in-session runner
  (`skills/pipeline-runner/SKILL.md`) calls `next-action`, spawns exactly the roles
  an `execute` names with the prompts it was given, writes each agent's reply
  verbatim to the staged path, and calls again. It decides nothing.

The runner runs in the invoking Claude Code session, the only place that can spawn
`Agent()`s. There is no headless `claude -p` or API-token path.

## Why this boundary

- **Runner as a sub-agent.** A sub-agent cannot spawn further sub-agents, so a
  runner inside one would deadlock the first time it needed a producer or
  reviewer. The runner must be the main session.
- **Pure-script runner.** A Node process cannot invoke the `Agent` tool, so the
  engine cannot also be the spawner.
- **Pure-agent orchestration.** This is the unreliability problem above.

Model A respects both constraints: spawning lives in the session, and every
decision lives behind the seam in code.

## What the seam buys

- **Testability.** Transitions, gates and budgets are code with unit tests. The
  non-deterministic parts stay at the edges, in agent briefs.
- **Loud failure.** An unknown action, a non-zero CLI exit or a missing field stops
  the runner; it never "just advances".
- **Evidence the agent cannot forge.** Agents write only their own staged result.
  Identity comes from the staged path, engine state is write-protected, and
  verdicts come from executed gates and independent reviewers.
- **No prompt assembly in the runner.** The engine writes a per-role brief file and
  hands the runner a two-line prompt naming it. The runner pastes it verbatim.
  Spec envelopes work the same way, and spec agents write their own result file,
  so the runner never relays a large reply.
- **Self-correcting results.** An invalid result is moved aside and the role is
  re-issued with the reason, up to twice, instead of stalling or being "fixed" by
  the runner.
- **Restart from disk.** Every attempt is persisted before dispatch, and any later
  driver can consume its staged results. A crashed or compacted session loses no
  work. After compaction, the `SessionStart` hook reminds the session of the
  active run, its next command and the runner skill path (see
  [hooks.md](../reference/hooks.md)).

## The cost

The runner must obey the actions faithfully: spawn what an action names, write
replies verbatim, and keep calling. That discipline lives in the runner skill. It
cannot diverge on a transition because it makes none.

## See also

- [Architecture overview](../architecture/overview.md)
- [CLI reference](../reference/cli.md)
- [The verifier](./verifier.md)
