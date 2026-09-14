import struct

from audiosocket.protocol import BargeInDetector, frame_energy


def _slin_frame(amplitude: int, samples: int = 160) -> bytes:
    return struct.pack(f"<{samples}h", *([amplitude] * samples))


def test_frame_energy_silence_is_zero():
    silence = _slin_frame(0)
    assert frame_energy(silence) == 0.0


def test_frame_energy_full_scale_is_near_one():
    loud = _slin_frame(32000)
    assert frame_energy(loud) > 0.9


def test_frame_energy_empty_payload_is_zero():
    assert frame_energy(b"") == 0.0


def test_barge_in_ignored_when_bot_not_speaking():
    detector = BargeInDetector(threshold=0.1, consecutive_frames=1)
    loud = _slin_frame(20000)
    assert detector.observe(loud, bot_speaking=False) is False


def test_barge_in_triggers_after_consecutive_loud_frames():
    detector = BargeInDetector(threshold=0.1, consecutive_frames=2)
    loud = _slin_frame(20000)
    quiet = _slin_frame(0)

    assert detector.observe(loud, bot_speaking=True) is False  # 1st hit, not yet
    assert detector.observe(loud, bot_speaking=True) is True  # 2nd consecutive hit
    # Counter resets after firing.
    assert detector.observe(quiet, bot_speaking=True) is False


def test_barge_in_resets_on_quiet_frame_between_loud_ones():
    detector = BargeInDetector(threshold=0.1, consecutive_frames=2)
    loud = _slin_frame(20000)
    quiet = _slin_frame(0)

    assert detector.observe(loud, bot_speaking=True) is False
    assert detector.observe(quiet, bot_speaking=True) is False  # resets hit counter
    assert detector.observe(loud, bot_speaking=True) is False  # only 1 consecutive again
    assert detector.observe(loud, bot_speaking=True) is True


def test_barge_in_below_threshold_never_triggers():
    detector = BargeInDetector(threshold=0.5, consecutive_frames=1)
    quiet_ish = _slin_frame(1000)  # well below threshold
    assert detector.observe(quiet_ish, bot_speaking=True) is False
