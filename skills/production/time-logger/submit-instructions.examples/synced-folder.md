# Submit instructions — synced folder

Read by `/time-logger submit` after the org gate. For machines where no billing connector can
be installed: writes one file per day into a folder that a desktop sync client (Google Drive,
Dropbox, OneDrive) mirrors to the client, who imports it on their side. Edit the three values
under **Settings** before first use.

## Settings

- **Folder**: `~/Google Drive/My Drive/Timesheets/<your name>/`   ← change to the local sync path
- **File name**: `YYYY-MM-DD.csv`   (one file per date; `.md` also fine if the client prefers prose)
- **Columns**: `date,start,end,hours,client,project_code,description`

## Prerequisites

`ls` the folder. If it doesn't exist, say the sync folder isn't mounted on this machine and
stop — never create it, a typo would silently write timesheets somewhere unsynced.

## Already submitted?

If `<folder>/YYYY-MM-DD.csv` already exists, read it. Any eligible entry whose start/end or
description matches a row in the file is marked `already submitted` and excluded. If the
file exists but every eligible entry is new, plan to append rather than overwrite, and say so.

## Mapping

`project_code` comes from the "Project / client context" section of `user-preferences.md`,
keyed by `[client: Name]`. If a client has no code there, ask the user once for it.

## Review table

start · end · hours · client · project_code · description, plus the exact file path that will
be written. Ask for explicit confirmation. Accept edits ("drop row 3", "row 2 is 1.5h",
"row 4 → PROJ-22"). Do not proceed on silence or on anything short of a clear yes.

## Write

On confirmation, write (or append to) the file with a header row when creating it. Quote
fields that contain commas. Report the path and the number of rows written. Do not touch any
other file in the folder.

## Remember

Append any new client → project_code mapping to `user-preferences.md` under "Project / client
context" so the next submit doesn't ask again.
