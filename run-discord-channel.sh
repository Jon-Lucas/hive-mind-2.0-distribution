#!/bin/bash
# Launched by ~/Library/LaunchAgents/com.local.claude-discord.plist at login.
# Keeps a Claude Code session open so the Discord channel can deliver messages:
# channel events only arrive while a session is running.
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
cd "$HOME/hive-mind-2.0" || exit 1
mkdir -p logs

# Claude Code needs a terminal. screen -D -m gives it a pty without forking, so
# launchd supervises this process directly and KeepAlive works. Attach any time
# with:  screen -r claude-discord
exec /usr/bin/screen -D -m -S claude-discord \
  claude --model sonnet --effort medium --channels plugin:discord@claude-plugins-official --dangerously-skip-permissions
