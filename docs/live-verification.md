# Verification

This guide separates offline checks from tests that need the local model, and from checks requiring real hardware. It is not a production-readiness or compliance certificate.

## Offline unit tests

Install the locked Python environment first, then run:

```powershell
npm test
.\.venv\Scripts\python.exe -m unittest discover -s tests -p 'test_*.py' -v
```

Coverage includes note path confinement, memory persistence/correction, tool argument validation, bounded tool loops, microphone packet format, stale-response rejection, late device-permission cleanup, device/socket release, real ordered WebM encoding, audio bounds and cancellation generation ordering. Missing internal credentials prevent service startup without making modules unimportable for tests.

Offline unit tests do not need model downloads, a GPU, a microphone or private runtime files. The repository workflow runs this subset on a clean checkout.

The publication candidate includes 16 JavaScript tests and 7 Python tests. The exported clean snapshot is tested without private runtime files. A running-service test using the generated speech fixture passed video color order, streamed speech, spoken interruption, stale-audio rejection and the requested note title/body. These are reference test results, not a guarantee of model accuracy on new requests.

## Running-service checks

```powershell
.\.venv\Scripts\python.exe scripts/access_smoke.py
.\scripts\make-test-audio.ps1
.\.venv\Scripts\python.exe scripts/live_smoke.py
```

The access smoke test checks missing-session/wrong-origin media rejection, private model/media authentication, cross-origin writes and untrusted video-source rejection.

The live smoke test uses generated red/blue frames plus Windows' local speech synthesizer. It checks temporal video understanding, streamed speech, spoken interruption, stale-audio rejection and an actual note write with the requested title/body. Only its own synthetic notes are removed.

The test is model-driven. A failed tool call, a spoken pause splitting a command, or an incorrect answer is a failure to investigate, not a reason to weaken the assertion.

## Optional LAN checks

After enabling LAN mode:

```powershell
.\.venv\Scripts\python.exe scripts/lan_smoke.py
.\.venv\Scripts\python.exe scripts/live_smoke.py --lan
```

These verify the TLS chain/IP using the generated CA explicitly, secure browser cookies, host/origin rejection, encrypted media, public-certificate fingerprint and help-listener isolation. They do not install a root into the OS or browser.

## Manual browser checks

- Light and dark appearances, desktop and phone widths, no horizontal overflow.
- Typed request, reply audio, stop during generation and playback, and a new chat.
- Keyboard focus, labelled fields, memory/notes disclosure and readable errors.
- Physical camera/microphone permissions, actual room echo and interruption behavior with headphones.
- HTTPS from a second physical device, including its certificate trust and browser-specific network permissions.

Reference local runs have exercised the model/media flow, note saving, host-rendered UI and LAN TLS from the host. Physical-phone live-call coverage and calibrated speaker/microphone testing remain incomplete. Timings depend on hardware and are not published as model benchmarks.

## Publishing checks

Run `npm run check:publication` against staged files and use a dedicated secret scanner as well. Review the staged diff and every binary asset. The guard checks personal paths, emails, private network addresses outside test fixtures and sensitive files; it does not replace credential scanning or manual review.

Model downloads, internal keys, TLS files, notes, memory, logs, attachments and recordings are excluded. Project screenshots use synthetic example content. Host runtime and native-binary advisory review, broad adversarial model evaluation and screen-reader/Lighthouse audits are separate from the unit tests.

The CI workflow also runs `detect-secrets` 1.5.0 on tracked files with network verification disabled. Four public artifact SHA-256 checksums in `scripts/setup.ps1` are explicitly marked as non-secret values; files and detector classes are not broadly excluded.
