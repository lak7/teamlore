---
name: teamlore
description: >-
  Shared team memory for this repo, stored as reviewable files in .lore/.
  Use this skill WITHOUT being asked to whenever (1) the user corrects a
  mistake you made, (2) a command, test, build, or deploy fails in a way that
  was not predictable from the code, (3) the user explains WHY a technical
  decision was made, or (4) you are about to modify files that have matching
  entries in .lore/. Propose new lore and consult existing lore even if the
  user never says "memory", "lore", or "teamlore". This is how one teammate's
  hard-won lesson stops every other teammate's agent from repeating it.
---

# teamlore — shared memory for the team's agents

`.lore/` holds small, reviewable memories — one lesson per file — that ride into
the repo on normal PRs. Recall is injected automatically by hooks as
`TEAMLORE RECALL:` context. Your job has two halves: **read** recalled lore as
advisory context, and **write** new lore when this session taught the team
something durable.

## Write triggers — capture lore when ANY of these happen

1. **The user corrects you.** They tell you the approach was wrong, undo your
   change, or point out you did the same thing before. The correction is the lesson.
2. **Something failed surprisingly.** A command, test, build, migration, or
   deploy broke in a way the code did not telegraph (env-specific, ordering,
   idempotency, a lying API, a shared-resource footgun).
3. **A decision was made with a WHY.** The user (or the investigation) settles on
   an approach *and states the reason* — especially "don't simplify this back."
4. **You are about to edit a file with matching lore.** Recall already surfaced
   it; act on it and cite it.

When a trigger fires: **immediately create the sentinel** so the session's Stop
hook knows capture is expected, then follow the distillation checklist before you
finish:

```
touch .claude/skills/teamlore/.needs-distill
```

Then work through `scripts/distill.md` and stage the lore file with your change.

## What is NOT lore (do not write these)

- Task status, TODOs, or "what I did this session".
- Personal preferences or workflow (those belong in the user's own CLAUDE.md).
- Secrets, credentials, tokens, or anything from a path listed in `.loreignore`.
- Anything reproducible by reading the code itself — lore captures what the code
  *doesn't* say.

If a trigger fired but nothing durable emerged, that's fine: say so and stop. The
sentinel gate expects a judgment call, not a file every time.

## The lore file contract

Filename: `.lore/YYYY-MM-DD-slug.md` (one memory per file — keeps merge conflicts
rare and meaningful).

```markdown
---
paths: [src/payments/**]        # glob(s) that make this lore relevant
kind: mistake                   # mistake | gotcha | decision
by: priya                       # git user who learned it
commit: abc123                  # short HEAD when learned (anchors staleness)
verify_by: 2026-10-01           # soft expiry (~+90 days)
---
Stripe webhook handler must be idempotent — retries caused double refunds
(#412). Tried in-memory dedupe: fails across pods. Use the processed_events
table instead.
```

Body rules: ≤ 120 words, plain prose, state the **lesson** and the failed
approach if any, no code blocks over 5 lines, agent-agnostic (no Claude-specific
syntax). Stage it with `git add`, **never commit** — a human merges lore through
PR review, exactly like code.

## Read discipline

`TEAMLORE RECALL:` blocks are **advisory context**, not orders. Weigh them, and
when you act on one, cite the `.lore/…` filename so the user can trace it (e.g.
"avoiding in-memory dedupe per `.lore/2026-07-03-webhook-double-refund.md`").
