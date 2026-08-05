# Changelog

[中文版](CHANGELOG.zh-cn.md)

## [0.1.6] - 2026-08-05
### Features
- Unit test infrastructure using node:test + vscode mock (no new dependencies), 70 test cases covering Webview loading state transitions and judgment
- Extracted `stateUtils` to share the Webview state persistence logic across extension, webview, and unit tests

### Fixes
- Switching the sidebar no longer reloads an already-loaded webview (`retainContextWhenHidden` + silent health check in `ready` state)

---

## [0.1.4] - 2026-06-07
### Features
- Context menu commands no longer require text selection
- `appendCode` now includes line number info
- New config for terminal startup delay
- Opening OpenCode web (webview/browser) uses the workspace root as the project directory

### Fixes
- Fixed config key migration omission, unified under the `opencode-web` namespace

---

## [0.1.3] - 2025-06-07
### Features
- Added option to kill OpenCode process when VSCode closes (`opencode-web.killOnExit`)
- Added settings menu in sidebar for quick access to extension configuration
- Detect and connect to externally running OpenCode processes (configure port to match external process)
- Auto-migrate settings from old `opencode.*` config keys to `opencode-web.*`

### Refactoring
- Renamed configuration keys from `opencode` to `opencode-web` with automatic migration

---

## [0.1.2] - 2025-05-23
### Features
- Multi-language support (English, Chinese, Japanese, Korean)

### Refactoring
- Refactored WebviewProvider architecture

---

## [0.1.1] - Initial Release

### Features
- VSCode terminal integration for OpenCode process management
- Dual terminal architecture (background daemon + TUI terminal)
- Cross-shell compatibility (PowerShell, cmd, Git Bash, WSL)
- Webview panel supports both sidebar and editor views
- Language switching functionality
- Language status and process health debugging commands
- Process health monitoring and debugging tools

---