# Executor Confinement — design thread

**Status:** **Resolved (2026-06-03) — targeted fixes adopted; the full confinement architecture is DEFERRED.** See **Outcome** below; §1–§8 are retained as the record of _why_.
**Relationship to `artifact-storage-architecture.md`:** both this confinement architecture and that doc's storage-zoning are **deferred**; the only piece that graduates from either is the per-spec re-key (fix #3). Both docs' adversarial findings (location ≠ boundary; the forgeable verdict) are what _produced_ the targeted fixes — the exploration paid for itself even though the architecture didn't ship.
**North-star (unchanged):** maximise code quality. The gate stack is the entire trust boundary in a no-human-review pipeline; the targeted fixes harden it against the cheapest gaming paths without a redesign.

---

## Outcome — decision (2026-06-03)

Pressure-tested _"is this significantly better, or redesign for its own sake?"_ **Verdict: the full architecture is gold-plating under the project's own constraints (no OS sandbox) and threat model (emergent gaming — cheapest path to green, not a determined adversary). The high-ROI subset is small; it was extracted as targeted fixes. §1–§8 below are the supporting analysis.**

### Do now — targeted fixes (no architecture required)

1. **Derive-don't-store verdicts.** _Hole:_ `pipeline-state task-write <run> <task> quality_gate.ok true` writes verbatim — `_validate_task_field_value` enum-checks only `status/stage/risk_tier/holdout`; gate booleans hit the `*) return 0` default; no guard matches `task-write`. This is the **cheapest** gaming path. _Fix:_ recompute every gate verdict from ground-truth artifacts at gate time; never read a stored boolean; guard `task-write` of `*_gate*`/`security_gate*`/`coverage*`. _Cost:_ contained (the ship checklist is already derived from gate fields). **Highest security ROI in the thread.**
2. **Non-circular write-deny on the gate machinery** (`bin/`, `hooks/`, settings, `.git/hooks`). _Hole:_ `write-protection.sh:31-35` reads its blocklist from a config the executor can edit (circular), and `CLAUDE_PLUGIN_DATA=/tmp/x` redirects the loader (`pipeline-lib.sh:21-77`). The core invariant _"executor must not modify the gate machinery"_ is currently bypassable. _Fix:_ hardcode the gate-machinery denylist in the hook (not config-sourced); resolve `CLAUDE_PLUGIN_DATA` from a trusted source. _Cost:_ one honest hook. This is the minimal achievable slice of write-confinement — and the only slice that matters under the threat model.
3. **Re-key the spec per `(repo, spec-id)`** instead of per-`<run>`. **The original complaint** (regeneration across runs; hard to reference). _Does not need git-canonical anything_ — a key change wherever the spec lives today. _Cost:_ moderate (≈17 inline `.state/$run_id` constructions + `pipeline-score`, the `pipeline-cleanup` archive writer, `pipeline-rescue-apply` per storage §10).
4. **Holdout: make the answer key orchestrator-only** _(chosen 2026-06-03 — the original Q12 motivator)._ _Hole (verified):_ prompt redaction is real (`pipeline-build-prompt:99-167` → executor prompt carries `visible_criteria` only), **but** the withheld criteria are written verbatim to `${CLAUDE_PLUGIN_DATA}/runs/<run>/holdouts/<task>.json` (`:130-138`) which the executor holds `Read(${CLAUDE_PLUGIN_DATA}/**)` on (`settings.autonomous.json:19-21`) — one `cat` defeats it; and the full spec is readable so visible-vs-full diff recovers it. Both are **reads** confinement never covered. _Fix:_ executor receives only its redacted task-json; the answer key + full spec live where the executor can't read them; holdout evaluated off-host (orchestrator-side judge API call) or by a reviewer fed from trusted state. _This is "move trust out of reach" applied to the one artifact whose read must be prevented._ **Robustness sub-fork resolved 2026-06-03 → A1 (best-effort placement):** move the key out of the executor's Read grants (one deny on `…/holdouts/**`) + give the executor only the redacted task-json; defeats `cat`, accepts the interpreter-read residue (consistent with Q-CONF-2). A2 (off-disk/off-host, true hard-prevent) gated on the determined-adversary revisit condition.

**#1 + #2 + #3 ≈ 80% of the security/coherence value at ~15% of the cost** (targeted patches to verified holes, not a redesign). **#4** is the original motivator — bounded cost, overlaps #3 (orchestrator as spec custodian).

### Deferred — the confinement architecture (§1–§8)

Full read+write executor confinement, the git-canonical trusted store, and content-addressed spec pinning (Q-CONF-7 option A). **Why deferred:** (a) under emergent gaming, git-ref-forging is _not_ the cheapest path — the executor writes weak tests long before it hand-crafts `git update-ref` to rewrite a spec; (b) without the OS sandbox, confinement stays _best-effort_, so the existing guards can't be deleted — you'd run both → no net simplification; (c) it does not even solve the motivating problem — the **holdout is a _read_, confinement is _write_.** Fixes #1–#2 deliver the same _class_ of guarantee against the realistic paths.

**Conditions to revisit (un-defer if any holds):**

- You adopt the opt-in OS sandbox (Q-CONF-1) → confinement becomes airtight _and_ lets you delete the patchwork (the net-simplification argument flips positive).
- The threat model hardens from emergent gaming to a **determined adversary** (exotic paths come into scope).
- The holdout is moved on-host in a form whose _read_ must be prevented (read-confinement would then earn its keep).

### Still open regardless of scope

- **Q-CONF-5 (holdout disposition) — _RESOLVED (2026-06-03): option (A), fix by placement_** (now fix #4). **Sub-fork still open → Q-CONF-8.**
- **Q-CONF-8 — _RESOLVED (2026-06-03): A1 (best-effort placement)._** Move the answer key out of the executor's Read grants + Read-deny; executor gets only the redacted task-json; defeats `cat`, accepts the interpreter-read residue (consistent with Q-CONF-2). Rationale: under emergent gaming, finding+interpreter-reading a moved, Read-denied key is determined-adversary behavior (revisit-condition #2), so defending it here but nowhere else would be inconsistent. **A2** (off-disk/off-host; true hard-prevent; more mechanism) is the hardened variant, gated on the determined-adversary revisit condition.
- **Q-CONF-9 — _RESOLVED (2026-06-03): local-first, CI is the final net._** Maintainer: _"CI [is] only a final net to catch anything unexpected. All tests should run locally before the code is approved and pushed."_ **Ground truth = a _trusted_ local run: the orchestrator re-runs the suite in a clean checkout it owns, after the executor's commit is frozen** (executor can't tamper with harness or results). That run is the gate of record; the executor's self-reported numbers are never trusted; **CI remains the net at the merge boundary** (auto-merge still requires green). _Why not the executor's own run:_ trusting it is the exact forgeable thing fix #1 kills. _Cost:_ an orchestrator-side trusted test-run stage per task. **Sub-fork → Q-CONF-10.**
- **Q-CONF-10 — _RESOLVED (2026-06-03): (a) mutation local too._** Mutation runs locally per task as part of the trusted gate-of-record run (Q-CONF-9), **diff-scoped + incremental** (reuse CI's cache strategy) to stay tractable; CI re-confirms it as the net. _Why:_ mutation is _core quality_, not an env surprise, so by Q-CONF-9's principle it belongs in the local gate. _Cost:_ even diff-scoped, mutation is the biggest per-task wall-clock item (minutes-not-seconds). _Fallback:_ **(b)** keep Stryker CI-only as the net — documented to revisit if local mutation wall-clock proves prohibitive in the autonomous loop.

---

## 0. How we got here (the pivot)

1. Started from Q12 (holdout) → agreed a **hard-prevent** was warranted.
2. Maintainer asked to **re-architect where artifacts live** (spec/tasks under `.state/<run>` forces regeneration across runs; holdout placement same smell). I produced `artifact-storage-architecture.md`, then ran 3 adversarial critics over it (step "review it extremely critically").
3. **The critics demolished the security half of the storage framing.** On one uid with `Bash(*)`, _where a file sits barely changes who can touch it_ (one grant `Read/Edit/Write(${CLAUDE_PLUGIN_DATA}/**)` covers every proposed zone; protected writes are shell redirects not Edit/Write; no role reaches the hook layer; and the verdict is a **forgeable boolean** via `pipeline-state task-write`). See storage doc §0.
4. Maintainer rejected the next mechanism-level question as **"too low-level"** and reframed to **"a fundamental re-evaluation of what this plugin is for and how it works."**
5. The model that emerged — this document.

---

## 1. The reframe — confinement, not zoning

**The trust boundary is the agent, not the filesystem layout.**

- **Orchestrator = trusted.** Runs in the invoking Claude Code session. Owns the gate machinery, the verdicts, the rollup.
- **Executor (and every `isolation:worktree` subagent) = untrusted.** It is the thing being gated. Its threat profile is **emergent gaming** — a non-malicious but escalating LLM that will take the cheapest path to "green," _not_ a determined human exfiltrator.
- **In-repo is fair game.** "Anything in the repo should be fair game (so long as it respects other gates, such as the quality reviewers)." The executor is _supposed_ to rewrite the repo — that's the job. Quality is enforced at the **PR boundary** (reviewers, CI, mutation, holdout), not by forbidding edits.
- **`CLAUDE_PLUGIN_DATA` should stop being a trust store.** Maintainer: _"having anything stored in `CLAUDE_PLUGIN_DATA` is not helpful and creates the need for additional layers of security."_ If nothing the executor must-not-touch lives where the executor _can_ reach, whole defensive layers evaporate.

**Restated as one rule:** _the executor may read+write its own checkout and nothing else; everything trusted lives outside that checkout and is acted on only by the orchestrator._

---

## 2. What confinement dissolves — and the irreducible residue

Write-confining the executor to its worktree + keeping trusted artifacts outside it + running gates orchestrator-side **dissolves the entire tampering class with zero hook-denies**:

| Attack (today possible)                               | Why confinement kills it                                                                             |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Verdict forge (`task-write quality_gate.ok true`)     | state lives outside the worktree → not writable; verdict derived orchestrator-side from ground truth |
| Config edit (`config.json` blocklist self-neutralise) | config outside the worktree → not writable                                                           |
| Spec tamper (rewrite acceptance criteria)             | spec is git-canonical / orchestrator-held → not writable                                             |
| Output forge (overwrite a reviewer's `.md`)           | review artifacts written orchestrator-side, outside the worktree                                     |
| Gate-machinery edit (the project's core invariant)    | bin/, hooks/, settings outside the worktree → not writable                                           |

**Residue confinement does _not_ dissolve** (write-confinement says nothing about reads):

1. **Holdout READ.** The executor can still _read_ a withheld criterion if the secret sits anywhere it can read. Write-confinement is silent on this.
2. **Executor-produced evidence.** Coverage, test output, mutation results are _legitimately generated inside the sandbox_ by the executor's own run. Their _integrity_ (did the number get massaged?) is a separate problem — answered by **recompute in the TCB**, not by location.

These two are why §6's recommendation still needs "derive-don't-store" + "holdout off-host/advisory" on top of confinement.

---

## 3. Confinement shape — full vs write-only; and the no-OS-sandbox constraint

Two shapes were on the table:

- **Write-only confinement:** executor reads anything on the box, writes only its checkout (+ scratch).
- **Full confinement:** executor reads _and_ writes only its checkout (+ scratch) — can't read `~/.ssh`, `~/.aws`, sibling repos.

**Maintainer chose full** — rationale = blast-radius / exfiltration containment. _"The agent then has full control over the repo it's working on, and nothing else."_

**Hard constraint:** **no OS-level sandboxing as a pipeline dependency if avoidable.** _"I don't want OS-level sandboxing a dependency of the pipeline if I can avoid it. Ideally full access to the project directory plus limited access to a curated list (incl. `/tmp`). However, I lean more towards having temp files live in the repo and a cleanup script that removes them, as opposed to relying on system-level functionality."_

So the question handed to research: **can a `Bash(*)` agent be _fully_ (read) confined without an OS sandbox?**

---

## 4. Disadvantages of full confinement (surfaced, maintainer held firm)

- **Toolchain reads outside the tree** — global caches (`~/.npm`, `~/.cargo`, `~/.m2`), interpreters, `~/.gitconfig`, CA bundles. Strict full-read-confine breaks builds unless those paths are allowlisted (curated read-list).
- **Git `.git`-sharing** — worktrees share the parent `.git`. Confining strictly to the _worktree path_ breaks `git commit/push` (objects live in the shared `.git`, outside the worktree dir). Direct tension with the `worktree.baseRef:"head"` invariant. The writable set must include the needful `.git` paths _except_ the privilege-escalation ones (see §5, forced-read-only `.git/hooks`).
- **Enforcement availability** — see §5: portable enforcement is _best-effort_; airtight needs the OS sandbox the maintainer wants to avoid.
- **Plumbing** — every legitimate out-of-tree read/write becomes an allowlist entry to curate and maintain.

---

## 5. Research — how Claude Code and Codex actually confine (2026-06-03)

Two research agents, code/docs-grounded. **Bottom line: neither tool confines _reads_ without an OS sandbox — and neither confines reads even _with_ its sandbox, by default.** Full read-confinement of a `Bash(*)` agent without OS-level functionality is **not achievable** in either.

### Claude Code

- **Read/Edit/Write tool rules are path-scoped** (glob + anchors: `//abs`, `~/home`, `/project-root`, bare-relative).
- **Crucially:** Read/Edit _deny_ rules **also apply to _recognized_ bash file commands** — `cat`, `head`, `tail`, `sed`, `grep`, `find`, etc. So `Bash(cat ~/.ssh/id_rsa)` **is** blocked by a `Read(~/.ssh/**)` deny **with no sandbox at all**.
- **What it can't catch portably:** interpreters / arbitrary subprocesses (`python -c "open(...)"`, `node -e`) and command-substitution. Docs themselves call PreToolUse bash-arg filtering "fragile."
- **Built-in OS sandbox exists and is opt-in** (`sandbox.enabled`): macOS **Seatbelt (zero-install)**, Linux **bubblewrap + socat**. Defaults: write = cwd + subdirs; **read = entire computer except `denyRead`**. Settings `sandbox.filesystem.{allowWrite,denyWrite,denyRead}`, and **`failIfUnavailable:false` → graceful degrade** (use it where present, fall back where not). Network isolation via an external proxy.
- **Secret hygiene primitive:** `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` strips secrets from subprocess env; `env.TMPDIR` redirects temp.
- Sources: `code.claude.com/docs/en/{permissions,sandboxing,hooks,settings,common-workflows}.md` (fetched 2026-06-03). Continuable research agent: `a50cb486576f2e8ba`.

### Codex

- **Confinement _is_ the OS sandbox** — Seatbelt (macOS) / bubblewrap+seccomp (Linux) / restricted token (Windows). **No userspace fallback**: remove the OS sandbox and only `danger-full-access` remains.
- **Reads are NEVER confined, in any mode** — `has_full_disk_read_access()` returns `true` everywhere. Even sandboxed, Codex reads the whole disk (`~/.ssh`, `~/.aws`, siblings). Confirmed by its own security issues **#4410, #5237**.
- **Writable-allowlist model (the borrowable part):** `workspace-write` = cwd + `/tmp` + `$TMPDIR` ∪ `writable_roots`, **minus forced-read-only subpaths `.git` (esp. `.git/hooks`), `.codex`, `.agents`** — explicit anti-privilege-escalation (a writable `.git/hooks/pre-commit` is arbitrary code execution at commit time). Network **off by default**. Config: `sandbox_mode`, `[sandbox_workspace_write].writable_roots`, `network_access`, `exclude_tmpdir_env_var`, `exclude_slash_tmp`. Favors system `/tmp`; **no auto-cleanup**.
- Sources: `developers.openai.com/codex/concepts/sandboxing`, `config-reference`, `openai/codex` `protocol.rs` @ release **rust-v0.136.0 (2026-06-01)**. Continuable research agent: `a38c298664e64661a`.

### The decisive consequence

Maintainer's "full" target is not free without OS-level functionality. **But Claude Code's posture is materially better than Codex's for the no-OS case**, and lands close to what's wanted:

- **write-confinement** → achievable & portable (permission denies + bash-target hook).
- **read-_protection_** (not airtight confinement) → achievable & portable for the _obvious_ exfil (`cat ~/.ssh/...`) because Claude Code extends Read-deny to recognized bash commands. Interpreters evade — acceptable under the emergent-gaming threat model.
- **read-_confinement_** (airtight) → only with an OS sandbox. Claude Code's is **built-in, opt-in, graceful-degrading** — i.e. _opportunistic hardening, not a hard dependency_ (esp. macOS Seatbelt = zero install). This may warrant revisiting the no-OS-sandbox stance, since "use it when present" is not the same as "depend on it."

---

## 6. Recommendation — **mostly DEFERRED (see Outcome)**

> **Re-scoped 2026-06-03.** Within the confinement frame, option (a) (best-effort + opportunistic) was the right shape. But the frame itself was then deferred as gold-plating (see **Outcome**). Only the minimal slices graduate to "do now": **layer 7 → fix #1** (derive-don't-store), and **a minimal slice of layers 1+4 → fix #2** (hardcoded write-deny on the gate machinery). Layers 3, 5, 6, 8 and the full versions of 1–2/4 are deferred. Kept below verbatim as the design of record should a revisit condition trigger.

_(Original ratification, now scoped down:)_ Maintainer chose **option (a): best-effort + opportunistic** over bending the no-OS-sandbox constraint (option b) or dropping to write-only (option c). Rationale: (a) captures ~90% of full confinement at zero dependency cost, and the residual read-leak (interpreter exfil) is out of scope under the emergent-gaming threat model.

Layered, each layer independently valuable; degrade gracefully when a layer is unavailable.

1. **Write-confine the executor (portable, always-on).** Permission deny-rules + the existing PreToolUse **bash-target hook** (the shape the scribe guard at `pretooluse-pipeline-guards.sh:283-332` already uses) to bound _writes_ to the worktree (+ scratch). This is the prize — it dissolves the §2 tampering class.
2. **Read-protect sensitive paths (portable, best-effort).** Deny-list `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.config`, `.env*`, sibling repos. Claude Code enforces for built-in tools _and_ recognized bash commands. Not airtight (interpreters) — sized to emergent gaming, not a determined attacker.
3. **Opportunistic OS hardening (not a dependency).** Turn on Claude Code's built-in sandbox **where available** (`failIfUnavailable:false`), with `allowWrite:[worktree,scratch]` + `denyRead:[sensitive]`. macOS gets airtight read-confinement free (Seatbelt); Linux if `bwrap` present; everything else degrades to layers 1+2. Respects "no hard OS-sandbox dependency" while capturing the read-confinement upside where the platform allows.
4. **Borrow Codex's _model_, not its mechanism.** Writable set = worktree ∪ curated read/write list; **force `.git/hooks` read-only** (+ the plugin's own hook/bin/settings dirs) — directly serves the project's core invariant _"the executor must not modify the gate machinery."_ Network off by default.
5. **Temp in-repo (maintainer's lean, with a security bonus).** Put scratch in a **gitignored dir inside the worktree** and redirect `TMPDIR` there → you don't need `/tmp` in the writable allowlist at all, so confinement gets _tighter_. Cleanup on teardown. Caveats: must be gitignored (no diff pollution / accidental commit) and reaped (no bloat); some tools ignore `TMPDIR` and hardcode `/tmp` → keep `/tmp` as a narrow fallback only if a real tool needs it. (Codex favors system `/tmp`; we deliberately diverge.)
6. **Move trust out of reach — _git-canonical (ratified 2026-06-03)._** Trusted durable artifacts (spec, tasks, final verdicts) live **git-canonical** — durable, inspectable, portable across machines, recoverable after a plugin-data wipe, multi-repo-safe. Plugin-data keeps only ephemeral run-scoped scratch the orchestrator owns. Trusted state **must not live in the executor's working tree** (it would be writable). **Consequence / open tension:** worktree confinement protects _filesystem paths_, but the executor **shares `.git`** (worktree `.git`-sharing) and can reach any ref/object via plumbing (`git update-ref`, `git push`) — so being "in git" does **not** make an artifact unreachable to the executor. Integrity of git-canonical state therefore comes from elsewhere → **Q-CONF-7**.
7. **Derive-don't-store verdicts (orthogonal, still required).** Recompute gate verdicts from ground-truth artifacts at gate time; never trust a stored boolean. Guard `task-write` of `*_gate*` / `security_gate*` / `coverage*`. Kills the forgeable-boolean hole that confinement alone doesn't (state could be confined, but a _derived_ checklist over executor-written numbers is still gameable).
8. **Holdout off-host or advisory.** Since airtight read-confinement isn't guaranteed portably, the holdout secret can't be reliably hidden on the box. Options: evaluate off-host (a separate **orchestrator-side API call**, _not_ CI infrastructure — a different kind of "off-host" than the OS-sandbox dependency the maintainer rejected), or make it advisory. Carried from storage doc §7/§0.

**Env scrub + minimal token + network-off** apply across all layers (defense for the read paths layers 1-3 can't fully close).

---

## 7. Open questions (owned by maintainer)

- **Q-CONF-1 — _RESOLVED (2026-06-03):_ yes, as opt-in opportunistic hardening (layer 3), not a hard dependency.** Turn Claude Code's built-in sandbox on where available (`failIfUnavailable:false`); never require it.
- **Q-CONF-2 — _RESOLVED (2026-06-03):_ yes, best-effort reads off-macOS are acceptable.** "Blocks `cat ~/.ssh`; leaks via `python -c` are out of scope" is the portable floor, sized to emergent gaming, not a determined attacker.
- **Q-CONF-3 — `.git` writable carve-out.** Confinement must permit the `.git` writes `git commit/push` need (shared `.git` across worktrees) while forcing `.git/hooks` (+ plugin dirs) read-only. Confirm the exact writable/​read-only split.
- **Q-CONF-4 — Temp: in-repo `TMPDIR`-redirect vs. allowlist `/tmp`.** Default to gitignored in-worktree scratch; only allowlist `/tmp` for named tools that ignore `TMPDIR`? Who owns cleanup — teardown stage or a standalone script?
- **Q-CONF-5 — Holdout disposition.** Off-host API eval vs. advisory vs. accept best-effort hiding? (Ties to Q-V2 / Q-H1 in the storage doc.)
- **Q-CONF-6 — Does confinement let us _delete_ defensive layers?** If state/config/spec are unreachable by write, which existing hook-denies (`write-protection.sh`, parts of `pretooluse-pipeline-guards.sh`) become redundant and can be removed (simpler TCB) vs. kept as belt-and-suspenders?
- **Q-CONF-7 — Integrity model for git-canonical trusted state** _(open; raised by the layer-6 git-canonical decision)._ The executor shares `.git`, so git-canonical ≠ unreachable. Two philosophies: **(A) content-addressed + derived** (git-native, no new deps) — pin the spec to an immutable SHA recorded at run-start, read trusted artifacts by SHA, recompute all verdicts from ground truth; executor ref/blob tampering is inert because the orchestrator only reads pinned SHAs and re-derives. **(B) access-controlled store** — branch-protect the canonical refs on the remote + scope the executor's push token to its task branch so it literally cannot push trusted refs; adds a GitHub-config + credential-scoping dependency. (A) makes "derive-don't-store" (layer 7) load-bearing rather than optional.

---

## 8. Cross-references

- `artifact-storage-architecture.md` §0 (adversarial verdict), §7 (holdout), §8 (config), §12 (open questions Q-V1/Q-V2/Q-C1/Q-H1), §13 (ADR candidates). The locational work there is now _layer 6_ above.
- `design-intent-and-redesign.md` Deltas A/B (TCB / trust boundary) — confinement is the _mechanism_ for that boundary.
- `docs/explanation/decisions.md` Decision 12 (worktree.baseRef), Decision 17 (`Bash(*)` coarse allowlist — _the_ reason portable enforcement is best-effort).
- Threat model: emergent gaming (design-intent §4). Confinement is sized to it, not to a determined human adversary.
