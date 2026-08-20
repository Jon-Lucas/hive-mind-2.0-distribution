#!/bin/bash
# Restart the always-on Discord Claude Code session (com.local.claude-discord),
# which is how you clear its context — a restarted session starts empty.
#
# The restart is scheduled a few seconds out and detached, because kickstart
# kills the very session that ran this script. Without the delay the Discord
# reply never leaves the machine and the request looks like it hung.
UID_NUM=$(id -u)
nohup bash -c "sleep 8; launchctl kickstart -k gui/${UID_NUM}/com.local.claude-discord" \
  >/dev/null 2>&1 &
echo "Restart scheduled in 8s — send your reply now, then this session ends."
exit 0
