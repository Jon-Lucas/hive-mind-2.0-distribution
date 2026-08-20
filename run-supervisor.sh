#!/bin/bash
# Launched by ~/Library/LaunchAgents/com.local.hive-mind.plist at login.
# launchd gives a process a minimal PATH, so node/npm from ~/.local/bin are put
# back on it explicitly rather than relying on the login shell.
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
cd "$HOME/hive-mind-2.0" || exit 1
mkdir -p logs
# Android verification runs boot an emulator and run Gradle via blocking
# spawnSync, which starves the heartbeat for well over the 20s default and
# gets the whole run killed mid-test — see the Ebb project README's own
# account of this. 2h covers the longest real android-emulator target.
export HIVE_BACKEND_HEARTBEAT_TIMEOUT_MS=7200000
# exec so launchd supervises node directly and KeepAlive restarts the right pid.
exec node --import tsx src/supervisor.ts
