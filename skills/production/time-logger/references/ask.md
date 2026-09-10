# /time-logger <question>

Any argument that isn't a subcommand is a question. Answer it from the data home — you know
where everything is and how fresh it is — and only fetch when the question needs it.

## 1. Load the snapshot

```bash
bash <skill_dir>/scripts/context.sh
```

It prints the data home, the org and enabled sources, the submit instructions in use, server
and launchd state, when the scheduled refresh and morning run last finished, pending dashboard
comments, and a **freshness table**: for each of the last 7 days, the age of every raw source
file and of the draft (`time_entries_YYYYMMDD.md`), `-` where nothing exists. Read it before
deciding anything.

## 2. Decide whether freshness matters

Classify the question:

- **Historical / config / process** — past days, "which client is X", "how does submit work",
  "what's pending", "when did the morning run last go". Answer from disk. Never offer a refresh.
- **About today, or the current week including today** — "hours so far today", "what have I
  done this morning", "am I over 40 this week", "anything unlogged". Freshness matters. Check
  today's row: if the draft is missing, or any enabled source is older than ~2 hours, say so
  in one line *before* answering ("Today's draft is from 08:10 and Slack/Claude haven't been
  fetched since; want me to refresh first?") and ask whether to refresh or answer as-is. If
  the user already said "just tell me" or the staleness is under an hour, skip the question
  and just note the age.
- **Really a subcommand in disguise** — "refresh the dashboard", "log Friday", "submit
  yesterday", "summarize my week for the analytics review" (→ `summary`). Say which
  subcommand you're running and run it.

A refresh, when accepted, is the **Log** flow for today (prefetch enabled sources, then
`generate-time-entry`, which merges) followed by `node <data home>/app/dashboard/scripts/render.mjs`.
Don't build the combined file or upload — that stays with `log` and `morning`.

## 3. Answer from the files

Read only what the question needs:

| Question about | Read |
|---|---|
| hours, what was done, per-client split | `time_logs/time_entries_YYYYMMDD.md` — header `**Hours**` / `**Clients**` lines, then `### ` entry headings with `[client: Name]` |
| meetings, Slack, sessions, commits | `raw/{calendar,slack,claude,github,granola}/YYYY-MM-DD.md` |
| which client / org something belongs to | Orgs and Clients sections of `user-preferences.md`; `client.org` in `capabilities.yml` |
| what's stale, what's scheduled, server | the snapshot itself; `dashboard/logs/{refresh,morning}.log` for detail |
| what the dashboard is showing | `dashboard/data/*.json` (`meta.json` for section timestamps) |
| what's waiting on me | `dashboard/feedback/pending.json` (unresolved items) |
| where time goes on submit | the file named by `submit.instructions` |
| what I told people last week, previous updates | `summaries/YYYY-MM-DD_<slug>.md` (frontmatter has title, focus, audience, range) |

Rules that carry over from the rest of the skill: hours per client are computed from the
entries, not from the header, if they disagree say so. Work under an org other than
`client.org` is still visible to the user here — this is their own data — but label it as
the other org when it's mixed into a total ("9h total, 6h Snowpack, 3h Personal"). Drafts are
drafts: never describe anything as logged or submitted unless the submit instructions'
destination confirms it.

## 4. Reply

Lead with the answer. One line on freshness only when it changed what you could say. If the
user corrects something ("that was BGC, not Personal", "skip the all-hands"), apply the
**Feedback (preferences)** rule from `SKILL.md` — append to `user-preferences.md` and the
Corrections log — then offer to regenerate that day.
