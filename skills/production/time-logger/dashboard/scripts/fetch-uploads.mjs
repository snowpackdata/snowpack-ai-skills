// Fetches the list of uploaded combined files from the optional notes API (via the
// wrapper script named in capabilities.yml) and writes data/uploads.json so the
// dashboard can show per-day upload status. Convention: type=time-log, slug=<client.slug>.
// When integrations.notes_api.enabled is false, writes status "disabled" and exits 0 so
// the UI simply hides the upload chips.
import { execFileSync } from 'node:child_process';
import { writeFile, rename, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { DATA_HOME, get, expandHome } from './capabilities.mjs';

const DATA = join(DATA_HOME, 'dashboard', 'data');

async function write(payload) {
  await mkdir(DATA, { recursive: true });
  const out = join(DATA, 'uploads.json');
  await writeFile(`${out}.tmp`, JSON.stringify(payload, null, 2));
  await rename(`${out}.tmp`, out);
}

async function main() {
  const enabled = get('integrations.notes_api.enabled', false) === true;
  const script = expandHome(get('integrations.notes_api.script', ''));
  const slug = get('client.slug', '');
  if (!enabled || !script) {
    await write({ generated_at: new Date().toISOString(), status: 'disabled', data: { dates: [] } });
    console.log('uploads: notes_api disabled — skipped');
    return;
  }
  const raw = execFileSync(script, ['list', 'time-log'], { encoding: 'utf8', timeout: 30000 });
  const keys = JSON.parse(raw).notes || [];
  const suffix = slug ? `--time-log--${slug}.md` : `--time-log.md`;
  const dates = keys
    .map((k) => (k.endsWith(suffix) ? (k.match(/(\d{4}-\d{2}-\d{2})/) || [])[1] : null))
    .filter(Boolean)
    .sort();
  await write({ generated_at: new Date().toISOString(), status: 'ok', data: { dates } });
  console.log(`uploads: ${dates.length} days, latest ${dates[dates.length - 1] || 'none'}`);
}

main().catch((e) => {
  console.error('fetch-uploads failed:', e.message);
  process.exit(1);
});
