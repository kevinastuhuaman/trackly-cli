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

test('Claude review backstop accepts P1 findings with REQUEST_CHANGES', () => {
  const review = [
    '## 🔵 Claude Code Review',
    'Counts: 🔴 P1: 1 / 🟡 P2: 0 / 🟢 P3: 0',
    '**Recommendation:** REQUEST_CHANGES',
    '.github/workflows/review.yml:12 — 🔴 P1 — The gate can silently pass.',
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

test('Claude review backstop rejects finding counts without matching finding lines', () => {
  const result = runExtractor([{ type: 'result', result: [
    '## 🔵 Claude Code Review',
    'Counts: 🔴 P1: 0 / 🟡 P2: 1 / 🟢 P3: 0',
    'Recommendation: COMMENT',
    'There is one issue to consider.',
  ].join('\n') }]);
  assert.equal(result.status, 1);
});

test('Claude review backstop rejects approval when findings remain', () => {
  const result = runExtractor([{ type: 'result', result: [
    '## 🔵 Claude Code Review',
    'Counts: 🔴 P1: 0 / 🟡 P2: 0 / 🟢 P3: 1',
    'Recommendation: APPROVE',
    'lib/example.js:12 — 🟢 P3 — Clarify the fallback.',
  ].join('\n') }]);
  assert.equal(result.status, 1);
});

test('Claude review backstop rejects finding lines omitted from the declared counts', () => {
  const result = runExtractor([{ type: 'result', result: [
    '## 🔵 Claude Code Review',
    'Counts: 🔴 P1: 0 / 🟡 P2: 0 / 🟢 P3: 0',
    'Recommendation: APPROVE',
    'LGTM — no issues found.',
    'lib/example.js:12 — 🔴 P1 — This finding was not counted.',
  ].join('\n') }]);
  assert.equal(result.status, 1);
});

test('Claude review backstop rejects a zero-finding LGTM with request changes', () => {
  const result = runExtractor([{ type: 'result', result: [
    '## 🔵 Claude Code Review',
    'Counts: 🔴 P1: 0 / 🟡 P2: 0 / 🟢 P3: 0',
    'Recommendation: REQUEST_CHANGES',
    'LGTM — no issues found.',
  ].join('\n') }]);
  assert.equal(result.status, 1);
});

test('Claude review backstop rejects a negated LGTM phrase', () => {
  const result = runExtractor([{ type: 'result', result: [
    '## 🔵 Claude Code Review',
    'Counts: 🔴 P1: 0 / 🟡 P2: 0 / 🟢 P3: 0',
    'Recommendation: APPROVE',
    'This is not LGTM.',
  ].join('\n') }]);
  assert.equal(result.status, 1);
});

test('Claude review backstop accepts partial LGTM only as a comment', () => {
  const review = [
    '## 🔵 Claude Code Review',
    'Counts: 🔴 P1: 0 / 🟡 P2: 0 / 🟢 P3: 0',
    'Recommendation: COMMENT',
    'Partial LGTM — no issues found in the visible diff (coverage was partial).',
  ].join('\n');
  const result = runExtractor([{ type: 'result', result: review }]);
  assert.equal(result.status, 0, result.stderr);
});

test('Claude review backstop requires request changes for a P1 finding', () => {
  const result = runExtractor([{ type: 'result', result: [
    '## 🔵 Claude Code Review',
    'Counts: 🔴 P1: 1 / 🟡 P2: 0 / 🟢 P3: 0',
    'Recommendation: COMMENT',
    '.github/workflows/review.yml:12 — 🔴 P1 — The gate can silently pass.',
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

test('Claude review workflow always publishes this run and fails closed without trusted code', () => {
  assert.doesNotMatch(workflow, /INLINE_REVIEW_PRESENT|comments\?sort=created/);
  assert.match(workflow, /Publish the terminal text from this exact execution/);
  assert.match(workflow, /Could not load the Claude review extractor[\s\S]*?exit 1/);
  assert.match(workflow, /Could not decode the trusted Claude review extractor[\s\S]*?exit 1/);
});
