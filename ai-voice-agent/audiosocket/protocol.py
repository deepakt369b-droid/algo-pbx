"""AudioSocket binary protocol: frame encode/decode, 20ms pacing, barge-in.

ASSUMPTIONS (no internet access; reconstructed from knowledge of Asterisk 20's
`res_audiosocket`/`app_audiosocket` C source and the public AudioSocket spec
used by ictinnovations/asterisk-ai-voice-agent):

  Frame wire format (all integers big-endian, matches `struct ast_audiosocket_
  message` in res_audiosocket.h):

      +--------+------------------+-----------------------+
      | type   | length (uint16)  | payload (length bytes) |
      | 1 byte | 2 bytes          |                         |
      +--------+------------------+-----------------------+

  Type byte values (`AST_AUDIOSOCKET_KIND_*` in the Asterisk source):
      0x00  HANGUP   - sent by Asterisk (or sidecar) to end the session;
                       payload is empty.
      0x01  UUID     - the FIRST frame Asterisk sends on connect; 16-byte
                       raw UUID identifying the call (matches the UUID the
                       dialplan passed to `AudioSocket()`), used to correlate
                       against the 9091 HTTP pre-registration.
      0x03  DTMF     - 1-byte ASCII digit payload.
      0x10  SLIN     - audio payload, signed 16-bit little-endian PCM,
                       8000 Hz, mono, by default (`AudioSocket()` also
                       supports ulaw framing at 8kHz on some builds, but slin
                       is the safe default this sidecar assumes).
      0xff  ERROR    - 1-byte error code payload.

  A 20ms frame of 8kHz/16-bit mono slin is 320 bytes (8000 * 0.02 * 2).
  If a deployment configures ulaw framing instead, a 20ms frame is 160 bytes
  (8-bit samples) - see `SLIN_FRAME_BYTES`/`ULAW_FRAME_BYTES` below and
  `FRAME_MS`.

  These type-byte values are the ones documented across public AudioSocket
  client implementations; if the actual production Asterisk build uses
  different values, only `FrameType` here needs to change - the rest of the
  pipeline is agnostic to the exact enum values.
"""

from __future__ import annotations

import asyncio
import enum
import struct
import time
from dataclasses import dataclass, field
from typing import Optional

HEADER_STRUCT = struct.Struct(">BH")  # type (1 byte) + length (uint16, big-endian)
HEADER_LEN = HEADER_STRUCT.size

FRAME_MS = 20
SAMPLE_RATE_HZ = 8000
SLIN_BYTES_PER_SAMPLE = 2
SLIN_FRAME_BYTES = int(SAMPLE_RATE_HZ * (FRAME_MS / 1000) * SLIN_BYTES_PER_SAMPLE)  # 320
ULAW_FRAME_BYTES = int(SAMPLE_RATE_HZ * (FRAME_MS / 1000) * 1)  # 160


class FrameType(enum.IntEnum):
    HANGUP = 0x00
    UUID = 0x01
    DTMF = 0x03
    SLIN = 0x10
    ERROR = 0xFF


@dataclass
class Frame:
    type: FrameType
    payload: bytes = b""

    def encode(self) -> bytes:
        return HEADER_STRUCT.pack(int(self.type), len(self.payload)) + self.payload


class FrameDecodeError(Exception):
    pass


def encode_frame(frame_type: FrameType, payload: bytes = b"") -> bytes:
    """Encode a single AudioSocket frame for writing to the TCP stream."""
    if len(payload) > 0xFFFF:
        raise FrameDecodeError("AudioSocket payload exceeds uint16 length field")
    return Frame(frame_type, payload).encode()


def decode_frame(buf: bytes) -> tuple[Optional[Frame], bytes]:
    """Try to decode a single frame from the front of `buf`.

    Returns (frame_or_none, remaining_buffer). If there isn't a full frame
    yet, returns (None, buf) unchanged so the caller can keep buffering.
    """
    if len(buf) < HEADER_LEN:
        return None, buf
    kind_byte, length = HEADER_STRUCT.unpack_from(buf, 0)
    total = HEADER_LEN + length
    if len(buf) < total:
        return None, buf
    payload = buf[HEADER_LEN:total]
    try:
        kind = FrameType(kind_byte)
    except ValueError as exc:
        raise FrameDecodeError(f"unknown AudioSocket frame type 0x{kind_byte:02x}") from exc
    return Frame(kind, payload), buf[total:]


class FrameDecoderStream:
    """Incremental decoder for a TCP byte stream: feed bytes, pop frames."""

    def __init__(self) -> None:
        self._buf = bytearray()

    def feed(self, data: bytes) -> list[Frame]:
        self._buf.extend(data)
        frames: list[Frame] = []
        while True:
            frame, rest = decode_frame(bytes(self._buf))
            if frame is None:
                break
            self._buf = bytearray(rest)
            frames.append(frame)
        return frames


# --------------------------------------------------------------------------
# 20ms pacing
# --------------------------------------------------------------------------


class PacedPlayer:
    """Writes queued outbound audio frames on a steady 20ms clock.

    Asterisk (and real phones) expect audio arriving at real-time cadence;
    writing frames as fast as a TTS provider produces them causes choppy /
    buffered playback and defeats barge-in responsiveness. This mirrors the
    reference project's approach: an explicit pacing loop driven by a
    monotonic clock rather than "sleep(0.02) between writes", which drifts
    under load. `clock` is injectable for deterministic unit tests.
    """

    def __init__(
        self,
        send: "asyncio.Queue[bytes] | None" = None,
        frame_ms: int = FRAME_MS,
        clock=time.monotonic,
        sleep=asyncio.sleep,
    ) -> None:
        self.queue: "asyncio.Queue[bytes | None]" = asyncio.Queue()
        self.frame_ms = frame_ms
        self._clock = clock
        self._sleep = sleep
        self._stopped = False

    def enqueue(self, payload: bytes) -> None:
        self.queue.put_nowait(payload)

    def flush(self) -> None:
        """Drop all pending queued audio - used on barge-in."""
        while not self.queue.empty():
            try:
                self.queue.get_nowait()
            except asyncio.QueueEmpty:
                break

    def stop(self) -> None:
        # NOTE: `_stopped` is only a "no more enqueues will follow" marker,
        # not an eager loop-exit flag - `run()` drains whatever is already
        # queued before honoring it via the `None` sentinel below. Gating
        # `run()`'s while-condition on `_stopped` directly would drop every
        # already-queued frame whenever `stop()` races ahead of `run()`
        # draining them (e.g. call setup enqueues audio then immediately
        # stops the player at hangup).
        self._stopped = True
        self.queue.put_nowait(None)

    async def run(self, on_frame) -> None:
        """Drive the pacing loop, calling `on_frame(payload)` every 20ms
        while there is queued audio. Silence (no call) simply idles without
        writing, matching AudioSocket's tolerance for gaps.
        """
        interval = self.frame_ms / 1000.0
        next_tick = self._clock()
        while True:
            item = await self.queue.get()
            if item is None:
                break
            now = self._clock()
            if now < next_tick:
                await self._sleep(next_tick - now)
            on_frame(item)
            next_tick = max(next_tick + interval, self._clock())

    def next_send_delay(self, last_tick: float, now: Optional[float] = None) -> float:
        """Pure helper (used by tests with a mock clock): how long to wait
        before the next 20ms tick given the last tick time."""
        now = self._clock() if now is None else now
        target = last_tick + (self.frame_ms / 1000.0)
        return max(0.0, target - now)


# --------------------------------------------------------------------------
# Barge-in detection
# --------------------------------------------------------------------------


def frame_energy(payload: bytes) -> float:
    """RMS energy of a slin16 (signed 16-bit LE mono) frame, normalized to
    [0, 1] against the full-scale amplitude (32768). Cheap and dependency-free
    (no numpy) so it can run inline in the AudioSocket receive loop."""
    if not payload:
        return 0.0
    sample_count = len(payload) // 2
    if sample_count == 0:
        return 0.0
    total = 0
    for i in range(sample_count):
        sample = struct.unpack_from("<h", payload, i * 2)[0]
        total += sample * sample
    mean_sq = total / sample_count
    rms = mean_sq**0.5
    return min(1.0, rms / 32768.0)


@dataclass
class BargeInDetector:
    """Tracks whether caller audio energy is high enough, while TTS/realtime
    playback is active, to justify interrupting the bot and flushing the
    outbound queue. `threshold` and `consecutive_frames` guard against single
    noisy frames (e.g. line click) triggering a false barge-in.
    """

    threshold: float = 0.12
    consecutive_frames: int = 2
    _hits: int = field(default=0, repr=False)

    def observe(self, payload: bytes, *, bot_speaking: bool) -> bool:
        """Feed one inbound audio frame. Returns True exactly on the frame
        that crosses the barge-in decision (caller so a caller-side handler
        can stop TTS playback and flush the outbound player's queue)."""
        if not bot_speaking:
            self._hits = 0
            return False
        energy = frame_energy(payload)
        if energy >= self.threshold:
            self._hits += 1
        else:
            self._hits = 0
        if self._hits >= self.consecutive_frames:
            self._hits = 0
            return True
        return False
