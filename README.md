# teamlore

**Shared memory for your team's AI agents.** Ten Claudes, one lore.

On a team of N developers, each person's coding agent learns the project's hard
lessons *alone* — the migration that nukes staging, the webhook that must be
idempotent, the internal API that lies. When Billy's Claude makes a mistake on
Monday and she corrects it, nothing stops your Claude from making the identical
mistake on Tuesday.

teamlore fixes that with **no server**. It's a Claude Code skill plus a `.lore/`
folder in git. Each developer's agent distills its sessions into small,
reviewable "lore" files; every teammate's agent recalls them automatically.
Onboarding a teammate is `git pull`.

> **Break things only once.**

## Install

In the root of a git repo:

```bash
npx teamlore init
git add -A && git commit -m "Add teamlore"
```

Teammates get it on their next `git pull` — Claude Code picks up the committed
skill and hooks automatically.

`init` is idempotent: safe to re-run, and it never clobbers existing hooks or
settings.

## What it installs

```
your-repo/
├── .claude/
│   ├── skills/teamlore/
│   │   ├── SKILL.md              # when to recall, what counts as lore, format rules
│   │   └── scripts/
│   │       ├── recall.js         # path-scoped retrieval (frontmatter match)
│   │       ├── distill-check.js  # Stop-hook capture gate
│   │       └── distill.md        # the distillation checklist
│   └── settings.json             # SessionStart + UserPromptSubmit + Stop hooks (safely merged)
├── .lore/                        # the brain — one memory per file
│   └── README.md
└── .loreignore                   # paths that never generate lore (secrets, vendor, …)
```

## How it works

- **Recall (read).** A `SessionStart` hook injects a digest of lore relevant to
  your recent git activity; a `UserPromptSubmit` hook re-checks your evolving
  working set (and any path you mention) each turn, injecting newly-relevant lore
  once. Injection is capped at ~800 tokens (≤5 entries), path-scoped — never a
  full dump, and deduped so nothing repeats within a session. Zero matches inject
  nothing (no empty-state noise).
- **Distill (write).** The `teamlore` skill proposes lore when you correct the
  agent, a command/test/deploy breaks unpredictably, or a decision is made with a
  stated reason. A `Stop` hook is a deterministic safety net: it nudges for
  capture only when a trigger fired and nothing was staged, so trivial sessions
  cost nothing.

### The lore contract

```markdown
---
paths: [src/payments/**]        # glob(s) that make this lore relevant
kind: mistake                   # mistake | gotcha | decision
by: Billy                       # git user who learned it
commit: abc123                  # short HEAD when learned (anchors staleness)
verify_by: 2026-10-01           # soft expiry (~+90 days)
---
Stripe webhook handler must be idempotent — retries caused double refunds
(#412). Tried in-memory dedupe: fails across pods. Use the processed_events
table instead.
```

- Filename `YYYY-MM-DD-slug.md`, one memory per file (merge conflicts stay rare).
- Body ≤ 120 words, plain prose, states the lesson and the failed approach.
- `paths` scopes recall — keep globs tight.

## Lore is code — review it

Lore is **proposed by an agent** and **merged by a human**, in a PR, exactly like
code. Nothing enters the shared brain without review. That review is the trust and
security boundary: it's what stops a bad or **poisoned** instruction from becoming
something every teammate's agent obeys. The skill stages lore with `git add` and
never commits — the human always merges.

## The canonical scenario

**Monday** — Billy's Claude botches a Stripe webhook handler, causing double
refunds. She corrects it; a lore file rides her fix PR. **Tuesday** — your Claude
opens `src/payments/`, recall injects Billy's entry, and your agent avoids the
in-memory dedupe approach, citing her incident. *Your team already learned this.*

## Uninstall

```bash
npx teamlore remove
```

This deletes the skill and unwires the three hooks from `.claude/settings.json`
(leaving any other hooks and settings untouched) — but **keeps your `.lore/`
folder**, since it holds your team's real, committed memories. To delete
everything including the lore and `.loreignore`:

```bash
npx teamlore remove --purge
```

## Requirements & compatibility

- **Node ≥ 18** (already required to run `npx teamlore`).
- **Claude Code** with skills + hooks support.
- Hook scripts are plain Node (no bash/jq dependency), so they run on macOS,
  Linux, and Windows.

## Status

v0.1 — the skill-and-folder release. Path-scoped grep recall (no server, no
embeddings). Planned fast-follows: `teamlore stale`, `teamlore stats` (the
"dodges" receipts), and cross-agent adapters (Cursor / Codex reading the same
`.lore/`).

## License

MIT
