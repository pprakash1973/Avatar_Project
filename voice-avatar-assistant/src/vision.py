"""Keeps the latest frame of the user's screen share or camera so the agent can
look at it when the user speaks. Frames stay in memory and are never saved."""

import asyncio
import logging
import time

from livekit import rtc

logger = logging.getLogger("agent.vision")

# A frame older than this means the share was paused or the camera turned off.
_MAX_FRAME_AGE_SECONDS = 3.0

_SOURCE_LABELS = {
    rtc.TrackSource.SOURCE_SCREENSHARE: "screen",
    rtc.TrackSource.SOURCE_CAMERA: "camera",
}


class VideoWatcher:
    def __init__(self, room: rtc.Room) -> None:
        self._room = room
        self._tasks: dict[str, asyncio.Task] = {}
        # source -> (frame, monotonic time received)
        self._frames: dict[int, tuple[rtc.VideoFrame, float]] = {}

    def start(self) -> None:
        self._room.on("track_subscribed", self._on_track_subscribed)
        self._room.on("track_unsubscribed", self._on_track_unsubscribed)
        for participant in self._room.remote_participants.values():
            for publication in participant.track_publications.values():
                if publication.track is not None:
                    self._on_track_subscribed(
                        publication.track, publication, participant
                    )

    def _on_track_subscribed(
        self,
        track: rtc.Track,
        publication: rtc.RemoteTrackPublication,
        participant: rtc.RemoteParticipant,
    ) -> None:
        # Only the user's own video: the avatar joins as an "agent" participant.
        if (
            track.kind != rtc.TrackKind.KIND_VIDEO
            or participant.kind != rtc.ParticipantKind.PARTICIPANT_KIND_STANDARD
            or publication.source not in _SOURCE_LABELS
            or track.sid in self._tasks
        ):
            return
        logger.info("watching user's %s", _SOURCE_LABELS[publication.source])
        self._tasks[track.sid] = asyncio.create_task(
            self._read(track, publication.source)
        )

    def _on_track_unsubscribed(
        self,
        track: rtc.Track,
        publication: rtc.RemoteTrackPublication,
        participant: rtc.RemoteParticipant,
    ) -> None:
        task = self._tasks.pop(track.sid, None)
        if task is not None:
            task.cancel()

    async def _read(self, track: rtc.Track, source: int) -> None:
        stream = rtc.VideoStream(track)
        try:
            async for event in stream:
                self._frames[source] = (event.frame, time.monotonic())
        finally:
            self._frames.pop(source, None)
            await stream.aclose()

    def latest(self) -> tuple[str, rtc.VideoFrame] | None:
        """The freshest frame, preferring a screen share over the camera."""
        now = time.monotonic()
        for source in (
            rtc.TrackSource.SOURCE_SCREENSHARE,
            rtc.TrackSource.SOURCE_CAMERA,
        ):
            entry = self._frames.get(source)
            if entry and now - entry[1] <= _MAX_FRAME_AGE_SECONDS:
                return _SOURCE_LABELS[source], entry[0]
        return None

    async def aclose(self) -> None:
        for task in self._tasks.values():
            task.cancel()
        self._tasks.clear()
