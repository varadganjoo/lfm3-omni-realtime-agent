"""Local Pipecat media pipeline for LFM3-Omni, with spoken barge-in."""

import asyncio
import contextlib
import hmac
import math
import sys
import time
from contextlib import asynccontextmanager
from pathlib import Path

import aiohttp
from fastapi import FastAPI, WebSocket
from loguru import logger

from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.audio.vad.vad_analyzer import VADParams
from pipecat.frames.frames import (
    BotStartedSpeakingFrame, BotStoppedSpeakingFrame, CancelFrame, EndFrame,
    InputAudioRawFrame, InputImageRawFrame, InputTransportMessageFrame,
    InterruptionFrame, OutputTransportMessageUrgentFrame,
    TTSAudioRawFrame, TTSStartedFrame, TTSStoppedFrame,
    VADUserStartedSpeakingFrame, VADUserStoppedSpeakingFrame,
)
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.worker import PipelineParams, PipelineWorker
from pipecat.processors.audio.vad_processor import VADProcessor
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from pipecat.transports.websocket.fastapi import FastAPIWebsocketParams, FastAPIWebsocketTransport
from pipecat.workers.runner import WorkerRunner

from .live_media import TurnBuffer, encode_audio, encode_video, pcm16
from .live_serializer import BrowserSerializer

ROOT = Path(__file__).resolve().parents[2]
KEY = ""
ORIGIN = "http://127.0.0.1:8787"
calls = {}
logger.remove()
logger.add(sys.stderr, level="INFO")


class OmniProcessor(FrameProcessor):
    def __init__(self, session, emit, client, **kwargs):
        super().__init__(**kwargs)
        self.session = session
        self.emit = emit
        self.client = client
        self.buffer = TurnBuffer()
        self.response_task = None
        self.generation = 0
        self.muted = False
        self.last_meter = 0.0
        self.last_vision = 0.0
        self.bot_speaking = False

    async def interrupt(self, announce=True):
        # ASVS 2.3.1/15.4.2: invalidate late output before awaiting cancellation.
        self.generation += 1
        task, self.response_task = self.response_task, None
        if task and not task.done():
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task
        await self.broadcast_frame(InterruptionFrame)
        if announce:
            await self.emit({"type": "interrupted", "generation": self.generation})
        try:
            async with self.client.post(ORIGIN + "/api/cancel", json={}, headers=self.headers(), timeout=aiohttp.ClientTimeout(total=3)) as response:
                await response.read()
        except (aiohttp.ClientError, TimeoutError):
            logger.warning("Could not acknowledge agent cancellation; the closed request still aborts it.")

    def headers(self):
        return {"Origin": ORIGIN, "Cookie": "session=" + self.session, "X-Local-Engine-Key": KEY}

    async def cleanup(self):
        task, self.response_task = self.response_task, None
        if task and not task.done():
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task
        await super().cleanup()

    async def process_frame(self, frame, direction):
        await super().process_frame(frame, direction)
        if isinstance(frame, InputTransportMessageFrame):
            if direction == FrameDirection.DOWNSTREAM:
                await self.command(frame.message)
            return
        if isinstance(frame, InputImageRawFrame):
            self.buffer.add_image(frame.image, frame.size, frame.format)
            now = time.monotonic()
            if now - self.last_vision > 1:
                self.last_vision = now
                await self.emit({"type": "vision", "frames": len(self.buffer.video_frames()), "fps": 2})
            return
        if isinstance(frame, InputAudioRawFrame):
            if not self.muted:
                self.buffer.add_audio(frame.audio)
                now = time.monotonic()
                if now - self.last_meter > 0.1:
                    self.last_meter = now
                    samples = memoryview(frame.audio).cast("h")
                    level = math.sqrt(sum(sample * sample for sample in samples) / max(1, len(samples))) / 32768
                    await self.emit({"type": "level", "value": min(1, level * 6)})
            return
        if isinstance(frame, VADUserStartedSpeakingFrame):
            if not self.muted:
                self.buffer.start()
                active_response = self.response_task is not None and not self.response_task.done()
                await self.interrupt(announce=active_response or self.bot_speaking)
                await self.emit({"type": "state", "state": "listening"})
            return
        if isinstance(frame, VADUserStoppedSpeakingFrame):
            if self.buffer.speaking and not self.muted:
                try:
                    audio = self.buffer.finish()
                    if len(audio) >= 6400:
                        await self.start_response(audio=audio)
                except ValueError as error:
                    await self.emit({"type": "error", "message": str(error)})
            return
        if isinstance(frame, BotStartedSpeakingFrame):
            self.bot_speaking = True
            await self.emit({"type": "state", "state": "speaking"})
        elif isinstance(frame, BotStoppedSpeakingFrame):
            self.bot_speaking = False
            if not self.buffer.speaking:
                await self.emit({"type": "state", "state": "ready"})
        elif isinstance(frame, (CancelFrame, EndFrame)):
            await self.interrupt(announce=False)
        await self.push_frame(frame, direction)

    async def start_response(self, *, audio=None, text=None):
        if self.response_task and not self.response_task.done():
            await self.interrupt()
        generation = self.generation
        images = self.buffer.video_frames()
        self.response_task = asyncio.create_task(self.respond(generation, audio, text, images))

    async def respond(self, generation, audio, text, images):
        started = time.monotonic()
        await self.emit({"type": "state", "state": "thinking"})
        try:
            video = await asyncio.to_thread(encode_video, images)
            if generation != self.generation:
                return
            payload = {"speak": False, "video": video}
            if audio:
                payload["audio"] = encode_audio(audio)
                await self.emit({"type": "user", "text": "Voice turn", "videoFrames": len(images)})
            else:
                payload["text"] = text
            async with self.client.post(ORIGIN + "/api/turn", json=payload, headers=self.headers(), timeout=aiohttp.ClientTimeout(total=180)) as response:
                result = await response.json()
                if generation != self.generation:
                    return
                for event in result.get("events", []):
                    await self.emit({"type": "tool", "event": event})
                if response.status != 200:
                    raise ValueError(result.get("error", "The local model could not answer."))
            answer = result["answer"]
            await self.emit({"type": "answer", "text": answer, "generation": generation})
            await self.push_frame(TTSStartedFrame())
            async with self.client.post("http://127.0.0.1:8081/tts", json={"input": answer, "lang": "en", "voice": "female", "n_predict": 512, "response_format": "pcm", "stream": True}, headers={"Authorization": "Bearer " + KEY}, timeout=aiohttp.ClientTimeout(total=90)) as response:
                if response.status != 200:
                    raise ValueError("Speech generation failed. Your text reply is still available.")
                pending = bytearray()
                first = True
                async for chunk in response.content.iter_chunked(3840):
                    if generation != self.generation:
                        return
                    pending.extend(chunk)
                    count = len(pending) // 4 * 4
                    if not count:
                        continue
                    audio_chunk = pcm16(bytes(pending[:count]))
                    del pending[:count]
                    if first:
                        first = False
                        await self.emit({"type": "latency", "ms": round((time.monotonic() - started) * 1000)})
                    await self.push_frame(TTSAudioRawFrame(audio=audio_chunk, sample_rate=24000, num_channels=1))
            await self.push_frame(TTSStoppedFrame())
        except asyncio.CancelledError:
            raise
        except Exception as error:
            if generation == self.generation:
                logger.warning("Live response failed: {}", type(error).__name__)
                await self.emit({"type": "error", "message": str(error) if isinstance(error, ValueError) else "The local response failed. Check the live service log."})
                await self.push_frame(TTSStoppedFrame())
                await self.emit({"type": "state", "state": "ready"})

    async def command(self, message):
        if not isinstance(message, dict):
            return
        kind = message.get("type")
        if kind == "interrupt":
            await self.interrupt()
        elif kind == "camera" and isinstance(message.get("enabled"), bool):
            self.buffer.set_camera(message["enabled"])
        elif kind == "mute" and isinstance(message.get("enabled"), bool):
            self.muted = message["enabled"]
            self.buffer.speaking = False
            self.buffer.audio.clear()
            self.buffer.preroll.clear()
            await self.interrupt(announce=False)
        elif kind == "text" and isinstance(message.get("text"), str) and 0 < len(message["text"].strip()) <= 4000:
            await self.interrupt(announce=False)
            await self.start_response(text=message["text"].strip())


async def run_bot(websocket, session):
    async with aiohttp.ClientSession() as client:
        transport = FastAPIWebsocketTransport(websocket, params=FastAPIWebsocketParams(
            audio_in_enabled=True, audio_out_enabled=True,
            audio_in_sample_rate=16000, audio_out_sample_rate=24000,
            audio_out_10ms_chunks=2, add_wav_header=False,
            serializer=BrowserSerializer(), allowed_origins=[ORIGIN],
            session_timeout=1800,
        ))

        async def emit(message):
            await transport.output().send_message(OutputTransportMessageUrgentFrame(message=message))

        omni = OmniProcessor(session, emit, client)
        vad = VADProcessor(vad_analyzer=SileroVADAnalyzer(params=VADParams(
            start_secs=0.15, stop_secs=0.9, confidence=0.7, min_volume=0.5)))
        worker = PipelineWorker(
            Pipeline([transport.input(), vad, omni, transport.output()]),
            params=PipelineParams(audio_in_sample_rate=16000, audio_out_sample_rate=24000),
            idle_timeout_secs=None, enable_rtvi=False)
        runner = WorkerRunner(handle_sigint=False)
        await runner.add_workers(worker)

        @worker.event_handler("on_pipeline_started")
        async def ready(_worker, _frame):
            await emit({"type": "state", "state": "ready"})

        @transport.event_handler("on_client_disconnected")
        async def disconnected(_transport, _client):
            await worker.cancel()

        @transport.event_handler("on_session_timeout")
        async def timeout(_transport, _client):
            await worker.cancel()

        await runner.run()


@asynccontextmanager
async def lifespan(_app):
    global KEY
    KEY = (ROOT / "runtime" / "api-key").read_text(encoding="utf-8").strip()
    if not KEY:
        raise RuntimeError("The local service key is empty. Run scripts/start.ps1 to configure the prototype.")
    yield
    for websocket in list(calls.values()):
        with contextlib.suppress(Exception):
            await websocket.close(code=1001)


app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)


@app.get("/health")
async def health():
    return {"ready": True, "activeCalls": len(calls)}


@app.websocket("/media")
async def media(websocket: WebSocket):
    session = websocket.headers.get("x-local-session", "")
    # ASVS 3.5.1/4.4.2: the proxy authenticates the originating browser and binds its cookie.
    authorized = hmac.compare_digest(websocket.headers.get("authorization", ""), "Bearer " + KEY)
    if not authorized or websocket.headers.get("origin") != ORIGIN or len(session) != 64 or any(c not in "0123456789abcdef" for c in session):
        await websocket.close(code=1008)
        return
    if calls:
        await websocket.close(code=1013)
        return
    calls[session] = websocket
    try:
        await websocket.accept()
        await run_bot(websocket, session)
    except Exception as error:
        logger.error("Live pipeline failed: {}", type(error).__name__)
    finally:
        calls.pop(session, None)
        with contextlib.suppress(Exception):
            await websocket.close()


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8788, log_level="warning", access_log=False,
                ws_max_size=180000, ws_max_queue=16)
