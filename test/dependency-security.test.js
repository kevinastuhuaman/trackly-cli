'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  validateAuditReport,
} = require('../scripts/verify-audit-exceptions');

const POLICY_PATH = path.join(__dirname, '..', 'security', 'audit-exceptions.json');
const PACKAGE_LOCK_PATH = path.join(__dirname, '..', 'package-lock.json');
const SHRINKWRAP_PATH = path.join(__dirname, '..', 'npm-shrinkwrap.json');

function currentAuditReport() {
  return {
    auditReportVersion: 2,
    vulnerabilities: {
      '@hono/node-server': {
        name: '@hono/node-server',
        severity: 'moderate',
        isDirect: false,
        via: [{
          source: 1124006,
          name: '@hono/node-server',
          dependency: '@hono/node-server',
          title: 'Node.js Adapter for Hono: Path traversal in `serve-static` on Windows via encoded backslash (`%5C`)',
          url: 'https://github.com/advisories/GHSA-frvp-7c67-39w9',
          severity: 'moderate',
          cwe: ['CWE-22'],
          cvss: {
            score: 5.9,
            vectorString: 'CVSS:3.1/AV:N/AC:H/PR:N/UI:N/S:U/C:H/I:N/A:N',
          },
          range: '<2.0.5',
        }],
        effects: ['@modelcontextprotocol/sdk'],
        range: '<2.0.5',
        nodes: ['node_modules/@hono/node-server'],
        fixAvailable: {
          name: '@modelcontextprotocol/sdk',
          version: '1.24.3',
          isSemVerMajor: true,
        },
      },
      '@modelcontextprotocol/sdk': {
        name: '@modelcontextprotocol/sdk',
        severity: 'moderate',
        isDirect: true,
        via: ['@hono/node-server'],
        effects: [],
        range: '>=1.25.0',
        nodes: ['node_modules/@modelcontextprotocol/sdk'],
        fixAvailable: {
          name: '@modelcontextprotocol/sdk',
          version: '1.24.3',
          isSemVerMajor: true,
        },
      },
    },
    metadata: {
      vulnerabilities: {
        info: 0,
        low: 0,
        moderate: 2,
        high: 0,
        critical: 0,
        total: 2,
      },
      dependencies: {
        prod: 94,
        dev: 0,
        optional: 0,
        peer: 0,
        peerOptional: 0,
        total: 93,
      },
    },
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

test('published shrinkwrap exactly matches the repository dependency lock', () => {
  assert.deepEqual(
    JSON.parse(fs.readFileSync(SHRINKWRAP_PATH, 'utf8')),
    JSON.parse(fs.readFileSync(PACKAGE_LOCK_PATH, 'utf8')),
  );
});

test('audit policy documents the one temporary unreachable advisory', () => {
  const policy = JSON.parse(fs.readFileSync(POLICY_PATH, 'utf8'));

  assert.equal(policy.schemaVersion, 1);
  assert.equal(policy.exceptions.length, 1);
  assert.equal(policy.exceptions[0].advisory, 'GHSA-frvp-7c67-39w9');
  assert.equal(
    policy.exceptions[0].upstream,
    'https://github.com/modelcontextprotocol/typescript-sdk/issues/2531',
  );
  assert.match(policy.exceptions[0].rationale, /stdio/i);
  assert.match(policy.exceptions[0].rationale, /serveStatic/i);
});

test('current npm audit shape is accepted exactly', () => {
  const policy = JSON.parse(fs.readFileSync(POLICY_PATH, 'utf8'));
  assert.deepEqual(validateAuditReport(currentAuditReport(), policy), {
    allowedAdvisories: ['GHSA-frvp-7c67-39w9'],
    propagatedVulnerabilities: ['@hono/node-server', '@modelcontextprotocol/sdk'],
  });
});

for (const mutation of [
  {
    name: 'a second advisory',
    apply(report) {
      report.vulnerabilities.hono = {
        name: 'hono',
        severity: 'low',
        isDirect: true,
        via: [{
          source: 9999999,
          name: 'hono',
          dependency: 'hono',
          title: 'Unexpected advisory',
          url: 'https://github.com/advisories/GHSA-xxxx-yyyy-zzzz',
          severity: 'low',
          range: '<99.0.0',
        }],
        effects: [],
        range: '<99.0.0',
        nodes: ['node_modules/hono'],
        fixAvailable: true,
      };
      report.metadata.vulnerabilities.low = 1;
      report.metadata.vulnerabilities.total = 3;
    },
  },
  {
    name: 'a severity change',
    apply(report) {
      report.vulnerabilities['@hono/node-server'].severity = 'high';
      report.vulnerabilities['@hono/node-server'].via[0].severity = 'high';
      report.metadata.vulnerabilities.moderate = 1;
      report.metadata.vulnerabilities.high = 1;
    },
  },
  {
    name: 'an affected-range change',
    apply(report) {
      report.vulnerabilities['@hono/node-server'].range = '<2.0.6';
      report.vulnerabilities['@hono/node-server'].via[0].range = '<2.0.6';
    },
  },
  {
    name: 'a dependency-path change',
    apply(report) {
      report.vulnerabilities['@hono/node-server'].nodes =
        ['node_modules/unexpected/node_modules/@hono/node-server'];
    },
  },
  {
    name: 'a transitive relationship change',
    apply(report) {
      report.vulnerabilities['@hono/node-server'].effects = [];
    },
  },
]) {
  test(`audit gate rejects ${mutation.name}`, () => {
    const policy = JSON.parse(fs.readFileSync(POLICY_PATH, 'utf8'));
    const report = clone(currentAuditReport());
    mutation.apply(report);

    assert.throws(
      () => validateAuditReport(report, policy),
      /audit report does not match the temporary exception/i,
    );
  });
}

test('audit gate accepts a clean report after the upstream fix lands', () => {
  const policy = JSON.parse(fs.readFileSync(POLICY_PATH, 'utf8'));
  const cleanReport = {
    auditReportVersion: 2,
    vulnerabilities: {},
    metadata: {
      vulnerabilities: {
        info: 0,
        low: 0,
        moderate: 0,
        high: 0,
        critical: 0,
        total: 0,
      },
    },
  };

  assert.deepEqual(validateAuditReport(cleanReport, policy), {
    allowedAdvisories: [],
    propagatedVulnerabilities: [],
  });
});

test('audit gate reports registry failures without misclassifying the schema version', () => {
  const policy = JSON.parse(fs.readFileSync(POLICY_PATH, 'utf8'));

  assert.throws(
    () => validateAuditReport({
      message: 'request to the npm audit endpoint failed',
      error: { summary: '', detail: '' },
    }, policy),
    /npm audit did not return an advisory report: request to the npm audit endpoint failed/i,
  );
});
