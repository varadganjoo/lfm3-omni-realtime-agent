# Native voice experiment

During a call, choose **Attach an image** to send a JPEG, PNG or WebP with a typed question. The browser resizes the image and sends it to the local server. The attachment supplies visual context for that turn in place of the recent webcam clip.

In the local app, select **Start live**. Allow the microphone and optionally enable **Use camera**. Speak over a reply or use **Interrupt** to stop it. **Stop agent** releases the microphone and native model session.

## What runs locally

Pipecat still detects speech boundaries and buffers up to twenty seconds of audio. At the end of the turn, the adapter sends PCM16 chunks to LFM3 through llama.cpp's loopback `/v1/realtime` WebSocket. The model transcribes speech locally in a separate inference pass and receives the original audio in the native session. Speech output streams back at 24 kHz, with no `/tts` call or external speech model.

The session uses the existing `save_note` and `remember_fact` tools. The Node service retains validation and storage ownership. The private bootstrap/action endpoint requires the internal engine key and the owning browser session. Other app turns are rejected while a native call is active. A second slot in the same local server describes the recent camera clip at the start of each turn. The native voice model receives that description as untrusted text alongside the request. This adds latency, and details omitted by the description are unavailable to the voice session.

## Output selection

In local tests, forcing interleaved output on a spoken action request could produce a spoken intention without a tool call. Automatic selection issued the tool correctly, but could return text only. The adapter therefore:

1. Uses text for initial tool selection on camera turns and automatic output selection on voice-only turns.
2. Executes bounded, validated tools, then requests interleaved speech after the results.
3. If an ordinary reply contains text but no audio, requests a speech continuation in the same session with tool choice disabled. Unexpected actions in that continuation are rejected.

This may require more than one native response. It is not a single-pass or full-duplex guarantee, and it does not exercise incremental microphone prefill during speech yet.

## Interruption and context

Interruption invalidates the browser generation and flushes playback, sends `response.cancel`, and drains late events before another native response starts. Completed writes remain saved. Cancelled output can remain in the model's conversation context even if you did not hear all of it.

Native context lasts for the call and is bounded by the configured model context. Restart the call if it fills or becomes confused. Forgetting a persistent fact does not remove it from an already-open model context; start a new call afterward. An interrupted partial audio upload reconnects to discard it, which resets conversational context while preserving saved notes/facts.

The native session holds its inference slot until disconnect. If the media process crashes independently and leaves the app reporting the model as occupied, restart all services with the Stop/Start scripts. There is no independent lease-recovery service in this prototype.

## Verify

```powershell
npm test
.\.venv\Scripts\python.exe -m unittest discover -s tests -p 'test_*.py' -v
.\scripts\make-test-audio.ps1
.\.venv\Scripts\python.exe scripts/live_smoke.py
# Optional, with existing LAN configuration:
.\.venv\Scripts\python.exe scripts/live_smoke.py --lan
```

The native smoke test checks streamed speech, spoken barge-in without stale audio, an actual spoken note write and confirmation, persistent memory, model-slot exclusion and release on disconnect. It removes only its synthetic note and uniquely keyed memory. These host-driven checks do not replace physical microphone, echo or phone-browser testing. Windows Python may log a non-fatal socket-reset callback while the HTTPS test disconnects; check the final PASS/exit status.
