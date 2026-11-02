# Security and privacy

This is a personal testing prototype. It is not designed for public internet hosting, multiple untrusted users or high-impact actions.

## Expected boundaries

- Inference uses the local model after the initial downloads. The app has no cloud inference endpoint or browser CDN dependency.
- Browser camera/microphone access starts only after Start live and browser permission. Stop agent releases the devices and cancels pending work.
- Notes and memories are plaintext on the host under `data/`. They are intentionally shared across this instance's browser sessions.
- Optional LAN access has no login or access code. Any client on the configured subnet can use the app and access its notes/memory. Only enable it on a network whose users you trust.
- llama.cpp and Pipecat stay on loopback behind a generated internal key. That key is not a user login and is never shipped in source.
- The only model tools save notes and update memory. Tool arguments are validated; the model cannot select arbitrary filesystem destinations or run shell commands.
- A completed tool action is not undone by interruption. Review saved notes and memory after stopping a reply.

## Before sharing code or diagnostics

Review staged files and run a secret scanner. Never include `runtime/`, `models/`, `data/`, `.venv/`, `.codex-remote-attachments/`, certificates, private keys, `.env` files or real recordings. `.gitignore` helps but does not make already-tracked files private.

Use the repository's private vulnerability-reporting channel when available. Otherwise, open a minimal issue asking for a private contact method. Do not post credentials, private data or a working exploit with sensitive effects in a public issue.

No production security certification is claimed. Package advisory scans do not establish that the model, host runtimes, native binaries or agent behavior are safe for every use.
