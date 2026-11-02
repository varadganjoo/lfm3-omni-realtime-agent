# Architecture

The app has three local processes and one browser client. It intentionally avoids a cloud media provider, TURN service, vector database and generic tool-execution framework.

## Process map

| Process | Default address | Responsibility |
| --- | --- | --- |
| Node | `127.0.0.1:8787` | UI, sessions, media gateway, agent loop and file persistence |
| Pipecat / FastAPI | `127.0.0.1:8788` | PCM/video input, Silero VAD, turn buffers, interruption and speech output |
| llama.cpp | `127.0.0.1:8081` | LFM3 native multimodal inference and local speech synthesis |

Optional LAN listeners add HTTPS/WSS on port 8443 and public-certificate help on 8789. They do not expose the model or Python service directly.

## One spoken turn

1. `src/web/capture.js` emits mono PCM16 in 20 ms, 16 kHz packets. `src/web/live.js` also sends reduced 320x240 JPEG frames at 2 fps while the camera is enabled.
2. The Node upgrade handler validates Host, Origin and the browser's session. It inserts the internal key/session when proxying to Pipecat.
3. Pipecat Silero detects speech onset and approximately 0.9 seconds of trailing silence. `TurnBuffer` retains audio preroll and at most twelve recent camera frames.
4. At a turn boundary, PyAV encodes the ordered frames as a real VP8 WebM clip; audio becomes WAV. This is video input, not a single snapshot pretending to be video.
5. Pipecat calls the Node agent. `runTurn` sends media and recent conversation through `/v1/chat/completions`, then handles at most four rounds of validated tools.
6. The resulting text goes to the same local model's `/tts` endpoint. Float PCM is converted to PCM16 and streams through Pipecat to browser Web Audio playback at 24 kHz.

Typed requests use the same agent loop. Outside a live call, the browser receives a WAV reply with native audio controls.

## Interruption and stopping

Speech onset cancels the prior inference/speech task and broadcasts a Pipecat interruption. The browser clears scheduled audio. Generation numbers keep a late answer from restarting interrupted playback.

Stop agent also closes the media socket, releases all media tracks, pauses typed audio and requests server cancellation. A device-permission result arriving after disconnect is discarded. The recent user request stays in short-term context so a spoken continuation can finish an interrupted command.

Completed note writes remain saved. Stopping a confirmation cannot roll back an action that already finished.

## Tools and memory

`src/server/agent.mjs` owns two tools:

- `save_note`: bounded title/body, server-generated Markdown filename, fixed notes directory.
- `remember_fact`: bounded stable key/value, replace-by-key corrections and a maximum of 100 facts. The latest 30 enter model context as fallible data.

Only spoken/typed requests authorize actions. Camera text and saved facts are instructed to remain data. This is a guardrail, not a claim that a small model is immune to prompt injection or misunderstanding.

No weights are trained. The last two user turns live in memory; persistent facts and notes live in ignored `data/`.

## Deliberate limits

One live call, one model request, twenty seconds of audio per turn, six seconds of video context, 8,192 configured context tokens, bounded uploads/tools and a 30-minute media session. The model does not inspect the world continuously while speaking. Native simultaneous full-duplex audio/video decoding is not implemented.

The transport is Pipecat's FastAPI WebSocket transport. WebRTC is not part of the supported path; this avoids ICE/TURN configuration for the initial experiment.

## Interface

The UI uses native HTML/CSS/JavaScript with system fonts and no CDN assets. A neutral light/dark palette, conversation-first layout and sticky call controls keep the prototype usable without a framework migration. Design variance 5, motion intensity 2 and visual density 5. The skill's marketing imagery/scroll choreography does not apply to this control surface.
