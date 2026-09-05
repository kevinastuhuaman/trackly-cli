const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const extractor = path.join(__dirname, '..', 'scripts', 'extract-terminal-claude-review.js');
const workflow = fs.readFileSync(
  path.join(__dirname, '..', '.github', 'workflows', 'claude-code-review.yml'),
  'utf8',
);

function runExtractor(events) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'trackly-claude-review-'));
  const executionFile = path.join(directory, 'execution.jsonl');
  fs.writeFileSync(executionFile, events.map((event) => JSON.stringify(event)).join('\n'));
  const result = spawnSync(process.execPath, [extractor, executionFile], { encoding: 'utf8' });
  fs.rmSync(directory, { recursive: true, force: true });
  return result;
}

test('Claude review backstop accepts a complete terminal verdict', () => {
  const review = [
    '## 🔵 Claude Code Review',
    'Counts: 🔴 0 / 🟡 0 / 🟢 0',
    'Recommendation: APPROVE',
    'LGTM — no issues found.',
  ].join('\n');
  const result = runExtractor([
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Posting findings now.' }] } },
    { type: 'result', result: review },
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, review);
});

test('Claude review backstop accepts labeled counts and Markdown emphasis', () => {
  const review = [
    '## 🔵 Claude Code Review',
    'Counts: 🔴 P1: **0** / 🟡 P2: **0** / 🟢 P3: **1**',
    '**Recommendation:** COMMENT',
    '`lib/example.js:12` — 🟢 P3 — Clarify the fallback.',
  ].join('\n');
  const result = runExtractor([{ type: 'result', result: review }]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, review);
});

test('Claude review backstop rejects intermediate planning text', () => {
  const result = runExtractor([
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Posting findings now.' }] } },
  ]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /without the required terminal review verdict/i);
});

test('Claude review backstop rejects planning text prefixed to verdict markers', () => {
  const result = runExtractor([{ type: 'result', result: [
    'I am still building the changed-line map.',
    '## 🔵 Claude Code Review',
    'Counts: 🔴 0 / 🟡 0 / 🟢 0',
    'Recommendation: APPROVE',
  ].join('\n') }]);
  assert.equal(result.status, 1);
});

test('Claude review backstop fails closed when the final result is incomplete', () => {
  const result = runExtractor([
    {
      type: 'result',
      result: '## 🔵 Claude Code Review\nCounts: 🔴 0 / 🟡 0 / 🟢 0\nRecommendation: APPROVE',
    },
    { type: 'result', result: 'Posting findings now.' },
  ]);
  assert.equal(result.status, 1);
});

test('Claude review workflow fails closed when review state or trusted code is unavailable', () => {
  assert.match(workflow, /N="\$\(curl -sS --fail/);
  assert.match(workflow, /if \[ "\$N" = "-1" \]; then[\s\S]*?exit 1/);
  assert.match(workflow, /Could not load the Claude review extractor[\s\S]*?exit 1/);
  assert.match(workflow, /Could not decode the trusted Claude review extractor[\s\S]*?exit 1/);
});
