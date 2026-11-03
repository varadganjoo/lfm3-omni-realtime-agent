"""Real local Pipecat call with synthetic video, speech, and spoken interruption."""

import asyncio
import base64
import contextlib
import io
import json
import time
import wave
import argparse
import ssl
from uuid import uuid4
from pathlib import Path

import aiohttp
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
ORIGIN = "http://127.0.0.1:8787"


async def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--lan', action='store_true', help='Test the configured home-network HTTPS endpoint with explicit CA verification.')
    args = parser.parse_args()
    origin = ORIGIN
    context = True
    if args.lan:
        config = json.loads((ROOT / 'runtime' / 'lan.json').read_text())
        origin = f'https://{config["address"]}:8443'
        context = ssl.create_default_context(cafile=str(ROOT / 'runtime' / 'tls' / 'companion-ca.pem'))
    events, audio_times, note_names = [], [], []
    pending = bytearray()
    memory_key = "native_test_" + uuid4().hex[:12]
    color = "red"
    started = time.monotonic()
    async with aiohttp.ClientSession(connector=aiohttp.TCPConnector(ssl=context), cookie_jar=aiohttp.CookieJar(unsafe=True), headers={"Origin": origin}) as client:
        async with client.get(origin + "/api/state") as response:
            assert (await response.json())["liveReady"]
        async with client.ws_connect(origin.replace("http", "ws") + "/api/live/media") as socket:
            async def receive():
                async for message in socket:
                    if message.type == aiohttp.WSMsgType.BINARY:
                        if any(message.data):
                            audio_times.append(time.monotonic())
                    elif message.type == aiohttp.WSMsgType.TEXT:
                        data = json.loads(message.data)
                        data["at"] = round(time.monotonic() - started, 3)
                        events.append(data)
                        if data.get("type") not in {"level", "vision"}:
                            print(json.dumps(data), flush=True)
                        if data.get("type") == "tool" and data.get("event", {}).get("saved"):
                            note_names.append(data["event"]["filename"])

            async def send_audio():
                target = time.monotonic()
                while True:
                    raw = bytes(pending[:640]).ljust(640, b"\0")
                    del pending[:640]
                    await socket.send_bytes(raw)
                    target += 0.02
                    await asyncio.sleep(max(0, target - time.monotonic()))

            async def send_video():
                while True:
                    output = io.BytesIO()
                    Image.new("RGB", (320, 240), color).save(output, format="JPEG")
                    await socket.send_json({"type": "video", "image": base64.b64encode(output.getvalue()).decode()})
                    await asyncio.sleep(0.5)

            async def wait(predicate, timeout=35):
                deadline = time.monotonic() + timeout
                while not predicate():
                    errors = [event for event in events if event.get("type") == "error"]
                    if errors:
                        raise AssertionError(errors[-1])
                    if receiver.done():
                        raise AssertionError("The media connection closed unexpectedly.")
                    if time.monotonic() > deadline:
                        raise TimeoutError("Expected event did not arrive; inspect runtime/live.stderr.log.")
                    await asyncio.sleep(0.025)

            receiver = asyncio.create_task(receive())
            senders = []
            try:
                await wait(lambda: any(e.get("state") == "ready" for e in events))
                senders = [asyncio.create_task(send_audio())]
                senders.append(asyncio.create_task(send_video()))
                await asyncio.sleep(2)
                color = "blue"
                await asyncio.sleep(2)
                await socket.send_json({"type": "text", "text": "What color does the video change from and to? Explain in three sentences."})
                await wait(lambda: any(e.get("type") == "answer" for e in events))
                answer = next(e["text"] for e in events if e.get("type") == "answer")
                assert "red" in answer.lower() and "blue" in answer.lower(), answer
                await socket.send_json({"type": "text", "text": "Count aloud from one to thirty, using all the numbers."})
                events.clear()
                audio_times.clear()
                await wait(lambda: any(e.get("type") == "speech_start" for e in events))
                await wait(lambda: len(audio_times) > 5)

                with wave.open(str(ROOT / "runtime" / "live-command.wav"), "rb") as wav:
                    assert (wav.getframerate(), wav.getnchannels(), wav.getsampwidth()) == (16000, 1, 2)
                    pending.extend(wav.readframes(wav.getnframes()))
                spoken_at = time.monotonic()
                await wait(lambda: any(e.get("type") == "interrupted" for e in events), timeout=8)
                interrupted_at = time.monotonic()
                await wait(lambda: bool(note_names), timeout=40)
                await wait(lambda: any(e.get("type") == "answer" and e["at"] + started > interrupted_at for e in events))
                await wait(lambda: len([e for e in events if e.get("type") == "speech_start"]) >= 2)
                second_answer = [e for e in events if e.get("type") == "speech_start"][1]["at"] + started
                assert any(e.get("type") == "user" and e.get("videoFrames", 0) >= 4 for e in events)
                assert not [t for t in audio_times if interrupted_at + 0.25 < t < second_answer], 'Old audio continued after interruption'
                saved = next(e['event'] for e in events if e.get('type') == 'tool' and e.get('event', {}).get('saved'))
                assert 'live test' in saved['title'].lower(), saved
                note = (ROOT / 'data' / 'notes' / saved['filename']).read_text()
                assert 'live video and voice worked' in note.lower(), note
                await socket.send_json({"type": "text", "text": f'Remember that my test beverage is jasmine tea. Use the memory key {memory_key}.'})
                await wait(lambda: any(e.get('event', {}).get('remembered') and e['event'].get('key') == memory_key for e in events))
                async with client.get(origin + '/api/state') as response:
                    state = await response.json()
                    assert any(m['key'] == memory_key and 'jasmine' in m['value'].lower() for m in state['memories'])
                await socket.close()
                deadline = time.monotonic() + 8
                while True:
                    async with client.post(origin + '/api/reset', json={}) as response:
                        if response.status == 200:
                            break
                        assert response.status == 409
                    assert time.monotonic() < deadline, 'Native model ownership was not released after disconnect'
                    await asyncio.sleep(0.1)
                print(json.dumps({"PASS": ["native speech grounded in local video analysis", "streamed speech", "spoken barge-in with no stale audio", "spoken note title and body"], "barge_in_detection_ms": round((interrupted_at - spoken_at) * 1000)}), flush=True)
            finally:
                receiver.cancel()
                for task in senders:
                    task.cancel()
                await asyncio.gather(receiver, *senders, return_exceptions=True)
                async with client.post(origin + '/api/forget', json={'key': memory_key}) as response:
                    assert response.status == 200, 'Could not clean up synthetic memory'
                for name in note_names:
                    if len(name) == 39 and name.endswith(".md"):
                        with contextlib.suppress(FileNotFoundError):
                            (ROOT / "data" / "notes" / name).unlink()


if __name__ == "__main__":
    asyncio.run(main())
