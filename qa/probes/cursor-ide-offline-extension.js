// QA-only temporary extension, installed exclusively in an isolated Cursor profile.
// No history writes: import/open use Cursor commands; local files are receipts only.
const vscode = require('vscode');
const fs = require('node:fs');
const path = require('node:path');
exports.activate = async (context) => {
  const config = JSON.parse(fs.readFileSync(path.join(context.extensionPath, 'case.json'), 'utf8'));
  const folders = (vscode.workspace.workspaceFolders || []).map(x => x.uri.fsPath);
  const entry = config.workspaces.find(x => folders.length === 1 && x.path === folders[0]);
  if (!entry || !path.isAbsolute(config.root) || !entry.path.startsWith(config.root + path.sep)) return;
  const dir = path.join(config.root, entry.name);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const write = (name, data) => fs.writeFileSync(path.join(dir, name), JSON.stringify(data, null, 2), {mode:0o600});
  write('activated.json', {folders, extensionMode: context.extensionMode, pid:process.pid, appName:vscode.env.appName, sessionId:vscode.env.sessionId});
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      for (const name of fs.readdirSync(dir).filter(n => /^request-[a-z0-9-]+\.json$/.test(n))) {
        const op = name.slice(8, -5);
        const token = path.join(dir, `token-${op}`);
        if (fs.existsSync(token)) continue;
        const req = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
        if (!['import', 'open', 'selected'].includes(req.action)) throw Error('Unsupported action');
        if (req.action === 'import' && req.directory !== path.join(config.root, entry.name, 'payloads')) throw Error('Wrong payload directory');
        if (req.action === 'open' && !/^[0-9a-f-]{36}$/.test(req.id)) throw Error('Invalid ID');
        const fd = fs.openSync(token, 'wx', 0o600);
        fs.writeSync(fd, JSON.stringify(req)); fs.fsyncSync(fd); fs.closeSync(fd);
        const before = await vscode.commands.executeCommand('composer.getOrderedSelectedComposerIds');
        try {
          let result;
          if (req.action === 'import') result = await vscode.commands.executeCommand('developer.bulkImportChats', req.directory);
          if (req.action === 'open') result = await vscode.commands.executeCommand('composer.openComposer', req.id);
          const selected = await vscode.commands.executeCommand('composer.getOrderedSelectedComposerIds');
          write(`response-${op}.json`, {operation:op, request:req, folders, extensionMode:context.extensionMode, before, result:result ?? null, selected:selected ?? null});
        } catch(error) { write(`response-${op}.json`, {operation:op, request:req, error:String(error), folders}); }
      }
    } catch(error) { write('error.json', {error:String(error)}); }
    finally { busy = false; }
  };
  const timer = setInterval(tick, 250);
  context.subscriptions.push({dispose:()=>clearInterval(timer)});
  await tick();
};
