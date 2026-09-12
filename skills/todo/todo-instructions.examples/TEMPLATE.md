# Todo instructions — <backend name>

Read by `/todo add` (Create), `/todo list` (List), and `/todo done` (Complete) whenever a todo
resolves to this backend. Fill in every section; delete the guidance in angle brackets.

## Prerequisites

<What must be available for this to work — an MCP tool, a CLI, an API token. Say exactly how
to check, and what to tell the user if the check fails, e.g. "run `<cli> whoami`; if it errors,
say the connector isn't configured on this machine and fall back to `local`, noting why.">

## Mapping

<How a project name (from the Projects section of user-preferences.md) becomes whatever
identifier this backend needs — a repo slug, a project key, a board id. If a project maps here
with no identifier recorded, ask once and remember it (see Remember, below).>

## Create

<Exactly what to call to create one item, and what fields to set (title, description, labels
— keep it minimal; a todo isn't a full ticket). Show the user what will be created and ask for
explicit confirmation first. Return the id (`<backend>:<identifier>`) and a canonical URL, if
one exists, for the new item.>

## List

<How to check current status for one id — read-only, no writes. Return at least: still open or
closed/done, and the current title if it can have changed. `/todo list` uses this to self-heal
the file when something was closed directly in this backend instead of through `/todo
done`.>

## Discover (optional)

<How to find items that exist in this backend but aren't in the file yet — e.g. something
filed directly there instead of through `/todo add`. Read-only: return each as `{id, title,
url}` for `/todo list` to import; never write anything here. Skip this section entirely if the
backend has no sensible "everything of mine" query.>

## Complete

<Exactly what to call to close/resolve one item. Show what will happen and ask for explicit
confirmation first, same as Create.>

## Remember

<What to append to `user-preferences.md` (Projects section, or Corrections log) so the next
add/list/done for this project doesn't ask the same question again.>
