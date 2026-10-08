# Inkplain Runner

Runs Inkplain practical cases (Python, FastAPI, MCP servers, ...) on your own computer, so the
**Inkplain Code Editor** in your browser can start them and call them on `http://localhost`.

## Install

Download the file for your system from the [latest release](https://github.com/Inkplain-Practical-Cases/inkplain-local-runner/releases/latest) — the Code Editor links to the right one:

| System | File | First start |
|---|---|---|
| Windows | `inkplain-runner-setup-win-x64.exe` | Open it. If Windows says "Windows protected your PC", click **More info → Run anyway**. |
| macOS (Apple Silicon) | `inkplain-runner-mac-arm64.zip` | Open `Inkplain Runner.app`. If macOS blocks it: right-click → **Open**, or System Settings → Privacy & Security → **Open Anyway**. |
| macOS (Intel) | `inkplain-runner-mac-x64.zip` | Same as above. |
| Linux (x64 / ARM64) | `inkplain-runner-linux-x64` / `-arm64` | `chmod +x inkplain-runner-linux-x64 && ./inkplain-runner-linux-x64` |

The first start installs it for your user only (no admin rights) and registers the
`inkplain-runner://` link. After that the Code Editor's **Start runner** button starts it with one
click, and the editor connects by itself — nothing to copy or paste.

Python projects also need [Python 3](https://www.python.org/downloads/).

| | Installed to |
|---|---|
| Windows | `%LOCALAPPDATA%\Inkplain\Runner` — listed in Settings → Apps → Installed apps |
| macOS | `~/Applications/Inkplain Runner.app` |
| Linux | `~/.local/share/inkplain-runner` |

Uninstall: Windows → Installed apps → Inkplain Runner → Uninstall; elsewhere run the installed binary
with `--uninstall`. Projects and virtualenvs stay in `~/.inkplain-runner` until you delete it.

## What it does

- Keeps the editor's project files in `~/.inkplain-runner/workspaces`; edits are mirrored as you type,
  so `uvicorn --reload` and dev servers pick them up.
- **Run** in the editor: creates a Python virtualenv and installs `requirements.txt` (or runs
  `npm install`), then starts the project. Virtualenvs are shared by `requirements.txt` content in
  `~/.inkplain-runner/venvs`, so heavy packages (torch, ...) install only once.
- The editor's Terminal runs commands in the project folder with its virtualenv first on `PATH`.
- Servers it starts listen on your computer (`localhost`); the editor's API client and preview call them there.
- Closing the editor tab stops the programs it started; **Stop runner** in the editor stops the runner itself.

## Security

The runner listens on `127.0.0.1` only. A connection needs an allowed browser origin
(`https://app.inkplain.com`, plus `http://localhost:8076` for development) and a per-machine token
from `~/.inkplain-runner/token`, which the runner only hands to those same origins. Extra origins:
`--allow-origin <origin>` or `INKPLAIN_RUNNER_ORIGINS=a,b`.

## Development

```bash
npm install
npm start          # runs from source in this terminal (never installs itself)
npm run package    # builds this OS's download into dist/
```

Publishing a GitHub release runs `.github/workflows/build.yml`, which builds all five downloads on
their own OS and attaches them to the release. The downloads are not code-signed yet, hence the
Windows SmartScreen / macOS Gatekeeper prompts.

| Flag | |
|---|---|
| `--port 7077` | also `INKPLAIN_RUNNER_PORT` |
| `--root DIR` | data folder, default `~/.inkplain-runner` (also `INKPLAIN_RUNNER_HOME`) |
| `--allow-origin ORIGIN` | extra browser origin allowed to connect (repeatable) |
| `--no-install` | run the downloaded file in place without installing |
| `--uninstall` | remove the install and the `inkplain-runner://` link |
| `--reset-token` / `--print-token` | new token / print it |
