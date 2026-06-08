/**
 * WS10 — the low-level SPAWN mechanics: map a frozen {@link SpawnManifest}'s
 * agents onto the injected runner boundaries the loop owns.
 *
 * ARCHITECTURE (Model A — see types.ts): a HANDLER reports a spawn manifest; it
 * never spawns. The LOOP ({@link driveTask}) acts on that manifest by calling the
 * functions here. They are the ONE place that translates a manifest agent
 * ({role, model, max_turns, prompt_ref}) into a concrete runner call — so the
 * handler/loop split stays honest and the v1 CLI single-step path + the in-process
 * loop spawn IDENTICALLY (parity).
 *
 * Two manifest shapes, two return types, hence two functions (not one polymorphic
 * dispatch): a producer manifest yields a {@link ProducerOutcome} (a STATUS), a
 * panel manifest yields the reviewers' {@link RawReview}s (pre verify-then-fix).
 * A scribe spawn is a fire-and-forget docs pass (invariant #7).
 *
 * The producer↔reviewer worktree asymmetry is INTENTIONAL and follows the frozen
 * types: a {@link ProducerSpawn} carries no worktree (the producer runner is bound
 * to its task worktree at construction — the CLI/skill surface), whereas a
 * {@link ReviewerSpawnInput} carries the worktree per call (one reviewer runner
 * inspects many task worktrees). We honour the seams rather than reshape them.
 */
import type {
  ProducerOutcome,
  ProducerRole,
  ProducerSpawn,
  RawReview,
  SpawnAgent,
  SpawnRole,
} from "./deps.js";
import type { HandlerDeps, ReviewerRunner, ScribeRunner } from "./types.js";
import type { ProducerAgentRunner } from "./deps.js";

/** The producer roles, mirrored from the manifest vocabulary (TDD order). */
const PRODUCER_ROLES: readonly SpawnRole[] = ["test-writer", "executor"];

/**
 * Narrow a manifest agent's {@link SpawnRole} to a {@link ProducerRole}, LOUD on
 * mismatch. A producer manifest only ever carries `test-writer` / `executor`; a
 * reviewer/scribe role reaching {@link spawnProducer} is a wiring bug, never a
 * silent miscast.
 */
export function asProducerRole(role: SpawnRole): ProducerRole {
  if (role === "test-writer" || role === "executor") {
    return role;
  }
  throw new Error(
    `agent-runner: '${role}' is not a producer role (expected one of ${PRODUCER_ROLES.join(", ")})`,
  );
}

/**
 * Perform ONE producer spawn from a manifest agent: read the assembled
 * {@link ProducerContext} back from the artifact store the reporter persisted it
 * to (the `prompt_ref` round-trip — see artifacts.ts), build the
 * {@link ProducerSpawn}, and run it. Returns the producer's parsed
 * {@link ProducerOutcome} for the loop to classify (classify-before-retry, Δ D).
 *
 * `getProducerContext` is LOUD if the ref is absent — a missing artifact must
 * surface, never fall through to an empty-context spawn.
 */
export async function spawnProducer(
  agent: SpawnAgent,
  runId: string,
  deps: Pick<HandlerDeps, "artifacts">,
  producer: ProducerAgentRunner,
): Promise<ProducerOutcome> {
  const context = await deps.artifacts.getProducerContext(runId, agent.prompt_ref);
  const spawn: ProducerSpawn = {
    role: asProducerRole(agent.role),
    model: agent.model,
    maxTurns: agent.max_turns,
    context,
  };
  return producer.run(spawn);
}

/**
 * Spawn every reviewer in a panel manifest against one task worktree, returning
 * their RAW reviews (verdict + un-verified findings) in manifest order. The panel
 * members are independent, so they run CONCURRENTLY; `Promise.all` over `map`
 * preserves manifest order in the result, which keeps the downstream
 * citation-verify / floor derivation deterministic.
 *
 * No verdict is computed here — the loop feeds these raw reviews into `runPanel`
 * (citation-verify + independent finding-verifier + floor derivation, D27).
 */
export function spawnReviewers(
  agents: readonly SpawnAgent[],
  worktree: string,
  taskId: string,
  reviewer: ReviewerRunner,
): Promise<RawReview[]> {
  return Promise.all(
    agents.map((agent) =>
      reviewer.review({
        role: agent.role,
        model: agent.model,
        maxTurns: agent.max_turns,
        worktree,
        taskId,
      }),
    ),
  );
}

/**
 * Run the run-level Scribe (docs) pass over the integration worktree — a
 * fire-and-forget side effect (invariant #7: docs generation survives the
 * rewrite). The loop calls this only when a {@link ScribeRunner} is wired AND the
 * run reached a shippable terminal; absence of the runner is a no-op, not an error.
 */
export async function spawnScribe(
  worktree: string,
  maxTurns: number,
  scribe: ScribeRunner,
): Promise<void> {
  await scribe.document({ worktree, maxTurns });
}
