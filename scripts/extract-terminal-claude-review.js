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
  return /^## 🔵 Claude Code Review\s*$/m.test(review)
    && /🔴\s*\d+/u.test(review)
    && /🟡\s*\d+/u.test(review)
    && /🟢\s*\d+/u.test(review)
    && /recommendation\s*:\s*(?:approve|request[_ -]?changes|comment)\b/i.test(review);
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
