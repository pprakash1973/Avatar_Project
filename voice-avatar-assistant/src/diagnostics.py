"""A short timeline of each call, kept in its record, to explain why a call ended.

LiveKit Cloud only keeps the agent's logs while it runs, so after a dropped demo the
call record is the only evidence left: who left and why (LiveKit's disconnect reason),
the avatar dropping out, reconnects, and errors from the voice / AI models.
"""

import logging
import time
from typing import Any

from livekit import rtc
from livekit.agents import AgentSession
from livekit.protocol import models

logger = logging.getLogger("agent.diagnostics")

MAX_EVENTS = 40


def _kind(participant: rtc.RemoteParticipant) -> str:
    if participant.kind == rtc.ParticipantKind.PARTICIPANT_KIND_AGENT:
        return "avatar"
    return "host"


def _reason(participant: rtc.RemoteParticipant) -> str:
    reason = participant.disconnect_reason
    return models.DisconnectReason.Name(reason) if reason is not None else "UNKNOWN"


class _ErrorLogHandler(logging.Handler):
    """Errors LiveKit only logs, without a session "error" event: a rejected AI request
    left Tina silent mid-ceremony while the record said "0 errors"."""

    def __init__(self, call_log: "CallLog") -> None:
        super().__init__(level=logging.ERROR)
        self._call_log = call_log

    def emit(self, record: logging.LogRecord) -> None:
        try:
            error = record.getMessage()
            if record.exc_info and record.exc_info[1] is not None:
                error = f"{error}: {record.exc_info[1]}"
            self._call_log.errors += 1
            self._call_log.add("agent error", logger=record.name, error=error[:300])
        except Exception:
            self.handleError(record)


class CallLog:
    def __init__(self, started_at: float) -> None:
        self._started_at = started_at
        self.events: list[dict[str, Any]] = []
        # The first thing that ended the call, e.g. "host left: CLIENT_INITIATED".
        self.ended_by = ""
        self.errors = 0
        # Set once the call's own record is set up to be saved at the end.
        self.recorded = False

    def add(self, event: str, **info: Any) -> None:
        entry = {"t": round(time.time() - self._started_at, 1), "event": event, **info}
        logger.info("call event: %s", entry)
        if len(self.events) < MAX_EVENTS:
            self.events.append(entry)
        elif len(self.events) == MAX_EVENTS:
            self.events.append({"t": entry["t"], "event": "more events not kept"})

    def _ended(self, why: str) -> None:
        if not self.ended_by:
            self.ended_by = why

    def watch(self, room: rtc.Room, session: AgentSession) -> None:
        errors = _ErrorLogHandler(self)
        logging.getLogger("livekit").addHandler(errors)

        @room.on("participant_connected")
        def _joined(participant: rtc.RemoteParticipant) -> None:
            self.add(f"{_kind(participant)} joined", identity=participant.identity)

        @room.on("participant_disconnected")
        def _left(participant: rtc.RemoteParticipant) -> None:
            kind, reason = _kind(participant), _reason(participant)
            self.add(f"{kind} left", identity=participant.identity, reason=reason)
            # The host leaving ends the call; the avatar leaving freezes Tina's face.
            self._ended(f"{kind} left: {reason}")

        @room.on("track_unpublished")
        def _unpublished(
            publication: rtc.RemoteTrackPublication, participant: rtc.RemoteParticipant
        ) -> None:
            if (
                publication.kind == rtc.TrackKind.KIND_VIDEO
                and _kind(participant) == "avatar"
            ):
                self.add("avatar video stopped", identity=participant.identity)

        @room.on("connection_quality_changed")
        def _quality(
            participant: rtc.Participant, quality: rtc.ConnectionQuality
        ) -> None:
            if quality.name in ("QUALITY_POOR", "QUALITY_LOST"):
                self.add(
                    "poor connection",
                    identity=participant.identity,
                    quality=quality.name,
                )

        @room.on("reconnecting")
        def _reconnecting() -> None:
            self.add("agent reconnecting")

        @room.on("reconnected")
        def _reconnected() -> None:
            self.add("agent reconnected")

        @room.on("disconnected")
        def _disconnected(reason: Any = None) -> None:
            name = (
                models.DisconnectReason.Name(reason)
                if isinstance(reason, int)
                else str(reason)
            )
            self.add("agent disconnected", reason=name)
            self._ended(f"room closed: {name}")

        @session.on("error")
        def _error(ev) -> None:
            self.errors += 1
            source = type(ev.source).__name__ if ev.source is not None else "unknown"
            recoverable = getattr(ev.error, "recoverable", None)
            self.add(
                "error",
                source=source,
                recoverable=recoverable,
                error=str(ev.error)[:300],
            )
            if recoverable is False:
                self._ended(f"error in {source}")

        @session.on("close")
        def _close(ev) -> None:
            info: dict[str, Any] = {
                "reason": str(getattr(ev.reason, "value", ev.reason))
            }
            if ev.error is not None:
                info["error"] = str(ev.error)[:300]
            self.add("session closed", **info)
            logging.getLogger("livekit").removeHandler(errors)

    def summary(self, shutdown_reason: str) -> dict[str, Any]:
        """Fields for the call record."""
        return {
            "ended_by": self.ended_by or shutdown_reason or "unknown",
            "shutdown_reason": shutdown_reason,
            "errors": self.errors,
            "events": self.events,
        }
