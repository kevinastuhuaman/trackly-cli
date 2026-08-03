'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const ERRNO_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;

async function inspectExistingAncestor(exactPath) {
  let candidate = exactPath;
  while (true) {
    try {
      const stats = await fs.stat(candidate);
      return {
        ancestor: candidate,
        exactPathExists: candidate === exactPath,
        exactPathType: candidate === exactPath ? (stats.isDirectory() ? 'directory' : 'file') : null,
        writableDirectory: stats.isDirectory() ? candidate : path.dirname(candidate),
      };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(candidate);
      if (parent === candidate) {
        return { ancestor: parent, exactPathExists: false, exactPathType: null, writableDirectory: parent };
      }
      candidate = parent;
    }
  }
}

function parseFilesystemMountLine(line) {
  const columns = String(line || '').trim().split(/\s+/);
  if (columns.length < 6) return { mountPoint: null, device: null, observed: false };
  return {
    device: columns[0] || null,
    mountPoint: columns.slice(5).join(' ') || null,
    observed: true,
  };
}

async function filesystemMount(target) {
  try {
    const { stdout } = await execFileAsync('df', ['-Pk', target], { encoding: 'utf8' });
    const lines = stdout.trim().split(/\r?\n/);
    return parseFilesystemMountLine(lines.at(-1));
  } catch (_) {
    return { mountPoint: null, device: null, observed: false };
  }
}

async function diagnoseLocalPath(targetPath, options = {}) {
  if (typeof targetPath !== 'string' || targetPath.trim() === '') throw new Error('A non-empty path is required.');
  if (options.originalErrno != null && !ERRNO_PATTERN.test(options.originalErrno)) {
    throw new Error('originalErrno must be an uppercase errno code such as ENOSPC or EACCES.');
  }
  const exactPath = path.resolve(targetPath);
  const inspected = await inspectExistingAncestor(exactPath);
  const mount = await filesystemMount(inspected.ancestor);
  const result = {
    exactPath,
    exists: inspected.exactPathExists,
    pathType: inspected.exactPathType,
    testedAncestor: inspected.ancestor,
    originalErrno: options.originalErrno || null,
    filesystem: {
      ...mount,
      freeBytes: null,
      totalBytes: null,
      availableInodes: null,
      totalInodes: null,
      errorCode: null,
    },
    quota: { observed: false, status: 'not_observable' },
    exactFileAccess: {
      observed: inspected.exactPathType === 'file',
      readable: null,
      writable: null,
      readErrorCode: null,
      writeErrorCode: null,
    },
    writableProbe: {
      ok: false,
      errorCode: null,
      scope: inspected.exactPathType === 'file' ? 'same_directory_create' : 'ancestor_directory_create',
      testedPath: inspected.writableDirectory,
    },
  };

  try {
    const stats = await fs.statfs(inspected.ancestor);
    result.filesystem.freeBytes = Number(stats.bavail) * Number(stats.bsize);
    result.filesystem.totalBytes = Number(stats.blocks) * Number(stats.bsize);
    result.filesystem.availableInodes = stats.ffree === undefined ? null : Number(stats.ffree);
    result.filesystem.totalInodes = stats.files === undefined ? null : Number(stats.files);
  } catch (error) {
    result.filesystem.errorCode = error.code || 'statfs_failed';
  }

  if (inspected.exactPathType === 'file') {
    try {
      await fs.access(exactPath, fs.constants.R_OK);
      result.exactFileAccess.readable = true;
    } catch (error) {
      result.exactFileAccess.readable = false;
      result.exactFileAccess.readErrorCode = error.code || 'exact_file_read_failed';
    }
    try {
      await fs.access(exactPath, fs.constants.W_OK);
      result.exactFileAccess.writable = true;
    } catch (error) {
      result.exactFileAccess.writable = false;
      result.exactFileAccess.writeErrorCode = error.code || 'exact_file_write_failed';
    }
  }

  const probe = path.join(inspected.writableDirectory,
    `.trackly-write-probe-${process.pid}-${crypto.randomBytes(6).toString('hex')}`);
  try {
    const handle = await fs.open(probe, 'wx', 0o600);
    await handle.close();
    await fs.unlink(probe);
    result.writableProbe.ok = true;
  } catch (error) {
    result.writableProbe.errorCode = error.code || 'write_probe_failed';
    try {
      await fs.unlink(probe);
    } catch (cleanupError) {
      if (cleanupError.code !== 'ENOENT') result.writableProbe.cleanupErrorCode = cleanupError.code;
    }
  }
  return result;
}

module.exports = { diagnoseLocalPath, parseFilesystemMountLine, ERRNO_PATTERN };
