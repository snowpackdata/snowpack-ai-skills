# Submit instructions — Cronos (snowpack-mcp)

Read by `/time-logger submit` after the org gate, for the eligible entries of one date **or a
range**. Creates time entries in Cronos through the `snowpack-mcp` connector. It never
finalizes them for billing.

A single date behaves exactly as before — everything below still applies, the continuity check
(step 3) just has nothing to compare a lone day against and reports no flags. A range is where
this earns its keep: it's a real weekly review, not a loop of single-day submits.

## 1. Prerequisites

Call `list_active_billing_codes` with `date_from`/`date_to` covering the whole submit range (a
single date: both the same). If the tool isn't available, the connector isn't connected in this
Claude Code session — say so and stop. The result gives the valid `billing_code_id` /
`staffing_assignment_id` values for the range.

## 2. Already submitted?

Call `list_time_entries` once with `date_from`/`date_to` covering the whole range. Any eligible
entry that overlaps an existing Cronos entry on its own date (same time window, or same
description) is marked `already logged` and excluded from what follows.

## 3. Continuity check (per client, across the range)

Skip this step for a single-date submit — nothing to compare against.

For a range, build a flat list of `{date, client, hours}` from every remaining eligible entry
(after step 2) and write it to a temp JSON file, then run:
```bash
python3 ~/.local/share/time-logger/scripts/check_week_continuity.py <rows.json>
```
Read the report — one entry per client, each with `daily_totals`, `weekly_total`, and `flags`:
- `gap` — a weekday with no logged time for that client, inside their own active span for the
  range (first to last date they appear). A client who only worked Monday–Tuesday this week
  never gets flagged for Wednesday onward — the check only compares a client against their own
  activity, not the whole week.
- `unusual_daily_total` — a day whose hours are far outside that client's own average for the
  range.

These are signals to show the user, never a reason to drop or alter an entry yourself.

## 4. Mapping

Pre-select codes from the client's `kind`: `internal` → the org's internal codes, `client` →
that client's engagement code. Then resolve each entry to one billing code using the
"Project / client context" and "Corrections log" sections of `user-preferences.md`. For
anything still ambiguous, ask the user one question listing the candidate codes.

## 5. Review — summary first, then the detail

**Summary table** (always shown, even for a single date — it's the headline): one row per
`date × client`, columns date · client · hours · billing code. This is what answers "what's
about to go to Cronos" at a glance, especially for a week with several clients.

Immediately below or above it (whichever reads clearer for the number of flags), surface any
`gap` / `unusual_daily_total` findings from step 3, plainly — e.g. "Grindr: no time logged
Wednesday" or "Snowpack: Thursday is 10h against a 4h average this week." Don't bury these in
the row table; they need to be seen before confirming, not discovered by scanning rows.

**Detail table**: date · start · end · hours · billing code · description, one row per entry —
below the summary, for anyone who wants to check individual rows before confirming.

Ask for explicit confirmation. Accept edits ("drop row 3", "row 2 is 1.5h", "row 4 →
INTERNAL"). Do not proceed on silence or on anything short of a clear yes.

## 6. Write

On confirmation, call `create_time_entry` once per row (it takes `date` per call, so this
works the same whether the range was one day or five) and report each result. Do **not** call
`submit_time_entries` — the user finalizes in Cronos, or asks separately.

## 7. Remember

Append any new client → billing-code mapping you learned to `user-preferences.md` under
"Project / client context" so the next submit doesn't ask again.
