# teamlore 🧠

**Break things only once.**

Shared memory for your team's Claude Code. One dev's agent learns
a lesson — every teammate's agent remembers it. No server, no
accounts. The brain is a `.lore/` folder in git. Onboarding is
`git pull`.

```bash
npx teamlore init
```

## Your team already learned this

Monday: Billy's Claude causes double refunds. She fixes it.
Tuesday: your Claude opens the same file — and almost does it again.
The lesson existed. It was trapped in her session history.

teamlore ends that. One agent distills the lesson into a small lore
file. Every teammate's agent recalls it. When it stops a repeat, the
terminal says so:

```
⚡ teamlore — your team already learned this.

   billy · 3 days ago · mistake · src/payments/**
   "Stripe webhook retries caused double refunds (#412).
    In-memory dedupe fails across pods. Use processed_events."

   break things only once.
```

## Install

In the root of a git repo:

```bash
npx teamlore init
git add -A && git commit -m "Add teamlore"
```

Teammates get the brain on their next `git pull`. Claude Code picks
up the committed skill and hooks automatically.

`init` is idempotent. Safe to re-run. It never clobbers existing
hooks or settings.

## How it works

**Distill.** Your agent turns hard lessons into tiny lore files —
when you correct it, when a command breaks unpredictably, or when a
decision is made with a stated reason.

**Recall.** Teammates' agents load matching lore automatically. Path-scoped,
~800 tokens, max 5 entries. Never a full dump. Zero matches inject nothing —
silence is a feature.

**Review.** Lore rides the PR. Humans merge. Nothing enters the brain
unreviewed.

## The lore contract

One lore. One file. ≤120 words. Reviewed like code.

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

- Filename `YYYY-MM-DD-slug.md`. One memory per file. Merge conflicts stay rare.
- `paths` scopes recall. Keep globs tight.

## Lore is code — review it

Lore is **proposed by an agent** and **merged by a human**, in a PR, exactly like
code. Nothing enters the shared brain without review. That review is the trust and
security boundary. It's what stops a bad or **poisoned** instruction from becoming
something every teammate's agent obeys. The skill stages lore with `git add` and
never commits. The human always merges.

## Our own brain

teamlore keeps its own `.lore/`. Every mistake Claude made building this
tool, as reviewable git history. Read it in the repo.

## Uninstall

```bash
npx teamlore remove
```

This deletes the skill and unwires the three hooks from `.claude/settings.json`
(leaving any other hooks and settings untouched). It **keeps your `.lore/`
folder** — it holds your team's real, committed memories. To delete everything
including the lore and `.loreignore`:

```bash
npx teamlore remove --purge
```

## Requirements & compatibility

- **Node ≥ 18** (already required to run `npx teamlore`).
- **Claude Code** with skills + hooks support.
- Hook scripts are plain Node (no bash/jq dependency). They run on macOS,
  Linux, and Windows.

## Telemetry

teamlore collects minimal anonymous CLI usage telemetry: command name, outcome,
duration, package version, Node version, platform, architecture, and a random
anonymous ID stored on your machine. It does not collect project content, prompts,
file paths, repo names, git remotes, usernames, hostnames, environment variables,
or stack traces.

Disable telemetry with either:

```bash
TEAMLORE_TELEMETRY_DISABLED=1 npx teamlore init
```

or:

```bash
DO_NOT_TRACK=1 npx teamlore init
```

## Status

v0.2 — the skill-and-folder release. Path-scoped grep recall. No server,
no embeddings. Planned fast-follows: `teamlore stale`, `teamlore stats`
(the "dodges" receipts), and cross-agent adapters. Built for Claude Code.
Cursor & Codex next.

## License

MIT

---

**Break things only once.**
