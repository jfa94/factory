---
description: "Rescue a pipeline run from complex issues (merge conflicts, unmerged PRs, orphan branches, failed tasks) and hand off to resume"
argument-hint: "[--dry-run]"
arguments:
  - name: "--dry-run"
    description: "Scan and report only; skip auto-apply and user prompts"
    required: false
---

# /factory:rescue

Invoke the `rescue-protocol` skill. The skill runs autonomy check, scan, tier-1 auto-apply, tier-2/3 batch approval, apply, investigation agent dispatch, investigation batch approval, plan apply, then invokes `/factory:run resume`.

Parse `--dry-run` from the user's input. Then load the skill:

```
Skill(rescue-protocol, "dry-run=<bool>")
```

All orchestration logic lives in `skills/rescue-protocol/SKILL.md` and its `reference/` directory. Do not duplicate it here.
