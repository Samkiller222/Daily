// Pre-deploy checks: catches mistakes that would ship a broken web app.
// Usage: npm test   (no dependencies needed)
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const errors = [];

function parse(code, filename, lineOffset) {
  try {
    new vm.Script(code, { filename, lineOffset });
    return true;
  } catch (e) {
    const where = (e.stack || '').split('\n')[0];
    errors.push(`${where}: ${e.message}`);
    return false;
  }
}

// 1. Code.gs must be valid JavaScript.
const gs = read('Code.gs');
parse(gs, 'Code.gs', 0);

// 2. Top-level functions in Code.gs: no duplicates (Apps Script silently keeps the last one).
const fnNames = [...gs.matchAll(/^(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(/gm)].map((m) => m[1]);
const seen = new Set();
for (const name of fnNames) {
  if (seen.has(name)) errors.push(`Code.gs: function ${name}() is defined more than once`);
  seen.add(name);
}

// 3. Inline <script> blocks in index.html must be valid JavaScript.
const html = read('index.html');
for (const m of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
  const line = html.slice(0, m.index + m[0].indexOf('>') + 1).split('\n').length - 1;
  parse(m[1], 'index.html', line);
}

// 4. Every call('fn') in index.html must be a public function in Code.gs.
//    Names ending in "_" are private in Apps Script and can't be called from the page.
const called = new Set([...html.matchAll(/\bcall\(\s*['"]([A-Za-z0-9_$]+)['"]/g)].map((m) => m[1]));
for (const name of called) {
  if (!seen.has(name)) errors.push(`index.html calls ${name}() but Code.gs has no such function`);
  else if (name.endsWith('_')) errors.push(`index.html calls ${name}() but it is private (ends with "_")`);
}

// 5. appsscript.json must be valid JSON with a V8 runtime.
try {
  const manifest = JSON.parse(read('appsscript.json'));
  if (manifest.runtimeVersion !== 'V8') errors.push('appsscript.json: runtimeVersion should be "V8"');
} catch (e) {
  errors.push(`appsscript.json: ${e.message}`);
}

if (errors.length) {
  console.error(`✗ ${errors.length} problem(s) found:\n  ` + errors.join('\n  '));
  process.exit(1);
}
console.log(`✓ Code.gs (${fnNames.length} functions), index.html (${called.size} server calls) and appsscript.json look good`);
