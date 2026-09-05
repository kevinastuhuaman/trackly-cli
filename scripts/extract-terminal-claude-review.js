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

function isTerminalReview(review) {
  const normalized = review
    .replace(/[*`]/g, '')
    .replace(/_{1,2}([^_\r\n]+?)_{1,2}/g, '$1');
  if (!/^## 🔵 Claude Code Review\s*(?:\r?\n|$)/.test(normalized)) return false;
  const severityCounts = new Map();
  for (const [symbol, level] of [['🔴', 1], ['🟡', 2], ['🟢', 3]]) {
    const match = normalized.match(new RegExp(
      `${symbol}(?:[ \\t]*P${level})?[ \\t]*:?[ \\t]*(\\d+)`,
      'iu',
    ));
    if (!match) return false;
    severityCounts.set(symbol, Number(match[1]));
  }
  const recommendation = normalized.match(
    /recommendation\s*:\s*(approve|request[_ -]?changes|comment)\b/i,
  )?.[1]?.toLowerCase().replace(/[ -]/g, '_');
  if (!recommendation) return false;

  const findingCounts = new Map([['🔴', 0], ['🟡', 0], ['🟢', 0]]);
  const findingLine = /^\s*(?:[-*]\s*)?\S[^\r\n]*:\d+(?:-\d+)?\s+[—-]\s+(🔴|🟡|🟢)(?:\s*P([1-3]))?\s+[—-]\s+\S/iu;
  const expectedLevel = new Map([['🔴', '1'], ['🟡', '2'], ['🟢', '3']]);
  for (const line of normalized.split(/\r?\n/)) {
    const match = line.match(findingLine);
    if (!match) continue;
    if (match[2] && match[2] !== expectedLevel.get(match[1])) return false;
    findingCounts.set(match[1], findingCounts.get(match[1]) + 1);
  }
  const totalFindings = [...severityCounts.values()].reduce((sum, count) => sum + count, 0);
  if (totalFindings === 0) {
    if ([...findingCounts.values()].some((count) => count !== 0)) return false;
    if (/^\s*partial\s+lgtm\s*[—-]\s*no issues found\b.*$/im.test(normalized)) {
      return recommendation === 'comment';
    }
    return /^\s*lgtm\s*[—-]\s*no issues found\b.*$/im.test(normalized)
      && recommendation === 'approve';
  }
  if (recommendation === 'approve') return false;
  if (severityCounts.get('🔴') > 0 && recommendation !== 'request_changes') return false;
  return [...severityCounts].every(([symbol, count]) => findingCounts.get(symbol) === count);
}

const executionFile = process.argv[2];
if (!executionFile) {
  console.error('usage: extract-terminal-claude-review.js <execution-file>');
  process.exit(2);
}

try {
  const review = extractReview(parseEvents(fs.readFileSync(executionFile, 'utf8'))).trim();
  if (!isTerminalReview(review)) {
    console.error('Claude execution ended without the required terminal review verdict.');
    process.exit(1);
  }
  process.stdout.write(review);
} catch (error) {
  console.error(`Could not recover Claude review output: ${error.message}`);
  process.exit(1);
}
