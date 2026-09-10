// Fetches GitHub PRs authored by the user via the gh CLI and writes
// data/github_prs.json. Open PRs are always shown regardless of age (so
// long-forgotten ones surface); closed/merged PRs only for the last 7 days.
// PRs in archived repositories are excluded — they're read-only and can't be acted on.
import { execFileSync } from 'node:child_process';
import { writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { DATA_HOME } from './capabilities.mjs';

const DATA = join(DATA_HOME, 'dashboard', 'data');
const FIELDS = 'number,title,repository,url,createdAt,updatedAt,closedAt,isDraft';
const CLOSED_WINDOW_DAYS = 7;
const STALE_DAYS = 14;

function gh(args) {
  return JSON.parse(execFileSync('gh', args, { encoding: 'utf8', timeout: 60000 }));
}

function daysSince(iso) {
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
}

function shape(pr) {
  return {
    number: pr.number,
    title: pr.title,
    repo: pr.repository.nameWithOwner,
    url: pr.url,
    is_draft: pr.isDraft,
    created_at: pr.createdAt,
    updated_at: pr.updatedAt,
    closed_at: pr.closedAt || null,
    age_days: daysSince(pr.createdAt),
    idle_days: daysSince(pr.updatedAt),
  };
}

async function main() {
  const since = new Date(Date.now() - CLOSED_WINDOW_DAYS * 86400000).toISOString().slice(0, 10);

  const open = gh(['search', 'prs', '--author=@me', '--archived=false', '--state=open', '--json', FIELDS, '--limit', '100'])
    .map(shape)
    .map((p) => ({ ...p, stale: p.idle_days >= STALE_DAYS }))
    // most-neglected first, so forgotten PRs sit at the top
    .sort((a, b) => b.idle_days - a.idle_days);

  const closed = gh(['search', 'prs', '--author=@me', '--archived=false', '--state=closed', `--closed=>${since}`, '--json', FIELDS, '--limit', '50']);
  const mergedKeys = new Set(
    gh(['search', 'prs', '--author=@me', '--archived=false', '--merged', `--merged-at=>${since}`, '--json', 'number,repository', '--limit', '50'])
      .map((p) => `${p.repository.nameWithOwner}#${p.number}`)
  );
  const recently_closed = closed
    .map(shape)
    .map((p) => ({ ...p, merged: mergedKeys.has(`${p.repo}#${p.number}`) }))
    .sort((a, b) => new Date(b.closed_at) - new Date(a.closed_at));

  const payload = {
    generated_at: new Date().toISOString(),
    status: 'ok',
    data: { open, recently_closed, closed_window_days: CLOSED_WINDOW_DAYS },
  };
  const out = join(DATA, 'github_prs.json');
  await writeFile(`${out}.tmp`, JSON.stringify(payload, null, 2));
  await rename(`${out}.tmp`, out);
  console.log(`github_prs: ${open.length} open, ${recently_closed.length} closed in last ${CLOSED_WINDOW_DAYS}d`);
}

main().catch((e) => {
  console.error('fetch-github-prs failed:', e.message);
  process.exit(1);
});
