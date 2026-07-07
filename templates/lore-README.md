# .lore/ — your team's shared agent memory

This folder is the team's brain. Each file is **one memory**: a mistake, a
gotcha, or a decision your agents learned the hard way. When any teammate's
Claude Code session touches a relevant file, the matching lore is injected
automatically as `TEAMLORE RECALL:` context — so nobody's agent repeats a lesson
another agent already learned.

Installed and maintained by [teamlore](https://github.com/lak7/teamlore).
Onboarding a teammate is just `git pull`.

## The one rule: lore is code — review it

Lore is **proposed** by an agent and **merged** by a human, in a PR, exactly like
code. Nothing enters the shared brain without passing review. That review is the
trust and security boundary: it is what stops a bad or poisoned instruction from
becoming something every teammate's agent obeys.

## File format

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

- Filename: `YYYY-MM-DD-slug.md` — one memory per file keeps merge conflicts rare.
- Body: ≤ 120 words, plain prose, states the lesson (and the failed approach).
- `paths` is what scopes recall — keep globs tight so agents load only what's relevant.

## How it works

- **Read:** a `SessionStart` hook and a `UserPromptSubmit` hook run
  `../.claude/skills/teamlore/scripts/recall.js`, which greps this folder's
  frontmatter and injects up to 5 matching entries (~800 tokens max), deduped
  per session.
- **Write:** the `teamlore` skill proposes new lore when you correct the agent,
  something breaks surprisingly, or a decision gets made with a reason. It stages
  the file with your change; you review and merge it.

Curate freely — edit, merge, or delete entries as the code evolves. Delete this
README once your team knows the drill.
