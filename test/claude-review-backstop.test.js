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

function runExtractor(events, coverage = 'full', options = {}, changedLines) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'trackly-claude-review-'));
  const executionFile = path.join(directory, 'execution.jsonl');
  fs.writeFileSync(executionFile, events.map((event) => JSON.stringify(event)).join('\n'));
  const args = [extractor, executionFile, `--${coverage}`];
  if (changedLines !== undefined) {
    const changedLinesFile = path.join(directory, 'changed-lines.json');
    fs.writeFileSync(changedLinesFile, typeof changedLines === 'string' ? changedLines : JSON.stringify(changedLines));
    args.push(changedLinesFile);
  }
  const result = spawnSync(process.execPath, args, {
    encoding: 'utf8',
    ...options,
  });
  fs.rmSync(directory, { recursive: true, force: true });
  return result;
}

test('Claude review backstop accepts a complete terminal verdict', () => {
  const review = [
    '## 🔵 Claude Code Review',
    'Counts: 🔴 0 / 🟡 0 / 🟢 0',
    'Coverage: FULL',
    'Recommendation: APPROVE',
    'LGTM — no issues found (checked correctness, security, data-loss, tests, performance).',
  ].join('\n');
  const result = runExtractor([
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Posting findings now.' }] } },
    { type: 'result', result: review },
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, review);
});

test('Claude review backstop accepts a whole-file event array', () => {
  const review = [
    '## 🔵 Claude Code Review',
    'Counts: 🔴 P1: 0 / 🟡 P2: 0 / 🟢 P3: 0',
    'Coverage: FULL',
    'Recommendation: APPROVE',
    'LGTM — no issues found (checked correctness, security, data-loss, tests, performance).',
  ].join('\n');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'trackly-claude-review-array-'));
  const executionFile = path.join(directory, 'execution.json');
  fs.writeFileSync(executionFile, JSON.stringify([{ type: 'result', result: review }]));
  const result = spawnSync(process.execPath, [extractor, executionFile, '--full'], { encoding: 'utf8' });
  fs.rmSync(directory, { recursive: true, force: true });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, review.replace(
    'Counts: 🔴 P1: 0 / 🟡 P2: 0 / 🟢 P3: 0',
    'Counts: 🔴 0 / 🟡 0 / 🟢 0',
  ));
});

test('Claude review backstop accepts a terminal assistant-text event when no result exists', () => {
  const review = [
    '## 🔵 Claude Code Review',
    'Counts: 🔴 P1: 0 / 🟡 P2: 0 / 🟢 P3: 0',
    'Coverage: FULL',
    'Recommendation: APPROVE',
    'LGTM — no issues found (checked correctness, security, data-loss, tests, performance).',
  ].join('\n');
  const result = runExtractor([
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Planning.' }] } },
    { type: 'assistant', message: { content: [{ type: 'text', text: review }] } },
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, review.replace(
    'Counts: 🔴 P1: 0 / 🟡 P2: 0 / 🟢 P3: 0',
    'Counts: 🔴 0 / 🟡 0 / 🟢 0',
  ));
});

test('Claude review backstop accepts labeled counts and Markdown emphasis', () => {
  const review = [
    '## 🔵 Claude Code Review',
    'Counts: 🔴 P1: **0** / 🟡 P2: **0** / 🟢 P3: **1**',
    '**Coverage:** FULL',
    '**Recommendation:** COMMENT',
    '`lib/example.js:12` — 🟢 P3 — Clarify the fallback.',
  ].join('\n');
  const result = runExtractor([{ type: 'result', result: review }]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, review.replace(
    'Counts: 🔴 P1: **0** / 🟡 P2: **0** / 🟢 P3: **1**',
    'Counts: 🔴 0 / 🟡 0 / 🟢 1',
  ));
});

test('Claude review backstop accepts P1 findings with REQUEST_CHANGES', () => {
  const review = [
    '## 🔵 Claude Code Review',
    'Counts: 🔴 P1: 1 / 🟡 P2: 0 / 🟢 P3: 0',
    'Coverage: FULL',
    '**Recommendation:** REQUEST_CHANGES',
    '.github/workflows/review.yml:12 — 🔴 P1 — The gate can silently pass.',
  ].join('\n');
  const result = runExtractor([{ type: 'result', result: review }]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, review.replace(
    'Counts: 🔴 P1: 1 / 🟡 P2: 0 / 🟢 P3: 0',
    'Counts: 🔴 1 / 🟡 0 / 🟢 0',
  ));
});

test('Claude review backstop recovers the reconstructed PR 139 fallback execution', () => {
  const fixtureDir = path.join(__dirname, 'fixtures', 'claude-review');
  const executionFile = path.join(fixtureDir, 'pr139-run-34062183216.execution.json');
  const changedLinesFile = path.join(fixtureDir, 'pr139-run-34062183216.changed-lines.json');
  const rejectedFile = path.join(fixtureDir, 'pr139-autolink-rejected.execution.json');
  const recovered = spawnSync(process.execPath, [extractor, executionFile, '--full', changedLinesFile], { encoding: 'utf8' });
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.equal(recovered.stdout, [
    '## 🔵 Claude Code Review',
    'Counts: 🔴 0 / 🟡 0 / 🟢 0',
    'Coverage: FULL',
    'Recommendation: APPROVE',
    'LGTM — no issues found (checked correctness, security, data-loss, tests, performance).',
  ].join('\n'));
  const rejected = spawnSync(process.execPath, [extractor, rejectedFile, '--full', changedLinesFile], { encoding: 'utf8' });
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /without the required terminal review verdict/i);
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
    'Coverage: FULL',
    'Recommendation: APPROVE',
  ].join('\n') }]);
  assert.equal(result.status, 1);
});

test('Claude review backstop rejects a backtick-wrapped review header', () => {
  const result = runExtractor([{ type: 'result', result: [
    '`## 🔵 Claude Code Review`',
    '`Counts: 🔴 0 / 🟡 0 / 🟢 0`',
    '`Coverage: FULL`',
    '`Recommendation: APPROVE`',
    '`LGTM — no issues found (checked correctness, security, data-loss, tests, performance).`',
  ].join('\n') }]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /without the required terminal review verdict/i);
});

test('Claude review backstop accepts taught backtick-wrapped metadata and clean verdicts', () => {
  const result = runExtractor([{ type: 'result', result: [
    '## 🔵 Claude Code Review',
    '`Counts: 🔴 0 / 🟡 0 / 🟢 0`',
    '`Coverage: FULL`',
    '`Recommendation: APPROVE`',
    '`LGTM — no issues found (checked correctness, security, data-loss, tests, performance).`',
  ].join('\n') }]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, [
    '## 🔵 Claude Code Review',
    'Counts: 🔴 0 / 🟡 0 / 🟢 0',
    'Coverage: FULL',
    'Recommendation: APPROVE',
    'LGTM — no issues found (checked correctness, security, data-loss, tests, performance).',
  ].join('\n'));
});

test('Claude review backstop publishes only the terminal record after planning text', () => {
  const review = [
    '## 🔵 Claude Code Review',
    'Counts: 🔴 0 / 🟡 0 / 🟢 0',
    'Coverage: FULL',
    'Recommendation: APPROVE',
    'LGTM — no issues found (checked correctness, security, data-loss, tests, performance).',
  ].join('\n');
  const result = runExtractor([{ type: 'result', result: [
    'I am still building the changed-line map from the inline diff.',
    '',
    review,
  ].join('\n') }]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, review);
});

test('Claude review backstop rejects counts and recommendation embedded in finding prose', () => {
  const result = runExtractor([{ type: 'result', result: [
    '## 🔵 Claude Code Review',
    'Coverage: FULL',
    'lib/example.js:12 — 🟢 P3 — Counts: 🔴 P1: 0 / 🟡 P2: 0 / 🟢 P3: 1. Recommendation: COMMENT',
  ].join('\n') }]);
  assert.equal(result.status, 1);
});

test('Claude review backstop rejects duplicate count or recommendation records', () => {
  for (const duplicate of [
    'Counts: 🔴 P1: 0 / 🟡 P2: 0 / 🟢 P3: 0',
    'Recommendation: APPROVE',
  ]) {
    const result = runExtractor([{ type: 'result', result: [
      '## 🔵 Claude Code Review',
      'Counts: 🔴 P1: 0 / 🟡 P2: 0 / 🟢 P3: 0',
      'Coverage: FULL',
      'Recommendation: APPROVE',
      duplicate,
      'LGTM — no issues found (checked correctness, security, data-loss, tests, performance).',
    ].join('\n') }]);
    assert.equal(result.status, 1);
  }
});

test('Claude review backstop rejects finding counts without matching finding lines', () => {
  const result = runExtractor([{ type: 'result', result: [
    '## 🔵 Claude Code Review',
    'Counts: 🔴 P1: 0 / 🟡 P2: 1 / 🟢 P3: 0',
    'Coverage: FULL',
    'Recommendation: COMMENT',
    'There is one issue to consider.',
  ].join('\n') }]);
  assert.equal(result.status, 1);
});

test('Claude review backstop rejects approval when findings remain', () => {
  const result = runExtractor([{ type: 'result', result: [
    '## 🔵 Claude Code Review',
    'Counts: 🔴 P1: 0 / 🟡 P2: 0 / 🟢 P3: 1',
    'Coverage: FULL',
    'Recommendation: APPROVE',
    'lib/example.js:12 — 🟢 P3 — Clarify the fallback.',
  ].join('\n') }]);
  assert.equal(result.status, 1);
});

test('Claude review backstop rejects finding lines omitted from the declared counts', () => {
  const result = runExtractor([{ type: 'result', result: [
    '## 🔵 Claude Code Review',
    'Counts: 🔴 P1: 0 / 🟡 P2: 0 / 🟢 P3: 0',
    'Coverage: FULL',
    'Recommendation: APPROVE',
    'LGTM — no issues found (checked correctness, security, data-loss, tests, performance).',
    'lib/example.js:12 — 🔴 P1 — This finding was not counted.',
  ].join('\n') }]);
  assert.equal(result.status, 1);
});

test('Claude review backstop rejects a zero-finding LGTM with request changes', () => {
  const result = runExtractor([{ type: 'result', result: [
    '## 🔵 Claude Code Review',
    'Counts: 🔴 P1: 0 / 🟡 P2: 0 / 🟢 P3: 0',
    'Coverage: FULL',
    'Recommendation: REQUEST_CHANGES',
    'LGTM — no issues found (checked correctness, security, data-loss, tests, performance).',
  ].join('\n') }]);
  assert.equal(result.status, 1);
});

test('Claude review backstop rejects a negated LGTM phrase', () => {
  const result = runExtractor([{ type: 'result', result: [
    '## 🔵 Claude Code Review',
    'Counts: 🔴 P1: 0 / 🟡 P2: 0 / 🟢 P3: 0',
    'Coverage: FULL',
    'Recommendation: APPROVE',
    'This is not LGTM.',
  ].join('\n') }]);
  assert.equal(result.status, 1);
});

test('Claude review backstop accepts partial LGTM only as a comment', () => {
  const review = [
    '## 🔵 Claude Code Review',
    'Counts: 🔴 P1: 0 / 🟡 P2: 0 / 🟢 P3: 0',
    'Coverage: PARTIAL',
    'Recommendation: COMMENT',
    'Partial LGTM — no issues found in the visible diff (coverage was partial because the diff was truncated).',
  ].join('\n');
  const result = runExtractor([{ type: 'result', result: review }], 'partial');
  assert.equal(result.status, 0, result.stderr);
});

test('Claude review backstop binds clean verdicts to trusted coverage', () => {
  const fullVerdict = [
    '## 🔵 Claude Code Review',
    'Counts: 🔴 P1: 0 / 🟡 P2: 0 / 🟢 P3: 0',
    'Coverage: FULL',
    'Recommendation: APPROVE',
    'LGTM — no issues found (checked correctness, security, data-loss, tests, performance).',
  ].join('\n');
  const partialVerdict = [
    '## 🔵 Claude Code Review',
    'Counts: 🔴 P1: 0 / 🟡 P2: 0 / 🟢 P3: 0',
    'Coverage: PARTIAL',
    'Recommendation: COMMENT',
    'Partial LGTM — no issues found in the visible diff (coverage was partial because the diff was truncated).',
  ].join('\n');
  assert.equal(runExtractor([{ type: 'result', result: fullVerdict }], 'partial').status, 1);
  assert.equal(runExtractor([{ type: 'result', result: partialVerdict }], 'full').status, 1);
});

test('Claude review backstop binds finding verdicts to trusted coverage', () => {
  const cases = [
    {
      counts: 'Counts: 🔴 P1: 1 / 🟡 P2: 0 / 🟢 P3: 0',
      recommendation: 'Recommendation: REQUEST_CHANGES',
      findings: ['lib/a.js:1 — 🔴 P1 — Red finding.'],
    },
    {
      counts: 'Counts: 🔴 P1: 0 / 🟡 P2: 1 / 🟢 P3: 0',
      recommendation: 'Recommendation: COMMENT',
      findings: ['lib/b.js:2 — 🟡 P2 — Yellow finding.'],
    },
    {
      counts: 'Counts: 🔴 P1: 0 / 🟡 P2: 0 / 🟢 P3: 1',
      recommendation: 'Recommendation: COMMENT',
      findings: ['lib/c.js:3 — 🟢 P3 — Green finding.'],
    },
    {
      counts: 'Counts: 🔴 P1: 1 / 🟡 P2: 1 / 🟢 P3: 1',
      recommendation: 'Recommendation: REQUEST_CHANGES',
      findings: [
        'lib/a.js:1 — 🔴 P1 — Red finding.',
        'lib/b.js:2 — 🟡 P2 — Yellow finding.',
        'lib/c.js:3 — 🟢 P3 — Green finding.',
      ],
    },
  ];
  for (const coverage of ['full', 'partial']) {
    for (const fixture of cases) {
      const matching = [
        '## 🔵 Claude Code Review',
        fixture.counts,
        `Coverage: ${coverage.toUpperCase()}`,
        fixture.recommendation,
        ...fixture.findings,
      ].join('\n');
      const mismatching = matching.replace(
        `Coverage: ${coverage.toUpperCase()}`,
        `Coverage: ${coverage === 'full' ? 'PARTIAL' : 'FULL'}`,
      );
      assert.equal(runExtractor([{ type: 'result', result: matching }], coverage).status, 0);
      assert.equal(runExtractor([{ type: 'result', result: mismatching }], coverage).status, 1);
      const contradictory = `${matching}\n${coverage === 'full'
        ? 'LGTM — no issues found (checked correctness, security, data-loss, tests, performance).'
        : 'Partial LGTM — no issues found in the visible diff (coverage was partial because the diff was truncated).'}`;
      assert.equal(runExtractor([{ type: 'result', result: contradictory }], coverage).status, 1);
    }
  }
});

test('Claude review backstop requires exactly one standalone coverage record', () => {
  const base = [
    '## 🔵 Claude Code Review',
    'Counts: 🔴 P1: 0 / 🟡 P2: 0 / 🟢 P3: 0',
    'Recommendation: APPROVE',
    'LGTM — no issues found (checked correctness, security, data-loss, tests, performance).',
  ];
  assert.equal(runExtractor([{ type: 'result', result: base.join('\n') }]).status, 1);
  assert.equal(runExtractor([{ type: 'result', result: [
    ...base.slice(0, 2),
    'Coverage: FULL',
    'Coverage: FULL',
    ...base.slice(2),
  ].join('\n') }]).status, 1);
});

test('Claude review backstop rejects fenced or bulleted verdict templates', () => {
  for (const lines of [
    [
      '```text',
      'Counts: 🔴 P1: 0 / 🟡 P2: 0 / 🟢 P3: 0',
      'Coverage: FULL',
      'Recommendation: APPROVE',
      'LGTM — no issues found (checked correctness, security, data-loss, tests, performance).',
      '```',
    ],
    [
      '   ~~~markdown',
      'Counts: 🔴 P1: 0 / 🟡 P2: 0 / 🟢 P3: 0',
      'Coverage: FULL',
      'Recommendation: APPROVE',
      'LGTM — no issues found (checked correctness, security, data-loss, tests, performance).',
      '   ~~~',
    ],
    [
      '* Counts: 🔴 P1: 0 / 🟡 P2: 0 / 🟢 P3: 0',
      '* Coverage: FULL',
      '* Recommendation: APPROVE',
      '* LGTM — no issues found (checked correctness, security, data-loss, tests, performance).',
    ],
    [
      '    Counts: 🔴 P1: 0 / 🟡 P2: 0 / 🟢 P3: 0',
      '    Coverage: FULL',
      '    Recommendation: APPROVE',
      '    LGTM — no issues found (checked correctness, security, data-loss, tests, performance).',
    ],
    [
      '\tCounts: 🔴 P1: 0 / 🟡 P2: 0 / 🟢 P3: 0',
      '\tCoverage: FULL',
      '\tRecommendation: APPROVE',
      '\tLGTM — no issues found (checked correctness, security, data-loss, tests, performance).',
    ],
  ]) {
    const result = runExtractor([{ type: 'result', result: [
      '## 🔵 Claude Code Review',
      ...lines,
    ].join('\n') }]);
    assert.equal(result.status, 1);
  }
});

test('Claude review backstop rejects verdict records hidden in raw HTML', () => {
  const metadata = [
    'Counts: 🔴 P1: 0 / 🟡 P2: 0 / 🟢 P3: 0',
    'Coverage: FULL',
    'Recommendation: APPROVE',
    'LGTM — no issues found (checked correctness, security, data-loss, tests, performance).',
  ];
  for (const lines of [
    ['<!--', ...metadata, '-->'],
    ['<PRE class="review-template">', ...metadata, '</PRE>'],
    ['<code>', ...metadata, '</code>'],
    ['<details open><summary>Review template</summary>', ...metadata, '</details>'],
    [`<!-- ${metadata.join(' ')} -->`],
  ]) {
    const result = runExtractor([{ type: 'result', result: [
      '## 🔵 Claude Code Review',
      ...lines,
    ].join('\n') }]);
    assert.equal(result.status, 1);
  }
});

test('Claude review backstop rejects trailing text that reverses a clean verdict', () => {
  const result = runExtractor([{ type: 'result', result: [
    '## 🔵 Claude Code Review',
    'Counts: 🔴 P1: 0 / 🟡 P2: 0 / 🟢 P3: 0',
    'Coverage: FULL',
    'Recommendation: APPROVE',
    'LGTM — no issues found? No: critical issues remain.',
  ].join('\n') }]);
  assert.equal(result.status, 1);
});

test('Claude review backstop rejects a second finding hidden in one record', () => {
  for (const finding of [
    'critical.js:1 — 🔴 P1 — harmless.js:2 — 🟢 P3 — Looks safe.',
    'safe.js:1 — 🟢 P3 — `critical.js:2` — 🔴 P1 — Hidden blocker.',
    'safe.js:1 — 🟢 P3 — [critical file].js:2 — 🔴 P1 — Hidden blocker.',
    'safe.js:1 — 🟢 P3 — issue;src/c.js:3 — 🔴 P1 — Hidden blocker.',
    'safe.js:1 — 🟢 P3 — issue — 🔴 P1 — Hidden blocker.',
    'safe.js:1 — 🟢 P3 — Looks safe.—🔴P1—Hidden blocker.',
    'safe.js:1 — 🟢 P3 — Looks safe.🔴Hidden blocker.',
  ]) {
    const result = runExtractor([{ type: 'result', result: [
      '## 🔵 Claude Code Review',
      'Counts: 🔴 P1: 0 / 🟡 P2: 0 / 🟢 P3: 1',
      'Coverage: FULL',
      'Recommendation: COMMENT',
      finding,
    ].join('\n') }]);
    assert.equal(result.status, 1);
  }
});

test('Claude review backstop rejects rendered-hidden finding records', () => {
  const prefix = [
    '## 🔵 Claude Code Review',
    'Counts: 🔴 P1: 0 / 🟡 P2: 0 / 🟢 P3: 1',
    'Coverage: FULL',
    'Recommendation: COMMENT',
  ];
  for (const findingLines of [
    ['<!--', 'lib/a.js:1 — 🟢 P3 — Hidden comment.', '-->'],
    ['<details><summary>Hidden</summary>', 'lib/a.js:1 — 🟢 P3 — Collapsed.', '</details>'],
    ['> lib/a.js:1 — 🟢 P3 — Block quote.'],
    ['    lib/a.js:1 — 🟢 P3 — Indented code.'],
    ['```text', 'lib/a.js:1 — 🟢 P3 — Fenced code.', '```'],
    ['lib/a.js:1 — 🟢 P3 — benign<br>Recommendation: APPROVE'],
    ['lib/a.js:1 — 🟢 P3 — <blockquote>Hidden detail</blockquote>'],
    ['lib/a.js:1 — 🟢 P3 — <div hidden>Hidden detail</div>'],
    ['lib/a.js:1 — 🟢 P3 — ![hidden detail](https://example.invalid/image.png)'],
  ]) {
    const result = runExtractor([{ type: 'result', result: [...prefix, ...findingLines].join('\n') }]);
    assert.equal(result.status, 1);
  }
});

test('Claude review backstop permits rendered-literal markup in balanced inline code', () => {
  for (const description of [
    'Escape the `<script>` element.',
    'Reject the literal `<!-- marker -->` sequence.',
    'Reject `![alt](url)` before rendering.',
    'Use `a < b && b > c` for the bound.',
  ]) {
    const result = runExtractor([{ type: 'result', result: [
      '## 🔵 Claude Code Review',
      'Counts: 🔴 P1: 0 / 🟡 P2: 0 / 🟢 P3: 1',
      'Coverage: FULL',
      'Recommendation: COMMENT',
      `lib/a.js:1 — 🟢 P3 — ${description}`,
    ].join('\n') }]);
    assert.equal(result.status, 0, result.stderr);
  }
});

test('Claude review backstop rejects unmatched inline-code delimiters', () => {
  const result = runExtractor([{ type: 'result', result: [
    '## 🔵 Claude Code Review',
    'Counts: 🔴 P1: 0 / 🟡 P2: 0 / 🟢 P3: 1',
    'Coverage: FULL',
    'Recommendation: COMMENT',
    'lib/a.js:1 — 🟢 P3 — Unclosed `<script> markup.',
  ].join('\n') }]);
  assert.equal(result.status, 1);
});

test('Claude review backstop does not treat escaped backticks as inline code', () => {
  for (const description of [
    'The escaped \\`<div hidden>secret</div>\\` markers are not code.',
    'The escaped \\`<!-- hidden -->\\` markers are not code.',
  ]) {
    const result = runExtractor([{ type: 'result', result: [
      '## 🔵 Claude Code Review',
      'Counts: 🔴 P1: 0 / 🟡 P2: 1 / 🟢 P3: 0',
      'Coverage: FULL',
      'Recommendation: COMMENT',
      `lib/a.js:1 — 🟡 P2 — ${description}`,
    ].join('\n') }]);
    assert.equal(result.status, 1);
  }
});

test('Claude review backstop rejects invisible or display-reordering finding descriptions', () => {
  for (const description of [
    '\u200B',
    '\u200D',
    '\u2060',
    '\u00AD',
    '\0',
    '\u202EHidden',
    '\uFE0F',
    '\u{E0100}',
    '`\u200B`',
    '`Visible\u202E`',
    '---',
  ]) {
    const result = runExtractor([{ type: 'result', result: [
      '## 🔵 Claude Code Review',
      'Counts: 🔴 P1: 0 / 🟡 P2: 1 / 🟢 P3: 0',
      'Coverage: FULL',
      'Recommendation: COMMENT',
      `lib/a.js:1 — 🟡 P2 — ${description}`,
    ].join('\n') }]);
    assert.equal(result.status, 1, JSON.stringify(description));
  }
});

test('Claude review backstop rejects invisible entities and empty Markdown links', () => {
  for (const description of [
    '&#8203;',
    '&#x200B;',
    '&shy;',
    '&#x202E;Hidden',
    '[](https://example.invalid)',
    '[ ](https://example.invalid)',
  ]) {
    const result = runExtractor([{ type: 'result', result: [
      '## 🔵 Claude Code Review',
      'Counts: 🔴 P1: 0 / 🟡 P2: 1 / 🟢 P3: 0',
      'Coverage: FULL',
      'Recommendation: COMMENT',
      `lib/a.js:1 — 🟡 P2 — ${description}`,
    ].join('\n') }]);
    assert.equal(result.status, 1, description);
  }
});

test('Claude review backstop requires each finding row to close Markdown formatting', () => {
  for (const descriptions of [
    ['Visible ~~start', 'end~~ visible.'],
    ['Visible *start', 'end* visible.'],
    ['Visible _start', 'end_ visible.'],
    ['Visible [label', 'continued](https://example.invalid)'],
  ]) {
    const result = runExtractor([{ type: 'result', result: [
      '## 🔵 Claude Code Review',
      'Counts: 🔴 P1: 0 / 🟡 P2: 2 / 🟢 P3: 0',
      'Coverage: FULL',
      'Recommendation: COMMENT',
      `lib/a.js:1 — 🟡 P2 — ${descriptions[0]}`,
      `lib/b.js:2 — 🟡 P2 — ${descriptions[1]}`,
    ].join('\n') }]);
    assert.equal(result.status, 1, descriptions.join(' / '));
  }
});

test('Claude review backstop permits unsafe Markdown literals only inside inline code', () => {
  for (const description of [
    'Show the `\\*` escape literally.',
    'Use `snake_case` for the identifier.',
    'Compare `[label](url)` as literal code.',
    'Keep `~~text~~` literal.',
    'Show `&shy;` literally.',
  ]) {
    const result = runExtractor([{ type: 'result', result: [
      '## 🔵 Claude Code Review',
      'Counts: 🔴 P1: 0 / 🟡 P2: 0 / 🟢 P3: 1',
      'Coverage: FULL',
      'Recommendation: COMMENT',
      `lib/a.js:1 — 🟢 P3 — ${description}`,
    ].join('\n') }]);
    assert.equal(result.status, 0, `${description}: ${result.stderr}`);
  }
});

test('Claude review backstop accepts visible, line-balanced emphasis and intraword underscores', () => {
  for (const description of [
    'Preserve expected_revision during replay.',
    'Preserve **visible emphasis** in the finding.',
    'Preserve _visible emphasis_ in the finding.',
    'Preserve [the visible label] as literal text.',
    'Keep ~~deprecated behavior~~ out of the path.',
  ]) {
    const result = runExtractor([{ type: 'result', result: [
      '## 🔵 Claude Code Review',
      'Counts: 🔴 P1: 0 / 🟡 P2: 0 / 🟢 P3: 1',
      'Coverage: FULL',
      'Recommendation: COMMENT',
      `lib/a.js:1 — 🟢 P3 — ${description}`,
    ].join('\n') }]);
    assert.equal(result.status, 0, `${description}: ${result.stderr}`);
  }
});

test('Claude review backstop rejects clickable links and nested hidden markup', () => {
  for (const description of [
    '[external](https://example.invalid/finding)',
    '[protocol relative](//example.invalid/finding)',
    '[email](mailto:security@example.invalid)',
    '[repository relative](/trackly-app/trackly-cli/issues/1)',
    'Visit https://example.invalid/finding for context.',
    'Visit http://example.invalid/finding for context.',
    'Visit ftp://example.invalid/finding for context.',
    'Visit www.example.invalid/finding for context.',
    'Email security@example.invalid for context.',
    'Open mailto:security@example.invalid for context.',
    '**[](https://example.invalid/hidden-finding)**',
    '_[](https://example.invalid/hidden-finding)_',
    '~~[](https://example.invalid/hidden-finding)~~',
  ]) {
    const result = runExtractor([{ type: 'result', result: [
      '## 🔵 Claude Code Review',
      'Counts: 🔴 P1: 0 / 🟡 P2: 1 / 🟢 P3: 0',
      'Coverage: FULL',
      'Recommendation: COMMENT',
      `lib/a.js:1 — 🟡 P2 — ${description}`,
    ].join('\n') }]);
    assert.equal(result.status, 1, description);
  }
});

test('Claude review backstop rejects autolinks and mentions anywhere in a rendered finding row', () => {
  for (const finding of [
    'www.example.invalid:12 — 🟡 P2 — This path becomes a link.',
    'lib/a.js:1 — 🟡 P2 — Notify @kevinastuhuaman about this.',
    '@trackly-app/review.js:1 — 🟡 P2 — This path can ping a team.',
  ]) {
    const result = runExtractor([{ type: 'result', result: [
      '## 🔵 Claude Code Review',
      'Counts: 🔴 P1: 0 / 🟡 P2: 1 / 🟢 P3: 0',
      'Coverage: FULL',
      'Recommendation: COMMENT',
      finding,
    ].join('\n') }]);
    assert.equal(result.status, 1, finding);
  }
});

test('Claude review backstop rejects GitHub issue, commit, and compare autolinks', () => {
  for (const description of [
    'See #136 for context.',
    'See GH-136 for context.',
    'See octocat/Hello-World#1 for context.',
    'The regression began at e6224f9d.',
    'Compare e6224f9...debe407.',
  ]) {
    const result = runExtractor([{ type: 'result', result: [
      '## 🔵 Claude Code Review',
      'Counts: 🔴 P1: 0 / 🟡 P2: 1 / 🟢 P3: 0',
      'Coverage: FULL',
      'Recommendation: COMMENT',
      `lib/a.js:1 — 🟡 P2 — ${description}`,
    ].join('\n') }]);
    assert.equal(result.status, 1, description);
  }
});

test('Claude review backstop rejects GitHub emoji shortcodes outside inline code', () => {
  for (const description of [
    'This hides :red_circle: P1 after the declared severity.',
    'This hides :yellow_circle: P2 after the declared severity.',
    'This renders :warning: as an unreviewed symbol.',
  ]) {
    const result = runExtractor([{ type: 'result', result: [
      '## 🔵 Claude Code Review',
      'Counts: 🔴 0 / 🟡 0 / 🟢 1',
      'Coverage: FULL',
      'Recommendation: COMMENT',
      `lib/a.js:1 — 🟢 P3 — ${description}`,
    ].join('\n') }]);
    assert.equal(result.status, 1, description);
  }
});

test('Claude review backstop rejects Markdown escapes that become unsafe after rendering', () => {
  for (const description of [
    'See octocat/Hello\\-World#1 for context.',
    'Looks safe. :red\\_circle: P1 hidden.',
  ]) {
    const result = runExtractor([{ type: 'result', result: [
      '## 🔵 Claude Code Review',
      'Counts: 🔴 0 / 🟡 0 / 🟢 1',
      'Coverage: FULL',
      'Recommendation: COMMENT',
      `lib/a.js:1 — 🟢 P3 — ${description}`,
    ].join('\n') }]);
    assert.equal(result.status, 1, description);
  }
});

test('Claude review backstop rejects list markers that wrap finding rows', () => {
  for (const finding of [
    '1. lib/a.js:1 — 🟢 P3 — Ordered list.',
    '1) lib/a.js:1 — 🟢 P3 — Parenthesized list.',
    '+ lib/a.js:1 — 🟢 P3 — Unordered list.',
  ]) {
    const result = runExtractor([{ type: 'result', result: [
      '## 🔵 Claude Code Review',
      'Counts: 🔴 0 / 🟡 0 / 🟢 1',
      'Coverage: FULL',
      'Recommendation: COMMENT',
      finding,
    ].join('\n') }]);
    assert.equal(result.status, 1, finding);
  }
});

test('Claude review backstop rejects Unicode spacing that can disguise another finding', () => {
  for (const spacing of ['\u00a0', '\u2009', '\u202f']) {
    const result = runExtractor([{ type: 'result', result: [
      '## 🔵 Claude Code Review',
      'Counts: 🔴 P1: 0 / 🟡 P2: 0 / 🟢 P3: 1',
      'Coverage: FULL',
      'Recommendation: COMMENT',
      `safe.js:1 — 🟢 P3 — Looks safe.${spacing}—${spacing}🔴 P1${spacing}—${spacing}Hidden blocker.`,
    ].join('\n') }]);
    assert.equal(result.status, 1, JSON.stringify(spacing));
  }
});

test('Claude review backstop permits link-like text and mentions inside inline code', () => {
  for (const description of [
    'Reject `https://example.invalid/finding` before publishing.',
    'Reject `security@example.invalid` before publishing.',
    'Reject `@trackly-app` before publishing.',
    'Reject `🔴 P1` outside a counted finding.',
    'Reject `:red_circle: P1` outside inline code.',
    'Reject `octocat/Hello\\-World#1` outside inline code.',
    'Reject `octocat/Hello-World#1` outside inline code.',
    'Reject `e6224f9...debe407` outside inline code.',
  ]) {
    const result = runExtractor([{ type: 'result', result: [
      '## 🔵 Claude Code Review',
      'Counts: 🔴 P1: 0 / 🟡 P2: 0 / 🟢 P3: 1',
      'Coverage: FULL',
      'Recommendation: COMMENT',
      `lib/a.js:1 — 🟢 P3 — ${description}`,
    ].join('\n') }]);
    assert.equal(result.status, 0, `${description}: ${result.stderr}`);
  }
});

test('Claude review backstop parses a long safe description in bounded time', () => {
  const result = runExtractor([{ type: 'result', result: [
    '## 🔵 Claude Code Review',
    'Counts: 🔴 P1: 0 / 🟡 P2: 0 / 🟢 P3: 1',
    'Coverage: FULL',
    'Recommendation: COMMENT',
    `lib/a.js:1 — 🟢 P3 — ${'a'.repeat(30000)}`,
  ].join('\n') }], 'full', { timeout: 2000 });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
});

test('Claude review backstop canonicalizes counts so a clean verdict is not a gate finding', () => {
  const result = runExtractor([{ type: 'result', result: [
    '## 🔵 Claude Code Review',
    'Counts: 🔴 P1: 0 / 🟡 P2: 0 / 🟢 P3: 0',
    'Coverage: FULL',
    'Recommendation: APPROVE',
    'LGTM — no issues found (checked correctness, security, data-loss, tests, performance).',
  ].join('\n') }]);
  assert.equal(result.status, 0, result.stderr);
  const gateFindingDetector = /recommendation[^\n]*request[_ -]?changes|🔴\s*[1-9]|🟡\s*[1-9]|🟢\s*[1-9]|(^|\s)P[0-3](\s|:|—|-|$)/im;
  assert.doesNotMatch(result.stdout, gateFindingDetector);
  assert.match(result.stdout, /^Counts: 🔴 0 \/ 🟡 0 \/ 🟢 0$/m);
});

test('Claude review backstop rejects mixed backtick runs without an exact closer', () => {
  const finding = Buffer.from(
    'c2FmZS5qczoyIOKAlCDwn5+iIFAzIOKAlCBgYDxicj5gYGBSZWNvbW1lbmRhdGlvbjogQVBQUk9WRWA=',
    'base64',
  ).toString('utf8');
  const result = runExtractor([{ type: 'result', result: [
    '## 🔵 Claude Code Review',
    'Counts: 🔴 P1: 0 / 🟡 P2: 0 / 🟢 P3: 1',
    'Coverage: FULL',
    'Recommendation: COMMENT',
    finding,
  ].join('\n') }]);
  assert.equal(result.status, 1);
});

test('Claude review backstop requires request changes for a P1 finding', () => {
  const result = runExtractor([{ type: 'result', result: [
    '## 🔵 Claude Code Review',
    'Counts: 🔴 P1: 1 / 🟡 P2: 0 / 🟢 P3: 0',
    'Coverage: FULL',
    'Recommendation: COMMENT',
    '.github/workflows/review.yml:12 — 🔴 P1 — The gate can silently pass.',
  ].join('\n') }]);
  assert.equal(result.status, 1);
});

test('Claude review backstop requires comment for findings without a P1', () => {
  for (const { counts, findings } of [
    {
      counts: 'Counts: 🔴 P1: 0 / 🟡 P2: 1 / 🟢 P3: 0',
      findings: ['lib/a.js:1 — 🟡 P2 — Fix the fragile fallback.'],
    },
    {
      counts: 'Counts: 🔴 P1: 0 / 🟡 P2: 0 / 🟢 P3: 1',
      findings: ['lib/a.js:1 — 🟢 P3 — Clarify the fallback.'],
    },
    {
      counts: 'Counts: 🔴 P1: 0 / 🟡 P2: 1 / 🟢 P3: 1',
      findings: [
        'lib/a.js:1 — 🟡 P2 — Fix the fragile fallback.',
        'lib/b.js:2 — 🟢 P3 — Clarify the boundary.',
      ],
    },
  ]) {
    const result = runExtractor([{ type: 'result', result: [
      '## 🔵 Claude Code Review',
      counts,
      'Coverage: FULL',
      'Recommendation: REQUEST_CHANGES',
      ...findings,
    ].join('\n') }]);
    assert.equal(result.status, 1, counts);
  }
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

test('Claude review backstop validates finding locators against the trusted changed-line map', () => {
  const review = (locator) => [
    '## 🔵 Claude Code Review',
    'Counts: 🔴 P1: 0 / 🟡 P2: 1 / 🟢 P3: 0',
    'Coverage: FULL',
    'Recommendation: COMMENT',
    `${locator} — 🟡 P2 — Bound the retry loop.`,
  ].join('\n');
  const changedLines = { 'lib/client.js': [[10, 14], [40, 52]], 'mcp/server.js': [[3, 3]] };
  for (const accepted of ['lib/client.js:12', 'lib/client.js:40-52', '`lib/client.js:14`', 'mcp/server.js:3']) {
    const result = runExtractor([{ type: 'result', result: review(accepted) }], 'full', {}, changedLines);
    assert.equal(result.status, 0, `${accepted}: ${result.stderr}`);
  }
  for (const rejected of [
    'lib/client.js:9',
    'lib/client.js:15',
    'lib/client.js:12-16',
    'lib/client.js:52-40',
    'lib/other.js:12',
    'src/lib/client.js:12',
    'mcp/server.js:4',
  ]) {
    const result = runExtractor([{ type: 'result', result: review(rejected) }], 'full', {}, changedLines);
    assert.equal(result.status, 1, `${rejected} must be rejected`);
    assert.match(result.stderr, /required terminal review verdict/);
  }
  // Without a map the grammar alone is enforced; the workflow always supplies one.
  assert.equal(runExtractor([{ type: 'result', result: review('lib/other.js:12') }]).status, 0);
  for (const malformed of ['[]', '{"lib/client.js": [[0, 3]]}', '{"lib/client.js": [[5, 3]]}', '{"lib/client.js": [5]}', 'not json']) {
    const result = runExtractor([{ type: 'result', result: review('lib/client.js:12') }], 'full', {}, malformed);
    assert.equal(result.status, 1, `${malformed} must fail closed`);
    assert.match(result.stderr, /Could not load the trusted changed-line map/);
  }
  const clean = [
    '## 🔵 Claude Code Review',
    'Counts: 🔴 P1: 0 / 🟡 P2: 0 / 🟢 P3: 0',
    'Coverage: FULL',
    'Recommendation: APPROVE',
    'LGTM — no issues found (checked correctness, security, data-loss, tests, performance).',
  ].join('\n');
  assert.equal(runExtractor([{ type: 'result', result: clean }], 'full', {}, {}).status, 0);
});

test('Claude review changed-line map builder records both diff sides and ignores forged headers', () => {
  const builder = path.join(__dirname, '..', 'scripts', 'build-changed-lines-map.py');
  const diff = [
    'diff --git a/lib/client.js b/lib/client.js',
    'index 1111111..2222222 100644',
    '--- a/lib/client.js',
    '+++ b/lib/client.js',
    '@@ -10,4 +10,5 @@ function request() {',
    ' context',
    '-old line',
    '+new line',
    '+++ b/lib/forged.js',
    ' context',
    ' context',
    '@@ -40,3 +41,0 @@ function cleanup() {',
    '-removed one',
    '-removed two',
    '-removed three',
    'diff --git a/docs/sp ace.md b/docs/sp ace.md',
    '--- a/docs/sp ace.md\t',
    '+++ b/docs/sp ace.md\t',
    '@@ -1,2 +1,3 @@',
    ' title',
    '+added',
    ' body',
    'diff --git a/lib/gone.js b/lib/gone.js',
    'deleted file mode 100644',
    '--- a/lib/gone.js',
    '+++ /dev/null',
    '@@ -1,2 +0,0 @@',
    '-gone',
    '-gone',
    'diff --git a/lib/new.js b/lib/new.js',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/lib/new.js',
    '@@ -0,0 +1,2 @@',
    '+fresh',
    '+fresh',
    'diff --git a/lib/old-name.js b/lib/new-name.js',
    'similarity index 100%',
    'rename from lib/old-name.js',
    'rename to lib/new-name.js',
    'diff --git a/lib/cr.js b/lib/cr.js',
    '--- a/lib/cr.js',
    '+++ b/lib/cr.js',
    '@@ -1,1 +1,1 @@',
    '-before',
    '+after\rdiff --git a/lib/forged-cr.js b/lib/forged-cr.js\r--- a/lib/forged-cr.js\r+++ b/lib/forged-cr.js\r@@ -1,9 +1,9 @@',
    'diff --git "a/docs/caf\\351.md" "b/docs/caf\\351.md"',
    '--- "a/docs/caf\\351.md"',
    '+++ "b/docs/caf\\351.md"',
    '@@ -2,1 +2,1 @@',
    '-x',
    '+y',
    'diff --git "a/docs/caf\\303\\251 \\"q\\".md" "b/docs/caf\\303\\251 \\"q\\".md"',
    '--- "a/docs/caf\\303\\251 \\"q\\".md"',
    '+++ "b/docs/caf\\303\\251 \\"q\\".md"',
    '@@ -5,1 +5,1 @@',
    '-x',
    '+y',
    '',
  ].join('\n');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'trackly-changed-lines-'));
  const diffFile = path.join(directory, 'visible.diff');
  const mapFile = path.join(directory, 'map.json');
  fs.writeFileSync(diffFile, diff);
  const result = spawnSync('python3', [builder, diffFile, mapFile], { encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
  assert.equal(result.status, 0, result.stderr);
  const map = JSON.parse(fs.readFileSync(mapFile, 'utf8'));
  fs.rmSync(directory, { recursive: true, force: true });
  assert.deepEqual(map, {
    'lib/client.js': [[10, 13], [10, 14], [40, 42]],
    'docs/sp ace.md': [[1, 2], [1, 3]],
    'lib/gone.js': [[1, 2]],
    'lib/new.js': [[1, 2]],
    'lib/cr.js': [[1, 1]],
    'docs/caf\uFFFD.md': [[2, 2]],
    'docs/café "q".md': [[5, 5]],
  });
  assert.equal(Object.hasOwn(map, 'lib/forged.js'), false);
  assert.equal(Object.hasOwn(map, 'lib/forged-cr.js'), false);
  assert.equal(Object.hasOwn(map, 'lib/new-name.js'), false);

  // A visible diff cut mid-hunk (PARTIAL coverage) only trusts the lines the
  // model could actually see; a hunk header with no body records nothing.
  const buildMap = (text) => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'trackly-changed-lines-'));
    fs.writeFileSync(path.join(scratch, 'visible.diff'), text);
    const run = spawnSync('python3', [builder, path.join(scratch, 'visible.diff'), path.join(scratch, 'map.json')], { encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
    assert.equal(run.status, 0, run.stderr);
    const built = JSON.parse(fs.readFileSync(path.join(scratch, 'map.json'), 'utf8'));
    fs.rmSync(scratch, { recursive: true, force: true });
    return built;
  };
  assert.deepEqual(buildMap([
    'diff --git a/lib/big.js b/lib/big.js',
    '--- a/lib/big.js',
    '+++ b/lib/big.js',
    '@@ -100,6 +100,8 @@ function big() {',
    ' context',
    '+added one',
    '+added two',
    '-removed',
    ' cont',
  ].join('\n')), { 'lib/big.js': [[100, 102], [100, 103]] });
  assert.deepEqual(buildMap('diff --git a/lib/big.js b/lib/big.js\n--- a/lib/big.js\n+++ b/lib/big.js\n@@ -100,6 +100,8 @@ function big() {\n'), { 'lib/big.js': [] });
  // A shared old/new span followed by another file is clamped once to the
  // longer visible side, exactly like the end-of-input path.
  assert.deepEqual(buildMap([
    'diff --git a/lib/shared.js b/lib/shared.js',
    '--- a/lib/shared.js',
    '+++ b/lib/shared.js',
    '@@ -10,4 +10,4 @@',
    ' keep',
    '-old',
    '+new',
    'diff --git a/lib/next.js b/lib/next.js',
    '--- a/lib/next.js',
    '+++ b/lib/next.js',
    '@@ -1,1 +1,1 @@',
    '-a',
    '+b',
  ].join('\n')), { 'lib/shared.js': [[10, 11]], 'lib/next.js': [[1, 1]] });
});

test('Claude review backstop keeps decimal literals while rejecting commit references', () => {
  const review = (description) => [
    '## 🔵 Claude Code Review',
    'Counts: 🔴 P1: 0 / 🟡 P2: 1 / 🟢 P3: 0',
    'Coverage: FULL',
    'Recommendation: COMMENT',
    `lib/client.js:12 — 🟡 P2 — ${description}`,
  ].join('\n');
  for (const accepted of [
    'Reject payloads larger than 1048576 bytes.',
    'Retry after 30000000 milliseconds is too long.',
  ]) {
    const result = runExtractor([{ type: 'result', result: review(accepted) }]);
    assert.equal(result.status, 0, `${accepted}: ${result.stderr}`);
  }
  for (const rejected of [
    'Regressed since deadbeef1.',
    'Compare with 5210d80aed14f2ebdc37f0ac8d438353b3996847 before merging.',
    'Introduced in 1234567a.',
  ]) {
    assert.equal(runExtractor([{ type: 'result', result: review(rejected) }]).status, 1, rejected);
  }
});

test('Claude review workflow inlines the exact checked-in changed-line map builder', () => {
  const builder = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'build-changed-lines-map.py'), 'utf8');
  const heredoc = workflow.match(/<<'PY'\n([\s\S]*?)\n {10}PY\n/u);
  assert.ok(heredoc, 'workflow must inline the builder in a quoted heredoc');
  const inlined = heredoc[1].split('\n').map((line) => line.replace(/^ {10}/u, '')).join('\n');
  assert.equal(`${inlined}\n`, builder);
  assert.match(workflow, /python3 - "\$VISIBLE_DIFF_FILE" "\$CHANGED_LINES_FILE" <<'PY'/);
  assert.match(workflow, /head -c "\$MAXLEN" "\$DIFF_FILE" > "\$VISIBLE_DIFF_FILE"/);
});

test('Claude review backstop normalizes diff-prefixed locators only onto changed paths', () => {
  const review = (locator) => [
    '## 🔵 Claude Code Review',
    'Counts: 🔴 P1: 0 / 🟡 P2: 1 / 🟢 P3: 0',
    'Coverage: FULL',
    'Recommendation: COMMENT',
    `${locator} — 🟡 P2 — Bound the retry loop.`,
  ].join('\n');
  const changedLines = { 'lib/client.js': [[10, 14]] };
  for (const accepted of ['b/lib/client.js:12', 'a/lib/client.js:10-14']) {
    assert.equal(runExtractor([{ type: 'result', result: review(accepted) }], 'full', {}, changedLines).status, 0);
  }
  for (const rejected of ['b/lib/other.js:12', 'c/lib/client.js:12', 'b/b/lib/client.js:12']) {
    assert.equal(runExtractor([{ type: 'result', result: review(rejected) }], 'full', {}, changedLines).status, 1);
  }
});

test('Claude review backstop accepts Unicode changed paths in finding locators', () => {
  const review = (locator) => [
    '## 🔵 Claude Code Review',
    'Counts: 🔴 P1: 0 / 🟡 P2: 1 / 🟢 P3: 0',
    'Coverage: FULL',
    'Recommendation: COMMENT',
    `${locator} — 🟡 P2 — Bound the retry loop.`,
  ].join('\n');
  const changedLines = { 'docs/café.md': [[5, 5]], 'docs/日本語/guide.md': [[1, 3]], 'docs/foo:bar.md': [[5, 5]], 'docs/a b#c.md': [[1, 1]] };
  for (const accepted of ['docs/café.md:5', '`docs/日本語/guide.md:2`', '`docs/foo:bar.md:5`', 'docs/a b#c.md:1']) {
    const result = runExtractor([{ type: 'result', result: review(accepted) }], 'full', {}, changedLines);
    assert.equal(result.status, 0, `${accepted}: ${result.stderr}`);
  }
  for (const rejected of ['docs/cafe.md:5', 'docs/foo:bar.md:6', 'docs/foo:5', 'docs/caf\uFFFD.md:5']) {
    assert.equal(runExtractor([{ type: 'result', result: review(rejected) }], 'full', {}, changedLines).status, 1, rejected);
  }
  // A bare locator is part of the rendered row, so link markup in the path is
  // rejected even when the trusted map contains that exact filename. Balanced
  // emphasis and intraword underscores stay valid, matching the description
  // grammar; wrapping the locator in inline code is still accepted.
  const markupPaths = { 'docs/*bold*.md': [[5, 5]], 'docs/[label](https:/evil.example).md': [[1, 1]], 'docs/a_b_c.md': [[2, 2]], 'docs/~~x~~.md': [[3, 3]] };
  for (const rejected of ['docs/[label](https:/evil.example).md:1']) {
    assert.equal(runExtractor([{ type: 'result', result: review(rejected) }], 'full', {}, markupPaths).status, 1, rejected);
  }
  for (const accepted of ['docs/*bold*.md:5', 'docs/~~x~~.md:3', '`docs/*bold*.md:5`', '`docs/a_b_c.md:2`', 'docs/a_b_c.md:2']) {
    assert.equal(runExtractor([{ type: 'result', result: review(accepted) }], 'full', {}, markupPaths).status, 0, accepted);
  }
});

test('Claude review workflow marks opaque binary diffs as partial coverage', () => {
  const opaqueGrep = workflow.match(/grep -qE '(\^\(Binary files[^']*\)\$)' "\$VISIBLE_DIFF_FILE"/u);
  assert.ok(opaqueGrep, 'workflow must grep the visible diff for opaque entries');
  const opaque = new RegExp(opaqueGrep[1], 'm');
  for (const visible of [
    'Binary files a/x.png and b/x.png differ',
    'GIT binary patch',
    'old mode 100755',
    'new mode 100644',
    'new file mode 160000',
    'deleted file mode 160000',
    'index 1234abcd..89ef0123 160000',
    'similarity index 100%',
  ]) assert.match(`diff --git a/x b/x\n${visible}\n`, opaque, visible);
  for (const ordinary of [
    'index 1234abcd..89ef0123 100644',
    '+Subproject commit 1234abcd1234abcd1234abcd1234abcd1234abcd',
    ' Binary files a/x.png and b/x.png differ',
    '+old mode 100755',
    'rename from old/path',
    'rename to new/path',
    'copy from old/path',
    'similarity index 85%',
    'similarity index',
  ]) assert.doesNotMatch(`diff --git a/x b/x\n${ordinary}\n`, opaque, ordinary);
  // json.dump escapes U+FFFD as the six-character \ufffd sequence.
  assert.match(workflow, /\|\| grep -qF '\\ufffd' "\$CHANGED_LINES_FILE"/);
  const locatableCheck = workflow.match(/python3 -c '([^']+)' "\$CHANGED_LINES_FILE"/);
  assert.ok(locatableCheck, 'workflow must fail closed when the trusted map has no locatable ranges');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'trackly-changed-lines-'));
  const runLocatable = (map) => {
    const mapFile = path.join(scratch, 'locatable.json');
    fs.writeFileSync(mapFile, map);
    return spawnSync('python3', ['-c', locatableCheck[1], mapFile], { encoding: 'utf8' }).status;
  };
  assert.equal(runLocatable('{}'), 1);
  assert.equal(runLocatable('{"lib/a.js": []}'), 1);
  assert.equal(runLocatable('{"lib/a.js": [[1, 1]]}'), 0);
  fs.writeFileSync(path.join(scratch, 'visible.diff'), 'diff --git "a/docs/caf\\351.md" "b/docs/caf\\351.md"\n--- "a/docs/caf\\351.md"\n+++ "b/docs/caf\\351.md"\n@@ -1,1 +1,1 @@\n-x\n+y\n');
  const built = spawnSync('python3', [path.join(__dirname, '..', 'scripts', 'build-changed-lines-map.py'), path.join(scratch, 'visible.diff'), path.join(scratch, 'map.json')], { encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
  assert.equal(built.status, 0, built.stderr);
  assert.match(fs.readFileSync(path.join(scratch, 'map.json'), 'utf8'), /\\ufffd/);
  fs.writeFileSync(path.join(scratch, 'rename.diff'), 'diff --git a/old/path b/new/path\nsimilarity index 100%\nrename from old/path\nrename to new/path\n');
  const renamed = spawnSync('python3', [path.join(__dirname, '..', 'scripts', 'build-changed-lines-map.py'), path.join(scratch, 'rename.diff'), path.join(scratch, 'rename.json')], { encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
  assert.equal(renamed.status, 0, renamed.stderr);
  assert.equal(fs.readFileSync(path.join(scratch, 'rename.json'), 'utf8'), '{}');
  assert.equal(runLocatable(fs.readFileSync(path.join(scratch, 'rename.json'), 'utf8')), 1);
  fs.rmSync(scratch, { recursive: true, force: true });
  assert.match(workflow, /elif \[ "\$OPAQUE" = "true" \]; then\n\s+echo "partial=true" >> "\$GITHUB_OUTPUT"/);
  // Both PARTIAL notes carry the marker the prompt keys its partial verdict on.
  const notes = workflow.match(/(?:TRUNC_NOTE|OPAQUE_NOTE)="\[NOTE:[^\n]*\]"/g) || [];
  assert.equal(notes.length, 2);
  for (const note of notes) assert.match(note, /coverage is PARTIAL/);
  assert.equal((workflow.match(/contains a NOTE saying `coverage is PARTIAL`/g) || []).length, 2);
  assert.doesNotMatch(workflow, /contains `\[NOTE: diff truncated`/);
  assert.equal((workflow.match(/carries no PARTIAL coverage NOTE, use exactly:/g) || []).length, 2);
});

test('Claude review workflow builds and passes the trusted changed-line map', () => {
  assert.match(workflow, /CHANGED_LINES_FILE="\$\{RUNNER_TEMP:-\/tmp\}\/claude-review-changed-lines\.json"/);
  assert.match(workflow, /grep -q 'function loadChangedLines' "\$TRUSTED_EXTRACTOR"[\s\S]*?does not validate finding locations[\s\S]*?exit 1/);
  assert.match(workflow, /Could not build the trusted changed-line map[\s\S]*?exit 1/);
  assert.match(workflow, /echo "changed_lines_file=\$\{CHANGED_LINES_FILE\}" >> "\$GITHUB_OUTPUT"/);
  assert.match(workflow, /CHANGED_LINES_FILE: \$\{\{ steps\.precompute\.outputs\.changed_lines_file \}\}/);
  assert.match(workflow, /Trusted changed-line map is missing[\s\S]*?exit 1/);
  assert.match(workflow, /node "\$TRUSTED_EXTRACTOR" "\$EXEC_FILE" "\$COVERAGE_FLAG" "\$CHANGED_LINES_FILE"/);
});

test('Claude review workflow always publishes this run and fails closed without trusted code', () => {
  assert.doesNotMatch(workflow, /INLINE_REVIEW_PRESENT|comments\?sort=created/);
  assert.match(workflow, /Publish the terminal text from this exact execution/);
  assert.match(workflow, /isolates the last header-led terminal record and unwraps/);
  assert.match(workflow, /Could not load the Claude review extractor[\s\S]*?exit 1/);
  assert.match(workflow, /Could not decode the trusted Claude review extractor[\s\S]*?exit 1/);
  assert.doesNotMatch(workflow, /head -c 60000/);
  assert.match(workflow, /REVIEW_BYTES[\s\S]*?refusing to truncate findings[\s\S]*?exit 1/);
  assert.doesNotMatch(workflow, /mcp__github_inline_comment__create_inline_comment|classify_inline_comments/);
  assert.equal((workflow.match(/^\s+--tools=$/gm) || []).length, 2);
  assert.doesNotMatch(workflow, /--tools ""/);
  assert.equal((workflow.match(/Outside inline code, do/g) || []).length, 2);
  assert.equal((workflow.match(/`Counts: 🔴 N \/ 🟡 N \/ 🟢 N`/g) || []).length, 2);
  assert.equal((workflow.match(/Use APPROVE only for a full-coverage zero-finding review\./g) || []).length, 2);
  assert.equal((workflow.match(/use REQUEST_CHANGES when any P1/g) || []).length, 2);
  assert.match(workflow, /lacked the required valid terminal verdict; inline comments are insufficient review coverage/);
});

test('Claude review workflow only trusts the protected default branch as its base', () => {
  assert.match(
    workflow,
    /pull_request:\n\s+branches: \[main\]\n\s+types: \[opened, synchronize, reopened, ready_for_review\]/,
  );
  assert.match(
    workflow,
    /github\.event\.pull_request\.base\.ref == github\.event\.repository\.default_branch &&/,
  );
});

test('Claude review workflow binds every posted result to its head and run', () => {
  assert.equal((workflow.match(/HEAD_SHA: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/g) || []).length, 3);
  assert.equal((workflow.match(/RUN_URL: \$\{\{ github\.server_url \}\}\/\$\{\{ github\.repository \}\}\/actions\/runs\/\$\{\{ github\.run_id \}\}/g) || []).length, 3);
  assert.match(workflow, /exact-run terminal record for head \\`\$\{HEAD_SHA\}\\`; \[workflow run\]\(\$\{RUN_URL\}\)\./);
});

test('Claude review workflow binds a diff over 100 KB to trusted partial coverage', () => {
  const fullVerdict = '`LGTM — no issues found (checked correctness, security, data-loss, tests, performance).`';
  const partialVerdict = '`Partial LGTM — no issues found in the visible diff (coverage was partial because the diff was truncated).`';
  assert.match(workflow, /MAXLEN=100000[\s\S]*?\[ "\$BYTES" -gt "\$MAXLEN" \][\s\S]*?partial=true/);
  assert.match(workflow, /else\n\s+echo "partial=false"/);
  assert.match(workflow, /PARTIAL_COVERAGE: \$\{\{ steps\.precompute\.outputs\.partial \}\}/);
  assert.equal((workflow.match(/`Coverage: FULL\|PARTIAL`/g) || []).length, 2);
  assert.equal(workflow.split(fullVerdict).length - 1, 2);
  assert.equal(workflow.split(partialVerdict).length - 1, 2);
  assert.match(workflow, /true\) COVERAGE_FLAG="--partial"[\s\S]*?false\) COVERAGE_FLAG="--full"/);
  assert.match(workflow, /node "\$TRUSTED_EXTRACTOR" "\$EXEC_FILE" "\$COVERAGE_FLAG"/);
});
