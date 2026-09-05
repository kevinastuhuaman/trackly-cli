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

function runExtractor(events, coverage = 'full') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'trackly-claude-review-'));
  const executionFile = path.join(directory, 'execution.jsonl');
  fs.writeFileSync(executionFile, events.map((event) => JSON.stringify(event)).join('\n'));
  const result = spawnSync(process.execPath, [extractor, executionFile, `--${coverage}`], { encoding: 'utf8' });
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
  assert.equal(result.stdout, review);
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
    'Coverage: FULL',
    'Recommendation: APPROVE',
  ].join('\n') }]);
  assert.equal(result.status, 1);
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

test('Claude review backstop permits Markdown delimiters only when escaped or inside inline code', () => {
  for (const description of [
    'Escape the \\* marker.',
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

test('Claude review backstop accepts visible, line-balanced Markdown and intraword underscores', () => {
  for (const description of [
    'Preserve expected_revision during replay.',
    'Preserve **visible emphasis** in the finding.',
    'Preserve _visible emphasis_ in the finding.',
    'See [the contract](https://example.invalid/contract) for context.',
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
  assert.doesNotMatch(workflow, /head -c 60000/);
  assert.match(workflow, /REVIEW_BYTES[\s\S]*?refusing to truncate findings[\s\S]*?exit 1/);
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
  assert.match(workflow, /exact-run terminal record for head \\`\$\{HEAD_SHA\}\\`; \[workflow run\]\(\$\{RUN_URL\}\)/);
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
