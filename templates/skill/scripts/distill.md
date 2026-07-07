# Distillation checklist

Run this when a teamlore write-trigger fired (see SKILL.md). Goal: turn what this
session taught into at most one small, durable, team-relevant lore file — or
decide, honestly, that nothing qualifies.

## 1. Is there a real lesson?

A lesson qualifies only if it is **durable** (still true next month), **team-relevant**
(would save any teammate, not just you), and **not reproducible from the code**.

- ✅ mistake corrected, surprising failure, decision-with-a-why
- ❌ task status, personal preference, a secret, or "the code already says this"

If it does not qualify, stop here and tell the user why — do not write a file.

## 2. Check for a duplicate

Skim existing `.lore/*.md` (recall likely already surfaced the relevant ones). If an
entry already covers this lesson, **update that file** (refresh `commit`/`verify_by`,
sharpen the body) instead of adding a near-duplicate.

## 3. Fill the frontmatter

- `paths`: glob(s) matching the files this lesson is about, e.g. `[src/payments/**]`
  or `[prisma/schema.prisma, prisma/migrations/**]`. Scope tightly — this controls
  who gets the recall.
- `kind`: `mistake` | `gotcha` | `decision`.
- `by`: the git user. Get it: `git config user.name` (or `user.email`).
- `commit`: short HEAD now. Get it: `git rev-parse --short HEAD`.
- `verify_by`: about 90 days out (soft expiry that a future stale-check nags on).

## 4. Write the body

≤ 120 words, plain prose. State the **lesson** and, if relevant, the approach that
failed and the fix. No code blocks over 5 lines. Keep it agent-agnostic.

## 5. Stage it (do not commit)

- Path: `.lore/YYYY-MM-DD-slug.md` (today's date, short kebab slug).
- `git add .lore/<file>` so it rides the same PR as the code change.
- Leave the commit to the human — lore is reviewed like code.

Tell the user in one line what you captured and where.
