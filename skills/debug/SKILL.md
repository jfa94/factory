---
name: debug
description: Review and repair a committed diff using the v2 feature engine.
auto-invoke: false
---

# Debug

Follow `commands/debug.md` and `skills/pipeline-runner/SKILL.md`.
Create with `factory debug create --base <ref>`, then drive next-action with
a stable driver identity. The engine owns review, repair budgets and delivery.
Debug always leaves a reviewable PR or a verified no-change outcome.
Never invoke legacy staging, seed, finalize or per-task scheduling commands.
