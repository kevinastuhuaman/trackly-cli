'use strict';

// Replaces the previously-vacuous docs-drift "all MCP tools documented" CI step.
//
// The old check (`.github/workflows/docs-drift.yml`) extracted tool names with
// `grep "server.tool(" | grep -oP "'[^']+'"` — but in mcp/server.js the
// `server.tool(` call and the `'tool_name'` literal are on SEPARATE lines, and
// grep is line-oriented, so the extraction returned ZERO tools. The for-loop
// then iterated nothing and the gate trivially passed. That is exactly how the
// 11th tool (trackly_request_company) reached main undocumented.
//
// JS regex `\s*` DOES match across newlines (unlike grep), so this extraction is
// correct. It covers both MCP SDK registration styles, cross-checks the extracted
// count against their raw call sites, and proves with a fixture that the checker
// actually fails on an undocumented tool.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

// --- pure helpers (also exercised against a synthetic fixture below) ---

// Extract MCP tool names from server.js source. Supports ', ", and ` string quotes.
function extractToolNames(serverSrc) {
  const re = /server\.(?:tool|registerTool)\(\s*['"`]([^'"`]+)['"`]/g;
  const names = [];
  let m;
  while ((m = re.exec(serverSrc)) !== null) names.push(m[1]);
  return names;
}

// Count raw tool registration call sites (quote-style agnostic) to cross-check
// that extractToolNames did not miss one because of an unexpected quote style.
function countToolCalls(serverSrc) {
  return (serverSrc.match(/server\.(?:tool|registerTool)\(/g) || []).length;
}

// Slice the README down to just the "MCP Tools Reference" section (heading → next
// `## ` heading) so prose / changelog / comparison-table mentions elsewhere in the
// README can't mask a missing row in the actual tools table.
function mcpTableRegion(readmeSrc) {
  const start = readmeSrc.indexOf('MCP Tools Reference');
  if (start === -1) return '';
  const rest = readmeSrc.slice(start);
  const next = rest.indexOf('\n## ', 1);
  return next === -1 ? rest : rest.slice(0, next);
}

// Exact-token presence (NOT plain substring): a `\b…\b` match so a short tool
// name can't be masked by a longer one that contains it — e.g. deleting the
// `trackly_get_job` row must still fail even though `trackly_get_job_brief`
// (which contains "trackly_get_job") remains documented.
function documented(haystack, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('\\b' + escaped + '\\b').test(haystack);
}

// Returns the coverage gaps as a list of { tool, where }.
function coverageGaps(serverSrc, readmeSrc, docsSrc) {
  const names = extractToolNames(serverSrc);
  const region = mcpTableRegion(readmeSrc);
  const gaps = [];
  for (const name of names) {
    if (!documented(region, name)) gaps.push({ tool: name, where: 'README MCP Tools Reference table' });
    if (!documented(docsSrc, name)) gaps.push({ tool: name, where: 'docs/trackly-tools.md' });
  }
  return gaps;
}

// Every "N tools" / "N MCP tools" count claim in the README must equal the real
// tool count. This restores the guard the old grep-based count step provided
// (Codex P3): name-presence alone wouldn't catch a stale "11 MCP tools" headline.
function toolCountClaims(readmeSrc) {
  return [...readmeSrc.matchAll(
    /(\d+)\s+(?:(?:local\s+)?MCP\s+|local\s+)?tools\b/gi
  )].map((m) => Number(m[1]));
}

// --- real-repo assertions ---

const serverSrc = [
  fs.readFileSync(path.join(ROOT, 'mcp/server.js'), 'utf8'),
  fs.readFileSync(path.join(ROOT, 'mcp/apply-tools.js'), 'utf8'),
].join('\n');
const readmeSrc = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
const docsSrc = fs.readFileSync(path.join(ROOT, 'docs/trackly-tools.md'), 'utf8');
const contributorSrc = fs.readFileSync(path.join(ROOT, 'CLAUDE.md'), 'utf8');

test('tool extraction is not vacuous and matches every raw registration call', () => {
  const names = extractToolNames(serverSrc);
  const rawCount = countToolCalls(serverSrc);
  assert.ok(names.length > 0, 'extracted zero MCP tools — the extraction is broken/vacuous');
  assert.equal(
    names.length,
    rawCount,
    `extracted ${names.length} tool names but found ${rawCount} registration calls — a style was missed`
  );
});

test('every MCP tool is documented in the README table AND docs/trackly-tools.md', () => {
  const gaps = coverageGaps(serverSrc, readmeSrc, docsSrc);
  assert.deepEqual(
    gaps,
    [],
    'undocumented MCP tools:\n' + gaps.map((g) => `  - ${g.tool} missing from ${g.where}`).join('\n')
  );
});

test('README "N tools" count claims all match the real tool count', () => {
  const count = extractToolNames(serverSrc).length;
  const claims = toolCountClaims(readmeSrc);
  assert.ok(claims.length > 0, 'expected at least one "N tools" claim in README');
  for (const c of claims) {
    assert.equal(c, count, `README claims ${c} tools but the MCP modules register ${count}`);
  }
});

test('contributor guide MCP tool counts match the real tool count', () => {
  const count = extractToolNames(serverSrc).length;
  const claims = toolCountClaims(contributorSrc);
  assert.ok(claims.length > 0, 'expected at least one tool-count claim in CLAUDE.md');
  for (const claim of claims) {
    assert.equal(claim, count, `CLAUDE.md claims ${claim} tools but the MCP modules register ${count}`);
  }
});

test('coverage uses exact-token match (a short name is not masked by a longer one)', () => {
  // Doc that contains ONLY the longer name must NOT count as documenting the short one.
  const fakeServer = "server.tool(\n  'trackly_get_job',\n  'x', {}, async () => ({}));";
  const onlyLong = '## MCP Tools Reference\n\n| trackly_get_job_brief | brief |\n';
  const gaps = coverageGaps(fakeServer, onlyLong, onlyLong);
  assert.ok(
    gaps.some((g) => g.tool === 'trackly_get_job'),
    'trackly_get_job must be flagged missing even though trackly_get_job_brief is present'
  );
});

test('checker FAILS on an undocumented tool (fixture — proves the gate is not vacuous)', () => {
  // Append a synthetic 12th tool that exists in neither doc. The checker must flag
  // it in BOTH the README table and docs/trackly-tools.md. No repo files are mutated.
  const fakeServer = serverSrc + "\n  server.tool('trackly_fake_undocumented', 'x', {}, async () => ({}));\n";
  const gaps = coverageGaps(fakeServer, readmeSrc, docsSrc);
  const fakeGaps = gaps.filter((g) => g.tool === 'trackly_fake_undocumented');
  assert.equal(
    fakeGaps.length,
    2,
    'fixture: an undocumented tool should be flagged in BOTH the README table and docs/trackly-tools.md'
  );
});

module.exports = { extractToolNames, countToolCalls, mcpTableRegion, documented, coverageGaps, toolCountClaims };
