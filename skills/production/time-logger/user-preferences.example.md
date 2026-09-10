# User Preferences — time-logger

This file is gitignored and machine-specific. The generate-time-entry agent reads it
on every run and can write corrections back to it when you provide feedback.

To teach the agent something new, just say it: "always skip X", "this project is for Y",
"remember that Z meeting is a standup". The agent will append it here.

---

## Meetings to always skip

- (add recurring meetings you never want logged, e.g. All Hands, Weekly Sync)

---

## Project / client context

- (describe your work context so the agent writes better descriptions, e.g. "I work at Acme Corp on the data engineering team")

---

## Orgs

Everyone you do work for is a **client**; each client belongs to an **org**. The org named in
`capabilities.yml` (`client.org`) is the one this install logs time for: its entries are
eligible for `/time-logger submit`, standups, and the digest. Every other org's entries stay in
the daily log and on the dashboard only — **never** submitted, never in standups, never in
the digest.

- **Acme** — billing: Cronos
- **Me** — personal clients and personal projects

---

## Clients

Every time entry is tagged `[client: <Name>]` from this list. `kind` is `internal` (the org's
own work), `client` (a paying client of the org), or `personal`. Match on repo names, Claude
project folders, Slack channels/people, or meeting titles. When nothing matches, the agent
tags `[client: unknown]` so the gap is visible instead of silent.

- **Acme** — org: Acme — kind: internal — matches: acme-*, data-platform, #de-team
- **BigCo** — org: Acme — kind: client — matches: bigco-*, BigCo weekly sync
- **SideClient** — org: Me — kind: client — matches: sideclient-*
- **Personal** — org: Me — kind: personal — matches: blog, side-project-*

---

## Time estimation adjustments

(none yet)

---

## Corrections log

(corrections from past sessions will be appended here by the agent)
