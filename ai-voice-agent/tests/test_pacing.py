import asyncio

import pytest

from audiosocket.protocol import FRAME_MS, PacedPlayer


class FakeClock:
    """Deterministic monotonic clock: `sleep()` advances it, mimicking real
    time passing, so the pacing loop's own scheduling math is what's under
    test - not real wall-clock timing (which would make this test flaky)."""

    def __init__(self, start: float = 0.0) -> None:
        self.now = start
        self.sleep_calls: list[float] = []

    def clock(self) -> float:
        return self.now

    async def sleep(self, seconds: float) -> None:
        self.sleep_calls.append(seconds)
        self.now += seconds


@pytest.mark.asyncio
async def test_paced_player_emits_frames_20ms_apart():
    fake = FakeClock()
    player = PacedPlayer(clock=fake.clock, sleep=fake.sleep)

    received: list[bytes] = []
    for i in range(3):
        player.enqueue(bytes([i]))
    player.stop()

    await player.run(lambda payload: received.append(payload))

    assert received == [b"\x00", b"\x01", b"\x02"]
    # First frame ships immediately (next_tick starts at clock() at loop
    # entry, so there's nothing to wait for); each subsequent frame waits
    # ~20ms since the fake clock only advances when `sleep()` is called.
    assert len(fake.sleep_calls) == 2
    for wait in fake.sleep_calls:
        assert wait == pytest.approx(FRAME_MS / 1000.0, abs=1e-6)


@pytest.mark.asyncio
async def test_paced_player_does_not_sleep_when_already_late():
    """If the consumer is behind schedule (e.g. GC pause), the loop should
    not accumulate extra sleep - it catches up rather than drifting further
    behind, per PacedPlayer.run's max(next_tick + interval, now) logic."""
    fake = FakeClock()
    player = PacedPlayer(clock=fake.clock, sleep=fake.sleep)

    player.enqueue(b"a")
    # Simulate a delay before the second item is even enqueued/processed by
    # jumping the fake clock forward past one whole interval.
    fake.now += 0.5
    player.enqueue(b"b")
    player.stop()

    received: list[bytes] = []
    await player.run(lambda p: received.append(p))

    assert received == [b"a", b"b"]
    # Second frame should not have triggered an extra ~0.02s sleep on top of
    # the 0.5s that already elapsed - next_tick catches up instead of stacking.
    assert sum(fake.sleep_calls) < 0.05


def test_flush_drops_queued_frames():
    player = PacedPlayer()
    player.enqueue(b"1")
    player.enqueue(b"2")
    player.flush()
    assert player.queue.empty()


def test_next_send_delay_helper():
    fake = FakeClock(start=10.0)
    player = PacedPlayer(clock=fake.clock)
    delay = player.next_send_delay(last_tick=10.0, now=10.005)
    assert delay == pytest.approx(0.015)

    # Already past the tick: delay clamps to zero, never negative.
    delay_late = player.next_send_delay(last_tick=10.0, now=10.05)
    assert delay_late == 0.0
