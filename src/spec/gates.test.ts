import { describe, it, expect } from "vitest";
import {
  verticalSliceGate,
  testabilityGate,
  traceabilityGate,
  runSpecGates,
  extractPrdRequirements,
} from "./gates.js";
import type { SpecTask } from "./schema.js";
import type { Prd } from "./gh.js";

function task(overrides: Partial<SpecTask> = {}): SpecTask {
  return {
    task_id: "task_1",
    title: "Add checkout endpoint",
    description: "Implement the checkout endpoint",
    files: ["src/checkout.ts"],
    acceptance_criteria: ["POST /checkout returns 201 with an order id"],
    tests_to_write: ["POST /checkout returns 201 and an order id for a valid cart"],
    depends_on: [],
    risk_tier: "medium",
    risk_rationale: "payment path",
    ...overrides,
  };
}

const prd = (body: string): Prd => ({
  issue_number: 7,
  title: "Checkout",
  body,
  labels: [],
  body_truncated: false,
});

describe("testability gate — per-criterion (Δ vague criterion blocks)", () => {
  it("Δ testability: a criterion with no covering tests_to_write entry BLOCKS, cited", () => {
    const t = task({
      acceptance_criteria: ["the inventory ledger decrements on purchase"],
      tests_to_write: ["POST /checkout returns 201 for a valid cart"], // unrelated
    });
    const r = testabilityGate([t]);
    expect(r.passed).toBe(false);
    expect(r.blockers.some((b) => b.includes("inventory ledger"))).toBe(true);
  });

  it("Δ testability: a vague/non-actionable criterion BLOCKS", () => {
    const t = task({
      acceptance_criteria: ["the checkout works well"],
      tests_to_write: ["checkout works"],
    });
    const r = testabilityGate([t]);
    expect(r.passed).toBe(false);
    expect(r.blockers.some((b) => b.includes("vague"))).toBe(true);
  });

  it("Δ testability: a concrete criterion with a matching test PASSES", () => {
    const r = testabilityGate([task()]);
    expect(r.passed).toBe(true);
    expect(r.blockers).toEqual([]);
  });
});

describe("vertical-slice gate", () => {
  it("blocks a purely-horizontal decomposition (all tasks are bare layers)", () => {
    const tasks = [
      task({ task_id: "t1", title: "Database schema" }),
      task({ task_id: "t2", title: "Backend" }),
      task({ task_id: "t3", title: "Frontend" }),
    ];
    const r = verticalSliceGate(tasks);
    expect(r.passed).toBe(false);
    expect(r.blockers[0]).toContain("horizontal");
  });

  it("passes a mixed/feature decomposition", () => {
    const tasks = [
      task({ task_id: "t1", title: "Add checkout endpoint with order creation" }),
      task({ task_id: "t2", title: "Database schema" }),
    ];
    expect(verticalSliceGate(tasks).passed).toBe(true);
  });

  it("passes a single-task spec (no decomposition to judge)", () => {
    expect(verticalSliceGate([task({ title: "Backend" })]).passed).toBe(true);
  });
});

describe("traceability gate — BIDIRECTIONAL, PRD = axiom", () => {
  const body =
    "- The system must let a user submit a checkout order.\n" +
    "- The system must email an order confirmation receipt.\n";

  it("Δ traceability: a PRD requirement with NO covering acceptance criterion BLOCKS (backward)", () => {
    // Spec covers checkout submission but NOT the email confirmation requirement.
    const tasks = [
      task({
        task_id: "t1",
        title: "Submit checkout order",
        description: "user submits a checkout order",
        acceptance_criteria: ["a user can submit a checkout order"],
        tests_to_write: ["user can submit a checkout order"],
      }),
    ];
    const r = traceabilityGate(prd(body), tasks);
    expect(r.passed).toBe(false);
    expect(
      r.blockers.some(
        (b) => b.includes("email") || b.includes("confirmation") || b.includes("receipt"),
      ),
    ).toBe(true);
  });

  it("Δ traceability: a task that ladders to NO PRD requirement BLOCKS (forward)", () => {
    const tasks = [
      task({
        task_id: "t1",
        title: "Submit checkout order",
        description: "user submits a checkout order",
        acceptance_criteria: [
          "a user can submit a checkout order",
          "an order confirmation email receipt is sent",
        ],
        tests_to_write: ["user submits checkout order", "order confirmation email receipt sent"],
      }),
      task({
        task_id: "t2",
        title: "Add an unrelated analytics dashboard widget",
        description: "render telemetry sparklines on a metrics dashboard",
        acceptance_criteria: ["the analytics dashboard renders telemetry sparklines"],
        tests_to_write: ["analytics dashboard renders telemetry sparklines"],
      }),
    ];
    const r = traceabilityGate(prd(body), tasks);
    expect(r.passed).toBe(false);
    expect(r.blockers.some((b) => b.includes("t2") && b.includes("ladder"))).toBe(true);
  });

  it("Δ traceability: a fully-covered spec (both directions) PASSES", () => {
    const tasks = [
      task({
        task_id: "t1",
        title: "Submit checkout order",
        description: "user submits a checkout order",
        acceptance_criteria: ["a user can submit a checkout order"],
        tests_to_write: ["user submits a checkout order"],
      }),
      task({
        task_id: "t2",
        title: "Email order confirmation receipt",
        description: "system emails an order confirmation receipt",
        acceptance_criteria: ["the system emails an order confirmation receipt on submit"],
        tests_to_write: ["system emails order confirmation receipt"],
      }),
    ];
    const r = traceabilityGate(prd(body), tasks);
    expect(r.passed).toBe(true);
    expect(r.blockers).toEqual([]);
  });

  it("Δ traceability: a PRD with no extractable requirements BLOCKS (cannot verify the axiom)", () => {
    const r = traceabilityGate(prd("   \n  \n"), [task()]);
    expect(r.passed).toBe(false);
  });
});

describe("extractPrdRequirements", () => {
  it("pulls bullets, numbered items, and normative sentences", () => {
    const reqs = extractPrdRequirements(
      "# Heading\n- bullet one\n1. numbered item\nThe app must persist sessions.\nplain prose line\n",
    );
    expect(reqs).toContain("bullet one");
    expect(reqs).toContain("numbered item");
    expect(reqs.some((r) => r.includes("must persist sessions"))).toBe(true);
    // A plain non-normative prose line is not a requirement.
    expect(reqs).not.toContain("plain prose line");
  });
});

describe("runSpecGates — conjunctive", () => {
  it("aggregates blockers from every failing gate", () => {
    const tasks = [
      task({
        task_id: "t1",
        title: "Backend",
        acceptance_criteria: ["works well"],
        tests_to_write: ["x"],
      }),
      task({
        task_id: "t2",
        title: "Frontend",
        acceptance_criteria: ["works well"],
        tests_to_write: ["x"],
      }),
    ];
    const r = runSpecGates(prd("- must do a thing\n"), tasks);
    expect(r.passed).toBe(false);
    expect(r.blockers.length).toBeGreaterThan(1);
  });
});
