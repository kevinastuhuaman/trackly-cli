#!/usr/bin/env node

const fs = require('node:fs');

function parseEvents(source) {
  try {
    const parsed = JSON.parse(source);
    return Array.isArray(parsed) ? parsed.flat(1) : [parsed];
  } catch {
    return source
      .split(/\r?\n/)
      .filter((line) => line.trim())
      .flatMap((line) => {
        const parsed = JSON.parse(line);
        return Array.isArray(parsed) ? parsed.flat(1) : [parsed];
      });
  }
}

function extractReview(events) {
  const results = events
    .filter((event) => event?.type === 'result' && typeof event.result === 'string')
    .map((event) => event.result);
  if (results.length) return results.at(-1);

  const assistantTexts = events.flatMap((event) => {
    if (event?.type !== 'assistant' || !Array.isArray(event.message?.content)) return [];
    return event.message.content
      .filter((content) => content?.type === 'text' && typeof content.text === 'string')
      .map((content) => content.text);
  });
  return assistantTexts.at(-1) || '';
}

function normalizeMetadataLine(line) {
  return line
    .replace(/^([ \t]*)(?:\*\*Counts:\*\*|__Counts:__)(?=[ \t])/, '$1Counts:')
    .replace(/^([ \t]*)(?:\*\*Coverage:\*\*|__Coverage:__)(?=[ \t])/, '$1Coverage:')
    .replace(/^([ \t]*)(?:\*\*Recommendation:\*\*|__Recommendation:__)(?=[ \t])/, '$1Recommendation:')
    .replace(/\*\*(\d+)\*\*|__(\d+)__/g, (_match, bold, underline) => bold || underline);
}

function normalizeFindingLine(line) {
  return line.replace(/^`([^`\r\n]+:\d+(?:-\d+)?)`/, '$1');
}

const COUNT_LINE = /^counts:[ \t]*🔴(?:[ \t]*P1)?[ \t]*:?[ \t]*(\d+)[ \t]*\/[ \t]*🟡(?:[ \t]*P2)?[ \t]*:?[ \t]*(\d+)[ \t]*\/[ \t]*🟢(?:[ \t]*P3)?[ \t]*:?[ \t]*(\d+)[ \t]*$/iu;
const REVIEW_HEADER = '## 🔵 Claude Code Review';
const FULL_LGTM = 'LGTM — no issues found (checked correctness, security, data-loss, tests, performance).';
const PARTIAL_LGTM = 'Partial LGTM — no issues found in the visible diff (coverage was partial because the diff was truncated).';

// The workflow prompt teaches the metadata and clean-verdict lines as inline
// code. Accept one wrapping pair of backticks on those taught lines only;
// fenced blocks and inner backticks stay outside the grammar.
function unwrapTaughtInlineCode(line) {
  const match = /^`([^`\r\n]+)`$/u.exec(line);
  return match ? match[1] : line;
}

function taughtMetadataLine(line) {
  return normalizeMetadataLine(unwrapTaughtInlineCode(line));
}

// Claude Code's final result string is the whole last assistant turn. Recover
// the last header-led terminal record from that turn so planning text before
// the required header cannot hide a complete verdict. Publish only that block.
function isolateTerminalRecord(review) {
  const lines = review.split(/\r?\n/);
  let start = -1;
  for (let index = 0; index < lines.length; index += 1) {
    if (unwrapTaughtInlineCode(lines[index]) === REVIEW_HEADER) start = index;
  }
  return start === -1 ? review : lines.slice(start).join('\n');
}

function isEscapedAt(value, position) {
  let backslashes = 0;
  for (let cursor = position - 1; cursor >= 0 && value[cursor] === '\\'; cursor -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

function markdownOutsideInlineCode(value) {
  let outside = '';
  for (let index = 0; index < value.length;) {
    if (value[index] !== '`' || isEscapedAt(value, index)) {
      outside += value[index];
      index += 1;
      continue;
    }
    let runLength = 1;
    while (value[index + runLength] === '`') runLength += 1;
    if (runLength > 2) return null;
    const delimiter = '`'.repeat(runLength);
    let close = value.indexOf(delimiter, index + runLength);
    while (close !== -1) {
      let closeRunLength = 1;
      while (value[close + closeRunLength] === '`') closeRunLength += 1;
      if (closeRunLength === runLength) break;
      close = value.indexOf(delimiter, close + closeRunLength);
    }
    if (close === -1) return null;
    outside += ' ';
    index = close + runLength;
  }
  return outside;
}

function hasUnsafeMarkdownDelimiter(value) {
  const isWordCharacter = (character) => character != null && /[\p{L}\p{N}]/u.test(character);
  for (let index = 0; index < value.length; index += 1) {
    if (isEscapedAt(value, index)) continue;
    const character = value[index];
    if (character === '_' && isWordCharacter(value[index - 1]) && isWordCharacter(value[index + 1])) {
      continue;
    }
    if (character === '[') {
      const closeLabel = value.indexOf(']', index + 1);
      if (closeLabel === -1 || isEscapedAt(value, closeLabel)) return true;
      const label = value.slice(index + 1, closeLabel);
      if (!/[\p{L}\p{N}]/u.test(label)) return true;
      if (value[closeLabel + 1] === '(') {
        // Review text is posted with a trusted bot identity. Keep destinations
        // in inline code so prompt-injected findings cannot publish links.
        return true;
      }
      index = closeLabel;
      continue;
    }
    if (character === ']') return true;
    if (!'*_~'.includes(character)) continue;
    let runLength = 1;
    while (value[index + runLength] === character) runLength += 1;
    if ((character === '~' && runLength !== 2) || (character !== '~' && runLength > 2)) return true;
    const delimiter = character.repeat(runLength);
    let close = value.indexOf(delimiter, index + runLength);
    while (close !== -1 && isEscapedAt(value, close)) {
      close = value.indexOf(delimiter, close + runLength);
    }
    const content = close === -1 ? '' : value.slice(index + runLength, close);
    if (close === -1 || !/[\p{L}\p{N}]/u.test(content)
        || hasUnsafeMarkdownDelimiter(content)) return true;
    index = close + runLength - 1;
  }
  return false;
}

// The locator path accepts any git path text except Markdown block leaders and
// HTML angle brackets; exact membership in the trusted changed-line map is what
// validates it, while the row-level checks below still reject backslashes,
// controls, links, entities, and hidden markup.
function parseFindingLine(line) {
  if (/^[ \t]*(?:[-+*]|\d+[.)])[ \t]+/u.test(line)) return { invalid: true };
  const normalized = normalizeFindingLine(line);
  const match = normalized.match(
    /^([^\s`<>#|!\[][^`\r\n<>]*?:\d+(?:-\d+)?)[ \t]+[—-][ \t]+(🔴|🟡|🟢)(?:[ \t]*P([1-3]))?[ \t]+[—-][ \t]+(\S.*)$/u,
  );
  if (!match) return null;
  const description = match[4];
  const outsideInlineCode = markdownOutsideInlineCode(match[4]);
  const renderedRow = markdownOutsideInlineCode(line);
  if (outsideInlineCode === null || renderedRow === null
      || /[\p{Cc}\p{Cs}\p{Bidi_Control}\p{Default_Ignorable_Code_Point}]/u.test(line)
      || /[\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/u.test(renderedRow)
      || !/[\p{L}\p{N}]/u.test(description)
      || /&(?:#\d+|#x[0-9a-f]+|[a-z][a-z0-9]+);/iu.test(renderedRow)
      || /\b(?:https?|ftp):\/\/|\bwww\.|\bmailto:/iu.test(renderedRow)
      || renderedRow.includes('@')
      || renderedRow.includes('\\')
      || /(?:^|[^\p{L}\p{N}_])(?:#\d+|gh-\d+|[a-z0-9_.-]{1,39}\/[a-z0-9_.-]{1,100}#\d+|(?=[0-9]*[a-f])[0-9a-f]{7,40})(?![\p{L}\p{N}_])/iu.test(renderedRow)
      || /:[a-z0-9_+-]{1,64}:/iu.test(renderedRow)
      || hasUnsafeMarkdownDelimiter(outsideInlineCode)
      || hasUnsafeMarkdownDelimiter(renderedRow)
      || /<!--|-->|<[^>\r\n]*>|!\[|~~~/i.test(renderedRow)
      || /[🔴🟡🟢]/u.test(outsideInlineCode)) {
    return { invalid: true };
  }
  return { invalid: false, severity: match[2], level: match[3], locator: match[1] };
}

function loadChangedLines(changedLinesFile) {
  const parsed = JSON.parse(fs.readFileSync(changedLinesFile, 'utf8'));
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('changed-line map must be a JSON object keyed by path');
  }
  const changedLines = new Map();
  for (const [filePath, ranges] of Object.entries(parsed)) {
    if (!Array.isArray(ranges) || !ranges.every((range) => (
      Array.isArray(range) && range.length === 2
      && Number.isInteger(range[0]) && Number.isInteger(range[1])
      && range[0] >= 1 && range[1] >= range[0]
    ))) {
      throw new Error(`changed-line map for ${filePath} must list [start, end] line ranges`);
    }
    changedLines.set(filePath, ranges);
  }
  return changedLines;
}

// A finding locator is trusted only when it names a changed path and every
// cited line falls inside a hunk of the trusted diff. A hallucinated path or
// line number must not become part of a validated exact-run record.
function locatorInChangedLines(locator, changedLines) {
  const match = locator.match(/^(.*):(\d+)(?:-(\d+))?$/u);
  if (!match) return false;
  // Accept a locator copied from a diff header (`a/` or `b/` prefix) only
  // when the unprefixed path is itself a changed path.
  const ranges = changedLines.get(match[1])
    ?? (/^[ab]\//u.test(match[1]) ? changedLines.get(match[1].slice(2)) : undefined);
  if (!ranges) return false;
  const start = Number(match[2]);
  const end = match[3] === undefined ? start : Number(match[3]);
  if (end < start) return false;
  return ranges.some(([rangeStart, rangeEnd]) => start >= rangeStart && end <= rangeEnd);
}

function isTerminalReview(review, coverage, changedLines = null) {
  if (coverage !== 'full' && coverage !== 'partial') return false;
  const lines = review.split(/\r?\n/).filter((line) => line.trim() !== '');
  if (unwrapTaughtInlineCode(lines[0] || '') !== REVIEW_HEADER) return false;
  const countMatch = taughtMetadataLine(lines[1] || '').match(COUNT_LINE);
  if (!countMatch) return false;
  const severityCounts = new Map([
    ['🔴', Number(countMatch[1])],
    ['🟡', Number(countMatch[2])],
    ['🟢', Number(countMatch[3])],
  ]);
  const recommendationLine = /^recommendation:[ \t]*(approve|request[_ -]?changes|comment)[ \t]*$/i;
  const coverageLine = /^coverage:[ \t]*(full|partial)[ \t]*$/i;
  const coverageMatch = taughtMetadataLine(lines[2] || '').match(coverageLine);
  if (!coverageMatch || coverageMatch[1].toLowerCase() !== coverage) return false;
  const recommendationMatch = taughtMetadataLine(lines[3] || '').match(recommendationLine);
  if (!recommendationMatch) return false;
  const recommendation = recommendationMatch[1].toLowerCase().replace(/[ -]/g, '_');

  const findingCounts = new Map([['🔴', 0], ['🟡', 0], ['🟢', 0]]);
  const expectedLevel = new Map([['🔴', '1'], ['🟡', '2'], ['🟢', '3']]);
  let hasPartialVerdict = false;
  let hasFullVerdict = false;
  for (const line of lines.slice(4)) {
    const finding = parseFindingLine(line);
    if (finding) {
      if (finding.invalid) return false;
      if (finding.level && finding.level !== expectedLevel.get(finding.severity)) return false;
      if (changedLines && !locatorInChangedLines(finding.locator, changedLines)) return false;
      findingCounts.set(finding.severity, findingCounts.get(finding.severity) + 1);
    } else if (unwrapTaughtInlineCode(line) === PARTIAL_LGTM) {
      if (hasPartialVerdict) return false;
      hasPartialVerdict = true;
    } else if (unwrapTaughtInlineCode(line) === FULL_LGTM) {
      if (hasFullVerdict) return false;
      hasFullVerdict = true;
    } else {
      // The terminal record is a strict machine-readable grammar. Reject
      // prose, templates, and rendered-hidden containers instead of trying to
      // infer whether GitHub will display them.
      return false;
    }
  }
  const totalFindings = [...severityCounts.values()].reduce((sum, count) => sum + count, 0);
  if (totalFindings === 0) {
    if ([...findingCounts.values()].some((count) => count !== 0)) return false;
    if (coverage === 'partial') {
      return hasPartialVerdict && !hasFullVerdict && recommendation === 'comment';
    }
    return hasFullVerdict && !hasPartialVerdict && recommendation === 'approve';
  }
  if (recommendation === 'approve') return false;
  if (hasFullVerdict || hasPartialVerdict) return false;
  if (severityCounts.get('🔴') > 0 && recommendation !== 'request_changes') return false;
  if (severityCounts.get('🔴') === 0 && recommendation !== 'comment') return false;
  return [...severityCounts].every(([symbol, count]) => findingCounts.get(symbol) === count);
}

function canonicalizeCountRecord(review) {
  let nonEmptyLine = 0;
  return isolateTerminalRecord(review).split(/\r?\n/).map((line) => {
    if (line.trim() === '') return line;
    nonEmptyLine += 1;
    const taught = unwrapTaughtInlineCode(line);
    if (nonEmptyLine === 2) {
      const countMatch = normalizeMetadataLine(taught).match(COUNT_LINE);
      if (!countMatch) return line;
      return `Counts: 🔴 ${Number(countMatch[1])} / 🟡 ${Number(countMatch[2])} / 🟢 ${Number(countMatch[3])}`;
    }
    if (
      nonEmptyLine === 1
      || nonEmptyLine === 3
      || nonEmptyLine === 4
      || taught === FULL_LGTM
      || taught === PARTIAL_LGTM
    ) {
      return taught;
    }
    return line;
  }).join('\n');
}

const executionFile = process.argv[2];
const coverageFlag = process.argv[3];
const changedLinesFile = process.argv[4];
const coverage = coverageFlag === '--partial' ? 'partial' : coverageFlag === '--full' ? 'full' : '';
if (!executionFile || !coverage) {
  console.error('usage: extract-terminal-claude-review.js <execution-file> <--full|--partial> [changed-lines.json]');
  process.exit(2);
}

let changedLines = null;
if (changedLinesFile !== undefined) {
  try {
    changedLines = loadChangedLines(changedLinesFile);
  } catch (error) {
    console.error(`Could not load the trusted changed-line map: ${error.message}`);
    process.exit(1);
  }
}

try {
  const review = isolateTerminalRecord(
    extractReview(parseEvents(fs.readFileSync(executionFile, 'utf8'))),
  ).trim();
  if (!isTerminalReview(review, coverage, changedLines)) {
    console.error('Claude execution ended without the required terminal review verdict.');
    process.exit(1);
  }
  process.stdout.write(canonicalizeCountRecord(review));
} catch (error) {
  console.error(`Could not recover Claude review output: ${error.message}`);
  process.exit(1);
}
