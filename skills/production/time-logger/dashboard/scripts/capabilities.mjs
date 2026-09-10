// Shared config reader for the dashboard scripts. Resolves the data home and parses
// capabilities.yml without a YAML dependency (the file is a fixed two-level shape:
// top-level sections, nested `key: value` scalars, `#` comments).
//
// CLI use (from shell scripts): node capabilities.mjs dashboard.port  -> prints the value
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

export const HOME = homedir();
export const DATA_HOME = process.env.TIME_LOGGER_DATA_HOME || join(HOME, '.local', 'share', 'time-logger');

export function expandHome(p) {
  if (!p) return p;
  return p.replace(/^~(?=$|\/)/, HOME);
}

function scalar(raw) {
  let v = raw.trim();
  // strip trailing comment (not inside quotes)
  if (!/^["']/.test(v)) v = v.replace(/\s+#.*$/, '').trim();
  const q = v.match(/^(["'])(.*)\1$/);
  if (q) return q[2];
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v === '' || v === '~' || v === 'null') return '';
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v;
}

export function parseYaml(text) {
  const root = {};
  const stack = [{ indent: -1, node: root }];
  for (const line of text.split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const m = line.match(/^(\s*)([A-Za-z0-9_.-]+):\s*(.*)$/);
    if (!m) continue;
    const indent = m[1].length;
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
    const parent = stack[stack.length - 1].node;
    if (m[3].trim() === '' || m[3].trim().startsWith('#')) {
      const node = {};
      parent[m[2]] = node;
      stack.push({ indent, node });
    } else {
      parent[m[2]] = scalar(m[3]);
    }
  }
  return root;
}

let cached;
export function loadCapabilities() {
  if (cached) return cached;
  try {
    cached = parseYaml(readFileSync(join(DATA_HOME, 'capabilities.yml'), 'utf8'));
  } catch {
    cached = {};
  }
  return cached;
}

export function get(path, fallback = '') {
  const v = path.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), loadCapabilities());
  return v === undefined || v === '' ? fallback : v;
}

// Values the dashboard UI needs (rendered to dashboard/data/config.json by render.mjs).
export function uiConfig() {
  return {
    org: get('client.org', ''),
    client_slug: get('client.slug', ''),
    client_name: get('client.name', ''),
    jira_browse_url: get('client.jira_browse_url', ''),
    todos_file: expandHome(get('dashboard.todos_file', '')),
    port: Number(get('dashboard.port', 4680)),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const key = process.argv[2];
  if (!key) {
    console.log(JSON.stringify(loadCapabilities(), null, 2));
  } else {
    const v = get(key, '');
    process.stdout.write(typeof v === 'object' ? JSON.stringify(v) : String(v));
  }
}
