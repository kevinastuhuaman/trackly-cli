const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const extractor = path.join(__dirname, '..', 'scripts', 'extract-terminal-claude-review.js');

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

test('Claude review backstop rejects intermediate planning text', () => {
  const result = runExtractor([
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Posting findings now.' }] } },
  ]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /without the required terminal review verdict/i);
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
