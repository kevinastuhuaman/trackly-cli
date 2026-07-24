'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { apiRequest, downloadFile, getConfigPaths, hasAuth, maintenanceOutput } = require('./client');
const { version: PACKAGE_VERSION } = require('../package.json');
const SKILL_VERSION = '4.1.1';
const CLI_USER_AGENT = `trackly-cli/${PACKAGE_VERSION}`;
const MCP_USER_AGENT = `trackly-mcp/${PACKAGE_VERSION}`;

const SKILL_NAME = 'trackly-apply';
const SKILL_MAJOR = Number(SKILL_VERSION.split('.')[0]);
const MIN_APPLY_PROTOCOL_VERSION = '3.1.0';
const CACHE_TTL_MS = 2 * 60 * 60 * 1000;
const MANAGED_FILE = '.trackly-managed.json';
const SKILL_MANIFEST_VERSION = 1;
const RESUME_PROOF_FILE = '.trackly-resume-proof.json';
const RESUME_PROOF_KEY_BYTES = 32;

function bundledSkillDir() {
  return path.join(__dirname, '..', 'skills', SKILL_NAME);
}

function canonicalSkillDir() {
  return path.resolve(getConfigPaths().dir, 'skills', SKILL_NAME);
}

function clientSkillDir(client) {
  if (client === 'codex') {
    return path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'skills', SKILL_NAME);
  }
  if (client === 'claude') {
    return path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'skills', SKILL_NAME);
  }
  throw new Error(`Unsupported agent client: ${client}`);
}

function ensureDir(dir, mode = 0o700) {
  fs.mkdirSync(dir, { recursive: true, mode });
  try { fs.chmodSync(dir, mode); } catch (_) {}
}

function copyDirectory(source, destination) {
  ensureDir(destination, 0o700);
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isDirectory()) copyDirectory(from, to);
    else if (entry.isFile()) fs.copyFileSync(from, to);
  }
}

function skillContentManifest(root) {
  const files = [];

  function collect(directory, relativeDirectory = '') {
    const names = fs.readdirSync(directory).sort();
    for (const name of names) {
      if (!relativeDirectory && name === MANAGED_FILE) continue;
      const absolutePath = path.join(directory, name);
      const relativePath = relativeDirectory ? `${relativeDirectory}/${name}` : name;
      const stat = fs.lstatSync(absolutePath);
      if (stat.isDirectory()) {
        collect(absolutePath, relativePath);
        continue;
      }
      if (!stat.isFile()) {
        throw new Error(`Trackly Apply skill contains an unsupported filesystem entry: ${relativePath}`);
      }
      const content = fs.readFileSync(absolutePath);
      files.push({
        path: relativePath,
        sizeBytes: content.length,
        sha256: crypto.createHash('sha256').update(content).digest('hex'),
      });
    }
  }

  collect(root);
  const digest = crypto.createHash('sha256')
    .update(JSON.stringify({ version: SKILL_MANIFEST_VERSION, files }))
    .digest('hex');
  return {
    version: SKILL_MANIFEST_VERSION,
    digest,
    fileCount: files.length,
  };
}

function managedMetadata(extra = {}) {
  return JSON.stringify({ managedBy: 'trackly-cli', skill: SKILL_NAME, skillVersion: SKILL_VERSION, ...extra }, null, 2);
}

function isManagedDirectory(target) {
  return managedSkillMetadata(target) !== null;
}

function managedSkillMetadata(target) {
  try {
    const metadata = JSON.parse(fs.readFileSync(path.join(target, MANAGED_FILE), 'utf8'));
    return metadata.managedBy === 'trackly-cli' && metadata.skill === SKILL_NAME ? metadata : null;
  } catch (_) {
    return null;
  }
}

function installCanonicalSkill() {
  const source = bundledSkillDir();
  if (!fs.existsSync(path.join(source, 'SKILL.md'))) {
    throw new Error('The npm package does not contain the Trackly Apply skill. Reinstall trackly-cli.');
  }
  const destination = canonicalSkillDir();
  const parent = path.dirname(destination);
  ensureDir(parent, 0o700);
  const staging = `${destination}.staging.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
  try {
    copyDirectory(source, staging);
    const manifest = skillContentManifest(staging);
    fs.writeFileSync(path.join(staging, MANAGED_FILE), managedMetadata({
      skillManifestVersion: manifest.version,
      skillContentDigest: manifest.digest,
      skillFileCount: manifest.fileCount,
    }), { mode: 0o600 });
  } catch (error) {
    if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true, force: true });
    throw error;
  }

  if (fs.existsSync(destination)) {
    try {
      const stat = fs.lstatSync(destination);
      if (!stat.isDirectory() || !isManagedDirectory(destination)) {
        fs.rmSync(staging, { recursive: true, force: true });
        throw new Error(`Refusing to overwrite unmanaged skill at ${destination}`);
      }
      const previous = `${destination}.previous.${process.pid}`;
      fs.renameSync(destination, previous);
      try {
        fs.renameSync(staging, destination);
        fs.rmSync(previous, { recursive: true, force: true });
      } catch (error) {
        if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true, force: true });
        if (!fs.existsSync(destination)) fs.renameSync(previous, destination);
        throw error;
      }
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        try {
          fs.renameSync(staging, destination);
        } catch (renameError) {
          if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true, force: true });
          throw renameError;
        }
      } else {
        if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true, force: true });
        throw error;
      }
    }
  } else {
    try {
      fs.renameSync(staging, destination);
    } catch (error) {
      if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true, force: true });
      throw error;
    }
  }
  return destination;
}

function linkClientSkill(client, canonical) {
  const target = clientSkillDir(client);
  ensureDir(path.dirname(target), 0o700);
  let backup = null;
  try {
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink() && path.resolve(path.dirname(target), fs.readlinkSync(target)) === canonical) {
      return { client, target, method: 'symlink', status: 'current' };
    }
    if (!isManagedDirectory(target)) {
      throw new Error(`Refusing to overwrite unmanaged skill at ${target}`);
    }
    backup = `${target}.previous.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
    fs.renameSync(target, backup);
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error;
  }

  try {
    fs.symlinkSync(canonical, target, 'dir');
    if (backup) fs.rmSync(backup, { recursive: true, force: true });
    return { client, target, method: 'symlink', status: 'installed' };
  } catch (error) {
    if (!['EPERM', 'EACCES', 'ENOTSUP', 'EINVAL'].includes(error.code)) {
      if (backup && !fs.existsSync(target)) fs.renameSync(backup, target);
      throw error;
    }
    const staging = `${target}.staging.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
    try {
      copyDirectory(canonical, staging);
      const manifest = skillContentManifest(staging);
      fs.writeFileSync(path.join(staging, MANAGED_FILE), managedMetadata({
        copiedFrom: canonical,
        skillManifestVersion: manifest.version,
        skillContentDigest: manifest.digest,
        skillFileCount: manifest.fileCount,
      }), { mode: 0o600 });
      fs.renameSync(staging, target);
      if (backup) fs.rmSync(backup, { recursive: true, force: true });
      return { client, target, method: 'copy', status: 'installed' };
    } catch (copyError) {
      if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true, force: true });
      if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
      if (backup) fs.renameSync(backup, target);
      throw copyError;
    }
  }
}

function normalizeClients(client) {
  if (client === 'both') return ['codex', 'claude'];
  if (client === 'codex' || client === 'claude') return [client];
  throw new Error('Use --client codex, claude, or both.');
}

function codexMcpRegistration(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (_) { return 'missing'; }
  const header = /^\s*\[mcp_servers\.trackly\]\s*(?:#.*)?$/m;
  const match = header.exec(text);
  if (!match) return 'missing';
  const bodyStart = match.index + match[0].length;
  const remainder = text.slice(bodyStart);
  const nextTable = remainder.search(/^\s*\[/m);
  const body = nextTable === -1 ? remainder : remainder.slice(0, nextTable);
  const commandMatches = /^\s*command\s*=\s*["']trackly["']\s*(?:#.*)?$/m.test(body);
  const argsMatches = /^\s*args\s*=\s*\[\s*["']mcp["']\s*\]\s*(?:#.*)?$/m.test(body);
  return commandMatches && argsMatches ? 'current' : 'stale';
}

function claudeMcpRegistration(files) {
  let found = false;
  for (const file of files) {
    try {
      const config = JSON.parse(fs.readFileSync(file, 'utf8'));
      const entry = config?.mcpServers?.trackly;
      if (!entry) continue;
      found = true;
      if (entry.command === 'trackly' && Array.isArray(entry.args)
          && entry.args.length === 1 && entry.args[0] === 'mcp') {
        return 'current';
      }
    } catch (_) {}
  }
  return found ? 'stale' : 'missing';
}

function mcpRegistrationState(client) {
  const claudeConfigFiles = process.env.CLAUDE_CONFIG_DIR
    ? [path.join(process.env.CLAUDE_CONFIG_DIR, 'settings.json'), path.join(process.env.CLAUDE_CONFIG_DIR, '.claude.json')]
    : [path.join(os.homedir(), '.claude.json'), path.join(os.homedir(), '.claude', 'settings.json')];
  return client === 'codex'
    ? codexMcpRegistration(path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'config.toml'))
    : claudeMcpRegistration(claudeConfigFiles);
}

function isMissingMcpRegistrationError(result) {
  const output = `${result.stderr || ''}\n${result.stdout || ''}`;
  const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines.length === 1
    && /^no mcp server named ["']?trackly["']? in user scope\.?$/i.test(lines[0]);
}

function registerMcp(client) {
  const executable = client === 'codex' ? 'codex' : 'claude';
  if (!commandExists(executable)) return { status: 'missing_client', error: `${executable} is not installed` };
  const registration = mcpRegistrationState(client);
  if (registration === 'current') return { status: 'current' };
  if (registration === 'stale') {
    const removeArgs = client === 'codex'
      ? ['mcp', 'remove', 'trackly']
      : ['mcp', 'remove', '--scope', 'user', 'trackly'];
    const removed = spawnSync(executable, removeArgs, { encoding: 'utf8' });
    const alreadyMissing = client === 'claude' && isMissingMcpRegistrationError(removed);
    if (removed.status !== 0 && !alreadyMissing) {
      return { status: 'failed', error: (removed.stderr || removed.stdout || 'Unable to replace stale MCP registration').trim() };
    }
  }
  const args = client === 'codex'
    ? ['mcp', 'add', 'trackly', '--', 'trackly', 'mcp']
    : ['mcp', 'add', '--scope', 'user', 'trackly', '--', 'trackly', 'mcp'];
  const result = spawnSync(executable, args, { encoding: 'utf8' });
  if (result.status !== 0) {
    return { status: 'failed', error: (result.stderr || result.stdout || 'MCP registration failed').trim() };
  }
  return { status: 'installed' };
}

function setupAgent(client) {
  const canonical = installCanonicalSkill();
  const clients = normalizeClients(client).map((name) => ({
    ...linkClientSkill(name, canonical),
    mcp: registerMcp(name),
  }));
  return {
    skillVersion: SKILL_VERSION,
    canonical,
    clients,
  };
}

function commandExists(command) {
  if (command !== 'codex' && command !== 'claude') return false;
  return String(process.env.PATH || '')
    .split(path.delimiter)
    .filter(Boolean)
    .some((directory) => {
      try {
        fs.accessSync(path.join(directory, command), fs.constants.X_OK);
        return true;
      } catch {
        return false;
      }
    });
}

function inspectClient(client) {
  const target = clientSkillDir(client);
  const executable = commandExists(client === 'codex' ? 'codex' : 'claude');
  const metadata = managedSkillMetadata(target);
  let expectedManifest = null;
  let installedManifest = null;
  try {
    expectedManifest = skillContentManifest(bundledSkillDir());
    installedManifest = skillContentManifest(target);
  } catch (_) {}
  const hasRecordedManifest = metadata?.skillManifestVersion === SKILL_MANIFEST_VERSION
    && typeof metadata?.skillContentDigest === 'string'
    && Number.isInteger(metadata?.skillFileCount);
  const contentMatches = hasRecordedManifest
    && expectedManifest !== null
    && installedManifest !== null
    && metadata.skillContentDigest === expectedManifest.digest
    && metadata.skillContentDigest === installedManifest.digest
    && metadata.skillFileCount === expectedManifest.fileCount
    && metadata.skillFileCount === installedManifest.fileCount;
  const skillIntegrity = contentMatches
    ? 'verified'
    : metadata && !hasRecordedManifest
      ? 'manifest_missing'
      : metadata
        ? 'content_mismatch'
        : 'not_managed';
  const installed = fs.existsSync(path.join(target, 'SKILL.md'))
    && metadata?.skillVersion === SKILL_VERSION
    && skillIntegrity === 'verified';
  const mcpRegistration = mcpRegistrationState(client);
  const mcpRegistered = mcpRegistration === 'current';
  return {
    client,
    executable,
    installed,
    installedSkillVersion: metadata?.skillVersion || null,
    skillIntegrity,
    expectedSkillContentDigest: expectedManifest?.digest || null,
    installedSkillContentDigest: installedManifest?.digest || null,
    recordedSkillContentDigest: metadata?.skillContentDigest || null,
    mcpRegistered,
    mcpRegistration,
    target,
  };
}

function cacheDir() {
  return path.resolve(getConfigPaths().dir, 'cache', 'resumes');
}

function cleanResumeCache(now = Date.now()) {
  const dir = cacheDir();
  if (!fs.existsSync(dir)) return { removed: 0, directory: dir };
  let removed = 0;

  function ignoreConcurrentRemoval(error, codes = ['ENOENT']) {
    if (codes.includes(error?.code)) return true;
    throw error;
  }

  function cleanDirectory(current, removeWhenExpired = false) {
    let directoryStat;
    try {
      directoryStat = fs.lstatSync(current);
    } catch (error) {
      if (ignoreConcurrentRemoval(error)) return;
    }
    if (!directoryStat.isDirectory()) return;
    const directoryExpired = removeWhenExpired && now - directoryStat.mtimeMs > CACHE_TTL_MS;
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (error) {
      if (ignoreConcurrentRemoval(error)) return;
    }
    for (const entry of entries) {
      const item = path.join(current, entry.name);
      if (entry.isDirectory()) {
        cleanDirectory(item, true);
        continue;
      }
      if (!entry.isFile()) continue;
      let stat;
      try {
        stat = fs.lstatSync(item);
      } catch (error) {
        if (ignoreConcurrentRemoval(error)) continue;
      }
      if (!stat.isFile()) continue;
      if (now - stat.mtimeMs > CACHE_TTL_MS) {
        try {
          fs.rmSync(item, { force: true });
          removed++;
        } catch (error) {
          if (!ignoreConcurrentRemoval(error)) throw error;
        }
      }
    }
    if (!directoryExpired) return;
    try {
      if (fs.readdirSync(current).length === 0) fs.rmdirSync(current);
    } catch (error) {
      ignoreConcurrentRemoval(error, ['ENOENT', 'ENOTEMPTY']);
    }
  }

  cleanDirectory(dir);
  return { removed, directory: dir };
}

function safeResumeName(fileName, contentType) {
  const extension = contentType === 'application/pdf' ? '.pdf' : '.docx';
  const value = fileName == null || fileName === '' ? `resume${extension}` : String(fileName);
  const invalid = value === '.'
    || value === '..'
    || value !== value.trim()
    || /[\\/\0-\x1f\x7f]/.test(value)
    || Buffer.byteLength(value, 'utf8') > 240
    || !value.toLowerCase().endsWith(extension);
  if (invalid) throw new Error('Trackly returned an unsafe or incompatible resume filename. Update the default resume and try again.');
  return value;
}

function resumeCacheName(fileName, contentType, now = Date.now(), nonce = crypto.randomBytes(4).toString('hex')) {
  return path.join(`${now}-${nonce}`, safeResumeName(fileName, contentType));
}

function resumeConfirmation(fileName, sha256, sizeBytes, exactLocalPath, runId, expiresAt, confirmationId) {
  return {
    required: true,
    source: 'trackly_default_resume',
    runId,
    confirmationId,
    fileName,
    sha256,
    sizeBytes,
    expiresAt,
    verification: {
      preferred: 'local_preview',
      exactLocalPath,
      displayExactPathRequired: true,
    },
  };
}

function resumeProofKey() {
  const configDir = path.resolve(getConfigPaths().dir);
  ensureDir(configDir, 0o700);
  const keyPath = path.join(configDir, 'resume-proof.key');

  function readExistingKey() {
    const stat = fs.lstatSync(keyPath);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
      throw new Error('The Trackly resume-proof key is not a private regular file.');
    }
    const key = fs.readFileSync(keyPath);
    if (key.length !== RESUME_PROOF_KEY_BYTES) throw new Error('The Trackly resume-proof key is invalid.');
    return key;
  }

  try {
    return readExistingKey();
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  const candidate = crypto.randomBytes(RESUME_PROOF_KEY_BYTES);
  try {
    fs.writeFileSync(keyPath, candidate, { mode: 0o600, flag: 'wx' });
    fs.chmodSync(keyPath, 0o600);
    return candidate;
  } catch (error) {
    candidate.fill(0);
    if (error?.code !== 'EEXIST') throw error;
    return readExistingKey();
  }
}

function signedResumeProof(record) {
  const payload = JSON.stringify(record);
  const key = resumeProofKey();
  try {
    return {
      ...record,
      signature: crypto.createHmac('sha256', key).update(payload).digest('hex'),
    };
  } finally {
    key.fill(0);
  }
}

function verifyResumeProofSignature(manifest) {
  const { signature, ...record } = manifest || {};
  if (!/^[a-f0-9]{64}$/i.test(signature || '')) throw new Error('The prepared resume proof is invalid. Prepare and confirm it again.');
  const key = resumeProofKey();
  try {
    const expected = crypto.createHmac('sha256', key).update(JSON.stringify(record)).digest();
    if (!crypto.timingSafeEqual(expected, Buffer.from(signature, 'hex'))) {
      throw new Error('The prepared resume proof is invalid. Prepare and confirm it again.');
    }
  } finally {
    key.fill(0);
  }
  return record;
}

function materializeResume(download, options = {}) {
  const runId = Number(options.runId);
  if (!Number.isInteger(runId) || runId < 1) throw new Error('A valid Trackly Apply run ID is required before preparing a resume.');
  const now = options.now ?? Date.now();
  const nonce = options.nonce ?? crypto.randomBytes(4).toString('hex');
  const confirmationId = options.confirmationId ?? crypto.randomUUID();
  const validated = validateResumeFile(download);
  const dir = cacheDir();
  ensureDir(dir, 0o700);
  const name = resumeCacheName(download.fileName, validated.contentType, now, nonce);
  const destination = path.join(dir, name);
  ensureDir(path.dirname(destination), 0o700);
  fs.writeFileSync(destination, download.buffer, { mode: 0o600, flag: 'wx' });
  try { fs.chmodSync(destination, 0o600); } catch (_) {}
  const fileName = path.basename(destination);
  const expiresAt = new Date(now + CACHE_TTL_MS).toISOString();
  const confirmation = resumeConfirmation(
    fileName,
    validated.digest,
    download.buffer.length,
    destination,
    runId,
    expiresAt,
    confirmationId,
  );
  const manifestPath = path.join(path.dirname(destination), RESUME_PROOF_FILE);
  try {
    const manifest = signedResumeProof({
      runId,
      confirmationId,
      exactLocalPath: destination,
      fileName,
      sha256: validated.digest,
      sizeBytes: download.buffer.length,
      expiresAt,
    });
    fs.writeFileSync(manifestPath, JSON.stringify(manifest), { mode: 0o400, flag: 'wx' });
    fs.chmodSync(manifestPath, 0o400);
  } catch (error) {
    fs.rmSync(destination, { force: true });
    try { fs.rmdirSync(path.dirname(destination)); } catch (cleanupError) {
      if (!['ENOENT', 'ENOTEMPTY'].includes(cleanupError?.code)) throw cleanupError;
    }
    throw error;
  }
  return {
    path: destination,
    fileName,
    contentType: validated.contentType,
    sha256: validated.digest,
    sizeBytes: download.buffer.length,
    expiresAt,
    confirmation,
  };
}

function verifyPreparedResume(proof, now = Date.now()) {
  const runId = Number(proof?.runId);
  if (!Number.isInteger(runId) || runId < 1) throw new Error('A valid Trackly Apply run ID is required to verify a prepared resume.');
  if (!proof?.confirmationId || typeof proof.confirmationId !== 'string') throw new Error('The prepared resume confirmation ID is required.');
  if (!/^[a-f0-9]{64}$/i.test(proof?.sha256 || '')) throw new Error('The prepared resume SHA-256 is invalid.');
  if (!Number.isInteger(proof?.sizeBytes) || proof.sizeBytes < 1) throw new Error('The prepared resume size is invalid.');
  const expiresAtMs = Date.parse(proof?.expiresAt || '');
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= now) throw new Error('The prepared resume confirmation expired. Prepare and confirm the resume again.');

  const expectedPath = path.resolve(String(proof?.exactLocalPath || ''));
  const cacheRoot = path.resolve(cacheDir());
  if (!expectedPath.startsWith(`${cacheRoot}${path.sep}`)) throw new Error('The prepared resume path is outside the private Trackly cache.');

  let realPath;
  try {
    realPath = fs.realpathSync(expectedPath);
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error('The prepared resume no longer exists. Prepare and confirm the resume again.');
    throw error;
  }
  const realCacheRoot = fs.realpathSync(cacheRoot);
  if (!realPath.startsWith(`${realCacheRoot}${path.sep}`)) throw new Error('The prepared resume resolves outside the private Trackly cache.');

  let manifest;
  try {
    const manifestPath = path.join(path.dirname(expectedPath), RESUME_PROOF_FILE);
    const manifestStat = fs.lstatSync(manifestPath);
    if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || (manifestStat.mode & 0o077) !== 0) {
      throw new Error('The prepared resume proof is not private. Prepare and confirm it again.');
    }
    manifest = verifyResumeProofSignature(JSON.parse(fs.readFileSync(manifestPath, 'utf8')));
  } catch (error) {
    if (error instanceof SyntaxError || error?.code === 'ENOENT') {
      throw new Error('The prepared resume proof is missing or invalid. Prepare and confirm it again.');
    }
    throw error;
  }

  const bindingMatches = manifest.runId === runId
    && manifest.confirmationId === proof.confirmationId
    && manifest.exactLocalPath === expectedPath
    && manifest.fileName === path.basename(expectedPath)
    && manifest.sha256 === proof.sha256
    && manifest.sizeBytes === proof.sizeBytes
    && manifest.expiresAt === proof.expiresAt;
  if (!bindingMatches) throw new Error('The prepared resume proof does not match the confirmed run and file. Prepare and confirm it again.');

  let stat;
  try {
    stat = fs.lstatSync(expectedPath);
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error('The prepared resume no longer exists. Prepare and confirm the resume again.');
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('The prepared resume is not a regular private cache file.');
  if ((stat.mode & 0o077) !== 0) throw new Error('The prepared resume permissions are not private.');
  if (stat.size !== proof.sizeBytes) throw new Error('The prepared resume size changed after confirmation. Prepare and confirm it again.');

  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(expectedPath)).digest('hex');
  if (!crypto.timingSafeEqual(Buffer.from(sha256, 'hex'), Buffer.from(proof.sha256, 'hex'))) {
    throw new Error('The prepared resume contents changed after confirmation. Prepare and confirm it again.');
  }

  fs.chmodSync(expectedPath, 0o400);
  return {
    verified: true,
    runId,
    confirmationId: proof.confirmationId,
    exactLocalPath: expectedPath,
    sha256,
    sizeBytes: stat.size,
    expiresAt: new Date(expiresAtMs).toISOString(),
    permissions: '400',
  };
}

function validateResumeFile(download) {
  const digest = crypto.createHash('sha256').update(download.buffer).digest('hex');
  if (download.sha256 && String(download.sha256).toLowerCase() !== digest) {
    throw new Error('Downloaded resume failed its SHA-256 integrity check.');
  }
  const isPdf = download.buffer.subarray(0, 5).toString() === '%PDF-';
  const isZip = download.buffer[0] === 0x50 && download.buffer[1] === 0x4b;
  const hasContentTypes = download.buffer.includes(Buffer.from('[Content_Types].xml'));
  const hasWordDocument = download.buffer.includes(Buffer.from('word/document.xml'));
  const isDocx = isZip && hasContentTypes && hasWordDocument;
  if (!isPdf && !isDocx) throw new Error(`Unsupported or invalid resume type: ${download.contentType}`);
  return {
    digest,
    contentType: isPdf
      ? 'application/pdf'
      : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  };
}

async function prepareResume(runId, browserSurface, browserBindingHash, userAgent = MCP_USER_AGENT) {
  if (!hasAuth()) throw new Error('Authenticate first with `trackly login` or `trackly config --api-key ...`.');
  const normalizedRunId = Number(runId);
  if (!Number.isInteger(normalizedRunId) || normalizedRunId < 1) {
    throw new Error('A valid Trackly Apply run ID is required before preparing a resume.');
  }
  if (!['codex_in_app', 'chrome_extension', 'claude_in_chrome'].includes(browserSurface)) {
    throw new Error('A supported semantic browser surface is required before preparing a resume.');
  }
  if (!/^[a-f0-9]{64}$/.test(String(browserBindingHash || ''))) {
    throw new Error('A lowercase SHA-256 browser binding is required before preparing a resume.');
  }
  cleanResumeCache();
  const download = await downloadFile(
    `/api/jobscout/application-profile/default-resume?runId=${normalizedRunId}`
      + `&browserSurface=${encodeURIComponent(browserSurface)}`
      + `&browserBindingHash=${browserBindingHash}`,
    userAgent,
  );
  try {
    if (Number(download.applyRunId) !== normalizedRunId) {
      throw new Error('Trackly did not confirm that the resume belongs to the active Apply run.');
    }
    return materializeResume(download, { runId: normalizedRunId });
  } finally {
    download.buffer.fill(0);
  }
}

function protocolAtLeast(version, minimum = MIN_APPLY_PROTOCOL_VERSION) {
  const parse = (value) => String(value || '').split('.').map((part) => Number(part));
  const actual = parse(version);
  const required = parse(minimum);
  if (
    actual.length < 2
    || required.length < 2
    || actual.some((part) => !Number.isInteger(part) || part < 0)
    || required.some((part) => !Number.isInteger(part) || part < 0)
  ) return false;
  for (let index = 0; index < Math.max(actual.length, required.length); index++) {
    const left = actual[index] || 0;
    const right = required[index] || 0;
    if (left !== right) return left > right;
  }
  return true;
}

function evaluateApplyCompatibility(protocol, clients) {
  const compatibleSkillMajor = Number(protocol?.compatibleSkillMajor);
  const minimumSkillVersion = typeof protocol?.compatibleSkillMinimumVersion === 'string'
    ? protocol.compatibleSkillMinimumVersion
    : null;
  const protocolCompatible = compatibleSkillMajor === SKILL_MAJOR
    && protocolAtLeast(protocol?.version, MIN_APPLY_PROTOCOL_VERSION);
  const compatibleClientSkills = minimumSkillVersion
    ? clients
      .filter((client) => {
        const installedMajor = Number(String(client.installedSkillVersion || '').split('.')[0]);
        return client.installed === true
          && installedMajor === compatibleSkillMajor
          && protocolAtLeast(client.installedSkillVersion, minimumSkillVersion);
      })
      .map((client) => client.client)
    : [];
  const skillMinimumSatisfied = compatibleClientSkills.length > 0;
  return {
    protocolCompatible,
    minimumSkillVersion,
    compatibleClientSkills,
    skillMinimumSatisfied,
    compatible: protocolCompatible && skillMinimumSatisfied,
  };
}

function liveBrowserReady(browserControl) {
  return (browserControl?.codex === true && browserControl?.codexComputerUse === true)
    || browserControl?.claude === true;
}

async function doctorAgent() {
  const cache = cleanResumeCache();
  const codexBrowser = fs.existsSync(path.join(os.homedir(), '.codex', 'plugins', 'cache', 'openai-bundled', 'chrome'));
  const codexComputerUse = fs.existsSync(path.join(os.homedir(), '.codex', 'plugins', 'cache', 'openai-bundled', 'computer-use'));
  const browserControl = {
    codex: codexBrowser,
    codexComputerUse,
    claude: null,
  };
  const tabInventory = {
    controllerOwnedTabs: 'runtime_verification_required',
    userOwnedTabs: 'runtime_verification_required',
    unionReconciliation: 'runtime_verification_required',
    detectedSurfaces: [],
    unionInventoryDetected: false,
    requiredForClosedClaim: true,
    note: 'Installed plugins do not prove controller-owned and user-owned tab union inventory. The active browser client must verify both inventories before claiming a tab is closed.',
  };
  const clients = ['codex', 'claude'].map(inspectClient);
  const skillIntegrityFailures = clients
    .filter((client) => (
      client.installedSkillVersion === SKILL_VERSION
      && client.skillIntegrity !== 'verified'
    ))
    .map((client) => ({ client: client.client, integrity: client.skillIntegrity }));
  const report = {
    skillVersion: SKILL_VERSION,
    authenticated: hasAuth(),
    clients,
    skillPackIntegrity: {
      ok: skillIntegrityFailures.length === 0,
      failures: skillIntegrityFailures,
    },
    browserControl: {
      ...browserControl,
      semanticReady: liveBrowserReady(browserControl),
      tabInventory,
      note: 'A live run requires both semantic browser control and computer use. Claude capability must be verified by the active client before the run starts.',
    },
    cache,
    protocol: null,
    profile: null,
    resume: { available: false },
    compatible: false,
    ok: false,
  };
  if (!report.authenticated) return report;
  try {
    const [protocol, profile] = await Promise.all([
      apiRequest('GET', '/api/jobscout/apply/protocol'),
      apiRequest('GET', '/api/jobscout/application-profile'),
    ]);
    report.protocol = protocol.protocol || protocol;
    report.profile = {
      revision: profile.profile?.revision,
      completeness: profile.profile?.completeness,
      hasDefaultResume: Boolean(profile.profile?.defaultResume),
    };
    report.compatibility = evaluateApplyCompatibility(report.protocol, report.clients);
    report.compatible = report.compatibility.compatible;
    if (report.profile.hasDefaultResume) {
      report.resume = {
        available: true,
        fileName: profile.profile.defaultResume.fileName || null,
        validation: 'Exact bytes are prepared and verified only after a real Apply run starts.',
      };
    }
  } catch (error) {
    report.apiError = maintenanceOutput(error) || error.error || error.message || String(error);
  }
  report.ok = report.authenticated
    && report.compatible
    && report.browserControl.semanticReady
    && report.skillPackIntegrity.ok
    && report.clients.some((client) => client.executable && client.installed && client.mcpRegistered)
    && Boolean(report.profile?.hasDefaultResume)
    && report.resume.available
    && report.profile?.completeness?.missingKeys?.length === 0;
  return report;
}

function resumeValidationStatus(report) {
  if (!report?.profile?.hasDefaultResume) return 'not applicable (no default resume set)';
  return report.resume?.available
    ? 'available (exact bytes are verified during an active Apply run)'
    : 'failed';
}

module.exports = {
  CACHE_TTL_MS,
  CLI_USER_AGENT,
  MCP_USER_AGENT,
  SKILL_MAJOR,
  MIN_APPLY_PROTOCOL_VERSION,
  SKILL_NAME,
  bundledSkillDir,
  cacheDir,
  canonicalSkillDir,
  cleanResumeCache,
  clientSkillDir,
  doctorAgent,
  evaluateApplyCompatibility,
  inspectClient,
  liveBrowserReady,
  materializeResume,
  prepareResume,
  protocolAtLeast,
  resumeConfirmation,
  resumeCacheName,
  resumeValidationStatus,
  setupAgent,
  validateResumeFile,
  verifyPreparedResume,
};
