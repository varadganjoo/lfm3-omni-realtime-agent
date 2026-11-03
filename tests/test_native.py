import base64
import unittest
from unittest.mock import AsyncMock

from src.media.native import NativeSession


def created(identity):
    return {"type": "response.created", "response": {"id": identity}}


def done(identity, output=None, status="completed"):
    return {"type": "response.done", "response": {"id": identity, "status": status, "output": output or []}}


class NativeTests(unittest.IsolatedAsyncioTestCase):
    async def test_native_audio_and_tools_share_a_session_and_duplicate_calls_write_once(self):
        native = NativeSession(None, "test", {})
        native.socket = AsyncMock()
        call = {"type": "function_call", "name": "save_note", "arguments": '{"title":"Test","body":"Synthetic"}', "call_id": "a"}
        native.socket.receive_json.side_effect = [
            created("one"), done("one", [call, {**call, "call_id": "b"}]),
            created("two"),
            {"type": "response.output_audio.delta", "response_id": "stale", "delta": "invalid"},
            {"type": "response.output_audio.delta", "response_id": "two", "delta": base64.b64encode(b"\0\1" * 20).decode()},
            {"type": "response.output_text.done", "response_id": "two", "text": "Saved."}, done("two")]
        native.control = AsyncMock(return_value={"result": {"saved": True, "title": "Test"}})
        event, audio = AsyncMock(), AsyncMock()
        native.describe_visual = AsyncMock(return_value="The scene changes from red to blue.")
        await native.respond(b"\0\1" * 640, None, event, audio, video="synthetic clip")
        native.control.assert_awaited_once_with("tool", name="save_note", arguments=call["arguments"], request=None)
        audio.assert_awaited_once_with(b"\0\1" * 20)
        self.assertFalse(native.pending)
        sent = [entry.args[0] for entry in native.socket.send_json.await_args_list]
        native.describe_visual.assert_awaited_once_with(
            {"type": "input_video", "input_video": {"data": "synthetic clip"}}, None)
        self.assertIn("The scene changes from red to blue.", sent[0]["item"]["content"][0]["text"])
        self.assertEqual(sent[1]["type"], "input_audio_buffer.append")
        self.assertEqual(sum(item["type"] == "response.create" for item in sent), 2)
        responses = [item["response"] for item in sent if item["type"] == "response.create"]
        self.assertEqual(responses, [{"output_modalities": ["text"]}, {"output_modalities": ["text", "audio"]}])
        self.assertEqual(sum(item.get("item", {}).get("type") == "function_call_output" for item in sent), 2)

    async def test_cancel_drains_late_output_before_another_response(self):
        native = NativeSession(None, "test", {})
        native.socket = AsyncMock()
        native.pending = True
        native.socket.receive_json.side_effect = [created("old"),
            {"type": "response.output_audio.delta", "response_id": "old", "delta": "AAAA"}, done("old", status="cancelled")]
        await native.cancel()
        native.socket.send_json.assert_awaited_once_with({"type": "response.cancel"})
        self.assertFalse(native.pending)
        self.assertEqual(native.socket.receive_json.await_count, 3)

    async def test_text_only_reply_uses_bounded_native_speech_continuation_without_actions(self):
        native = NativeSession(None, "test", {})
        native.socket = AsyncMock()
        native.socket.receive_json.side_effect = [created("one"),
            {"type": "response.output_text.done", "response_id": "one", "text": "Hello."}, done("one"),
            created("two"), {"type": "response.output_text.done", "response_id": "two", "text": "Hello."},
            {"type": "response.output_audio.delta", "response_id": "two", "delta": "AAE="}, done("two")]
        native.control = AsyncMock()
        event = AsyncMock()
        await native.respond(None, "Hello", event, AsyncMock())
        event.assert_awaited_once_with({"type": "answer", "text": "Hello."})
        native.control.assert_not_awaited()
        sent = native.socket.send_json.await_args_list[-1].args[0]
        self.assertEqual(sent["response"]["tool_choice"], "none")

    async def test_unfinished_audio_is_discarded_by_reconnecting(self):
        native = NativeSession(None, "test", {})
        native.socket = AsyncMock()
        native.input_open = True
        native.connect = AsyncMock()
        await native.cancel()
        native.socket.close.assert_awaited_once()
        native.connect.assert_awaited_once()
        self.assertFalse(native.input_open)

    async def test_speech_continuation_cannot_execute_an_unexpected_action(self):
        native = NativeSession(None, "test", {})
        native.socket = AsyncMock()
        native.socket.receive_json.side_effect = [created("one"),
            {"type": "response.output_text.done", "response_id": "one", "text": "Hello."}, done("one"),
            created("two"), done("two", [{"type": "function_call", "name": "save_note", "arguments": "{}", "call_id": "bad"}])]
        native.control = AsyncMock()
        with self.assertRaisesRegex(ValueError, "No tool was executed"):
            await native.respond(None, "Hello", AsyncMock(), AsyncMock())
        native.control.assert_not_awaited()

    async def test_model_errors_do_not_execute_tools_and_close_releases_ownership(self):
        native = NativeSession(None, "test", {})
        native.socket = AsyncMock()
        native.socket.receive_json.return_value = {"type": "error", "error": {"message": "context full"}}
        native.control = AsyncMock()
        with self.assertRaisesRegex(ValueError, "context full"):
            await native.respond(None, "Hello", AsyncMock(), AsyncMock())
        native.control.assert_not_awaited()
        native.owned = True
        native.socket.close.side_effect = RuntimeError("socket closed")
        with self.assertRaises(RuntimeError):
            await native.close()
        native.control.assert_awaited_once_with("close")
        self.assertFalse(native.owned)

    async def test_runaway_native_tool_calls_stop_after_six_actions(self):
        native = NativeSession(None, "test", {})
        native.socket = AsyncMock()
        events = []
        for round_index in range(3):
            identity = str(round_index)
            calls = [{"type": "function_call", "name": "save_note", "arguments": str(round_index * 3 + i),
                      "call_id": str(round_index * 3 + i)} for i in range(3)]
            events.extend([created(identity), done(identity, calls)])
        native.socket.receive_json.side_effect = events
        native.control = AsyncMock(return_value={"result": {"saved": True}})
        with self.assertRaisesRegex(ValueError, "tool limit"):
            await native.respond(None, "Synthetic request", AsyncMock(), AsyncMock())
        self.assertEqual(native.control.await_count, 6)
