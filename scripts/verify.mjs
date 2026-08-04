/**
 * Run before pushing:  npm run verify
 *
 * Checks the repository is this release and nothing else. Files left behind by
 * an earlier ZIP are the single most likely cause of a deployment that builds
 * successfully and then crashes: a stale route still imports a folder this
 * release no longer ships, so it throws while loading and Next answers with its
 * own HTML error page.
 */
import { readdir, stat, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const MUST_EXIST = [
  'package.json',
  'next.config.mjs',
  'app/layout.js',
  'app/page.js',
  'app/api/docket/route.js',
  'app/api/ping/route.js',
  'public/console.html'
];

const MUST_NOT_EXIST = [
  'lib',
  'pages',
  'src',
  'app/api/auth',
  'app/api/board',
  'app/api/media',
  'app/api/diag',
  'app/api/health',
  'app/api/cron',
  'api'
];

let problems = 0;

for (const path of MUST_EXIST) {
  if (!existsSync(path)) {
    console.log(`  MISSING   ${path}`);
    problems++;
  }
}

for (const path of MUST_NOT_EXIST) {
  if (existsSync(path)) {
    console.log(`  STALE     ${path}   <-- left over from an earlier version; delete it`);
    problems++;
  }
}

// No route file may import anything from this project.
async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (['node_modules', '.next', '.git'].includes(entry.name)) continue;
    const full = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else out.push(full);
  }
  return out;
}

const files = await walk('app');
for (const file of files.filter((f) => f.endsWith('route.js'))) {
  const src = await readFile(file, 'utf8');
  const imports = [...src.matchAll(/^\s*import .*from ['"]([^'"]+)['"]/gm)].map((m) => m[1]);
  if (imports.length) {
    console.log(`  IMPORTS   ${file} loads ${imports.join(', ')} at the top of the file`);
    problems++;
  }
}

const routes = files.filter((f) => f.endsWith('route.js'));
console.log(`\n  routes found: ${routes.map((r) => r.replace('app', '').replace('/route.js', '')).join(', ')}`);

if (problems) {
  console.log(`\n  ${problems} problem(s). Do not push yet — see above.\n`);
  process.exit(1);
}
console.log('\n  Clean. Safe to push.\n');
