# /time-logger summary [focus]

Produces a progress summary backed by real time-log data, for whatever audience and occasion
the focus names, then **saves it** to the data home so it shows up on the dashboard's
Summaries tab and can feed later reviews. `standup` is an alias: `/time-logger standup` ≡
`/time-logger summary Friday standup Slack message — this week and what's next`.

Paths are relative to the data home (`~/.local/share/time-logger/`, or `$TIME_LOGGER_DATA_HOME`).

## Step 0 — Read the focus

The argument is free text. Pull four things out of it, defaulting where it's silent:

| | Default | Examples of what overrides it |
|---|---|---|
| **scope** | Monday of this week through today | "last two weeks", "since the 1st", "yesterday and today", "Q3 so far" |
| **audience** | the user's manager / team lead (see "Project / client context" in `user-preferences.md`) | "for the analytics team review", "for the client", "for my own notes" |
| **format** | verbal bullets Mon–Thu, Slack message on Friday | "Slack message", "email", "one paragraph", "talking points", "doc section" |
| **extra context** | none | "look at previous Granola notes for this meeting to see what they care about", "include the blockers on the migration" |

When the focus names a recurring meeting, read the last 2–3 Granola notes whose title matches
(`raw/granola/*.md`, or the Granola MCP `list_meetings` if enabled) before drafting, so the
update speaks to what that group tracks. Echo the resolved scope, audience, and format in one
line before doing anything else, e.g. `Summary → Sep 1–9, analytics team review, talking points`.

### Preset: `daily digest`

The dashboard's Overview digest is this flow with a fixed focus, so the digest is stored,
linked, and rendered exactly like every other summary. `refresh digest`, `refresh all`, and
the morning run invoke it as `summary daily digest`. The preset pins Step 0:

| | |
|---|---|
| **scope** | yesterday (last workday), Monday–today, and last week |
| **audience** | the user themself, first thing in the morning |
| **format** | `digest` — markdown with exactly these sections, in this order |
| **delivery** | none — Step 5 is skipped; it only gets saved (Step 6) |
| **file** | `summaries/YYYY-MM-DD_daily-digest.md`, today's date, overwritten on every run |
| **title** | `Daily digest — <Weekday, Mon D>` |

Body sections:

```markdown
## Where you left off
- 3–5 bullets of open threads: the latest time-entry file's Open Items, in-flight todos (if a
  todos file is configured), open PRs. Verdicts and next actions, not raw evidence.

## Yesterday — <Weekday, Mon D>
2–3 sentences on the last workday's entries. If none exist, one line saying which prefetch to run.

## This week (<Mon D>–<today>)
Monday through today, one short paragraph.

## Last week (<range> · <N>h)
Hours summed from last week's time-entry headers; one paragraph of themes, no per-day detail.
```

Client gate as in Step 4: only clients under the configured org, and one closing line
`Other orgs: <N>h this week, <N>h last week` so the personal total stays visible. Freshness
(Steps 2–3) still runs — a digest built on a stale yesterday is wrong in the way that matters
most. Link every reference as in Step 4.

## Step 1 — Determine scope

Use the scope from Step 0 — default **Monday of this week through today, inclusive**. Today
is naturally partial, but a progress summary is "what I've done to this point + what's next"
— always fetch today's data as part of the freshness pass (otherwise work finished this
morning shows up under "next up"). If the scope is just today and it's Monday, say the week
is only starting.

## Step 2 — Freshness check

For each day in scope, check the combined file (`<slug>` is `client.slug`; no suffix if blank):

```bash
ls -l ~/.local/share/time-logger/raw/combined/time-log_YYYY-MM-DD_<slug>.md
```

Classify each day:

- **Missing** — no combined file → needs a prefetch + log run.
- **Possibly outdated** — the file's last-modified date is the *same calendar day* the file
  covers, and that day is now in the past. (A fetch made mid-day can't have captured work done
  after it; a fetch made any later day is complete.) → needs a rerun.
- **Fresh** — file exists and was last modified on a later day than the one it covers.
- **Today** — always fetch/refetch, regardless of whether a combined file exists.

Also note per day whether a `## Recommended Time Log Structure` section exists (the day has
been through `log`, and possibly the dashboard review). Prefer that section as the source of
truth when summarizing; fall back to the raw sections when it's absent — don't block the
standup on an unreviewed day.

## Step 3 — Refetch what's needed

If any days are missing or possibly outdated, **tell the user first** — one line, e.g.
"Mon was never fetched and Tue was fetched mid-day; refetching both before summarizing" —
then run **Prefetch** for those days (parallel fetch agents), rebuild each combined file per
[`combined-file.md`](./combined-file.md). Prefetch is
idempotent — rerunning a day overwrites in place. Don't regenerate time entries here (standup
only needs the data); carry any existing Recommended Time Log Structure section over, and
mention that refetched days haven't been re-logged. Fresh time logs matter for these
summaries — don't skip this step because the focus is informal.

If everything is fresh, say so in one line and move on.

## Step 4 — Summarize

Read each in-scope day's combined file (Recommended Time Log Structure sections first). Also
scan the most recent Slack DMs/threads in the raw data for stated next steps (e.g. priorities
agreed with a teammate) — "what's next" should come from real commitments, not invention.

**Audience: from Step 0** (default the user's manager or team lead — check "Project / client
context" in `user-preferences.md` for who that is and anything they care about). The summary exists so
they can see where things are, what shipped, what's in progress, and where they may need to
step in — not to prove the work happened. Write verdicts, not evidence: "shipped and
backfilled", not the sandbox/validation/CI mechanics behind it. Keep a number only if someone
downstream will notice or ask about it; drop implementation detail (review-comment fixes,
verification methodology, tooling friction). One distinct scope per bullet — never merge
unrelated work because it's the same kind of work.

**Match the team's format, not a status log.** If `client.standup_channel_id` is set in
`capabilities.yml`, read the latest ~5 teammate updates there (`slack_read_channel`) before
drafting and mirror the prevailing structure and tone — formats drift, so check every time.
Without a channel, use this default:

- **Group by project/workstream**, one bold header per project — NOT status sections like
  Done / In progress / Waiting.
- Under each project, 1–3 bullets of plain human sentences: what happened, the outcome, and
  what's next on that project — status woven into the narrative ("merged Monday", "ready for
  review", "next up: comparing against the WBR decks").
- **Never list bare PR numbers or repos** — that reads like a generated changelog. Embed
  links in descriptive text instead, or omit the link entirely.
- **Link every reference you keep.** A ticket, PR, Slack thread, doc, or dashboard that the
  reader might open should be a link, not a bare identifier:
  - Jira tickets → `client.jira_browse_url` + the ID (`[PROJ-123](https://acme.atlassian.net/browse/PROJ-123)`
    in markdown, `<url|PROJ-123>` in Slack). If `jira_browse_url` is blank, leave the ID as
    plain text — don't guess a host.
  - PRs → the PR URL from `raw/github/` or the dashboard's PR store, anchored on descriptive
    text ("the tiered analytics change"), per the rule above.
  - Slack threads → the permalink when the raw data has it.
  - Granola notes, artifacts, docs → the URL the source recorded.
  This applies to the saved file as much as the delivered message — the saved markdown is
  what gets re-read later, and a bare `PROJ-123` there is a dead end.
- Credit collaborators by name (thanks/h/t with @mentions where natural).
- Blockers and nudges must stay visible — in the relevant project's bullet or a short closing
  line ("Next week: ..."), never buried.
- Optional personal note at the end (OOO, etc.). Ask the user — or infer from the
  conversation — whether there's anything the data can't capture: upcoming time off,
  handoffs, blockers, or asks they want surfaced.

**Client gate.** The summary covers clients under the configured org only (`client.org` in
`capabilities.yml`, resolved through the Orgs and Clients sections of `user-preferences.md`).
Skip every entry whose client belongs to any other org — personal projects and side clients
never appear in a summary for the configured organization, even as an aside. Entries tagged `unknown` are skipped too; mention
once at the end that N entries were untagged so the user can fix the Clients map. When the
configured org has several clients (internal work plus client engagements), group the
summary by client first, then by workstream.

Other exclusions follow the same rules as time entries (no time-logger tooling, no
self-DMs, no automated job runs — but interactive confirmation/analysis of job outputs IS
real work, and often the evidence that something is Done rather than Next).

## Step 5 — Deliver

Use the format from Step 0:

- **Verbal / talking points** (default Mon–Thu): present directly in chat, formatted for
  reading aloud — plain bullets, bold workstream names, no preamble.
- **Slack message** (default Friday, or when asked): the project-grouped style from Step 4
  (bold workstream headers, • bullets of human sentences, embedded links). Show the draft and
  ask the user to confirm or adjust; once approved, send via `slack_send_message` to their own
  user ID (`integrations.slack.user_id`) as a self-DM, or to a channel they name, and return
  the message link. **Never send without confirmation** — these messages are visible to
  others. Don't add version labels like "(v2)" unless replacing an already-sent message.
- **Anything else** (email, paragraph, doc section): present it in chat in that shape.

## Step 6 — Save it

Every summary is kept, so it can be re-read, compared with the next one, and used to review
time entries later. After the user is happy with it (or immediately, if they don't respond
with edits), write:

```
<data home>/summaries/YYYY-MM-DD_<slug>.md
```

where the date is today and `<slug>` is a short kebab-case name from the focus
(`friday-standup`, `analytics-team-review`, `client-progress-email`). If a file with that
name already exists today, overwrite it — one summary per focus per day. Shape:

```markdown
---
title: Friday standup — week of Sep 8
date: 2026-09-12
focus: Friday standup Slack message — this week and what's next
audience: team lead
format: slack
range: 2026-09-08..2026-09-12
sources: [time_entries, slack, granola]
sent: https://snowpack.slack.com/archives/C0.../p...   # only if it was actually sent
---

<the summary body, in standard markdown — the same content the user approved>
```

`title` is what the dashboard lists, so make it say what the update was for and roughly when:
audience or occasion plus a date hint, never just "Summary". Keep references linked in the
body (see Step 4) — write markdown links, not Slack `<url|text>` syntax, so the viewer renders
them; the Slack form belongs only in the `## As sent` block. If a Slack message was sent,
also append a `## As sent` section with the exact text in a fenced block. Then run
`node <data home>/app/dashboard/scripts/render.mjs` so the Summaries tab picks it up, and tell
the user the file path in one line.
