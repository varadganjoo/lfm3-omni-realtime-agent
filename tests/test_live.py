import asyncio
import base64
import io
import unittest
import wave
from unittest.mock import AsyncMock, Mock
from unittest.mock import patch
from pathlib import Path
from tempfile import TemporaryDirectory

import av
import numpy as np
from PIL import Image

from src.media.live_media import MAX_AUDIO_BYTES, TurnBuffer, encode_audio, encode_video, pcm16


class MediaTests(unittest.TestCase):
    def test_audio_has_preroll_and_rejects_overflow(self):
        buffer = TurnBuffer()
        buffer.add_audio(b"\0" * 640)
        buffer.start()
        buffer.add_audio(b"\1" * 640)
        self.assertEqual(buffer.finish(), b"\0" * 640 + b"\1" * 640)
        buffer.start()
        buffer.add_audio(b"\0" * (MAX_AUDIO_BYTES + 2))
        with self.assertRaisesRegex(ValueError, "20 seconds"):
            buffer.finish()

    def test_camera_window_expires_and_hiding_clears_it(self):
        buffer = TurnBuffer()
        image = Image.new("RGB", (640, 480), "blue")
        for i in range(30):
            buffer.add_image(image.tobytes(), image.size, "RGB", now=1 + i * 0.5)
        self.assertEqual(len(buffer.images), 12)
        self.assertEqual(len(buffer.video_frames(now=20)), 4)
        buffer.set_camera(False)
        buffer.add_image(image.tobytes(), image.size, "RGB", now=30)
        self.assertEqual(buffer.video_frames(now=30), [])

    def test_webm_is_real_ordered_video_not_a_still_image(self):
        images = [Image.new("RGB", (320, 240), color) for color in ("red", "blue")]
        data = base64.b64decode(encode_video(images))
        self.assertEqual(data[:4], b"\x1aE\xdf\xa3")
        with av.open(io.BytesIO(data)) as container:
            frames = list(container.decode(video=0))
        self.assertEqual(len(frames), 2)
        first, second = (frame.to_ndarray(format="rgb24").mean(axis=(0, 1)) for frame in frames)
        self.assertGreater(first[0], first[2])
        self.assertGreater(second[2], second[0])

    def test_pcm_and_wav_formats(self):
        raw = np.array([-2, -1, 0, 1, 2, float("nan")], dtype="<f4").tobytes()
        audio = pcm16(raw)
        self.assertEqual(np.frombuffer(audio, dtype="<i2").tolist(), [-32767, -32767, 0, 32767, 32767, 0])
        with wave.open(io.BytesIO(base64.b64decode(encode_audio(audio)))) as wav:
            self.assertEqual((wav.getframerate(), wav.getnchannels(), wav.getsampwidth()), (16000, 1, 2))
            self.assertEqual(wav.readframes(6), audio)


class CancellationTests(unittest.IsolatedAsyncioTestCase):
    async def test_missing_key_prevents_service_startup_without_breaking_module_import(self):
        from src.media.live import lifespan
        with TemporaryDirectory() as directory, patch("src.media.live.ROOT", Path(directory)):
            with self.assertRaises(FileNotFoundError):
                async with lifespan(None):
                    self.fail("The service must not start without its private key.")

    async def test_interruption_invalidates_generation_before_old_response_finishes(self):
        from src.media.live import OmniProcessor
        events = []
        client = Mock()
        # Offline cancellation acknowledgement is allowed to fail without resuming old audio.
        client.post.side_effect = TimeoutError
        processor = OmniProcessor("a" * 64, AsyncMock(side_effect=events.append), client)
        processor.broadcast_frame = AsyncMock()
        ended = asyncio.Event()

        async def old_response():
            try:
                await asyncio.sleep(100)
            finally:
                ended.set()

        processor.response_task = asyncio.create_task(old_response())
        await asyncio.sleep(0)
        await processor.interrupt()
        self.assertTrue(ended.is_set())
        self.assertEqual(processor.generation, 1)
        self.assertIsNone(processor.response_task)
        self.assertEqual(events, [{"type": "interrupted", "generation": 1}])
        processor.broadcast_frame.assert_awaited_once()

    async def test_live_protocol_rejects_invalid_or_oversized_packets(self):
        from src.media.live_serializer import BrowserSerializer
        from pipecat.frames.frames import InputAudioRawFrame
        serializer = BrowserSerializer()
        frame = await serializer.deserialize(b"\0" * 640)
        self.assertIsInstance(frame, InputAudioRawFrame)
        self.assertEqual(frame.sample_rate, 16000)
        for packet in [b"x", b"x" * 6402, '[]', '{"type":"run_shell"}', 'x' * 180001]:
            with self.assertRaises(ValueError):
                await serializer.deserialize(packet)


if __name__ == "__main__":
    unittest.main()
