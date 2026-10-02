'use strict';
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const VERSION = '0.1.0';
const MAX_FRAME = 128 * 1024 * 1024;
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
function safe(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || path.normalize(value) !== value) throw Error('Invalid bridge path');
  for (let current = value; current !== path.dirname(current); current = path.dirname(current)) {
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw Error('Bridge path is a link');
  }
  return value;
}
function owned(value, kind) {
  const stat = fs.lstatSync(safe(value));
  if (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0 || !stat[kind]()) throw Error('Bridge endpoint is not private');
}
function durable(file, value) {
  const fd = fs.openSync(file, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  // Native operation dispatch is macOS only; protocol tests also run on Windows,
  // where opening a directory for fsync is unsupported.
  if (process.platform !== 'win32') {
    const directory = fs.openSync(path.dirname(file), 'r');
    try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
  }
}
async function saveBinding(secrets, key, binding) {
  // Each window writes its own credential. A shared read/modify/write array can
  // lose another extension host's binding. The hint is discovery only; Runtime
  // decides whether automatic reconnection has an unambiguous window identity.
  await secrets.store(key + '.' + binding.binding_id, JSON.stringify(binding));
  await secrets.store(key, JSON.stringify({binding_id: binding.binding_id}));
}
async function loadBinding(secrets, key) {
  const hint = JSON.parse((await secrets.get(key)) || '{}');
  if (!uuid(hint.binding_id)) return;
  const saved = JSON.parse((await secrets.get(key + '.' + hint.binding_id)) || '{}');
  if (saved.binding_id !== hint.binding_id) return;
  return saved;
}
function retryLoop(attempt, blocked, setTimer = setTimeout, clearTimer = clearTimeout) {
  let timer, running = false, stopped = false, delay = 2000;
  const schedule = () => {
    if (timer || running || stopped || blocked()) return;
    timer = setTimer(() => { timer = undefined; void wake(); }, delay);
    delay = Math.min(delay * 2, 30000);
  };
  const wake = async () => {
    if (running || stopped || blocked()) return;
    clearTimer(timer); timer = undefined; running = true;
    let again = true;
    try { again = await attempt(); } catch { /* Runtime may not have created its socket yet. */ }
    finally {
      running = false;
      if (again) schedule();
    }
  };
  return {wake, schedule, reset: () => { delay = 2000; }, dispose: () => { stopped = true; clearTimer(timer); }};
}
async function dispatch(context, vscode, message, binding) {
  if (message.protocol !== 1 || message.boot_id !== binding.boot_id || message.binding_id !== binding.binding_id || message.lease !== binding.lease || !uuid(message.request_id)) throw Error('Bridge request identity changed');
  const folders = vscode.workspace.workspaceFolders || [];
  if (folders.length !== 1 || folders[0].uri.scheme !== 'file' || fs.realpathSync(folders[0].uri.fsPath) !== message.workspace) throw Error('Bridge workspace changed');
  if (!['status', 'import', 'open', 'selected'].includes(message.action)) throw Error('Unsupported bridge action');
  if (message.action === 'status') return {workspace: message.workspace, session_id: vscode.env.sessionId};
  if (message.action === 'selected') return await vscode.commands.executeCommand('composer.getOrderedSelectedComposerIds');
  const args = message.args;
  if (message.action === 'open') {
    if (!uuid(args.native_id)) throw Error('Invalid Cursor session identity');
    await vscode.commands.executeCommand('composer.openComposer', args.native_id);
    const selected = await vscode.commands.executeCommand('composer.getOrderedSelectedComposerIds');
    if (!Array.isArray(selected) || selected.length !== 1 || selected[0] !== args.native_id) throw Error('Cursor selected a different session');
    return {selected};
  }
  if (!uuid(args.operation_id) || !/^[a-f0-9]{64}$/.test(args.plan_hash) || typeof args.payload !== 'string' || hash(args.payload) !== args.payload_hash) throw Error('Invalid approved import payload');
  const payload = JSON.parse(args.payload);
  if (payload.version !== 1 || typeof payload.conversationState !== 'string' || typeof payload.blobs !== 'object' || Array.isArray(payload.blobs)) throw Error('Unsupported Cursor export format');
  const storage = safe(context.globalStorageUri.fsPath);
  fs.mkdirSync(storage, {recursive: true});
  const operations = path.join(storage, 'operations-v1');
  safe(operations); fs.mkdirSync(operations, {recursive: true, mode: 0o700});
  const directory = path.join(operations, args.operation_id);
  safe(directory);
  if (fs.existsSync(directory)) {
    const consumed = JSON.parse(fs.readFileSync(safe(path.join(directory, 'attempted.json')), 'utf8'));
    if (consumed.plan_hash !== args.plan_hash || consumed.payload_hash !== args.payload_hash) throw Error('Operation fingerprint mismatch');
    return {consumed: true}; // A lost importer response never authorizes a second import.
  }
  fs.mkdirSync(directory, {mode: 0o700});
  durable(path.join(directory, 'attempted.json'), {plan_hash: args.plan_hash, payload_hash: args.payload_hash});
  const payloadDirectory = path.join(directory, 'payload'); fs.mkdirSync(payloadDirectory, {mode: 0o700});
  const payloadFile = path.join(payloadDirectory, 'import.json');
  const fd = fs.openSync(payloadFile, 'wx', 0o600);
  try { fs.writeFileSync(fd, args.payload); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  if (fs.readdirSync(payloadDirectory).length !== 1 || hash(fs.readFileSync(safe(payloadFile))) !== args.payload_hash) throw Error('Import payload changed');
  const result = await vscode.commands.executeCommand('developer.bulkImportChats', payloadDirectory);
  durable(path.join(directory, 'receipt.json'), {plan_hash: args.plan_hash, result});
  return {consumed: true, result};
}
exports.activate = async context => {
  const vscode = require('vscode');
  if (process.platform !== 'darwin') return;
  let active;
  let disposed = false;
  const folders = vscode.workspace.workspaceFolders || [];
  if (folders.length !== 1 || folders[0].uri.scheme !== 'file') return;
  const profileKey = 'agentkib.bridge.v1.' + hash(fs.realpathSync(folders[0].uri.fsPath));
  function hello() {
    const folders = vscode.workspace.workspaceFolders || [];
    if (folders.length !== 1 || folders[0].uri.scheme !== 'file' || context.extensionMode !== 1) throw Error('Connect a local single-folder production window');
    return {protocol: 1, extension_version: VERSION, workspace: fs.realpathSync(folders[0].uri.fsPath), global_storage: fs.realpathSync(context.globalStorageUri.fsPath), app_root: fs.realpathSync(vscode.env.appRoot), session_id: vscode.env.sessionId, extension_mode: context.extensionMode};
  }
  async function connect(endpoint, auth) {
    if (active) active.destroy();
    owned(path.dirname(endpoint), 'isDirectory'); owned(endpoint, 'isSocket');
    fs.mkdirSync(context.globalStorageUri.fsPath, {recursive: true});
    const identity = hello();
    if (auth.credential && auth.workspace !== identity.workspace) return;
    const socket = net.createConnection({path: endpoint}); active = socket;
    let buffer = Buffer.alloc(0), binding, queue = Promise.resolve();
    socket.on('connect', () => socket.write(JSON.stringify({...identity, ticket: auth.ticket || null, credential: auth.credential || null}) + '\n'));
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > MAX_FRAME) { socket.destroy(); return; }
      for (;;) {
        const index = buffer.indexOf(10); if (index < 0) break;
        const raw = buffer.subarray(0, index); buffer = buffer.subarray(index + 1);
        queue = queue.then(async () => {
          const message = JSON.parse(raw.toString('utf8'));
          if (!binding) {
            if (message.protocol !== 1 || !uuid(message.binding_id) || !uuid(message.boot_id) || !uuid(message.lease)) throw Error('Invalid Cursor pairing response');
            binding = message;
            recovery.reset();
            if (message.credential) {
              await saveBinding(context.secrets, profileKey, {binding_id: message.binding_id, credential: message.credential, endpoint: message.endpoint, workspace: identity.workspace});
            }
            return;
          }
          let reply;
          try { reply = {result: await dispatch(context, vscode, message, binding)}; }
          catch { reply = {error: 'Cursor action failed; reconcile the operation in AgentKib'}; }
          socket.write(JSON.stringify({protocol: 1, boot_id: binding.boot_id, lease: binding.lease, request_id: message.request_id, ...reply}) + '\n');
        }).catch(() => socket.destroy());
      }
    });
    socket.on('error', () => {});
    socket.on('close', () => {
      if (active !== socket || disposed) return;
      active = undefined;
      recovery.schedule();
    });
  }
  async function reconnect() {
      const saved = await loadBinding(context.secrets, profileKey);
      if (!saved?.credential || !saved.endpoint) return false;
      owned(saved.endpoint, 'isFile');
      if (fs.statSync(saved.endpoint).size > 4096) return false;
      const endpoint = JSON.parse(fs.readFileSync(saved.endpoint, 'utf8'));
      if (endpoint.schema_version !== 1) return false;
      await connect(endpoint.socket, saved);
      return true;
  }
  const recovery = retryLoop(reconnect, () => disposed || !!active);
  context.subscriptions.push(vscode.commands.registerCommand('agentkib.connect', async () => {
    const value = await vscode.window.showInputBox({prompt: 'Paste the one-time local connection challenge from AgentKib', password: true, ignoreFocusOut: true});
    if (!value) return;
    try {
      const input = JSON.parse(value);
      if (!/^[a-f0-9]{64}$/.test(input.ticket)) throw Error('Invalid challenge');
      await connect(input.socket, {ticket: input.ticket});
    } catch { await vscode.window.showErrorMessage('AgentKib connection failed. Create a new challenge and connect the matching workspace.'); }
  }));
  context.subscriptions.push({dispose: () => { disposed = true; recovery.dispose(); active?.destroy(); }});
  await recovery.wake();
};
exports._test = {dispatch, safe, hash, saveBinding, loadBinding, retryLoop};
