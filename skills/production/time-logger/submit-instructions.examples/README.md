# Submit instruction templates

`/time-logger submit` has no built-in destination. After the shared safety rails run (draft
exists, dashboard comments applied, org gate), it reads the file named by
`submit.instructions` in `capabilities.yml` and follows it for the eligible entries. That
file lives in the data home, one per machine, so the same skill install can push to a billing
system on one laptop and drop files into a synced folder on another.

`/time-logger setup` copies one of these templates to `<data home>/submit-instructions.md`
and you edit it from there. Pick the closest:

| Template | Use when |
|---|---|
| `cronos.md` | You have the `snowpack-mcp` connector and log time in Cronos |
| `synced-folder.md` | No connector on this machine; the client picks up a file from a Google Drive / Dropbox / OneDrive folder that syncs locally |
| `TEMPLATE.md` | Something else — the contract every instructions file must satisfy, with blanks. A private notes API, a client's own ticketing tool, an email to a manager: anything that counts as *sending* the day's time belongs here, wired up per machine |

## Contract

Whatever the file says, submit always:

1. Receives only entries that passed the org gate. Anything under another org, `unknown`, or
   untagged is already in the "not submitted" block and must not be written anywhere.
2. Shows a review table and waits for an explicit yes before writing anything. Silence, "looks
   fine I guess", or a partial answer is not a yes.
3. Reports what it wrote, one line per entry, and what it skipped and why.

The instructions file cannot loosen those. It decides everything else: which tool or path to
write to, how to detect entries already submitted so re-runs don't duplicate, how to map a
client to whatever identifier the destination needs, and what to remember afterwards.
