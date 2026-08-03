'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { diagnoseLocalPath, parseFilesystemMountLine } = require('../lib/path-diagnostics');

test('filesystem mount parsing preserves mount points containing spaces', () => {
  assert.deepEqual(
    parseFilesystemMountLine('/dev/disk3s1 1000 100 900 10% /Volumes/Trackly Data'),
    { device: '/dev/disk3s1', mountPoint: '/Volumes/Trackly Data', observed: true },
  );
  assert.deepEqual(
    parseFilesystemMountLine('malformed'),
    { device: null, mountPoint: null, observed: false },
  );
});

test('path diagnosis tests the exact filesystem without deleting user files', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'trackly-path-diagnostic-'));
  const userFile = path.join(directory, 'keep.txt');
  fs.writeFileSync(userFile, 'keep');
  try {
    const result = await diagnoseLocalPath(userFile, { originalErrno: 'ENOSPC' });
    assert.equal(result.exactPath, path.resolve(userFile));
    assert.equal(result.exists, true);
    assert.equal(result.writableProbe.ok, true);
    assert.equal(result.exactFileAccess.readable, true);
    assert.equal(result.exactFileAccess.writable, true);
    assert.equal(result.writableProbe.scope, 'same_directory_create');
    assert.equal(result.writableProbe.testedPath, path.resolve(directory));
    assert.equal(result.originalErrno, 'ENOSPC');
    assert.ok(result.filesystem.freeBytes >= 0);
    assert.equal(fs.readFileSync(userFile, 'utf8'), 'keep');
    assert.deepEqual(fs.readdirSync(directory), ['keep.txt']);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('path diagnosis accepts only real uppercase errno-shaped codes', async () => {
  await assert.rejects(
    diagnoseLocalPath('/tmp/example', { originalErrno: 'disk full' }),
    /uppercase errno code/,
  );
});

test('path diagnosis returns structured evidence when parent traversal is denied', async () => {
  const denied = Object.assign(new Error('permission denied'), { code: 'EACCES' });
  const result = await diagnoseLocalPath('/private/blocked/application.pdf', {}, {
    stat: async () => { throw denied; },
  });
  assert.equal(result.exists, null);
  assert.equal(result.pathInspectionErrorCode, 'EACCES');
  assert.equal(result.writableProbe.ok, false);
  assert.equal(result.writableProbe.errorCode, 'EACCES');
  assert.equal(result.writableProbe.scope, 'not_attempted_path_inspection_failed');
  assert.equal(result.writableProbe.testedPath, '/private/blocked/application.pdf');
});

test('path diagnosis reports exact-file permission failure instead of sibling writability', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'trackly-path-permission-'));
  const userFile = path.join(directory, 'read-only.txt');
  fs.writeFileSync(userFile, 'keep', { mode: 0o400 });
  try {
    const result = await diagnoseLocalPath(userFile, { originalErrno: 'EACCES' });
    assert.equal(result.exactFileAccess.observed, true);
    assert.equal(result.exactFileAccess.readable, true);
    assert.equal(result.exactFileAccess.writable, false);
    assert.equal(result.exactFileAccess.writeErrorCode, 'EACCES');
    assert.equal(result.writableProbe.scope, 'same_directory_create');
    assert.equal(result.writableProbe.ok, true);
    assert.equal(fs.readFileSync(userFile, 'utf8'), 'keep');
  } finally {
    fs.chmodSync(userFile, 0o600);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
