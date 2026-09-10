# Submit instructions — <destination name>

Read by `/time-logger submit` after the org gate. Input: the eligible entries for one date,
each with start, end, hours, `[client: Name]`, heading, and description. Fill in every
section; delete the guidance in angle brackets.

## Prerequisites

<What must be available for this to work — an MCP tool, a CLI, a mounted folder. Say exactly
how to check, and what to tell the user if the check fails, e.g. "call `list_x`; if the tool
isn't in this session, say the connector isn't connected and stop.">

## Already submitted?

<How to tell whether an entry for this date was already sent, so re-running submit is safe.
Query the destination, or look for a file. Mark matches `already submitted` and exclude them.>

## Mapping

<How a `[client: Name]` and the client's `kind` (internal | client | personal) become whatever
identifier the destination needs — a billing code, a folder, a column value. Consult the
"Project / client context" and "Corrections log" sections of `user-preferences.md` first.
If a mapping is still ambiguous, ask the user once, listing the candidates.>

## Review table

<Columns to show before asking for confirmation. Minimum: start, end, hours, destination
identifier, description. Accept row edits like "drop row 3", "row 2 is 1.5h".>

## Write

<Exactly what to do per confirmed row, and what NOT to do — e.g. create but never finalize.
Report each result.>

## Remember

<What to append to `user-preferences.md` so the next run doesn't ask the same question.>
