#!/usr/bin/env node
// Usuwa przebiegi workflowów z GitHuba. GitHub nie ma operacji „usuń wszystkie runy
// workflowu", więc stronicujemy API i kasujemy pojedynczo.
//
//   node scripts/prune-runs.mjs --list
//   node scripts/prune-runs.mjs --workflow screenshots.yml --dry-run
//   node scripts/prune-runs.mjs --workflow screenshots.yml
//   node scripts/prune-runs.mjs --orphans --dry-run
//
// `--orphans` bierze workflowy, których pliku nie ma już w `.github/workflows/`
// (poza generowanym przez GitHuba Dependabotem).

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';

const REPO = process.env.GITHUB_REPOSITORY ?? 'tiriana/ciezko-na-sercu-web';
const args = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const token = process.argv[index];
  if (!token.startsWith('--')) continue;
  const next = process.argv[index + 1];
  if (next && !next.startsWith('--')) {
    args.set(token.slice(2), next);
    index += 1;
  } else args.set(token.slice(2), 'true');
}

const dryRun = args.has('dry-run');
const ghOne = (path) => JSON.parse(execFileSync('gh', ['api', path], { encoding: 'utf8' }));

// `gh api --paginate` skleja strony w jeden strumień, którego nie da się sparsować,
// więc sami chodzimy po stronach i zbieramy listę.
const ghAll = (base, key) => {
  const items = [];
  for (let page = 1; page <= 100; page += 1) {
    const separator = base.includes('?') ? '&' : '?';
    const data = ghOne(`${base}${separator}per_page=100&page=${page}`);
    const list = Array.isArray(data) ? data : data[key] ?? [];
    items.push(...list);
    if (list.length < 100) break;
  }
  return items;
};

const workflows = ghAll(`repos/${REPO}/actions/workflows`, 'workflows');
const local = new Set(readdirSync('.github/workflows').map((name) => `.github/workflows/${name}`));
const isOrphan = (workflow) =>
  !workflow.path.startsWith('dynamic/') && !existsSync(workflow.path) && !local.has(workflow.path);

if (args.has('list')) {
  console.log('id\tpliki\truny\tnazwa');
  for (const workflow of workflows) {
    const runs = ghOne(`repos/${REPO}/actions/workflows/${workflow.id}/runs?per_page=1`).total_count ?? 0;
    const flag = isOrphan(workflow) ? 'SIEROTA' : 'ok';
    console.log(`${workflow.id}\t${flag}\t${runs}\t${workflow.name} (${workflow.path})`);
  }
  process.exit(0);
}

const wanted = [];
if (args.has('orphans')) wanted.push(...workflows.filter(isOrphan));
const selector = args.get('workflow');
if (selector) {
  const match = workflows.find(
    (workflow) =>
      workflow.path === selector ||
      workflow.path.endsWith(`/${selector}`) ||
      String(workflow.id) === selector ||
      workflow.name.toLowerCase() === selector.toLowerCase()
  );
  if (!match) {
    console.error(`Nie ma workflowu: ${selector}`);
    process.exit(1);
  }
  wanted.push(match);
}

if (wanted.length === 0) {
  console.error('Podaj --workflow <nazwa|plik|id> albo --orphans (albo --list).');
  process.exit(1);
}

let removed = 0;
for (const workflow of wanted) {
  const runs = ghAll(`repos/${REPO}/actions/workflows/${workflow.id}/runs`, 'workflow_runs');
  console.log(`${workflow.name}: ${runs.length} przebiegów${dryRun ? ' (próba)' : ''}`);
  for (const run of runs) {
    if (dryRun) continue;
    try {
      execFileSync('gh', ['api', '-X', 'DELETE', `repos/${REPO}/actions/runs/${run.id}`], { stdio: 'pipe' });
      removed += 1;
    } catch (error) {
      console.error(`  ${run.id}: ${String(error.message).slice(0, 120)}`);
    }
  }
}

console.log(dryRun ? 'nic nie usunięto (--dry-run)' : `usuniętych przebiegów: ${removed}`);
