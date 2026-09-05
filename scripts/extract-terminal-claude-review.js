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
        const closeTarget = value.indexOf(')', closeLabel + 2);
        if (closeTarget === -1 || isEscapedAt(value, closeTarget)
            || closeTarget === closeLabel + 2) return true;
        index = closeTarget;
      } else {
        index = closeLabel;
      }
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
    if (close === -1 || !/[\p{L}\p{N}]/u.test(value.slice(index + runLength, close))) return true;
    index = close + runLength - 1;
  }
  return false;
}

function parseFindingLine(line) {
  const normalized = normalizeFindingLine(line);
  const match = normalized.match(
    /^([A-Za-z0-9_.@/+][A-Za-z0-9_.@/+() -]*:\d+(?:-\d+)?)[ \t]+[—-][ \t]+(🔴|🟡|🟢)(?:[ \t]*P([1-3]))?[ \t]+[—-][ \t]+(\S.*)$/u,
  );
  if (!match) return null;
  const description = match[4];
  const outsideInlineCode = markdownOutsideInlineCode(match[4]);
  if (outsideInlineCode === null
      || /[\p{Cc}\p{Cs}\p{Bidi_Control}\p{Default_Ignorable_Code_Point}]/u.test(description)
      || !/[\p{L}\p{N}]/u.test(description)
      || /&(?:#\d+|#x[0-9a-f]+|[a-z][a-z0-9]+);/iu.test(outsideInlineCode)
      || hasUnsafeMarkdownDelimiter(outsideInlineCode)
      || /<!--|-->|<[^>\r\n]*>|!\[|~~~/i.test(outsideInlineCode)
      || /[ \t]+[—-][ \t]+(?:🔴|🟡|🟢)(?:[ \t]*P[1-3])?[ \t]+[—-][ \t]+/u.test(outsideInlineCode)) {
    return { invalid: true };
  }
  return { invalid: false, severity: match[2], level: match[3] };
}

function isTerminalReview(review, coverage) {
  if (coverage !== 'full' && coverage !== 'partial') return false;
  const lines = review.split(/\r?\n/).filter((line) => line.trim() !== '');
  if (lines[0] !== '## 🔵 Claude Code Review') return false;
  const countLine = /^counts:[ \t]*🔴(?:[ \t]*P1)?[ \t]*:?[ \t]*(\d+)[ \t]*\/[ \t]*🟡(?:[ \t]*P2)?[ \t]*:?[ \t]*(\d+)[ \t]*\/[ \t]*🟢(?:[ \t]*P3)?[ \t]*:?[ \t]*(\d+)[ \t]*$/iu;
  const countMatch = normalizeMetadataLine(lines[1] || '').match(countLine);
  if (!countMatch) return false;
  const severityCounts = new Map([
    ['🔴', Number(countMatch[1])],
    ['🟡', Number(countMatch[2])],
    ['🟢', Number(countMatch[3])],
  ]);
  const recommendationLine = /^recommendation:[ \t]*(approve|request[_ -]?changes|comment)[ \t]*$/i;
  const coverageLine = /^coverage:[ \t]*(full|partial)[ \t]*$/i;
  const coverageMatch = normalizeMetadataLine(lines[2] || '').match(coverageLine);
  if (!coverageMatch || coverageMatch[1].toLowerCase() !== coverage) return false;
  const recommendationMatch = normalizeMetadataLine(lines[3] || '').match(recommendationLine);
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
      findingCounts.set(finding.severity, findingCounts.get(finding.severity) + 1);
    } else if (line === 'Partial LGTM — no issues found in the visible diff (coverage was partial because the diff was truncated).') {
      if (hasPartialVerdict) return false;
      hasPartialVerdict = true;
    } else if (line === 'LGTM — no issues found (checked correctness, security, data-loss, tests, performance).') {
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
  return [...severityCounts].every(([symbol, count]) => findingCounts.get(symbol) === count);
}

const executionFile = process.argv[2];
const coverageFlag = process.argv[3];
const coverage = coverageFlag === '--partial' ? 'partial' : coverageFlag === '--full' ? 'full' : '';
if (!executionFile || !coverage) {
  console.error('usage: extract-terminal-claude-review.js <execution-file> <--full|--partial>');
  process.exit(2);
}

try {
  const review = extractReview(parseEvents(fs.readFileSync(executionFile, 'utf8'))).trim();
  if (!isTerminalReview(review, coverage)) {
    console.error('Claude execution ended without the required terminal review verdict.');
    process.exit(1);
  }
  process.stdout.write(review);
} catch (error) {
  console.error(`Could not recover Claude review output: ${error.message}`);
  process.exit(1);
}
