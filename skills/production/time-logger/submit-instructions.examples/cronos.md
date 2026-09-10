# Submit instructions — Cronos (snowpack-mcp)

Read by `/time-logger submit` after the org gate. Creates time entries in Cronos through the
`snowpack-mcp` connector for the eligible entries of one date. It never finalizes them for
billing.

## Prerequisites

Call `list_active_billing_codes` for the date. If the tool isn't available, the connector isn't
connected in this Claude Code session — say so and stop. The result gives the valid
`billing_code_id` / `staffing_assignment_id` values for that date.

## Already submitted?

Call `list_time_entries` for the date. An eligible entry is `already logged` — and excluded —
when an existing Cronos entry has the same description, or the same start time **and** the
same billing code. Overlapping time alone is not a duplicate: entries legitimately overlap
(parallel sessions, a meeting inside a coding block), so a different scope in the same
window is still new.

## Mapping

Pre-select codes from the client's `kind`: `internal` → the org's internal codes, `client` →
that client's engagement code. Then resolve each entry to one billing code using the
"Project / client context" and "Corrections log" sections of `user-preferences.md`. For
anything still ambiguous, ask the user one question listing the candidate codes.

## Review table

start · end · hours · billing code · description. Ask for explicit confirmation. Accept edits
("drop row 3", "row 2 is 1.5h", "row 4 → INTERNAL"). Do not proceed on silence or on anything
short of a clear yes.

## Write

On confirmation, call `create_time_entry` once per row and report each result. Do **not** call
`submit_time_entries` — the user finalizes in Cronos, or asks separately.

## Remember

Append any new client → billing-code mapping you learned to `user-preferences.md` under
"Project / client context" so the next submit doesn't ask again.
