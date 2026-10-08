#!/usr/bin/env node
// Inkplain local runner — the "local" half of the Simulator's /plugins/code-editor.
//
// The editor lives in the browser and can run Node projects there (WebContainer), but projects
// like a FastAPI + torch + chromadb chatbot need a real Python. This process is that Python: the
// editor pushes its files here over a websocket, the runner keeps them in a per-workspace folder,
// builds a venv / node_modules on demand, runs commands and streams their output back. Servers it
// starts listen on this machine, so the same browser reaches them on http://localhost:<port>.
//
// Anyone who can talk to this socket can run commands on the machine, so a connection needs an
// allowed Origin (browsers cannot fake it, so random websites are out) plus the token. The editor
// gets the token from /pair, which only answers allowed origins — the user never copies it. It
// binds to 127.0.0.1 only.

import { WebSocketServer } from 'ws';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const VERSION = '0.2.0';
const IS_WIN = process.platform === 'win32';

const args = parseArgs(process.argv.slice(2));
const PORT = Number(args.port ?? process.env.INKPLAIN_RUNNER_PORT ?? 7077);
const HOME = path.resolve(args.root ?? process.env.INKPLAIN_RUNNER_HOME ?? path.join(os.homedir(), '.inkplain-runner'));
const WORKSPACES_DIR = path.join(HOME, 'workspaces');
const VENVS_DIR = path.join(HOME, 'venvs');
const DEFAULT_ORIGINS = ['https://app.inkplain.com', 'http://localhost:8076', 'http://127.0.0.1:8076'];
const ALLOWED_ORIGINS = new Set([
  ...DEFAULT_ORIGINS,
  ...args.allowOrigin,
  ...(process.env.INKPLAIN_RUNNER_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
]);
const MAX_HTTP_BODY = 2 * 1024 * 1024;
// URL scheme the Code Editor's "Start runner" button opens (overridable for tests).
const SCHEME = process.env.INKPLAIN_RUNNER_SCHEME || 'inkplain-runner';
// The packaged single executable is not named node(.exe); under plain `node runner.mjs` nothing is installed.
const IS_PACKAGED = !/^node(\.exe)?$/i.test(path.basename(process.execPath));

fs.mkdirSync(WORKSPACES_DIR, { recursive: true });
fs.mkdirSync(VENVS_DIR, { recursive: true });
const TOKEN = loadToken();

// Started from a link or the Finder there is no console to read, so keep a log next to the data.
if (!process.stdout.isTTY) {
  const logFile = path.join(HOME, 'runner.log');
  if (fs.existsSync(logFile) && fs.statSync(logFile).size > 5 * 1024 * 1024) fs.rmSync(logFile);
  const stream = fs.createWriteStream(logFile, { flags: 'a' });
  for (const level of ['log', 'error']) {
    const original = console[level].bind(console);
    console[level] = (...parts) => {
      stream.write(`${parts.join(' ')}\n`);
      original(...parts);
    };
  }
}

if (args.printToken) {
  console.log(TOKEN);
  process.exit(0);
}

/** procId -> { child, killed, socket } */
const procs = new Map();

// ---------------------------------------------------------------------------------------------
// HTTP: health probe + workspace file serving (so an HTML file can be opened in the browser)

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    // Chrome's Private/Local Network Access preflight for https page -> localhost.
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
  }
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST');
    res.setHeader('Access-Control-Allow-Headers', 'x-inkplain-token');
    res.writeHead(204).end();
    return;
  }

  const url = new URL(req.url || '/', 'http://localhost');
  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, name: 'inkplain-local-runner', version: VERSION }));
    return;
  }

  // The editor asks for the token instead of making the user copy it. Browsers always send Origin
  // on this cross-origin fetch and cannot forge it, so only an allowed site can read the answer.
  if (url.pathname === '/pair') {
    if (!origin || !ALLOWED_ORIGINS.has(origin)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' }).end('Origin not allowed');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ token: TOKEN, version: VERSION }));
    return;
  }

  // "Stop runner" in the editor, and --uninstall stopping a running copy.
  if (url.pathname === '/shutdown' && req.method === 'POST') {
    if ((origin && !ALLOWED_ORIGINS.has(origin)) || !safeEqual(req.headers['x-inkplain-token'] || '', TOKEN)) {
      res.writeHead(403).end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/plain' }).end('stopping');
    log('stop requested - shutting down');
    for (const state of procs.values()) killProc(state);
    setTimeout(() => process.exit(0), 300);
    return;
  }

  // /files/<token>/<workspaceId>/<path...>
  const match = url.pathname.match(/^\/files\/([^/]+)\/([^/]+)\/(.*)$/);
  if (match && safeEqual(decodeURIComponent(match[1]), TOKEN)) {
    try {
      let file = resolveInWorkspace(match[2], decodeURIComponent(match[3] || ''));
      const stat = await fsp.stat(file).catch(() => null);
      if (stat?.isDirectory()) file = path.join(file, 'index.html');
      const data = await fsp.readFile(file);
      res.writeHead(200, {
        'Content-Type': contentType(file),
        'Cache-Control': 'no-store',
        // Lets the editor's cross-origin-isolated page frame it.
        'Cross-Origin-Resource-Policy': 'cross-origin',
      });
      res.end(data);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
    }
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
});

// ---------------------------------------------------------------------------------------------
// Websocket protocol: { id, type, ...payload } -> { id, ok, result | error }; plus pushed events
// { type: 'proc-output' | 'proc-exit', procId, ... }.

const wss = new WebSocketServer({
  server,
  maxPayload: 512 * 1024 * 1024,
  verifyClient: ({ origin, req }, done) => {
    const token = new URL(req.url || '/', 'http://localhost').searchParams.get('token') || '';
    if (!origin || !ALLOWED_ORIGINS.has(origin)) {
      log(`rejected connection from origin ${origin || '(none)'} — start with --allow-origin ${origin || '<origin>'} to allow it`);
      return done(false, 403, 'Origin not allowed');
    }
    if (!safeEqual(token, TOKEN)) {
      log(`rejected connection from ${origin}: wrong token`);
      return done(false, 401, 'Invalid token');
    }
    done(true);
  },
});

wss.on('connection', (socket, req) => {
  log(`editor connected (${req.headers.origin})`);
  socket.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    const handler = handlers[msg.type];
    if (!handler) {
      send(socket, { id: msg.id, ok: false, error: `Unknown message type: ${msg.type}` });
      return;
    }
    try {
      const result = await handler(msg, socket);
      send(socket, { id: msg.id, ok: true, result });
    } catch (err) {
      send(socket, { id: msg.id, ok: false, error: err?.message || String(err) });
    }
  });
  socket.on('close', () => {
    log('editor disconnected - stopping its processes');
    for (const [procId, state] of procs) {
      if (state.socket === socket) {
        killProc(state);
        procs.delete(procId);
      }
    }
  });
});

const handlers = {
  async hello() {
    return {
      version: VERSION,
      platform: process.platform,
      node: process.version,
      python: findPython()?.version || null,
      workspacesDir: WORKSPACES_DIR,
    };
  },

  async sync({ workspaceId, files }) {
    const root = workspaceDir(workspaceId);
    await fsp.mkdir(root, { recursive: true });
    for (const file of files || []) await writeWorkspaceFile(workspaceId, file);
    return { root, count: files?.length || 0 };
  },

  async write({ workspaceId, file }) {
    await writeWorkspaceFile(workspaceId, file);
    return null;
  },

  async remove({ workspaceId, path: rel }) {
    await fsp.rm(resolveInWorkspace(workspaceId, rel), { recursive: true, force: true });
    return null;
  },

  async rename({ workspaceId, from, to }) {
    const target = resolveInWorkspace(workspaceId, to);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.rename(resolveInWorkspace(workspaceId, from), target);
    return null;
  },

  async exec(msg, socket) {
    if (!msg.procId || procs.has(msg.procId)) throw new Error('Missing or duplicate procId');
    const state = { child: null, killed: false, socket };
    procs.set(msg.procId, state);
    // Do not await: the reply only confirms the start; output and exit arrive as events.
    runExec(msg, state).finally(() => procs.delete(msg.procId));
    return null;
  },

  async kill({ procId }) {
    const state = procs.get(procId);
    if (state) killProc(state);
    return null;
  },

  async input({ procId, data }) {
    const state = procs.get(procId);
    state?.child?.stdin?.write(data);
    return null;
  },

  // HTTP call made from this machine, so the target server needs no CORS setup to be tested.
  async http({ method = 'GET', url, headers = {}, body, timeoutMs = 60000 }) {
    const target = new URL(url);
    if (!['localhost', '127.0.0.1', '[::1]', '0.0.0.0'].includes(target.hostname)) {
      throw new Error('The local runner only calls localhost endpoints.');
    }
    if (target.hostname === '0.0.0.0') target.hostname = '127.0.0.1';
    const started = performance.now();
    const response = await fetch(target, {
      method,
      headers,
      body: ['GET', 'HEAD'].includes(method.toUpperCase()) ? undefined : body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const buf = Buffer.from(await response.arrayBuffer());
    return {
      status: response.status,
      statusText: response.statusText,
      headers: Object.fromEntries(response.headers.entries()),
      body: buf.subarray(0, MAX_HTTP_BODY).toString('utf8'),
      truncated: buf.length > MAX_HTTP_BODY,
      durationMs: Math.round(performance.now() - started),
    };
  },
};

// ---------------------------------------------------------------------------------------------
// Process execution

async function runExec({ procId, workspaceId, command, setup, env: extraEnv }, state) {
  const emit = (data) => send(state.socket, { type: 'proc-output', procId, data });
  let code = 1;
  try {
    const cwd = workspaceDir(workspaceId);
    await fsp.mkdir(cwd, { recursive: true });
    const env = buildEnv(cwd, extraEnv);

    if (setup === 'python') await setupPython(cwd, env, emit, state);
    if (setup === 'node') await setupNode(cwd, env, emit, state);
    if (state.killed) throw new Error('Stopped');

    if (command) {
      emit(`\x1b[2m$ ${command}\x1b[0m\r\n`);
      code = await runChild(command, cwd, buildEnv(cwd, extraEnv), emit, state);
    } else {
      code = 0;
    }
  } catch (err) {
    emit(`\r\n\x1b[31m${err?.message || err}\x1b[0m\r\n`);
  }
  send(state.socket, { type: 'proc-exit', procId, code: state.killed ? 130 : code });
}

function buildEnv(cwd, extraEnv = {}) {
  const env = { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8', FORCE_COLOR: '1', ...extraEnv };
  // Every command in a workspace that has a venv sees it first on PATH — `python`, `pip` and
  // `uvicorn` in the terminal mean the project's own, like an activated venv would.
  const venv = venvDir(cwd);
  const venvBin = path.join(venv, IS_WIN ? 'Scripts' : 'bin');
  if (fs.existsSync(venvBin)) {
    const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
    env[pathKey] = venvBin + path.delimiter + (env[pathKey] || '');
    env.VIRTUAL_ENV = venv;
  }
  return env;
}

// A torch/chromadb venv is gigabytes, and every import of a repo is a new workspace. So venvs are
// shared by requirements.txt content: re-importing the same repo (or two repos with identical
// requirements) reuses the installed venv. Without a requirements.txt the venv stays per workspace.
function venvDir(cwd) {
  const req = path.join(cwd, 'requirements.txt');
  if (!fs.existsSync(req)) return path.join(cwd, '.venv');
  return path.join(VENVS_DIR, `py-${sha(fs.readFileSync(req)).slice(0, 16)}`);
}

async function setupPython(cwd, env, emit, state) {
  const venv = venvDir(cwd);
  const ready = path.join(venv, '.inkplain-ready');
  if (fs.existsSync(ready)) {
    emit(`\x1b[2m▶ Reusing virtualenv ${venv}\x1b[0m\r\n`);
    return;
  }
  if (!fs.existsSync(venv)) {
    const py = findPython();
    if (!py) throw new Error('Python 3 was not found on this machine. Install it and restart the runner.');
    emit(`\x1b[36m▶ Creating virtualenv with ${py.version}\x1b[0m\r\n`);
    await fsp.mkdir(path.dirname(venv), { recursive: true });
    const code = await runChild(`${py.cmd} -m venv "${venv}"`, cwd, env, emit, state);
    if (code !== 0) throw new Error('Could not create the virtualenv');
  }
  if (fs.existsSync(path.join(cwd, 'requirements.txt'))) {
    emit('\x1b[36m▶ pip install -r requirements.txt (first run can take a while)\x1b[0m\r\n');
    const code = await runChild('python -m pip install -r requirements.txt', cwd, buildEnv(cwd, {}), emit, state);
    if (code !== 0) throw new Error('pip install failed');
  }
  // Only marked ready after a complete install, so a stopped/failed install is retried next run.
  await fsp.writeFile(ready, new Date().toISOString());
}

async function setupNode(cwd, env, emit, state) {
  const pkg = path.join(cwd, 'package.json');
  if (!fs.existsSync(pkg)) return;
  const lock = path.join(cwd, 'package-lock.json');
  const hash = sha(Buffer.concat([await fsp.readFile(pkg), fs.existsSync(lock) ? await fsp.readFile(lock) : Buffer.alloc(0)]));
  const stamp = path.join(cwd, 'node_modules', '.inkplain-package.sha');
  if (fs.existsSync(stamp) && (await fsp.readFile(stamp, 'utf8')) === hash) return;
  emit('\x1b[36m▶ npm install\x1b[0m\r\n');
  const code = await runChild('npm install', cwd, env, emit, state);
  if (code !== 0) throw new Error('npm install failed');
  await fsp.mkdir(path.dirname(stamp), { recursive: true });
  await fsp.writeFile(stamp, hash);
}

function runChild(command, cwd, env, emit, state) {
  return new Promise((resolve) => {
    if (state.killed) return resolve(130);
    const child = spawn(command, {
      cwd,
      env,
      shell: true,
      windowsHide: true,
      // Own process group on POSIX so stop can take down the whole tree (uvicorn --reload etc.).
      detached: !IS_WIN,
    });
    state.child = child;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', emit);
    child.stderr.on('data', emit);
    child.on('error', (err) => {
      emit(`\x1b[31m${err.message}\x1b[0m\r\n`);
      resolve(1);
    });
    child.on('close', (code) => {
      state.child = null;
      resolve(code ?? 1);
    });
  });
}

function killProc(state) {
  state.killed = true;
  const child = state.child;
  if (!child || child.exitCode !== null) return;
  if (IS_WIN) {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    return;
  }
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
  setTimeout(() => {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }, 3000).unref();
}

let pythonCache;
function findPython() {
  if (pythonCache !== undefined) return pythonCache;
  const candidates = IS_WIN ? ['py -3', 'python', 'python3'] : ['python3', 'python'];
  pythonCache = null;
  for (const cmd of candidates) {
    const out = spawnSync(`${cmd} --version`, { shell: true, encoding: 'utf8', windowsHide: true });
    const version = `${out.stdout || ''}${out.stderr || ''}`.trim();
    if (out.status === 0 && /^Python 3\./.test(version)) {
      pythonCache = { cmd, version };
      break;
    }
  }
  return pythonCache;
}

// ---------------------------------------------------------------------------------------------
// Workspace files

function workspaceDir(workspaceId) {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(workspaceId || '')) throw new Error('Invalid workspace id');
  return path.join(WORKSPACES_DIR, workspaceId);
}

function resolveInWorkspace(workspaceId, rel) {
  const root = workspaceDir(workspaceId);
  const target = path.resolve(root, String(rel || '').replace(/^[/\\]+/, ''));
  if (target !== root && !target.startsWith(root + path.sep)) throw new Error(`Path escapes the workspace: ${rel}`);
  return target;
}

async function writeWorkspaceFile(workspaceId, { path: rel, content, encoding }) {
  const target = resolveInWorkspace(workspaceId, rel);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(target, encoding === 'base64' ? Buffer.from(content || '', 'base64') : content ?? '');
}

// ---------------------------------------------------------------------------------------------
// Helpers

function send(socket, payload) {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(payload));
}

function loadToken() {
  const file = path.join(HOME, 'token');
  if (args.resetToken || !fs.existsSync(file)) {
    fs.writeFileSync(file, crypto.randomBytes(18).toString('base64url'), { mode: 0o600 });
  }
  return fs.readFileSync(file, 'utf8').trim();
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function sha(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function contentType(file) {
  const types = {
    '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.js': 'text/javascript',
    '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
    '.webp': 'image/webp', '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8',
    '.md': 'text/plain; charset=utf-8',
  };
  return types[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

function parseArgs(argv) {
  const out = { allowOrigin: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') out.port = argv[++i];
    else if (a === '--root') out.root = argv[++i];
    else if (a === '--allow-origin') out.allowOrigin.push(argv[++i]);
    else if (a === '--print-token') out.printToken = true;
    else if (a === '--reset-token') out.resetToken = true;
    else if (a === '--uninstall') out.uninstall = true;
    else if (a === '--no-install') out.noInstall = true;
    else if (a === '--help' || a === '-h') {
      console.log(`inkplain-runner [--port 7077] [--root DIR] [--allow-origin ORIGIN]... [--reset-token] [--print-token] [--no-install] [--uninstall]`);
      process.exit(0);
    }
  }
  return out;
}

function log(line) {
  console.log(`[${new Date().toLocaleTimeString()}] ${line}`);
}

// ---------------------------------------------------------------------------------------------
// Install: the downloaded file is its own installer. Its first start copies it to a fixed place and
// registers the inkplain-runner:// URL scheme, so from then on the Code Editor's "Start runner"
// button starts it with one click. Per-user only, no admin rights: HKCU on Windows, ~/Applications
// on macOS, ~/.local on Linux. `--uninstall` (also wired to Windows' Installed apps) undoes it.

function installedExePath() {
  if (IS_WIN) {
    const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(local, 'Inkplain', 'Runner', 'inkplain-runner.exe');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Applications', 'Inkplain Runner.app', 'Contents', 'MacOS', 'inkplain-runner');
  }
  return path.join(os.homedir(), '.local', 'share', 'inkplain-runner', 'inkplain-runner');
}

const macAppOf = (exe) => path.resolve(exe, '..', '..', '..');
const samePath = (a, b) => (IS_WIN ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b));

function install() {
  const target = installedExePath();
  if (process.platform === 'darwin') {
    const bundle = macAppOf(process.execPath);
    if (!bundle.endsWith('.app')) throw new Error('Start the runner from "Inkplain Runner.app".');
    const appTarget = macAppOf(target);
    fs.rmSync(appTarget, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(appTarget), { recursive: true });
    fs.cpSync(bundle, appTarget, { recursive: true, verbatimSymlinks: true });
  } else {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(process.execPath, target);
    if (!IS_WIN) fs.chmodSync(target, 0o755);
  }
  registerScheme(target);
  return target;
}

function registerScheme(exe) {
  if (IS_WIN) {
    const key = `HKCU\\Software\\Classes\\${SCHEME}`;
    reg(['add', key, '/ve', '/d', 'URL:Inkplain Runner', '/f']);
    reg(['add', key, '/v', 'URL Protocol', '/d', '', '/f']);
    reg(['add', `${key}\\shell\\open\\command`, '/ve', '/d', `"${exe}" "%1"`, '/f']);
    if (SCHEME === 'inkplain-runner') {
      // Shows up in Settings → Apps → Installed apps, with Uninstall wired to --uninstall.
      const un = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\InkplainRunner';
      reg(['add', un, '/v', 'DisplayName', '/d', 'Inkplain Runner', '/f']);
      reg(['add', un, '/v', 'DisplayVersion', '/d', VERSION, '/f']);
      reg(['add', un, '/v', 'Publisher', '/d', 'Inkplain', '/f']);
      reg(['add', un, '/v', 'DisplayIcon', '/d', exe, '/f']);
      reg(['add', un, '/v', 'InstallLocation', '/d', path.dirname(exe), '/f']);
      reg(['add', un, '/v', 'UninstallString', '/d', `"${exe}" --uninstall`, '/f']);
      reg(['add', un, '/v', 'NoModify', '/t', 'REG_DWORD', '/d', '1', '/f']);
      reg(['add', un, '/v', 'NoRepair', '/t', 'REG_DWORD', '/d', '1', '/f']);
    }
    return;
  }
  if (process.platform === 'darwin') {
    // The URL scheme is declared in the bundle's Info.plist; LaunchServices only has to see the app.
    spawnSync(LSREGISTER, ['-f', macAppOf(exe)]);
    return;
  }
  const apps = path.join(os.homedir(), '.local', 'share', 'applications');
  fs.mkdirSync(apps, { recursive: true });
  fs.writeFileSync(
    path.join(apps, `${SCHEME}.desktop`),
    `[Desktop Entry]\nType=Application\nName=Inkplain Runner\nExec="${exe}" %u\nTerminal=false\nNoDisplay=true\nMimeType=x-scheme-handler/${SCHEME};\n`,
  );
  spawnSync('xdg-mime', ['default', `${SCHEME}.desktop`, `x-scheme-handler/${SCHEME}`]);
  spawnSync('update-desktop-database', [apps]);
}

const LSREGISTER =
  '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';

function reg(regArgs) {
  const out = spawnSync('reg', regArgs, { windowsHide: true, encoding: 'utf8' });
  if (out.status !== 0) throw new Error(`reg ${regArgs.slice(0, 2).join(' ')} failed: ${(out.stderr || '').trim()}`);
}

async function uninstall() {
  // Stop a running copy first, or its files cannot be removed.
  await fetch(`http://127.0.0.1:${PORT}/shutdown`, { method: 'POST', headers: { 'x-inkplain-token': TOKEN } }).catch(() => undefined);
  const exe = installedExePath();
  if (IS_WIN) {
    spawnSync('reg', ['delete', `HKCU\\Software\\Classes\\${SCHEME}`, '/f'], { windowsHide: true });
    spawnSync('reg', ['delete', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\InkplainRunner', '/f'], { windowsHide: true });
    // A running .exe cannot delete itself: let a detached cmd remove the folder once we have exited.
    // Verbatim: Node would otherwise escape the inner quotes as \" and cmd would not find the folder.
    const dir = path.dirname(exe);
    spawn('cmd.exe', ['/d', '/s', '/c', `"ping -n 5 127.0.0.1 >nul & rmdir /s /q "${dir}" & rmdir "${path.dirname(dir)}" 2>nul"`], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      windowsVerbatimArguments: true,
    }).unref();
  } else if (process.platform === 'darwin') {
    spawnSync(LSREGISTER, ['-u', macAppOf(exe)]);
    fs.rmSync(macAppOf(exe), { recursive: true, force: true });
  } else {
    fs.rmSync(path.join(os.homedir(), '.local', 'share', 'applications', `${SCHEME}.desktop`), { force: true });
    fs.rmSync(path.dirname(exe), { recursive: true, force: true });
  }
  console.log('Inkplain Runner was uninstalled.');
  console.log(`Your projects and virtualenvs are still in ${HOME} - delete that folder to free the space.`);
}

/** Starts the installed copy in its own window (Windows) / in the background (macOS, Linux). */
function startInstalled(exe) {
  if (IS_WIN) {
    spawn('cmd.exe', ['/d', '/s', '/c', `start "" "${exe}"`], { detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true }).unref();
  } else if (process.platform === 'darwin') {
    spawn('open', [macAppOf(exe)], { detached: true, stdio: 'ignore' }).unref();
  } else {
    spawn(exe, [], { detached: true, stdio: 'ignore' }).unref();
  }
}

function isRunnerUp() {
  return fetch(`http://127.0.0.1:${PORT}/health`, { signal: AbortSignal.timeout(800) })
    .then(async (r) => r.ok && (await r.json()).name === 'inkplain-local-runner')
    .catch(() => false);
}

/** Leaves the console readable for a moment when the window will close with the process. */
const exitSoon = (code, ms = IS_WIN ? 4000 : 0) => setTimeout(() => process.exit(code), ms);

function serve() {
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') console.error(`Port ${PORT} is busy - is another runner already running? Use --port.`);
    else console.error(err);
    exitSoon(1);
  });

  server.listen(PORT, '127.0.0.1', () => {
    console.log(`\nInkplain Runner v${VERSION}`);
    console.log(`  Address     ws://127.0.0.1:${PORT}`);
    console.log(`  Workspaces  ${WORKSPACES_DIR}`);
    console.log(`  Venvs       ${VENVS_DIR}`);
    console.log(`  Python      ${findPython()?.version || 'not found - install Python 3 for Python projects'}`);
    console.log(`  Origins     ${[...ALLOWED_ORIGINS].join(', ')}`);
    console.log(`\nThe Code Editor connects by itself. Close this window to stop the runner.\n`);
  });
}

async function main() {
  if (args.uninstall) {
    await uninstall();
    return exitSoon(0);
  }
  // Clicking "Start runner" twice, or a second double-click, must not start a second copy.
  if (await isRunnerUp()) {
    console.log('Inkplain Runner is already running - you can close this window.');
    return exitSoon(0);
  }
  if (IS_PACKAGED && !args.noInstall) {
    const target = installedExePath();
    if (!samePath(process.execPath, target)) {
      // Started from the download: install, hand over to the installed copy, and leave.
      try {
        install();
        console.log(`Inkplain Runner ${VERSION} is installed.`);
        console.log('From now on the Code Editor starts it with its "Start runner" button. Starting it now...');
        startInstalled(target);
        return exitSoon(0);
      } catch (err) {
        console.error(`Could not install (${err.message}) - running from here instead.`);
      }
    } else {
      // Already the installed copy; re-registering keeps the scheme pointing here after updates.
      try {
        registerScheme(target);
      } catch (err) {
        console.error(`Could not register the ${SCHEME}:// link: ${err.message}`);
      }
    }
  }
  serve();
}

main();
