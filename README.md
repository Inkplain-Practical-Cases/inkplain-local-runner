# Inkplain Local Runner

Runs Inkplain practical cases (Python, FastAPI, MCP servers, ...) on your own computer, so the
**Inkplain Code Editor** in your browser can start them and call them on `http://localhost`.

## Install

1. Download the zip for your system from the [latest release](https://github.com/Inkplain-Practical-Cases/inkplain-local-runner/releases/latest):
   - Windows: `inkplain-runner-win-x64.zip`
2. Unzip it and start `inkplain-runner` (on Windows: double-click `inkplain-runner.exe`).
   Windows may show "Windows protected your PC" — click **More info → Run anyway**.
3. Go back to the Code Editor — it finds the runner and connects by itself.
   Keep the runner window open while you work.

Python projects also need [Python 3](https://www.python.org/downloads/).

## What it does

- Keeps the editor's project files in `~/.inkplain-runner/workspaces`.
- **Run**: creates a Python virtualenv and installs `requirements.txt` (or runs `npm install`), then starts the project.
  Virtualenvs are shared in `~/.inkplain-runner/venvs`, so a project's packages install only once.
- Servers it starts listen on your computer (`localhost`), and only Inkplain's own site can connect to the runner.
