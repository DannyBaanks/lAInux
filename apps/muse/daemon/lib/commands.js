'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { ActionRequest, canonicalJson, sha256 } = require('./security');
const { WorkspaceAuthority, WorkspaceAuthorityError, ActionApprovalStore } = require('./workspace-authority');
const { ActionGate } = require('./action-gate');

// Registered execution owner per action (checked by the ExecutionOwner
// Check): a request built for one owner cannot run through another.
const OWNERS = Object.freeze({
  'node.ping': 'muse-node.system',
  'node.system.which': 'muse-node.system',
  'workspace.files.list': 'muse-node.files',
  'workspace.files.read': 'muse-node.files',
  'workspace.files.search': 'muse-node.files',
  'workspace.files.write': 'muse-node.files',
  'workspace.command.run': 'muse-node.shell',
});

const IMAGE_TYPES = new Map([
  ['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'], ['.webp', 'image/webp'],
]);
const PROTECTED_PARTS = new Set(['.ssh', '.gnupg', '.aws', '.password-store']);
const LIST_PARAMS = new Set(['path', 'sort', 'limit', 'offset']);

function schema(description, { required = {}, optional = {}, permissions = [], datatype = 'application/json', timeoutMs = 10000 } = {}) {
  return {
    description,
    required,
    optional,
    permission_required: permissions,
    datatype,
    timeout_ms: timeoutMs,
  };
}

function string(description) { return { type: 'string', description }; }
function integer(description) { return { type: 'integer', description }; }
function boolean(description) { return { type: 'boolean', description }; }

function expandPath(input) {
  if (typeof input !== 'string' || !input.trim()) throw Object.assign(new Error('path is required'), { code: 'invalid_argument' });
  const expanded = input.startsWith('~/') ? path.join(os.homedir(), input.slice(2)) : input === '~' ? os.homedir() : input;
  const resolved = path.resolve(expanded);
  const parts = resolved.split(path.sep);
  if (parts.some((part) => PROTECTED_PARTS.has(part)) || resolved.includes('/.config/muse-desktop') || resolved.includes('/.Trash')) {
    throw Object.assign(new Error('Credential, Trash and Muse credential-store paths are rejected'), { code: 'permission_denied' });
  }
  return resolved;
}

function assertParams(params, allowed) {
  for (const key of Object.keys(params)) {
    if (!allowed.has(key)) throw Object.assign(new Error(`Unknown parameter: ${key}`), { code: 'invalid_argument' });
  }
}

function boundedInteger(value, fallback, minimum, maximum, name) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw Object.assign(new Error(`${name} must be an integer in ${minimum}...${maximum}`), { code: 'invalid_argument' });
  }
  return value;
}

function entryInfo(fullPath, stat) {
  return {
    name: path.basename(fullPath),
    path: fullPath,
    kind: stat.isDirectory() ? 'folder' : 'file',
    size: stat.isDirectory() ? 0 : stat.size,
    modified_at: stat.mtime.toISOString(),
    created_at: stat.birthtime.toISOString(),
  };
}

function sortEntries(entries, sort) {
  const compare = {
    size_desc: (a, b) => b.size - a.size,
    size_asc: (a, b) => a.size - b.size,
    modified_desc: (a, b) => b.modified_at.localeCompare(a.modified_at),
    modified_asc: (a, b) => a.modified_at.localeCompare(b.modified_at),
    created_desc: (a, b) => b.created_at.localeCompare(a.created_at),
    created_asc: (a, b) => a.created_at.localeCompare(b.created_at),
    name: (a, b) => a.name.localeCompare(b.name),
    name_desc: (a, b) => b.name.localeCompare(a.name),
  }[sort];
  if (!compare) throw Object.assign(new Error(`Invalid sort: ${sort}`), { code: 'invalid_argument' });
  entries.sort((a, b) => compare(a, b) || a.path.localeCompare(b.path));
}

function page(entries, offset, limit, partial = false) {
  const items = entries.slice(offset, offset + limit);
  const nextOffset = offset + items.length < entries.length ? offset + items.length : null;
  return {
    ok: true,
    entries: items,
    entry_count: items.length,
    total_count: entries.length,
    offset,
    next_offset: nextOffset,
    partial,
  };
}

function listFiles(params) {
  assertParams(params, LIST_PARAMS);
  const root = expandPath(params.path ?? '~');
  const sort = params.sort ?? 'size_desc';
  const limit = boundedInteger(params.limit, 20, 1, 200, 'limit');
  const offset = boundedInteger(params.offset, 0, 0, 999, 'offset');
  const stat = fs.statSync(root);
  if (!stat.isDirectory()) throw Object.assign(new Error('path is not a folder'), { code: 'not_a_folder' });
  const entries = [];
  let partial = false;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    try { entries.push(entryInfo(fullPath, fs.statSync(fullPath))); }
    catch { partial = true; }
  }
  sortEntries(entries, sort);
  return { ...page(entries, offset, limit, partial), path: root, sort };
}

function globMatch(name, query) {
  if (!query) return true;
  if (!query.includes('*') && !query.includes('?')) return name.toLowerCase().includes(query.toLowerCase());
  const escaped = query.replace(/[.+^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*').replaceAll('?', '.');
  return new RegExp(`^${escaped}$`, 'i').test(name);
}

function searchFiles(params) {
  const root = expandPath(params.path ?? '~');
  const query = params.query ?? '';
  const recursive = params.recursive ?? true;
  const kind = params.kind ?? 'any';
  const extension = params.extension?.replace(/^\./, '').toLowerCase();
  const sort = params.sort ?? 'modified_desc';
  const limit = boundedInteger(params.limit, 50, 1, 200, 'limit');
  const offset = boundedInteger(params.offset, 0, 0, 999, 'offset');
  const entries = [];
  const deadline = Date.now() + 6000;
  let scanned = 0;
  let partial = false;
  function visit(folder) {
    if (partial || Date.now() >= deadline || scanned >= 100000) { partial = true; return; }
    let children;
    try { children = fs.readdirSync(folder, { withFileTypes: true }); }
    catch { partial = true; return; }
    for (const child of children) {
      if (child.name.startsWith('.')) continue;
      const fullPath = path.join(folder, child.name);
      if (fullPath.includes('/.config/muse-desktop') || fullPath.includes('/.Trash')) continue;
      scanned += 1;
      let stat;
      try { stat = fs.statSync(fullPath); } catch { partial = true; continue; }
      // Recurse only into real folders: a symlinked folder may point outside
      // the granted path (e.g. at ~/.ssh).
      const isFolder = stat.isDirectory() && !child.isSymbolicLink();
      const matches = globMatch(child.name, query)
        && (kind === 'any' || (kind === 'folder' ? isFolder : !isFolder))
        && (!extension || (!isFolder && path.extname(child.name).slice(1).toLowerCase() === extension));
      if (matches) entries.push(entryInfo(fullPath, stat));
      if (entries.length >= 1000) { partial = true; return; }
      if (recursive && isFolder) visit(fullPath);
      if (partial) return;
    }
  }
  visit(root);
  sortEntries(entries, sort);
  return {
    ...page(entries, offset, limit, partial),
    path: root,
    query,
    recursive,
    scanned_count: scanned,
    ...(partial ? { partial_reason: 'scan_limit_or_metadata' } : {}),
  };
}

function readFile(params) {
  const filePath = expandPath(params.path);
  const offset = boundedInteger(params.offset, 1, 1, 1000000000, 'offset');
  const limit = boundedInteger(params.limit, 2000, 1, 10000, 'limit');
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) throw Object.assign(new Error('path is not a regular file'), { code: 'not_a_file' });
  const mime = IMAGE_TYPES.get(path.extname(filePath).toLowerCase());
  if (mime) {
    if (stat.size > 3 * 1024 * 1024) throw Object.assign(new Error('Image exceeds 3 MB; use files.upload'), { code: 'file_too_large' });
    return { ok: true, path: filePath, file: { name: path.basename(filePath), mime_type: mime, data_base64: fs.readFileSync(filePath).toString('base64') } };
  }
  const content = fs.readFileSync(filePath, 'utf8');
  if (content.includes('\0')) throw Object.assign(new Error('Binary files require files.upload'), { code: 'binary_file' });
  const lines = content.split('\n');
  const selected = lines.slice(offset - 1, offset - 1 + limit);
  let text = selected.join('\n');
  let truncatedReason = null;
  if (text.length > 1024 * 1024) {
    text = text.slice(0, 1024 * 1024);
    truncatedReason = 'size_cap';
  }
  const consumed = offset - 1 + selected.length;
  const eof = consumed >= lines.length && truncatedReason === null;
  return {
    ok: true,
    path: filePath,
    content: text,
    offset,
    line_count: selected.length,
    next_offset: eof ? null : consumed + 1,
    eof,
    truncated: !eof,
    ...(truncatedReason ? { truncated_reason: truncatedReason } : {}),
  };
}

// Snapshot of a target taken when the request is built. It is part of the
// approved digest; the owner re-takes it right before the effect and refuses
// if the file changed between approval and execution.
function fingerprint(target) {
  let info;
  try { info = fs.lstatSync(target); } catch (error) { if (error.code === 'ENOENT') return { exists: false }; throw error; }
  const snapshot = { exists: true, kind: info.isDirectory() ? 'folder' : info.isFile() ? 'file' : 'other', size: info.size, mtime_ms: Math.trunc(info.mtimeMs) };
  if (info.isFile() && info.size <= 8 * 1024 * 1024) snapshot.sha256 = sha256(fs.readFileSync(target));
  return snapshot;
}

function unchanged(request) {
  if (canonicalJson(fingerprint(request.target)) !== canonicalJson(request.parameters.expected)) {
    throw Object.assign(new Error('The target changed after it was approved; ask again'), { code: 'target_changed' });
  }
}

function writeFileOwner(request, content) {
  if (typeof content !== 'string' || sha256(content) !== request.parameters.content_sha256) {
    throw Object.assign(new Error('Content differs from the approved request'), { code: 'request_mismatch' });
  }
  if (!fs.statSync(path.dirname(request.target), { throwIfNoEntry: false })?.isDirectory()) {
    throw Object.assign(new Error('Parent folder does not exist; use files.mkdir'), { code: 'parent_not_found' });
  }
  unchanged(request);
  // O_NOFOLLOW: a symlink swapped in after approval is refused, not followed.
  const fd = fs.openSync(request.target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW, 0o644);
  try { fs.writeSync(fd, content); } finally { fs.closeSync(fd); }
  return { ok: true, path: request.target, bytes_written: Buffer.byteLength(content) };
}

function makeDirectoryOwner(request) {
  unchanged(request);
  fs.mkdirSync(request.target, { recursive: request.parameters.create_intermediates === true });
  return { ok: true, path: request.target, created: true };
}

function pick(params, keys) {
  return Object.fromEntries(keys.filter((key) => params[key] !== undefined).map((key) => [key, params[key]]));
}

// What the approval dialog shows: the real request, with file content kept
// for the preview (it is not part of the digest; its hash is).
function previewParams(commandId, params) {
  return commandId === 'files.write' ? { path: params.path, content: params.content } : params;
}

function which(params) {
  const name = params.name;
  if (typeof name !== 'string' || !/^[A-Za-z0-9._+-]+$/.test(name)) {
    throw Object.assign(new Error('Bare executable name required'), { code: 'invalid_argument' });
  }
  for (const folder of (process.env.PATH ?? '').split(path.delimiter)) {
    const candidate = path.join(folder, name);
    try { fs.accessSync(candidate, fs.constants.X_OK); if (fs.statSync(candidate).isFile()) return { ok: true, name, path: candidate }; }
    catch {}
  }
  return { ok: false, error_code: 'not_found', message: `${name} was not found on PATH` };
}

// Every shell.exec runs as the leader of its own process group so a timeout,
// a cancel or daemon shutdown signals the whole tree (bash and whatever it
// started: sha256sum, cp, du...), not just bash. Killing only bash left
// grandchildren holding stdout open, so 'close' never fired.
const activeGroups = new Set();
// No login profile and no inherited secrets: tokens exported by the desktop
// session (API keys, agent sockets) never reach a model-requested command.
const SHELL_ARGV = ['/bin/bash', '--noprofile', '--norc', '-c'];
const ENV_ALLOW = ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TMPDIR'];
function minimalEnv(source = process.env) {
  const env = { TERM: 'dumb', SHELL: '/bin/bash' };
  for (const key of ENV_ALLOW) if (source[key] !== undefined) env[key] = source[key];
  return env;
}
const KILL_GRACE_MS = 2000;

function signalGroup(pgid, signal) {
  try { process.kill(-pgid, signal); return true; } catch { return false; }
}

function terminateGroup(pgid, graceMs = KILL_GRACE_MS) {
  if (!signalGroup(pgid, 'SIGTERM')) return;
  setTimeout(() => signalGroup(pgid, 'SIGKILL'), graceMs).unref();
}

function killAllProcessGroups(signal = 'SIGTERM') {
  for (const pgid of activeGroups) signalGroup(pgid, signal);
  return activeGroups.size;
}

function shellExec(params, { graceMs = KILL_GRACE_MS } = {}) {
  if (typeof params.command !== 'string' || !params.command.trim()) {
    throw Object.assign(new Error('command is required'), { code: 'invalid_argument' });
  }
  const cwd = params.cwd ? expandPath(params.cwd) : os.homedir();
  const timeout = boundedInteger(params.timeout_ms, 30000, 100, 120000, 'timeout_ms');
  return new Promise((resolve) => {
    const child = spawn(SHELL_ARGV[0], [...SHELL_ARGV.slice(1), params.command], { cwd, env: minimalEnv(), stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    const pgid = child.pid;
    if (pgid) activeGroups.add(pgid);
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let exitInfo = null;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(drain);
      if (pgid) { signalGroup(pgid, 'SIGKILL'); activeGroups.delete(pgid); }
      resolve(value);
    };
    const report = () => finish({
      ok: !timedOut && exitInfo?.code === 0,
      exit_code: exitInfo?.code ?? null,
      signal: exitInfo?.signal ?? null,
      timed_out: timedOut,
      stdout: stdout.slice(0, 1048576),
      stderr: stderr.slice(0, 1048576),
    });
    let drain = null;
    const timer = setTimeout(() => { timedOut = true; if (pgid) terminateGroup(pgid, graceMs); }, timeout);
    child.stdout.on('data', (data) => { if (stdout.length < 1048576) stdout += data.toString(); });
    child.stderr.on('data', (data) => { if (stderr.length < 1048576) stderr += data.toString(); });
    child.on('error', (error) => finish({ ok: false, error_code: 'spawn_failed', message: error.message }));
    // 'exit' = bash is gone. A background grandchild can keep the pipes open,
    // so give 'close' a short drain window, then reap the group and report.
    child.on('exit', (code, signal) => {
      exitInfo = { code, signal };
      drain = setTimeout(report, timedOut ? 0 : 500);
    });
    child.on('close', (code, signal) => { exitInfo = exitInfo ?? { code, signal }; report(); });
  });
}

function createCommandRegistry({
  approve = async () => false, authority = new WorkspaceAuthority(), approvals = new ActionApprovalStore(),
  receipts = null, flow = null, onFlow = null, logger = console,
} = {}) {
  const definitions = {
    ping: schema('Connection liveness check'),
    'system.which': schema("Find a command-line tool's full path on this Linux computer's PATH; runs nothing.", {
      required: { name: string('Bare executable name to resolve on PATH.') },
    }),
    'files.list': schema('List one Linux folder, largest first and 20 entries per page by default. For filters or recursion use files.search.', {
      optional: {
        path: string('Absolute folder path; ~ is expanded. Defaults to the Linux home.'),
        sort: string('size_desc (default), size_asc, modified_desc, modified_asc, or name.'),
        limit: integer('Entries per page, default 20, max 200.'),
        offset: integer('Zero-based offset, 0...999.'),
      }, permissions: ['filesystem'],
    }),
    'files.search': schema('Find Linux files and folders by case-insensitive name substring or glob, searching subfolders by default.', {
      optional: {
        path: string('Absolute folder to search; ~ is expanded.'),
        query: string('Case-insensitive name substring, or whole-name glob with * and ?.'),
        recursive: boolean('Search subfolders, default true.'),
        kind: string('any (default), file, or folder.'),
        extension: string('Filename extension, e.g. pdf or .pdf.'),
        sort: string('modified_desc (default), modified_asc, created_desc, created_asc, size_desc, size_asc, name, or name_desc.'),
        limit: integer('Maximum entries per page, default 50, max 200.'),
        offset: integer('Zero-based offset, 0...999.'),
      }, permissions: ['filesystem'], timeoutMs: 15000,
    }),
    'files.read': schema('Read a UTF-8 text file on this Linux computer one page at a time; PNG/JPEG/GIF/WebP up to 3 MB return as an image.', {
      required: { path: string('Absolute file path; ~ is expanded.') },
      optional: {
        offset: integer('1-indexed line to start reading from, default 1.'),
        limit: integer('Maximum number of lines, default 2000.'),
      }, permissions: ['filesystem'],
    }),
    'files.write': schema('Create or overwrite a UTF-8 text file on this Linux computer after user approval. Parent folder must exist.', {
      required: {
        path: string('Absolute file path to write, including filename.'),
        content: string('Full new UTF-8 contents.'),
      }, permissions: ['filesystem'], timeoutMs: 120000,
    }),
    'files.mkdir': schema('Create a folder on this Linux computer after user approval.', {
      required: { path: string('Absolute folder path to create.') },
      optional: { create_intermediates: boolean('Also create missing parents; default false.') },
      permissions: ['filesystem'], timeoutMs: 120000,
    }),
    'shell.exec': schema('Execute a command through /bin/bash on this Linux computer after explicit user approval.', {
      required: { command: string('Full shell command to execute.') },
      optional: {
        cwd: string('Working directory; defaults to the Linux home.'),
        timeout_ms: integer('Timeout in milliseconds, default 30000, max 120000.'),
      }, permissions: ['shell'], timeoutMs: 240000,
    }),
  };
  const home = os.homedir();
  const gate = new ActionGate({ authority, approve, approvals, receipts, owners: OWNERS, home, flow, onFlow, logger });
  const commands = {
    ping: { build: () => ({ actionId: 'node.ping' }), run: async () => ({ ok: true, platform: 'linux', hostname: os.hostname(), timestamp: new Date().toISOString() }) },
    'system.which': {
      build: (params) => ({ actionId: 'node.system.which', target: String(params.name ?? '') }),
      run: async (request) => which({ name: request.target }),
    },
    'files.list': {
      build: (params) => {
        assertParams(params, LIST_PARAMS);
        return { actionId: 'workspace.files.list', target: authority.canonicalPath(params.path ?? '~'), parameters: pick(params, ['sort', 'limit', 'offset']) };
      },
      run: async (request) => listFiles({ ...request.parameters, path: request.target }),
    },
    'files.search': {
      build: (params) => ({ actionId: 'workspace.files.search', target: authority.canonicalPath(params.path ?? '~'), parameters: pick(params, ['query', 'recursive', 'kind', 'extension', 'sort', 'limit', 'offset']) }),
      run: async (request) => searchFiles({ ...request.parameters, path: request.target }),
    },
    'files.read': {
      build: (params) => ({ actionId: 'workspace.files.read', target: authority.canonicalPath(params.path), parameters: pick(params, ['offset', 'limit']) }),
      run: async (request) => readFile({ ...request.parameters, path: request.target }),
    },
    'files.write': {
      build: (params) => {
        if (typeof params.content !== 'string' || params.vm_path !== undefined) {
          throw Object.assign(new Error('files.write currently requires UTF-8 content and no vm_path'), { code: 'invalid_argument' });
        }
        const target = authority.canonicalPath(params.path);
        return {
          actionId: 'workspace.files.write', target,
          parameters: { op: 'write', content_sha256: sha256(params.content), bytes: Buffer.byteLength(params.content), expected: fingerprint(target) },
        };
      },
      run: async (request, params) => writeFileOwner(request, params.content),
    },
    'files.mkdir': {
      build: (params) => {
        const target = authority.canonicalPath(params.path);
        return { actionId: 'workspace.files.write', target, parameters: { op: 'mkdir', create_intermediates: params.create_intermediates === true, expected: fingerprint(target) } };
      },
      run: async (request) => makeDirectoryOwner(request),
    },
    'shell.exec': {
      build: (params) => {
        if (typeof params.command !== 'string' || !params.command.trim()) throw Object.assign(new Error('command is required'), { code: 'invalid_argument' });
        return {
          actionId: 'workspace.command.run', target: authority.canonicalPath(params.cwd ?? '~'),
          parameters: { command: params.command, timeout_ms: boundedInteger(params.timeout_ms, 30000, 100, 120000, 'timeout_ms'), interpreter: SHELL_ARGV.join(' '), env: 'minimal-v1' },
        };
      },
      run: async (request) => shellExec({ command: request.parameters.command, cwd: request.target, timeout_ms: request.parameters.timeout_ms }),
    },
  };
  return {
    definitions,
    gate,
    async invoke(commandId, params = {}, { invokeId = null } = {}) {
      const command = commands[commandId];
      if (!command) return { ok: false, error_code: 'unknown_command', message: `Unknown Linux node command: ${commandId}` };
      let request;
      try {
        const built = command.build(params ?? {});
        request = new ActionRequest({ workspaceRoot: authority.root, executionOwner: OWNERS[built.actionId], ...built });
      } catch (error) {
        const code = error instanceof WorkspaceAuthorityError ? 'permission_denied' : (error.code ?? 'invalid_argument');
        return { ok: false, error_code: code, message: error.message };
      }
      const decision = await gate.authorize(request, { invokeId, commandId, params: previewParams(commandId, params) });
      if (!decision.allowed) {
        const message = decision.verdict.checks.some((check) => check.name === 'Authority' && /did not approve/.test(check.reason))
          ? 'The user did not approve this action' : `Denied by ISySentinel: ${decision.reason}`;
        return { ok: false, error_code: 'permission_denied', message };
      }
      let result;
      try { result = await command.run(request, params); }
      catch (error) { result = { ok: false, error_code: error.code ?? 'command_failed', message: error.message }; }
      gate.returned(request, { invokeId, result });
      return result;
    },
  };
}

module.exports = { createCommandRegistry, expandPath, listFiles, searchFiles, readFile, which, shellExec, killAllProcessGroups, activeGroups, minimalEnv, fingerprint, OWNERS };
