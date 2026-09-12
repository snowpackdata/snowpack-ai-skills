# Todo instructions templates

`/todo add` routes a new todo to whatever backend the matching Projects entry in
`user-preferences.md` names. For anything other than `local` (which needs no file), it reads
the instructions file at `<data home>/todo-instructions/<backend>.md` and follows it. `/todo
setup` copies one of these templates there when you enable a backend.

| Template | Use when |
|---|---|
| `github-issues.md` | The project's repo is on GitHub and you use the `gh` CLI |
| `jira.md` | The project tracks work in Jira, via an Atlassian MCP connector |
| `TEMPLATE.md` | Something else — Linear, a private notes API, anything that counts as *tracking* a todo somewhere other than the flat file |

## Contract

Whatever the file says:

1. **Create** always shows what it's about to create and waits for explicit confirmation
   before doing anything visible outside this machine (opening a ticket, creating an issue).
   Silence or a partial answer is not a yes.
2. **List** and the optional **Discover** are read-only — they report current status (List) or
   what exists in the backend but isn't tracked yet (Discover); neither ever writes anywhere.
   `/todo list` is what turns a Discover result into a flat-file line, not the instructions file.
3. **Complete** always shows what it's about to close and waits for explicit confirmation,
   same as Create.
4. Every operation returns (or works from) an id in the form `<backend>:<identifier>` — e.g.
   `gh:owner/repo#123` — so the flat file line stays the single place `/todo done <id>` and
   `/todo list` look things up by.

The instructions file cannot loosen those. It decides everything else: what tool or API to
call, how a project maps to that backend's identifier, and what "closed" means there.
