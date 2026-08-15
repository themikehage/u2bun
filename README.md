# u2bun — Ultra-Fast Bun/TypeScript Android Controller

`u2bun` is a zero-dependency, high-efficiency TypeScript/Bun implementation providing Android device control backed by a native `uiautomator2` JSON-RPC client over ADB.

Designed specifically for AI agent interaction loops, `u2bun` prioritizes LLM context window efficiency, minimal token footprint, and sub-15ms execution via a background daemon.

## CLI Usage

```bash
bun run src/index.ts [--serial SERIAL] <domain> <command> [flags...]
```

## Available Domains & Commands

- `ui`: `snapshot` (compact semantic tree with `@1..@N` handles), `tap` (`--ref @1`), `input`, `swipe`, `press`, `wait`, `long_press`, `dump`
- `app`: `current`, `start`, `stop`, `list`
- `device`: `list`, `status`, `info`, `reconnect`
- `setup`: `verify`, `install`, `diagnose`
- `tools`: `list`, `show`, `schema`

## Ultra-Fast Agent Interaction (Handle-First)

Always prefer `ui snapshot` over `ui dump` to save 85%+ tokens on LLM context windows:

```bash
# 1. Get compact text snapshot with element handles (@1, @2, ...)
bun run src/index.ts --serial da0f5e72 ui snapshot

# Output:
# [App: com.google.android.youtube | fingerprint: 61fa698c]
# [@1] Input "Search"
# [@2] Button "All"
# [@3] Item "Video 1"

# 2. Tap element directly by ref handle (sub-15ms via background daemon)
bun run src/index.ts --serial da0f5e72 ui tap --ref @1

# Output:
# ok
```

## Development & Testing

```bash
# Run unit tests
bun test tests/unit
```
