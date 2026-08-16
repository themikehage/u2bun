---
name: u2bun
description: Android UI Automator control CLI for token-efficient agent automation
---

# u2bun Skill Guide

`u2bun` is a zero-dependency, token-efficient Android UI Automator control CLI written in Bun/TypeScript.

## Core Invariants

1. **PowerShell Handle Quoting**: In PowerShell, always quote element handles (`--ref "@1"`) to prevent shell expansion of `@`.
2. **Handle-First Action Pattern**: Prefer `--ref "@N"` selectors derived from `ui snapshot` over raw coordinates or nested selectors.
3. **Minimal Token Footprint**: CLI outputs `ok` for successful actions and raw compact trees for snapshots.

---

## Command Reference

### Device Management (`device`)

- **Unlock screen**:
  ```bash
  bun run src/index.ts device unlock
  ```
- **Wake screen**:
  ```bash
  bun run src/index.ts device wake
  ```
- **Check screen state**:
  ```bash
  bun run src/index.ts device screen
  # Returns: on | off
  ```
- **Clipboard Management**:
  ```bash
  bun run src/index.ts device clipboard --action get
  bun run src/index.ts device clipboard --action set --text "hello"
  ```
- **List devices**:
  ```bash
  bun run src/index.ts device list
  ```
- **Device Info**:
  ```bash
  bun run src/index.ts device info
  ```

### App Lifecycle (`app`)

- **Start application**:
  ```bash
  bun run src/index.ts app start --package com.example.app
  ```
- **Restart application** (force-stop + start):
  ```bash
  bun run src/index.ts app restart --package com.example.app
  ```
- **Stop application**:
  ```bash
  bun run src/index.ts app stop --package com.example.app
  ```
- **Reset app data / cache** (pm clear):
  ```bash
  bun run src/index.ts app clear --package com.example.app
  ```
- **Open URL / Deep link**:
  ```bash
  bun run src/index.ts app open_url --url "https://example.com"
  bun run src/index.ts app open_url --url "fb://profile"
  ```
- **Grant permissions**:
  ```bash
  bun run src/index.ts app grant_permissions --package com.example.app --permissions POST_NOTIFICATIONS,CAMERA
  ```
- **Get current foreground app**:
  ```bash
  bun run src/index.ts app current
  ```

### UI Interaction (`ui`)

- **Take snapshot**:
  ```bash
  bun run src/index.ts ui snapshot
  ```
- **Tap element**:
  ```bash
  bun run src/index.ts ui tap --ref "@1"
  ```
- **Type into input field**:
  ```bash
  bun run src/index.ts ui type --ref "@2" --text "Hello world"
  ```
- **Scroll with automatic snapshot** (saves 1 round-trip):
  ```bash
  bun run src/index.ts ui scroll --direction down --snapshot
  ```
- **Drag & drop**:
  ```bash
  bun run src/index.ts ui drag --from-ref "@1" --to-ref "@3"
  ```
- **Pinch zoom**:
  ```bash
  bun run src/index.ts ui pinch --ref "@2" --direction in
  bun run src/index.ts ui pinch --ref "@2" --direction out
  ```
- **Notifications**:
  ```bash
  bun run src/index.ts ui notifications --action expand
  bun run src/index.ts ui notifications --action read
  bun run src/index.ts ui notifications --action collapse
  ```
- **Screenshot** (saves PNG to local path):
  ```bash
  bun run src/index.ts ui screenshot
  bun run src/index.ts ui screenshot --output path/to/screen.png
  ```
- **Hardware keys**:
  ```bash
  bun run src/index.ts ui press --key back
  bun run src/index.ts ui press --key home
  bun run src/index.ts ui press --key enter
  ```
- **Hide keyboard / IME**:
  ```bash
  bun run src/index.ts ui keyboard_hide
  ```

---

## Contextual Help

Get full options for any domain or command:
```bash
bun run src/index.ts <domain> --help
bun run src/index.ts <domain> <command> --help
```

