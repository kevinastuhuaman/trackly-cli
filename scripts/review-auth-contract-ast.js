'use strict';

const crypto = require('node:crypto');

const OMITTED_AST_KEYS = new Set([
  'loc', 'start', 'end', 'leadingComments', 'trailingComments', 'innerComments', 'extra',
]);

const canonicalAst = (value) => {
  if (Array.isArray(value)) return value.map(canonicalAst);
  if (!value || typeof value !== 'object') return value;
  const result = {};
  for (const key of Object.keys(value).sort()) {
    if (OMITTED_AST_KEYS.has(key)) continue;
    result[key] = canonicalAst(value[key]);
  }
  return result;
};

const astSha256 = (node) => crypto
  .createHash('sha256')
  .update(JSON.stringify(canonicalAst(node)))
  .digest('hex');

module.exports = { astSha256, canonicalAst };
