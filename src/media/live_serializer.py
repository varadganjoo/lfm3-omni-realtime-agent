"""The local browser's bounded PCM/JPEG protocol for Pipecat."""

import base64
import io
import json
import time

from PIL import Image
from pipecat.frames.frames import (
    InputAudioRawFrame, InputImageRawFrame, InputTransportMessageFrame,
    InterruptionFrame, OutputAudioRawFrame,
    OutputTransportMessageFrame, OutputTransportMessageUrgentFrame,
)
from pipecat.serializers.base_serializer import FrameSerializer


def decode_jpeg(encoded):
    if not isinstance(encoded, str) or len(encoded) > 160000:
        raise ValueError("Invalid JPEG input")
    return base64.b64decode(encoded, validate=True)


class BrowserSerializer(FrameSerializer):
    def __init__(self):
        super().__init__()
        self.last_image = 0.0

    async def serialize(self, frame):
        if isinstance(frame, OutputAudioRawFrame):
            return frame.audio
        if isinstance(frame, InterruptionFrame):
            return json.dumps({"type": "flush"})
        if isinstance(frame, (OutputTransportMessageFrame, OutputTransportMessageUrgentFrame)):
            return json.dumps(frame.message)
        return None

    async def deserialize(self, data):
        # ASVS 2.2.1/5.2.1: PCM is mono 16 kHz; messages and decoded image dimensions are bounded.
        if isinstance(data, bytes):
            if not data or len(data) > 6400 or len(data) % 2:
                raise ValueError("Invalid PCM audio packet")
            return InputAudioRawFrame(audio=data, sample_rate=16000, num_channels=1)
        if len(data) > 180000:
            raise ValueError("Media message is too large")
        message = json.loads(data)
        if not isinstance(message, dict):
            raise ValueError("Invalid media message")
        kind = message.get("type")
        if kind == "video":
            now = time.monotonic()
            if now - self.last_image < 0.4:
                return None
            raw = decode_jpeg(message.get("image"))
            with Image.open(io.BytesIO(raw)) as image:
                if image.format != "JPEG" or image.width > 640 or image.height > 480:
                    raise ValueError("Camera images must be JPEG, at most 640 by 480")
                image = image.convert("RGB")
                result = InputImageRawFrame(image=image.tobytes(), size=image.size, format="RGB")
            self.last_image = now
            return result
        if kind == "ping":
            return None
        if kind == "text" and "image" in message:
            with Image.open(io.BytesIO(decode_jpeg(message["image"]))) as image:
                if image.format != "JPEG" or image.width > 640 or image.height > 480:
                    raise ValueError("Attachments must be JPEG, at most 640 by 480")
                image.load()
        if kind in {"interrupt", "camera", "mute", "text"}:
            return InputTransportMessageFrame(message=message)
        raise ValueError("Unknown live command")
