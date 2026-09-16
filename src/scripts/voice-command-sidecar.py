import asyncio
import base64
import json
import os
import re
import time
from collections import deque
from dataclasses import dataclass, field

import numpy
import openwakeword
import whisper
import websockets
from openwakeword.model import Model as WakeWordModel

HOST = os.getenv("VOICE_COMMANDS_SIDECAR_HOST", "127.0.0.1")
PORT = int(os.getenv("VOICE_COMMANDS_SIDECAR_PORT", "8765"))
WAKE_WORD = os.getenv("VOICE_COMMANDS_WAKE_WORD", "hey_jarvis")
WAKE_WORD_THRESHOLD = float(os.getenv("VOICE_COMMANDS_WAKE_WORD_THRESHOLD", "0.5"))
WHISPER_MODEL = os.getenv("VOICE_COMMANDS_WHISPER_MODEL", "base.en")
DEBUG = os.getenv("VOICE_COMMANDS_DEBUG", "false") == "true"
FRAME_BYTES = 2560
PREBUFFER_FRAMES = 12
USE_PREBUFFER_FOR_TRANSCRIPT = True
SILENCE_THRESHOLD = 600.0
SILENCE_SECONDS = 1.2
MAX_CAPTURE_SECONDS = 6.0
SAMPLE_RATE = 16000
MAX_WAKE_MODEL_POOL_SIZE = 8

openwakeword.utils.download_models()
WHISPER = whisper.load_model(WHISPER_MODEL)
WAKE_MODEL_POOL: deque[WakeWordModel] = deque()


def log(message: str) -> None:
    if DEBUG:
        print(f"[voice-debug] {message}", flush=True)


def create_wake_model() -> WakeWordModel:
    return WakeWordModel()


def checkout_wake_model() -> WakeWordModel:
    if WAKE_MODEL_POOL:
        wake_model = WAKE_MODEL_POOL.pop()
        wake_model.reset()
        return wake_model

    return create_wake_model()


def return_wake_model(wake_model: WakeWordModel) -> None:
    wake_model.reset()
    if len(WAKE_MODEL_POOL) < MAX_WAKE_MODEL_POOL_SIZE:
        WAKE_MODEL_POOL.append(wake_model)


def normalize_label(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", value.lower())


def match_prediction(predictions: dict[str, float], wake_word: str) -> float:
    wake_word_normalized = normalize_label(wake_word)
    scores = [
        score
        for label, score in predictions.items()
        if wake_word_normalized in normalize_label(label)
    ]
    return max(scores, default=0.0)


@dataclass
class StreamState:
    guild_id: str
    user_id: str
    wake_word: str
    wake_model: WakeWordModel = field(default_factory=checkout_wake_model)
    pre_buffer: deque[bytes] = field(default_factory=lambda: deque(maxlen=PREBUFFER_FRAMES))
    triggered: bool = False
    captured_chunks: list[bytes] = field(default_factory=list)
    last_voice_at: float = 0.0
    frame_count: int = 0
    max_score: float = 0.0
    max_rms: float = 0.0


async def send_json(socket, payload: dict[str, str]) -> None:
    await socket.send(json.dumps(payload))


def transcribe_audio(chunks: list[bytes]) -> str:
    if not chunks:
        return ""

    audio = numpy.frombuffer(b"".join(chunks), dtype=numpy.int16).astype(numpy.float32) / 32768.0
    result = WHISPER.transcribe(
        audio,
        language="en",
        fp16=False,
        condition_on_previous_text=False,
        temperature=0,
        without_timestamps=True,
    )
    log(f'whisper result text="{result.get("text", "").strip()}"')
    return result.get("text", "").strip()


async def finalize_stream(socket, stream_id: str, state: StreamState) -> None:
    if not state.triggered:
        log(
            f"finalize stream_id={stream_id} guild={state.guild_id} user={state.user_id} "
            f"without wake-word trigger frame_count={state.frame_count} max_score={state.max_score:.3f}"
        )
        return

    log(
        f"finalize stream_id={stream_id} guild={state.guild_id} user={state.user_id} "
        f"captured_chunks={len(state.captured_chunks)} frame_count={state.frame_count} max_rms={state.max_rms:.1f}"
    )
    transcript = transcribe_audio(state.captured_chunks)
    if transcript:
        log(f'transcript stream_id={stream_id} text="{transcript}"')
        await send_json(
            socket,
            {
                "type": "transcript",
                "guildId": state.guild_id,
                "userId": state.user_id,
                "wakeWord": state.wake_word,
                "text": transcript,
            },
        )
    else:
        log(f"no transcript produced for stream_id={stream_id}")


def reset_stream_capture(state: StreamState) -> None:
    state.triggered = False
    state.captured_chunks.clear()
    state.pre_buffer.clear()
    state.max_score = 0.0
    state.max_rms = 0.0
    state.frame_count = 0
    state.last_voice_at = 0.0
    state.wake_model.reset()


def release_stream_state(state: StreamState) -> None:
    reset_stream_capture(state)
    return_wake_model(state.wake_model)


async def handle_audio(socket, stream_id: str, state: StreamState, encoded_pcm: str) -> None:
    pcm_bytes = base64.b64decode(encoded_pcm)
    samples = numpy.frombuffer(pcm_bytes, dtype=numpy.int16)
    state.pre_buffer.append(pcm_bytes)
    state.frame_count += 1

    if not state.triggered:
        prediction = state.wake_model.predict(samples)
        score = match_prediction(prediction, state.wake_word)
        state.max_score = max(state.max_score, score)

        if DEBUG and (state.frame_count == 1 or state.frame_count % 10 == 0 or score >= WAKE_WORD_THRESHOLD):
            log(
                f"wake frame stream_id={stream_id} guild={state.guild_id} user={state.user_id} "
                f"frame={state.frame_count} score={score:.3f} max_score={state.max_score:.3f}"
            )

        if score >= WAKE_WORD_THRESHOLD:
            state.triggered = True
            state.captured_chunks = list(state.pre_buffer) if USE_PREBUFFER_FOR_TRANSCRIPT else []
            state.last_voice_at = time.monotonic()
            log(
                f"wake-word matched stream_id={stream_id} guild={state.guild_id} user={state.user_id} "
                f"score={score:.3f} threshold={WAKE_WORD_THRESHOLD:.3f} prebuffer_frames={len(state.pre_buffer)} "
                f"use_prebuffer_for_transcript={USE_PREBUFFER_FOR_TRANSCRIPT}"
            )
        return

    state.captured_chunks.append(pcm_bytes)

    rms = 0.0
    if samples.size:
        rms = float(numpy.sqrt(numpy.mean(samples.astype(numpy.float32) ** 2)))
        state.max_rms = max(state.max_rms, rms)

    now = time.monotonic()
    if rms >= SILENCE_THRESHOLD:
        state.last_voice_at = now

    if DEBUG and (state.frame_count % 10 == 0):
        log(
            f"capture frame stream_id={stream_id} guild={state.guild_id} user={state.user_id} "
            f"frame={state.frame_count} rms={rms:.1f} max_rms={state.max_rms:.1f}"
        )

    captured_seconds = sum(len(chunk) for chunk in state.captured_chunks) / (SAMPLE_RATE * 2)
    if captured_seconds >= MAX_CAPTURE_SECONDS or now - state.last_voice_at >= SILENCE_SECONDS:
        log(
            f"capture complete stream_id={stream_id} guild={state.guild_id} user={state.user_id} "
            f"captured_seconds={captured_seconds:.2f} silence_for={now - state.last_voice_at:.2f}"
        )
        await finalize_stream(socket, stream_id, state)
        reset_stream_capture(state)


async def handler(socket) -> None:
    streams: dict[str, StreamState] = {}
    await send_json(socket, {"type": "ready", "message": "voice sidecar ready"})
    log("websocket client connected")

    try:
        async for raw_message in socket:
            message = json.loads(raw_message)
            stream_id = message["streamId"]
            message_type = message["type"]

            if message_type == "start":
                log(
                    f"start stream_id={stream_id} guild={message['guildId']} user={message['userId']} "
                    f"wake_word={message['wakeWord']}"
                )
                streams[stream_id] = StreamState(
                    guild_id=message["guildId"],
                    user_id=message["userId"],
                    wake_word=message["wakeWord"],
                )
            elif message_type == "audio" and stream_id in streams:
                await handle_audio(socket, stream_id, streams[stream_id], message["pcm"])
            elif message_type == "stop" and stream_id in streams:
                log(f"stop stream_id={stream_id}")
                await finalize_stream(socket, stream_id, streams[stream_id])
                release_stream_state(streams[stream_id])
                del streams[stream_id]
    finally:
        for state in streams.values():
            release_stream_state(state)


async def main() -> None:
    print(f"starting voice sidecar on ws://{HOST}:{PORT}")
    log(
        f"voice sidecar config host={HOST} port={PORT} wake_word={WAKE_WORD} "
        f"threshold={WAKE_WORD_THRESHOLD:.3f} whisper_model={WHISPER_MODEL}"
    )
    async with websockets.serve(handler, HOST, PORT, max_size=2**20):
        await asyncio.Future()


if __name__ == "__main__":
    asyncio.run(main())
