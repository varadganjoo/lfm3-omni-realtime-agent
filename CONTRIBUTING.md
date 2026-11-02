# Contributing

Keep the experiment small and runnable locally. Discuss larger changes in an issue first.

1. Describe the behavior you want to change and the smallest way to reproduce it.
2. Keep model output and camera text untrusted. New tools need explicit input validation and a clear account of their effects.
3. Run the unit tests in [the verification guide](docs/live-verification.md). Media or interruption changes also need the local live smoke test.
4. For UI changes, check light and dark themes, phone and desktop widths, keyboard focus, errors and the Stop agent control.
5. Check every staged file before committing. Exclude model files, `runtime/`, `data/`, `.env` files, attachments, credentials, LAN addresses from your own environment and real recordings.

Use synthetic examples in issues and screenshots. Include versions and a redacted reproduction instead of personal conversation logs.
