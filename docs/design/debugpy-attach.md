# Attach to a running debugpy server

An existing server exposes a debugpy DAP endpoint, for example a container port forwarded to
`127.0.0.1:5679`. A `type: "pyokka"`, `request: "attach"` configuration connects to that endpoint.
The process keeps its environment, authentication and working directory.

The extension returns VS Code's `DebugAdapterServer` for attach. Debugpy handles the DAP
handshake, breakpoints, frames, variables, stepping and source path mappings. Launch and replay
keep the existing inline adapter. No local interpreter or Python extension is needed to attach.

The configuration requires `connect.port` (1–65535). An omitted `connect.host` means
`127.0.0.1`. Optional `pathMappings` pairs `localRoot` with `remoteRoot`; VS Code substitutes
workspace variables before validation, and debugpy interprets the paths. Remote paths are never
normalized with the client's operating system. `justMyCode` selects whether to step into libraries.
Launch-only options and recording requests fail with an explanation before any connection.

Normal Stop/Disconnect detaches from the server. Explicit termination remains a separate VS Code
action. Attach has no Pyokka recording, Time Machine, Debugger panel or CLI/MCP session. Process
injection (`processId`) and reverse connections (`listen`) are outside this change.

Verification:

- Unit tests check configuration validation, variable substitution timing and descriptor selection.
- A VS Code test starts an authenticated HTTP server under debugpy before attaching. Two source
  directories simulate container and local paths. A mapped breakpoint pauses an HTTP request,
  locals and stepping work, and disconnect resumes the request. The same PID serves authenticated
  requests after disconnect and accepts a second attach.

Run `./node_modules/.bin/vscode-test --run test/e2e/debug-attach.test.js` for the attach test.
Debugpy is a test dependency in `python/pyproject.toml`, installed by `uv sync --group dev`
from `python/`.

References: [debugpy listen](https://github.com/microsoft/debugpy/wiki/API-Reference),
[debugpy path mappings](https://github.com/microsoft/debugpy/wiki/Debugging-over-SSH),
[VS Code DebugAdapterServer](https://code.visualstudio.com/api/references/vscode-api#DebugAdapterServer).
