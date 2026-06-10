export const meta = {
  name: "factory-run",
  description:
    "Factory workflow driver: pump ready tasks in parallel through the factory CLI engine",
  whenToUse: "Launched by /factory:run --mode workflow after the spec phase + run create",
  phases: [{ title: "Drive", detail: "next/drive pump loop; producers + reviewers per manifest" }],
};

// args: { runId, shipMode: 'no-merge'|'live', dataDir }
const { runId, shipMode, dataDir } = args ?? {};
if (!runId || !shipMode || !dataDir) {
  throw new Error("factory-run workflow requires args { runId, shipMode, dataDir }");
}

const AGENT_TYPE = {
  "test-writer": "factory:test-writer",
  executor: "factory:task-executor",
  "implementation-reviewer": "factory:implementation-reviewer",
  "quality-reviewer": "factory:quality-reviewer",
  "architecture-reviewer": "factory:architecture-reviewer",
  "security-reviewer": "factory:security-reviewer",
  "silent-failure-hunter": "factory:silent-failure-hunter",
  "type-design-reviewer": "factory:type-design-reviewer",
};

const ENVELOPE = {
  type: "object",
  additionalProperties: true,
  required: ["kind"],
  properties: { kind: { type: "string" } },
};
const STATUS_OUT = {
  type: "object",
  required: ["status"],
  properties: { status: { type: "string" } },
};
const RAW_OUT = { type: "object", required: ["raw"], properties: { raw: { type: "string" } } };
const REVIEW_OUT = {
  type: "object",
  required: ["reviewer", "verdict", "findings"],
  properties: {
    reviewer: { type: "string" },
    verdict: { type: "string", enum: ["approve", "blocked", "error"] },
    findings: { type: "array", items: { type: "object", additionalProperties: true } },
  },
};
const VERDICT_OUT = {
  type: "object",
  required: ["holds", "note"],
  properties: { holds: { type: "boolean" }, note: { type: "string" } },
};

const modelAlias = (id) =>
  id.includes("haiku") ? "haiku" : id.includes("sonnet") ? "sonnet" : "opus";

let fileSeq = 0; // unique results paths without Date.now() (unavailable in workflow scripts)

// Run one factory CLI command through a cheap exec agent; return its JSON envelope.
async function cli(command, label, phase) {
  const env = await agent(
    `Run exactly this command with the Bash tool:\n\n${command}\n\n` +
      "It prints ONE JSON document to stdout. Return that JSON object verbatim as your " +
      "structured output. If the command exits non-zero, FAIL LOUDLY: do not fabricate an " +
      "envelope — raise an error that quotes the stderr text.",
    { label, phase, schema: ENVELOPE, model: "haiku" },
  );
  if (env === null) throw new Error(`exec agent '${label}' was skipped or died`);
  return env;
}

// Persist a DriveResults document and fold it: write file, then drive --results.
async function foldResults(taskId, stage, results) {
  fileSeq += 1;
  // Handoff files live OUTSIDE the TCB-protected runs/** store (the plugin's own
  // hooks deny writes there); drive --results reads from any path.
  const path = `${dataDir}/results/${runId}/wf-${taskId}-${stage}-${fileSeq}.json`;
  const json = JSON.stringify(results);
  return cli(
    `mkdir -p ${dataDir}/results/${runId} && cat > ${path} << 'FACTORY_EOF'\n${json}\nFACTORY_EOF\n` +
      `factory drive --run ${runId} --task ${taskId} --ship-mode ${shipMode} --results ${path}`,
    `fold:${taskId}`,
    "Drive",
  );
}

async function runProducer(taskId, env) {
  const a = env.manifest.agents[0];
  const out = await agent(
    `You are the factory ${a.role} for task ${taskId}.\n` +
      `1. Read your producer context JSON at: ${dataDir}/runs/${runId}/${a.prompt_ref} (Read tool).\n` +
      `2. Your working tree is ${env.worktree} — cd there and make ALL commits there, on the existing branch.\n` +
      `3. Do the work your role defines (test-writer: commit failing tests first, TDD; ` +
      `executor: commit the minimal implementation that meets the visible acceptance criteria).\n` +
      `Finish with your terminal STATUS line and return it as {"status": "<line>"} ` +
      `(one of "STATUS: DONE", "STATUS: BLOCKED — escalate", "STATUS: NEEDS_CONTEXT").`,
    {
      label: `${a.role}:${taskId}`,
      phase: "Drive",
      agentType: AGENT_TYPE[a.role],
      model: modelAlias(a.model),
      schema: STATUS_OUT,
    },
  );
  if (out === null) return { producer: { status: "STATUS: BLOCKED — escalate" } }; // skipped/dead agent = loud failure, classified by the engine
  return { producer: { status: out.status } };
}

async function runVerifyCollection(taskId, env) {
  // 1. Holdout sidecar FIRST (when present).
  let holdout;
  if (env.sidecar) {
    const h = await agent(
      env.sidecar.prompt + '\n\nReturn {"raw": "<your full JSON answer as a string>"}.',
      {
        label: `holdout:${taskId}`,
        phase: "Drive",
        isolation: "worktree",
        model: modelAlias(env.sidecar.model),
        schema: RAW_OUT,
      },
    );
    if (h === null) throw new Error(`holdout validator for ${taskId} was skipped or died`);
    holdout = { raw: h.raw };
  }

  // 2. The 6-reviewer panel, concurrent.
  const reviews = (
    await parallel(
      env.manifest.agents.map(
        (a) => () =>
          agent(
            `You are the factory ${a.role}. Review task ${taskId}.\n` +
              `Inspect the change via: git -C ${env.worktree} diff staging (plus Read/Grep in ${env.worktree}).\n` +
              `Emit ONE RawReview object: {"reviewer":"${a.role}","verdict":"approve|blocked|error",` +
              `"findings":[{"reviewer":"${a.role}","severity":"info|warning|error|critical","blocking":true|false,` +
              `"file":"<path>","line":<n>,"quote":"<verbatim code>","description":"<concern>"}]}. ` +
              `"quote" is REQUIRED per finding; findings may be empty for an approve.`,
            {
              label: `${a.role}:${taskId}`,
              phase: "Drive",
              agentType: AGENT_TYPE[a.role],
              isolation: "worktree",
              model: modelAlias(a.model),
              schema: REVIEW_OUT,
            },
          ),
      ),
    )
  ).filter(Boolean);
  if (reviews.length !== env.manifest.agents.length) {
    throw new Error(
      `panel for ${taskId}: ${env.manifest.agents.length - reviews.length} reviewer(s) died — failing loud`,
    );
  }

  // 3. Verify-then-fix: one independent verifier per blocking+citable finding.
  const verifications = [];
  for (const review of reviews) {
    const citable = review.findings.filter(
      (f) => f.blocking === true && f.file !== undefined && f.line !== undefined,
    );
    const verdicts = (
      await parallel(
        citable.map(
          (f) => () =>
            agent(
              `Adversarially verify this code-review finding — try to REFUTE it against the actual code.\n` +
                `Inspect via: git -C ${env.worktree} diff staging and Read ${env.worktree}/${f.file} around line ${f.line}.\n` +
                `Finding by ${review.reviewer}: ${f.file}:${f.line} — ${f.description}\nQuoted code: ${f.quote}\n` +
                `Return {"holds": true|false, "note": "<why>"} (holds=true iff the finding is real).`,
              {
                label: `verify:${taskId}:${f.file}:${f.line}`,
                phase: "Drive",
                isolation: "worktree",
                model: "opus",
                schema: VERDICT_OUT,
              },
            ).then((v) => {
              if (v === null)
                throw new Error(`finding-verifier for ${taskId} ${f.file}:${f.line} died`);
              return { file: f.file, line: f.line, holds: v.holds, note: v.note };
            }),
        ),
      )
    ).filter(Boolean);
    verifications.push({ reviewer: review.reviewer, verdicts });
  }

  return {
    ...(holdout !== undefined ? { holdout } : {}),
    reviews: {
      reviews,
      verifications,
      crossVendorAbsent: { reason: "no second-vendor reviewer configured" },
    },
  };
}

// Pump one task to terminal (or a quota stop).
async function driveTask(taskId) {
  let env = await cli(
    `factory drive --run ${runId} --task ${taskId} --ship-mode ${shipMode}`,
    `drive:${taskId}`,
    "Drive",
  );
  for (;;) {
    if (env.kind === "terminal" || env.kind === "quota-blocked") return env;
    if (env.kind !== "spawn")
      throw new Error(`drive(${taskId}): unknown envelope kind '${env.kind}'`);
    const collected =
      env.expects === "producer-status"
        ? await runProducer(taskId, env)
        : await runVerifyCollection(taskId, env);
    // fold_key echoed verbatim — the engine rejects stale/duplicate deliveries LOUD.
    const results = { fold_key: env.fold_key, ...collected };
    env = await foldResults(taskId, env.stage, results);
  }
}

phase("Drive");
const outcomes = [];
for (;;) {
  const next = await cli(`factory next --run ${runId}`, "next", "Drive");
  if (next.kind === "quota-blocked") {
    return {
      suspended: true,
      scope: next.scope,
      reason: next.reason,
      resets_at_epoch: next.resets_at_epoch ?? null,
      outcomes,
    };
  }
  if (next.kind === "all-terminal" || next.kind === "run-terminal") {
    // all-terminal carries cascade_dropped (this-invocation drops) — surface it, never swallow.
    return {
      suspended: false,
      kind: next.kind,
      cascade_dropped: next.cascade_dropped ?? [],
      outcomes,
    };
  }
  if (next.kind !== "tasks-ready") throw new Error(`next: unknown envelope kind '${next.kind}'`);
  log(`${next.ready.length} task(s) ready: ${next.ready.join(", ")}`);
  const batch = await parallel(next.ready.map((t) => () => driveTask(t)));
  for (const r of batch.filter(Boolean)) {
    outcomes.push(r);
    if (r.kind === "quota-blocked") {
      return {
        suspended: true,
        scope: r.scope,
        reason: r.reason,
        resets_at_epoch: r.resets_at_epoch ?? null,
        outcomes,
      };
    }
  }
}
