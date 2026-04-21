#!/usr/bin/env bash
# Step evaluators for pipeline-score. Evaluators read $state (JSON), $run_dir,
# $metrics_file, $audit_file closure variables set by the caller. Each prints
# one of: pass | fail | skipped_ok | not_performed.

_render_table() {
  # Minimal passthrough — enhanced in Task 12.
  cat
}
