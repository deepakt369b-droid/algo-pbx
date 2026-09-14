import uuid

import pytest

from audiosocket.protocol import (
    Frame,
    FrameDecodeError,
    FrameDecoderStream,
    FrameType,
    decode_frame,
    encode_frame,
)


def test_encode_decode_roundtrip_slin():
    payload = b"\x01\x02" * 160  # 320 bytes, one 20ms slin frame
    wire = encode_frame(FrameType.SLIN, payload)
    frame, rest = decode_frame(wire)
    assert frame is not None
    assert frame.type == FrameType.SLIN
    assert frame.payload == payload
    assert rest == b""


def test_encode_decode_roundtrip_uuid():
    call_uuid = uuid.uuid4()
    wire = encode_frame(FrameType.UUID, call_uuid.bytes)
    frame, rest = decode_frame(wire)
    assert frame.type == FrameType.UUID
    assert uuid.UUID(bytes=frame.payload) == call_uuid
    assert rest == b""


def test_encode_decode_roundtrip_hangup_empty_payload():
    wire = encode_frame(FrameType.HANGUP)
    frame, rest = decode_frame(wire)
    assert frame.type == FrameType.HANGUP
    assert frame.payload == b""
    assert rest == b""


def test_decode_incomplete_header_returns_none():
    frame, rest = decode_frame(b"\x10\x00")  # only 2 of 3 header bytes
    assert frame is None
    assert rest == b"\x10\x00"


def test_decode_incomplete_payload_returns_none():
    header = FrameType.SLIN.to_bytes(1, "big") + (10).to_bytes(2, "big")
    wire = header + b"12345"  # declares 10 bytes, only 5 present
    frame, rest = decode_frame(wire)
    assert frame is None
    assert rest == wire


def test_decode_unknown_type_raises():
    header = (0x99).to_bytes(1, "big") + (0).to_bytes(2, "big")
    with pytest.raises(FrameDecodeError):
        decode_frame(header)


def test_decoder_stream_handles_split_and_multiple_frames():
    frame1 = encode_frame(FrameType.DTMF, b"5")
    frame2 = encode_frame(FrameType.SLIN, b"\x00" * 320)
    combined = frame1 + frame2

    decoder = FrameDecoderStream()
    # Feed a chunk that cuts off mid-header (frame1's full 4 bytes are
    # header(3) + 1-byte payload, so splitting at 2 bytes lands inside the
    # length field) to exercise partial buffering.
    frames = decoder.feed(combined[:2])
    assert frames == []
    frames = decoder.feed(combined[2:])
    assert [f.type for f in frames] == [FrameType.DTMF, FrameType.SLIN]
    assert frames[0].payload == b"5"
    assert frames[1].payload == b"\x00" * 320


def test_frame_dataclass_encode_matches_function():
    frame = Frame(FrameType.ERROR, b"\x01")
    assert frame.encode() == encode_frame(FrameType.ERROR, b"\x01")


def test_encode_rejects_oversized_payload():
    with pytest.raises(FrameDecodeError):
        encode_frame(FrameType.SLIN, b"x" * 70000)
