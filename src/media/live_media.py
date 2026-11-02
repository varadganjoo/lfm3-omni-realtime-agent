"""Bounded live media buffers and the formats accepted by local llama.cpp."""

import base64
import io
import time
import wave
from collections import deque

import av
import numpy as np
from PIL import Image

SAMPLE_RATE = 16_000
MAX_AUDIO_BYTES = SAMPLE_RATE * 2 * 20


class TurnBuffer:
    def __init__(self):
        self.preroll = deque(maxlen=25)  # 500 ms at the transport's 20 ms frame size.
        self.images = deque(maxlen=12)
        self.audio = bytearray()
        self.speaking = False
        self.overflow = False
        self.camera_enabled = True
        self.last_image = 0.0

    def add_audio(self, audio):
        self.preroll.append(audio)
        if self.speaking:
            if len(self.audio) + len(audio) <= MAX_AUDIO_BYTES:
                self.audio.extend(audio)
            else:
                self.overflow = True

    def start(self):
        self.speaking = True
        self.overflow = False
        self.audio = bytearray(b"".join(self.preroll))

    def finish(self):
        self.speaking = False
        audio = bytes(self.audio)
        self.audio.clear()
        self.preroll.clear()
        if self.overflow:
            raise ValueError("That turn was longer than 20 seconds. Please ask in a shorter sentence.")
        return audio

    def add_image(self, image, size, image_format, now=None):
        now = time.monotonic() if now is None else now
        if not self.camera_enabled or now - self.last_image < 0.45:
            return
        if size[0] * size[1] > 1280 * 720 or image_format != "RGB":
            return
        frame = Image.frombytes("RGB", size, image)
        frame = frame.resize((320, 240))
        self.images.append((now, frame))
        self.last_image = now

    def video_frames(self, now=None):
        now = time.monotonic() if now is None else now
        return [image for timestamp, image in self.images if now - timestamp <= 6]

    def set_camera(self, enabled):
        self.camera_enabled = enabled
        self.images.clear()


def encode_audio(audio):
    output = io.BytesIO()
    with wave.open(output, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(SAMPLE_RATE)
        wav.writeframes(audio)
    return base64.b64encode(output.getvalue()).decode()


def encode_video(images):
    if not images:
        return None
    output = io.BytesIO()
    with av.open(output, mode="w", format="webm") as container:
        stream = container.add_stream("libvpx", rate=2)
        stream.width, stream.height = 320, 240
        stream.pix_fmt = "yuv420p"
        stream.options = {"deadline": "realtime", "cpu-used": "8", "threads": "2"}
        for i, image in enumerate(images):
            frame = av.VideoFrame.from_image(image)
            frame.pts = i
            for packet in stream.encode(frame):
                container.mux(packet)
        for packet in stream.encode():
            container.mux(packet)
    return base64.b64encode(output.getvalue()).decode()


def pcm16(float_bytes):
    values = np.frombuffer(float_bytes, dtype="<f4")
    return (np.nan_to_num(values).clip(-1, 1) * 32767).astype("<i2").tobytes()
