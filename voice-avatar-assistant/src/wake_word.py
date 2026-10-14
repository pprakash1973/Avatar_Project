"""Respond only when called by name ("Tina"), with a short follow-up window."""

import re
import time

AVATAR_NAME = "Tina"

# Speech-to-text spells the name in several ways; include the scripts of the
# other supported languages too.
_NAME_RE = re.compile(
    r"\b(tina|teena|tena|tinna|teina|deena)\b|टीना|टिना|டீனா|டினா|ടീന|ടിന",
    re.IGNORECASE,
)


def mentions_name(text: str) -> bool:
    return bool(_NAME_RE.search(text or ""))


class WakeWord:
    """Tracks whether the user is currently talking to Tina.

    Saying her name opens a window of ``window_seconds``; it is extended while
    she is talking and restarts when she finishes, so follow-ups don't need the
    name again.
    """

    def __init__(self, *, enabled: bool, window_seconds: float = 20.0) -> None:
        self.enabled = enabled
        self._window = window_seconds
        self._open_until = 0.0

    def accepts(self, text: str) -> bool:
        if not self.enabled:
            return True
        if mentions_name(text):
            self.extend()
            return True
        return time.monotonic() < self._open_until

    def extend(self) -> None:
        self._open_until = time.monotonic() + self._window
