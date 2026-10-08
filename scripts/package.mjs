// Builds the downloadable runner for THIS machine's OS/arch (it embeds the local node binary as a
// Node single executable application, so the user needs no Node). CI runs it once per platform.
//
//   Windows  dist/inkplain-runner-setup-win-x64.exe   — the file itself is the installer
//   macOS    dist/inkplain-runner-mac-<arch>.zip      — "Inkplain Runner.app" (an app cannot be one file)
//   Linux    dist/inkplain-runner-linux-<arch>        — the binary itself
//
//   npm run package

import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const work = path.join(root, 'build');
const dist = path.join(root, 'dist');
const { platform, arch } = process;

fs.rmSync(work, { recursive: true, force: true });
fs.mkdirSync(work, { recursive: true });
fs.mkdirSync(dist, { recursive: true });

// 1. One CommonJS file — a single executable runs a single script, with no node_modules.
await build({
  entryPoints: [path.join(root, 'runner.mjs')],
  outfile: path.join(work, 'runner.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  // ws loads these native speed-ups inside try/catch and falls back to JS without them. Telling it
  // not to try keeps the SEA's "require() only supports built-in modules" warning out of the window.
  external: ['bufferutil', 'utf-8-validate'],
  banner: { js: "process.env.WS_NO_BUFFER_UTIL='1';process.env.WS_NO_UTF_8_VALIDATE='1';" },
  logLevel: 'warning',
});

// 2. Node's SEA blob, injected into a copy of this node binary.
const seaConfig = path.join(work, 'sea-config.json');
fs.writeFileSync(
  seaConfig,
  JSON.stringify({ main: path.join(work, 'runner.cjs'), output: path.join(work, 'sea-prep.blob'), disableExperimentalSEAWarning: true }),
);
execFileSync(process.execPath, ['--experimental-sea-config', seaConfig], { stdio: 'inherit' });

const exe = path.join(work, platform === 'win32' ? 'inkplain-runner.exe' : 'inkplain-runner');
fs.copyFileSync(process.execPath, exe);
if (platform === 'darwin') execFileSync('codesign', ['--remove-signature', exe]);
execFileSync(
  process.execPath,
  [
    path.join(root, 'node_modules', 'postject', 'dist', 'cli.js'),
    exe,
    'NODE_SEA_BLOB',
    path.join(work, 'sea-prep.blob'),
    '--sentinel-fuse',
    'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
    ...(platform === 'darwin' ? ['--macho-segment-name', 'NODE_SEA'] : []),
  ],
  { stdio: 'inherit' },
);
if (platform !== 'win32') fs.chmodSync(exe, 0o755);

// 3. The artifact the Code Editor links to.
let artifact;
if (platform === 'win32') {
  artifact = path.join(dist, `inkplain-runner-setup-win-${arch}.exe`);
  fs.copyFileSync(exe, artifact);
} else if (platform === 'darwin') {
  // The inkplain-runner:// scheme lives in Info.plist; LSUIElement keeps it out of the Dock, since
  // it is a background helper (the Code Editor shows its state and has the Stop button).
  const app = path.join(work, 'Inkplain Runner.app');
  fs.mkdirSync(path.join(app, 'Contents', 'MacOS'), { recursive: true });
  fs.copyFileSync(exe, path.join(app, 'Contents', 'MacOS', 'inkplain-runner'));
  fs.chmodSync(path.join(app, 'Contents', 'MacOS', 'inkplain-runner'), 0o755);
  fs.writeFileSync(path.join(app, 'Contents', 'Info.plist'), infoPlist(pkg.version));
  // Apple Silicon will not start an unsigned binary at all; an ad-hoc signature is enough to start.
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app]);
  artifact = path.join(dist, `inkplain-runner-mac-${arch}.zip`);
  fs.rmSync(artifact, { force: true });
  execFileSync('ditto', ['-c', '-k', '--keepParent', app, artifact]);
} else {
  artifact = path.join(dist, `inkplain-runner-${platform}-${arch}`);
  fs.copyFileSync(exe, artifact);
  fs.chmodSync(artifact, 0o755);
}

console.log(`\n${path.relative(root, artifact)}  (${(fs.statSync(artifact).size / 1024 / 1024).toFixed(1)} MB)`);

function infoPlist(version) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Inkplain Runner</string>
  <key>CFBundleDisplayName</key><string>Inkplain Runner</string>
  <key>CFBundleIdentifier</key><string>com.inkplain.runner</string>
  <key>CFBundleVersion</key><string>${version}</string>
  <key>CFBundleShortVersionString</key><string>${version}</string>
  <key>CFBundleExecutable</key><string>inkplain-runner</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>LSUIElement</key><true/>
  <key>CFBundleURLTypes</key>
  <array>
    <dict>
      <key>CFBundleURLName</key><string>com.inkplain.runner</string>
      <key>CFBundleURLSchemes</key><array><string>inkplain-runner</string></array>
    </dict>
  </array>
</dict>
</plist>
`;
}
