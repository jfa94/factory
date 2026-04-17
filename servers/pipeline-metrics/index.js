#!/usr/bin/env node
/**
 * Pipeline Metrics MCP Server
 *
 * Provides tools for recording and querying pipeline execution metrics.
 * Uses SQLite for local storage.
 *
 * Tools:
 *   metrics_record  — Record a pipeline event
 *   metrics_query   — Query events with filters
 *   metrics_summary — Summarize metrics for a run
 *   metrics_export  — Export metrics as JSON
 *
 * Event types:
 *   task_start, task_end, review_round, quality_gate,
 *   model_switch, circuit_breaker, run_start, run_end
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import Database from "better-sqlite3";
import { resolve, dirname } from "path";
import { mkdirSync } from "fs";

const DB_PATH = process.env.METRICS_DB || resolve("metrics.db");

// Ensure parent directory exists
mkdirSync(dirname(DB_PATH), { recursive: true });

// Initialize database
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.prepare(
  `
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    run_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    task_id TEXT,
    data TEXT DEFAULT '{}',
    duration_ms INTEGER
  )
`,
).run();
db.prepare("CREATE INDEX IF NOT EXISTS idx_events_run ON events(run_id)").run();
db.prepare(
  "CREATE INDEX IF NOT EXISTS idx_events_type ON events(event_type)",
).run();

const CURRENT_SCHEMA_VERSION = 1;
const dbVersion = db.pragma("user_version", { simple: true });
if (dbVersion < 1) {
  db.pragma("user_version = 1");
}

const VALID_EVENT_TYPES = [
  "task_start",
  "task_end",
  "review_round",
  "quality_gate",
  "circuit_breaker",
  "run_start",
  "run_end",
];

// Domain-specific exception so the dispatcher can distinguish caller-input
// failures (returned as isError MCP responses) from genuine server crashes
// (re-thrown so the transport surfaces them).
class HandlerInputError extends Error {
  constructor(message) {
    super(message);
    this.name = "HandlerInputError";
  }
}

function _requireString(args, key) {
  const v = args?.[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new HandlerInputError(
      `missing or invalid required field: ${key} (expected non-empty string)`,
    );
  }
  return v;
}

// Tool definitions
const TOOLS = [
  {
    name: "metrics_record",
    description: "Record a pipeline execution event",
    inputSchema: {
      type: "object",
      properties: {
        run_id: { type: "string", description: "Pipeline run ID" },
        event_type: {
          type: "string",
          enum: VALID_EVENT_TYPES,
          description: "Type of event",
        },
        task_id: {
          type: "string",
          description: "Task ID (optional)",
        },
        data: {
          type: "object",
          description: "Additional event data",
        },
        duration_ms: {
          type: "number",
          description: "Duration in milliseconds (optional)",
        },
      },
      required: ["run_id", "event_type"],
    },
  },
  {
    name: "metrics_query",
    description: "Query pipeline events with filters",
    inputSchema: {
      type: "object",
      properties: {
        run_id: { type: "string", description: "Filter by run ID" },
        event_type: { type: "string", description: "Filter by event type" },
        task_id: { type: "string", description: "Filter by task ID" },
        limit: {
          type: "number",
          description: "Max results (default 100)",
          default: 100,
        },
        offset: {
          type: "number",
          description: "Offset for pagination (default 0)",
          default: 0,
        },
      },
    },
  },
  {
    name: "metrics_summary",
    description: "Get a summary of metrics for a pipeline run",
    inputSchema: {
      type: "object",
      properties: {
        run_id: { type: "string", description: "Pipeline run ID" },
      },
      required: ["run_id"],
    },
  },
  {
    name: "metrics_export",
    description: "Export all metrics for a run as JSON",
    inputSchema: {
      type: "object",
      properties: {
        run_id: { type: "string", description: "Pipeline run ID" },
      },
      required: ["run_id"],
    },
  },
];

// Parse a stored event.data blob. Returns { data, parse_error }.
// Stored data should always be valid JSON because handleRecord stringifies
// it on the way in, but rows written by an older schema (or hand-edited
// rows) could be corrupt — surface that via parse_error instead of swallowing
// the failure with `{}`.
function _parseStoredData(raw) {
  if (raw === null || raw === undefined || raw === "") {
    return { data: {}, parse_error: null };
  }
  try {
    return { data: JSON.parse(raw), parse_error: null };
  } catch (err) {
    return { data: {}, parse_error: err.message };
  }
}

// Handlers
function handleRecord(args) {
  const run_id = _requireString(args, "run_id");
  const event_type = _requireString(args, "event_type");
  if (!VALID_EVENT_TYPES.includes(event_type)) {
    throw new HandlerInputError(
      `invalid event_type: ${event_type} (expected one of ${VALID_EVENT_TYPES.join(", ")})`,
    );
  }
  const { task_id, data, duration_ms } = args;
  if (
    task_id !== undefined &&
    task_id !== null &&
    typeof task_id !== "string"
  ) {
    throw new HandlerInputError("task_id must be a string when present");
  }
  if (
    data !== undefined &&
    data !== null &&
    (typeof data !== "object" || Array.isArray(data))
  ) {
    throw new HandlerInputError("data must be an object when present");
  }
  if (
    duration_ms !== undefined &&
    duration_ms !== null &&
    (typeof duration_ms !== "number" || !Number.isFinite(duration_ms))
  ) {
    throw new HandlerInputError(
      "duration_ms must be a finite number when present",
    );
  }

  const stmt = db.prepare(
    "INSERT INTO events (run_id, event_type, task_id, data, duration_ms) VALUES (?, ?, ?, ?, ?)",
  );
  const result = stmt.run(
    run_id,
    event_type,
    task_id || null,
    JSON.stringify(data || {}),
    duration_ms == null ? null : duration_ms,
  );
  return { id: result.lastInsertRowid, recorded: true };
}

function handleQuery(args) {
  const { run_id, event_type, task_id, limit = 100, offset = 0 } = args || {};
  if (run_id !== undefined && typeof run_id !== "string") {
    throw new HandlerInputError("run_id must be a string when present");
  }
  if (event_type !== undefined && typeof event_type !== "string") {
    throw new HandlerInputError("event_type must be a string when present");
  }
  if (task_id !== undefined && typeof task_id !== "string") {
    throw new HandlerInputError("task_id must be a string when present");
  }
  if (typeof limit !== "number" || !Number.isFinite(limit) || limit < 0) {
    throw new HandlerInputError("limit must be a non-negative number");
  }
  if (typeof offset !== "number" || !Number.isFinite(offset) || offset < 0) {
    throw new HandlerInputError("offset must be a non-negative number");
  }

  let sql = "SELECT * FROM events WHERE 1=1";
  const params = [];
  if (run_id) {
    sql += " AND run_id = ?";
    params.push(run_id);
  }
  if (event_type) {
    sql += " AND event_type = ?";
    params.push(event_type);
  }
  if (task_id) {
    sql += " AND task_id = ?";
    params.push(task_id);
  }
  sql += " ORDER BY timestamp DESC LIMIT ? OFFSET ?";
  params.push(limit, offset);
  return db.prepare(sql).all(...params);
}

function handleSummary(args) {
  const run_id = _requireString(args, "run_id");
  const events = db
    .prepare("SELECT * FROM events WHERE run_id = ? ORDER BY timestamp")
    .all(run_id);

  if (events.length === 0) {
    return { run_id, error: "No events found" };
  }

  const summary = {
    run_id,
    total_events: events.length,
    event_counts: {},
    tasks: {},
    total_duration_ms: 0,
    review_rounds: 0,
    quality_gates: { passed: 0, failed: 0 },
    parse_errors: [],
  };

  for (const event of events) {
    summary.event_counts[event.event_type] =
      (summary.event_counts[event.event_type] || 0) + 1;

    if (event.duration_ms) {
      summary.total_duration_ms += event.duration_ms;
    }

    if (event.task_id) {
      if (!summary.tasks[event.task_id]) {
        summary.tasks[event.task_id] = { events: 0 };
      }
      summary.tasks[event.task_id].events++;
    }

    if (event.event_type === "review_round") {
      summary.review_rounds++;
    }

    if (event.event_type === "quality_gate") {
      const { data, parse_error } = _parseStoredData(event.data);
      if (parse_error) {
        summary.parse_errors.push({ event_id: event.id, parse_error });
        continue;
      }
      if (data.passed) {
        summary.quality_gates.passed++;
      } else {
        summary.quality_gates.failed++;
      }
    }
  }

  if (summary.parse_errors.length === 0) {
    delete summary.parse_errors;
  }

  return summary;
}

function handleExport(args) {
  const run_id = _requireString(args, "run_id");
  return db
    .prepare("SELECT * FROM events WHERE run_id = ? ORDER BY timestamp")
    .all(run_id)
    .map((row) => {
      const { data, parse_error } = _parseStoredData(row.data);
      const out = { ...row, data };
      if (parse_error) {
        out.data_parse_error = parse_error;
      }
      return out;
    });
}

// Server setup
const server = new Server(
  { name: "pipeline-metrics", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  let result;
  try {
    switch (name) {
      case "metrics_record":
        result = handleRecord(args);
        break;
      case "metrics_query":
        result = handleQuery(args);
        break;
      case "metrics_summary":
        result = handleSummary(args);
        break;
      case "metrics_export":
        result = handleExport(args);
        break;
      default:
        return {
          content: [{ type: "text", text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }
  } catch (err) {
    if (err instanceof HandlerInputError) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { error: err.message, tool: name, kind: "input_validation" },
              null,
              2,
            ),
          },
        ],
        isError: true,
      };
    }
    // Genuine server-side failure (DB error, etc.). Surface as isError but
    // also re-log so the host process notices.
    process.stderr.write(
      `pipeline-metrics ${name} failed: ${err.stack || err.message}\n`,
    );
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            { error: err.message, tool: name, kind: "internal_error" },
            null,
            2,
          ),
        },
      ],
      isError: true,
    };
  }
  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
  };
});

const transport = new StdioServerTransport();
await server.connect(transport);
