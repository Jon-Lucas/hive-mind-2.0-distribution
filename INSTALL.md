# Hive Mind 2.0 Install

This distribution repository contains the installable Hive Mind 2.0 source without the development repo history or local operator handoff files.

## Requirements

- macOS or Linux
- Node.js 22+
- Git
- Authenticated `codex` and `claude` CLIs, or OpenAI/Anthropic API keys

## Setup

```bash
npm install
cp .env.example .env
npm run check
npm run supervise
```

Open `http://127.0.0.1:4401`.

If the setup screen reports missing model access, either run:

```bash
codex login
claude login
```

or paste the relevant API key into the setup screen.

## Notes

- `.env` is intentionally ignored. Do not commit credentials.
- `HIVE_WORKSPACE` must be an absolute path and should point outside this repository.
- Discord integration is optional.
- This repository is for installation and evaluation. Send code changes upstream through the owner rather than treating this as the development source of truth.
