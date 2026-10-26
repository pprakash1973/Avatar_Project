"""Award ceremony mode: Tina announces winners word-for-word and shows each slide.

Winners are never put in Tina's instructions; the announce tools look them up only
when the host asks, so she can't reveal one early. A category can have several
winners (one entry each, in presentation order).
"""

import asyncio
import difflib
import json
import logging
import random
import re
import textwrap
import time
from collections.abc import AsyncIterable
from dataclasses import dataclass, field
from typing import Any, Literal

import anthropic
from livekit import rtc
from livekit.agents import (
    Agent,
    AgentSession,
    ModelSettings,
    RunContext,
    StopResponse,
    function_tool,
    llm,
    stt,
    tts,
    utils,
)
from livekit.agents.language import LanguageCode
from livekit.agents.voice import SpeechHandle

from claude import HELPER_MODEL, HelperUsage, get_client
from wake_word import WakeWord, mentions_name, name_in_english, without_name
from web_search import run_web_search
from youtube import search_videos

logger = logging.getLogger("agent.ceremony")

# Tina's first words, as soon as she appears; the host waits for them.
DEFAULT_INTRODUCTION = (
    "Hello, I am Tina, your AI avatar assistant. I am ready to support you."
)
# {name} is replaced by the host's name.
DEFAULT_GREETING = "Hi {name}, good day! I am happy to be your co-host."
DEFAULT_WELCOME_NOTE = (
    "Good evening, esteemed UST leaders and dear colleagues. A warm welcome to the PACS "
    "Annual Rewards and Recognition Ceremony. We sincerely thank our leaders for taking "
    "time out of their busy schedules to join us. Your presence and continued support "
    "make this occasion truly special. Let us celebrate excellence and achievement together!"
)


DEFAULT_LISTEN_PAUSE = 1.5
DEFAULT_SUSPENSE_SECONDS = 5.0
# What the host says to control a playing video, checked in this order.
VIDEO_CONTROLS: list[tuple[str, tuple[str, ...]]] = [
    ("next", ("next", "another", "different", "wrong", "அடுத்த")),
    ("pause", ("pause", "hold", "wait", "நிறுத்தி வை")),
    ("play", ("play", "resume", "continue", "unpause", "தொடர")),
    ("stop", ("stop", "close", "end", "enough", "நிறுத்து")),
]
# "Tina, louder" / "Tina, lower the volume" while music or a video plays. The plain
# verbs (increase, lower...) count only next to a volume word, so "announce the
# Revenue Increase award" isn't taken for one.
VOLUME_WORDS: dict[str, tuple[str, ...]] = {
    "up": (
        "louder",
        "turn up",
        "turn it up",
        "volume up",
        "more volume",
        "கூட்டு",
        "ஏத்து",
    ),
    "down": (
        "softer",
        "quieter",
        "turn down",
        "turn it down",
        "volume down",
        "less volume",
        "குறை",
    ),
}
VOLUME_VERBS: dict[str, tuple[str, ...]] = {
    "up": ("increase", "raise", "high", "அதிக"),
    "down": ("decrease", "reduce", "lower", "low"),
}
VOLUME_NOUNS = ("volume", "music", "sound", "சத்தம", "சவுண்ட")
# Built-in music for lucky draws and on-the-spot awards (frontend public/sounds),
# one picked at random each time.
SUSPENSE_TRACKS = (
    "/sounds/suspense_drum_roll.mp3",
    "/sounds/suspense_ticking_clock.mp3",
    "/sounds/suspense_game_show.mp3",
)
DEFAULT_WINNER_PAUSE = 3.0
# A first call that is only a greeting ("Hello Tina", "Good evening Tina").
_SALUTATION_WORDS = {
    "hello",
    "hi",
    "hey",
    "hai",
    "good",
    "morning",
    "afternoon",
    "evening",
    "day",
    "there",
    "dear",
    "namaste",
    "namaskar",
    "namaskaram",
    "vanakkam",
    "welcome",
    "ok",
    "okay",
    "so",
    "um",
    "uh",
    # Tamil: "வணக்கம்" (vanakkam), "காலை / மதிய / மாலை வணக்கம்" (good morning /
    # afternoon / evening), "இனிய" (pleasant), "ஹலோ", "ஹாய்".
    "வணக்கம்",
    "காலை",
    "மதிய",
    "மாலை",
    "இனிய",
    "ஹலோ",
    "ஹாய்",
}
# A request that stops on one of these words isn't finished ("...the award for");
# Tina waits for the rest instead of answering half a sentence.
_DANGLING_WORDS = {
    "a",
    "an",
    "the",
    "for",
    "of",
    "to",
    "and",
    "or",
    "but",
    "with",
    "about",
    "from",
    "on",
    "in",
    "at",
    "by",
    "is",
    "are",
    "announce",
    "please",
    "give",
    "show",
    "say",
    "tell",
    "who",
    "what",
    "which",
    "how",
    "my",
    "our",
    "your",
    "their",
    "this",
    "that",
    "um",
    "uh",
    "hey",
    "ok",
    "okay",
    "so",
}
# Words before a trailing "please" that leave the request unfinished.
_PLEASE_LEADS = {"you", "can", "could", "would", "will", "kindly"} | _DANGLING_WORDS
# How long the host must stay silent after an unfinished request before Tina
# answers what she heard.
UNFINISHED_WAIT_SECONDS = 3.0


def just_salutation(text: str) -> bool:
    """True if the host only greeted Tina, e.g. "Hello Tina" or "Good evening, Tina"."""
    words = [w for w in _phrase(text).split() if not mentions_name(w)]
    return all(w in _SALUTATION_WORDS for w in words)


def unfinished(text: str) -> bool:
    """True if the host stopped mid-request, e.g. "Tina," or "announce the award for"."""
    words = _phrase(text).split()
    if not words:
        return False
    if words[-1] == "please":
        # "Tina, can you please ..." is unfinished; "announce the next award please"
        # is a whole request (waiting on it delayed every polite request).
        before = words[-2] if len(words) > 1 else ""
        if not before or mentions_name(before) or before in _PLEASE_LEADS:
            return True
    elif words[-1] in _DANGLING_WORDS:
        return True
    # Just the name ("Tina", "hey Tina"): the request itself is still coming.
    rest = [w for w in words if not mentions_name(w) and w not in _DANGLING_WORDS]
    return mentions_name(text) and not rest


DEFAULT_CONGRATULATIONS = "Congratulations, {winner}!"
LANGUAGE_NAMES = {"en": "English", "hi": "Hindi", "ta": "Tamil", "ml": "Malayalam"}
# The Unicode block of each language's script, to tell which language a text is in.
_SCRIPTS = {
    "hi": ("\u0900", "\u097f"),
    "ta": ("\u0b80", "\u0bff"),
    "ml": ("\u0d00", "\u0d7f"),
}
KeywordAction = Literal["repeat", "hold", "continue"]
# Words around a keyword phrase that don't make it a longer request.
_KEYWORD_FILLER = {"please", "ok", "okay", "now", "hey", "pls", "தயவுசெய்து"}
DEFAULT_KEYWORDS: list[tuple[str, KeywordAction]] = [
    ("please repeat", "repeat"),
    ("repeat that", "repeat"),
    ("please hold", "hold"),
    ("hold on", "hold"),
    ("continue", "continue"),
    # Tamil: "say it again", "wait", "wait a little", "continue".
    ("மீண்டும் சொல்லுங்கள்", "repeat"),
    ("திரும்ப சொல்லுங்க", "repeat"),
    ("காத்திருங்கள்", "hold"),
    ("கொஞ்சம் இருங்க", "hold"),
    ("தொடருங்கள்", "continue"),
    ("தொடருங்க", "continue"),
]


def _phrase(text: str) -> str:
    # Indic vowel signs aren't \w in Python: keep the whole Indic range.
    return " ".join(re.sub(r"[^\w\u0900-\u0dff ]", " ", text.lower()).split())


def video_control(text: str) -> str | None:
    """next / pause / play / stop when the host is controlling the video."""
    said = f" {_phrase(text)} "
    for action, words in VIDEO_CONTROLS:
        if any(f" {w}" in said for w in words):
            return action
    return None


def volume_change(text: str) -> str | None:
    """up / down when the host asks for the music or video to be louder or softer."""
    said = f" {_phrase(text)} "
    if re.search(r"award|விருது", said):
        return None
    has_noun = any(f" {n}" in said for n in VOLUME_NOUNS)
    for change in ("up", "down"):
        if any(f" {w}" in said for w in VOLUME_WORDS[change]):
            return change
        if has_noun and any(f" {w}" in said for w in VOLUME_VERBS[change]):
            return change
    return None


def short_title(title: str) -> str:
    """A YouTube title as Tina would say it: "Nehru Trophy Snake Boat Race | Lake
    Punnamada 4K #kerala" -> "Nehru Trophy Snake Boat Race"."""
    # "Luis Fonsi - Despacito (Official Video) | 4K" -> "Luis Fonsi, Despacito".
    head = re.split(r"[|#(\[]", title)[0]
    head = re.sub(r"\s[\-\u2013\u2014:]\s", ", ", head)
    words = re.sub(r"[^\w\s'\u2019&,.!?\u0900-\u0dff]", " ", head).split()
    return " ".join(words[:10]).rstrip(".,!?") or "the video"


def silence(seconds: float, rate: int = 24000) -> AsyncIterable[rtc.AudioFrame]:
    """Silent audio, for a dramatic pause inside an announcement."""
    samples = rate // 50

    async def frames():
        for _ in range(int(seconds * 50)):
            yield rtc.AudioFrame(b"\0\0" * samples, rate, 1, samples)

    return frames()


def script_language(text: str) -> str:
    """The language of the first Indic letter in the text, else "en"."""
    for char in text:
        for language, (low, high) in _SCRIPTS.items():
            if low <= char <= high:
                return language
    return "en"


def _languages(raw) -> list[str]:
    codes = [c for c in LANGUAGE_NAMES if c in (raw or [])]
    return codes or ["en"]


def _translations(raw) -> dict[str, str]:
    raw = raw if isinstance(raw, dict) else {}
    return {
        c: str(raw[c]).strip() for c in LANGUAGE_NAMES if str(raw.get(c, "")).strip()
    }


@dataclass
class Award:
    category: str
    winner: str
    script: str
    slide: int
    announced: bool = False
    # Said once before the category's first winner, e.g. what the award recognises.
    intro: str = ""


EventTrigger = Literal["called", "appear", "first_call"]


@dataclass
class CeremonyEvent:
    """Something Tina says word-for-word besides the awards: her introduction ("appear"),
    the greeting ("first_call") or a programme item the host calls by name, in any order
    ("called"), e.g. the welcome message or the lamp lighting."""

    name: str
    # English; {name} is the host's name.
    script: str
    # Slide shown while Tina speaks (0: Tina full screen).
    slide: int = 0
    trigger: EventTrigger = "called"
    # Spoken in turn; the others than English use their translation (translated on
    # the fly if empty).
    languages: list[str] = field(default_factory=lambda: ["en"])
    translations: dict[str, str] = field(default_factory=dict)
    # "ask_ai": after its text, Tina takes questions from the audience on stage.
    kind: Literal["say", "ask_ai"] = "say"
    done: bool = False


# During Ask AI a short turn made only of these is chatter ("okay thanks", "wow"),
# not a question; any other turn, however short ("Who's Messi?"), is answered.
ASK_AI_CHATTER = {
    "ok", "okay", "thanks", "thank", "you", "yes", "yeah", "no", "wow", "nice",
    "great", "cool", "super", "good", "hmm", "haha", "ha", "oh", "ah", "so", "and",
    "right", "fine", "sure", "hi", "hello", "bye", "next", "go", "on", "come",
    "நன்றி", "சரி", "ஓகே",
}  # fmt: skip
ASK_AI_CHATTER_MAX_WORDS = 3
# A long ceremony's conversation is trimmed to its recent part once it grows this
# long, so each reply stays fast (announcements and events are tracked separately).
HISTORY_MAX_ITEMS = 60
HISTORY_KEEP_ITEMS = 30
ASK_AI_RULES = """
# Ask AI is on

Members of the audience come to the stage and ask you anything that comes to mind; they don't say your name. They are not the host: never address anyone by name or call them the host.
- Answer every question with warmth and light, good-natured humour, in one to three short sentences; a playful line is welcome, but keep it respectful and never at anyone's expense.
- Use web_search for current facts.
- If a question touches sensitive information, reply exactly: "Sorry, I cannot answer that." Sensitive: personal details about real people (salaries, phone numbers, addresses, health, relationships), confidential company, client or deal information, the award winners, passwords or security, and divisive topics (politics, religion, caste) or anything offensive.
- If what you hear isn't meant for you (applause, chatter, someone talking to the audience), reply with one word at most, e.g. "Ha!"
- When the host ends Ask AI ("Tina, end Ask AI", "thank you all, let's move on"), call end_ask_ai.
"""


def _tool_calls_last(chat_ctx: llm.ChatContext) -> llm.ChatContext:
    """The conversation with anything Tina said while a tool ran (a queued announcement,
    a filler) moved before that tool's call. Left between the call and its result, it
    made the request end with Tina's words, which the model rejects."""
    items: list[llm.ChatItem] = []
    running: set[str] = set()
    for item in chat_ctx.items:
        if item.type == "function_call":
            running.add(item.call_id)
        elif item.type == "function_call_output":
            running.discard(item.call_id)
        elif item.type == "message" and item.role == "assistant" and running:
            first_call = next(
                i
                for i, x in enumerate(items)
                if x.type == "function_call" and x.call_id in running
            )
            items.insert(first_call, item)
            continue
        items.append(item)
    if items == chat_ctx.items:
        return chat_ctx
    return llm.ChatContext(items)


def _legacy_events(raw: dict) -> list[CeremonyEvent]:
    """Pages from before events had their own introduction / greeting / welcome note."""
    if not any(k in raw for k in ("introduction", "greeting", "welcome_note")):
        return []
    greeting_languages = _languages(raw.get("greeting_languages"))
    events = [
        CeremonyEvent(
            "Introduction",
            str(raw.get("introduction", DEFAULT_INTRODUCTION)).strip(),
            trigger="appear",
            languages=greeting_languages,
        ),
        CeremonyEvent(
            "Greeting",
            str(raw.get("greeting") or DEFAULT_GREETING).strip(),
            trigger="first_call",
            languages=greeting_languages,
            translations=_translations(raw.get("greeting_translations")),
        ),
        CeremonyEvent(
            "Welcome Message",
            str(raw.get("welcome_note") or DEFAULT_WELCOME_NOTE).strip(),
            languages=_languages(raw.get("welcome_languages")),
            translations=_translations(raw.get("welcome_translations")),
        ),
    ]
    return [e for e in events if e.script]


def _event_key(text: str) -> str:
    return " ".join(
        w
        for w in _phrase(text).split()
        if w not in ("the", "event", "segment", "ceremony", "please")
    )


def _closest(wanted: str, names: dict[str, Any]) -> Any:
    """The entry whose (normalized) name matches `wanted` (normalized the same way):
    exactly, by containment if only one does, else the closest spelling."""
    if wanted in names:
        return names[wanted]
    contains = [v for n, v in names.items() if wanted and (wanted in n or n in wanted)]
    if len(contains) == 1:
        return contains[0]
    close = difflib.get_close_matches(wanted, list(names), n=1, cutoff=0.6)
    return names[close[0]] if close else None


@dataclass
class CeremonySettings:
    # With several winners in a category: "ask" the host before each next winner,
    # or continue "auto"matically after a pause.
    # Several winners in a category are announced one after another, each with its
    # slide, this many seconds apart.
    pause_seconds: float = DEFAULT_WINNER_PAUSE
    congratulate: bool = True
    # Languages Tina understands and replies in; she answers in the host's language.
    conversation_languages: list[str] = field(default_factory=lambda: ["en"])
    # How Tina carries herself: a polished "professional" host, or a "lively" MC.
    style: Literal["professional", "lively"] = "professional"
    # Seconds of silence before Tina treats the host's request as finished, so a
    # pause mid-sentence ("Tina, please announce ... the next award") isn't cut off.
    listen_pause: float = DEFAULT_LISTEN_PAUSE
    # "And the winner is...": a pause before the name while the slide is hidden.
    suspense: bool = True
    suspense_seconds: float = DEFAULT_SUSPENSE_SECONDS
    congratulations: str = DEFAULT_CONGRATULATIONS
    # Phrases the host can say without "Tina", e.g. "please hold".
    keywords: list[tuple[str, KeywordAction]] = field(
        default_factory=lambda: list(DEFAULT_KEYWORDS)
    )
    # Written name -> how Tina should say it, e.g. "Soumya" -> "Sow-mya".
    pronunciations: dict[str, str] = field(default_factory=dict)
    # Songs the host can ask for by name during a break: (name, link).
    songs: list[tuple[str, str]] = field(default_factory=list)

    def announcement(self, award: "Award") -> str:
        """The approved script plus the congratulations, as Tina says it."""
        parts = [award.script]
        if self.congratulate and award.winner:
            parts.append(self.congratulations.replace("{winner}", award.winner))
        return self.spoken(" ".join(parts))

    def announcement_parts(self, award: "Award") -> tuple[str, str]:
        """The announcement split before the winner's name: ("The award for X goes
        to", "Soumya Rao. ... Congratulations, Soumya Rao!"). The first part is ""
        when the script doesn't contain the name."""
        whole = self.announcement(award)
        name = award.winner.strip()
        at = award.script.lower().find(name.lower()) if name else -1
        if at <= 0:
            return "", whole
        lead = award.script[:at].strip()
        rest = [award.script[at:]]
        if self.congratulate and award.winner:
            rest.append(self.congratulations.replace("{winner}", award.winner))
        return self.spoken(lead), self.spoken(" ".join(rest))

    def keyword(self, text: str) -> KeywordAction | None:
        """The action of the longest keyword phrase in what the host said."""
        said = f" {_phrase(text)} "
        for phrase, action in sorted(self.keywords, key=lambda k: -len(k[0])):
            if phrase and f" {_phrase(phrase)} " in said:
                return action
        return None

    def only_keyword(self, text: str) -> bool:
        """True if the host said just a keyword phrase ("Please hold", "Tina,
        continue"), with nothing more than the name or a "please" around it."""
        said = f" {_phrase(text)} "
        for phrase, _ in sorted(self.keywords, key=lambda k: -len(k[0])):
            if phrase and f" {_phrase(phrase)} " in said:
                said = said.replace(f" {_phrase(phrase)} ", " ", 1)
                break
        rest = [w for w in said.split() if not mentions_name(w)]
        return all(w in _KEYWORD_FILLER for w in rest)

    def song(self, name: str) -> tuple[str, str] | None:
        """The song the host asked for, tolerating small differences in the name."""
        names = {_phrase(n): (n, url) for n, url in self.songs}
        wanted = _phrase(name)
        if wanted in names:
            return names[wanted]
        contains = [
            s for n, s in names.items() if wanted and (wanted in n or n in wanted)
        ]
        if len(contains) == 1:
            return contains[0]
        close = difflib.get_close_matches(wanted, list(names), n=1, cutoff=0.6)
        return names[close[0]] if close else None

    def spoken(self, text: str) -> str:
        """Text as Tina should say it: names replaced by their spoken spelling."""
        for written, said in sorted(
            self.pronunciations.items(), key=lambda kv: -len(kv[0])
        ):
            text = re.sub(rf"\b{re.escape(written)}\b", said, text, flags=re.IGNORECASE)
        return text


def _norm(text: str) -> str:
    text = re.sub(r"[^a-z0-9 ]", " ", text.lower())
    text = re.sub(r"\b(the|award|awards|for|category|of)\b", " ", text)
    return " ".join(text.split())


@dataclass
class CeremonyProgram:
    awards: list[Award] = field(default_factory=list)
    settings: CeremonySettings = field(default_factory=CeremonySettings)
    events: list[CeremonyEvent] = field(default_factory=list)

    @classmethod
    def from_json(cls, text: str) -> "CeremonyProgram":
        data = json.loads(text)
        # Older pages sent just the award list.
        items = data if isinstance(data, list) else data.get("awards", [])
        raw = {} if isinstance(data, list) else data.get("settings", {}) or {}
        settings = CeremonySettings(
            pause_seconds=min(
                max(float(raw.get("pause_seconds", DEFAULT_WINNER_PAUSE)), 1), 30
            ),
            congratulate=raw.get("congratulate", True) is not False,
            conversation_languages=_languages(raw.get("conversation_languages")),
            style="lively" if raw.get("style") == "lively" else "professional",
            listen_pause=min(
                max(float(raw.get("listen_pause") or DEFAULT_LISTEN_PAUSE), 0.5), 4.0
            ),
            suspense=raw.get("suspense", True) is not False,
            suspense_seconds=min(
                max(
                    float(raw.get("suspense_seconds") or DEFAULT_SUSPENSE_SECONDS), 1.0
                ),
                10.0,
            ),
            congratulations=str(
                raw.get("congratulations") or DEFAULT_CONGRATULATIONS
            ).strip(),
            keywords=[
                (_phrase(str(k["phrase"])), k["action"])
                for k in raw.get("keywords", DEFAULT_KEYWORDS_RAW) or []
                if isinstance(k, dict)
                and _phrase(str(k.get("phrase", "")))
                and k.get("action") in ("repeat", "hold", "continue")
            ],
            pronunciations={
                str(p["written"]).strip(): str(p["spoken"]).strip()
                for p in raw.get("pronunciations", []) or []
                if str(p.get("written", "")).strip()
                and str(p.get("spoken", "")).strip()
            },
            songs=[
                (str(s["name"]).strip(), str(s["url"]).strip())
                for s in raw.get("songs", []) or []
                if isinstance(s, dict)
                and str(s.get("name", "")).strip()
                and str(s.get("url", "")).strip()
            ],
        )
        awards = [
            Award(
                category=str(item["category"]).strip(),
                winner=str(item.get("winner", "")).strip(),
                script=str(item["script"]).strip(),
                slide=int(item.get("slide", 1)),
                intro=str(item.get("intro") or "").strip(),
            )
            for item in items
            if str(item.get("category", "")).strip()
            and str(item.get("script", "")).strip()
        ]
        events = [
            CeremonyEvent(
                name=str(e["name"]).strip(),
                script=str(e["script"]).strip(),
                slide=max(0, int(e.get("slide") or 0)),
                trigger=e["trigger"]
                if e.get("trigger") in ("appear", "first_call")
                else "called",
                languages=_languages(e.get("languages")),
                translations=_translations(e.get("translations")),
                kind="ask_ai" if e.get("kind") == "ask_ai" else "say",
            )
            for e in raw.get("events", []) or []
            if isinstance(e, dict)
            and str(e.get("name", "")).strip()
            and str(e.get("script", "")).strip()
        ]
        return cls(
            awards=awards, settings=settings, events=_legacy_events(raw) + events
        )

    def events_on(self, trigger: EventTrigger) -> list[CeremonyEvent]:
        return [e for e in self.events if e.trigger == trigger]

    def match_event(self, spoken: str) -> CeremonyEvent | None:
        """The event the host called by name, tolerating small differences."""
        names: dict[str, CeremonyEvent] = {}
        for e in self.events_on("called"):
            names.setdefault(_event_key(e.name), e)
        return _closest(_event_key(spoken), names)

    def next_event(self) -> CeremonyEvent | None:
        return next((e for e in self.events_on("called") if not e.done), None)

    def categories(self) -> list[str]:
        """Category names in presentation order, each once."""
        seen: dict[str, str] = {}
        for a in self.awards:
            seen.setdefault(_norm(a.category), a.category)
        return list(seen.values())

    def entries(self, category: str) -> list[Award]:
        key = _norm(category)
        return [a for a in self.awards if _norm(a.category) == key]

    def intro(self, category: str) -> str:
        """The category's introduction (set on any of its winners), or ""."""
        return next((a.intro for a in self.entries(category) if a.intro), "")

    def match(self, spoken: str) -> str | None:
        """Matches what the host said to a category name, tolerating small differences."""
        names = {_norm(c): c for c in self.categories()}
        wanted = _norm(spoken)
        if wanted in names:
            return names[wanted]
        contains = [
            c for n, c in names.items() if wanted and (wanted in n or n in wanted)
        ]
        if len(contains) == 1:
            return contains[0]
        close = difflib.get_close_matches(wanted, list(names), n=1, cutoff=0.6)
        return names[close[0]] if close else None

    def next_category(self) -> str | None:
        for category in self.categories():
            if any(not a.announced for a in self.entries(category)):
                return category
        return None


HOST_STYLES = {
    "professional": (
        "Your style is that of a polished, professional award-ceremony host: gracious, "
        "articulate and composed. Be warm and celebratory, but always dignified and formal; "
        "no slang, jokes or hype."
    ),
    "lively": (
        "Your style is that of a seasoned, charismatic event MC, like an expert DJ working "
        "the room: upbeat, celebratory and full of energy, with short, punchy lines that get "
        "the audience cheering. Stay gracious and respectful; never joke about the winners or "
        "the leaders."
    ),
}
HOLD_REPLY = "Sure, I'll wait."
RESUME_REPLY = "Thank you! Let's continue."
NOTHING_TO_REPEAT = "There's nothing to repeat yet."
SEARCH_FILLER = "Let me check that for you."
# Tina's own short lines in the other languages she can talk in.
REPLIES = {
    "ta": {
        HOLD_REPLY: "சரி, நான் காத்திருக்கிறேன்.",
        RESUME_REPLY: "நன்றி! தொடரலாம்.",
        NOTHING_TO_REPEAT: "மீண்டும் சொல்ல இன்னும் எதுவும் இல்லை.",
        SEARCH_FILLER: "ஒரு நிமிடம், பார்க்கிறேன்.",
    },
}
DEFAULT_KEYWORDS_RAW = [{"phrase": p, "action": a} for p, a in DEFAULT_KEYWORDS]


async def translate(text: str, language: str, usage: HelperUsage) -> str:
    """Fallback when the operator left a translation empty."""
    response = await get_client().messages.create(
        model=HELPER_MODEL,
        max_tokens=2000,
        messages=[
            {
                "role": "user",
                "content": (
                    f"Translate this text, spoken aloud by a warm, formal co-host at a "
                    f"corporate award ceremony in India, into natural spoken "
                    f"{LANGUAGE_NAMES[language]} in the native script. Keep personal and "
                    f"company names as they are. Reply with only the final translation: no notes, alternatives or self-corrections.\n\n{text}"
                ),
            }
        ],
    )
    usage.add(response.usage)
    return "".join(b.text for b in response.content if b.type == "text").strip()


class CeremonyHost(Agent):
    def __init__(
        self,
        *,
        program: CeremonyProgram,
        llm_model: llm.LLM,
        send_slide,
        send_view,
        send_status,
        make_tts,
        usage: HelperUsage,
        wake: WakeWord,
        host_name: str = "",
    ) -> None:
        self._program = program
        # The human host, whom Tina addresses by name.
        self._host_name = host_name.strip()
        self._send_slide = send_slide
        self._send_view = send_view
        self._send_status = send_status
        self._make_tts = make_tts
        # Not named _tts: the Agent base class uses that name for its own TTS.
        self._voices: dict[str, tts.TTS] = {}
        self._usage = usage
        self._wake = wake
        self._tasks: set[asyncio.Task] = set()
        # "please hold": ignore everything but a continue phrase until resumed.
        self._resumed = asyncio.Event()
        self._resumed.set()
        # After her introduction Tina waits for the host's first call ("Hello Tina"),
        # then greets them by name: (language, text) pairs.
        self._greeting: list[tuple[str, str]] = []
        # The start of a request the host hasn't finished, and when it was heard.
        self._pending = ""
        self._pending_at = 0.0
        self._pending_task: asyncio.Task | None = None
        # When the host was last heard (any transcript, even partial).
        self._last_heard = 0.0
        # What "please repeat" says again: (language, text) pairs.
        self._last_said: list[tuple[str, str]] = []
        # Prompts like "Shall I announce the next one?" aren't worth repeating.
        self._prompts: set[str] = {HOLD_REPLY, RESUME_REPLY, NOTHING_TO_REPEAT}
        self._prompts |= {t for lines in REPLIES.values() for t in lines.values()}
        # The language of the host's last request (one of conversation_languages).
        self._host_language = "en"
        # Media playing on the stage ("video", "music"): the PA feeds it into the mic.
        self._media: set[str] = set()
        # When the current video started (the model must not stop it straight away).
        self._video_started = 0.0
        # The suspense track played last, so the next one differs.
        self._last_suspense = ""
        # The slide on screen, so a winner on the same slide isn't hidden again.
        self._shown_slide = 0
        # Ask AI: the audience asks questions on stage, without saying Tina's name.
        self._ask_ai = False
        # Tina reminds the host once of awards not yet announced before ending; the
        # host's next "end the ceremony" is final.
        self._end_reminded = False
        # Not named _instructions: the Agent base class stores its text under that name.
        pause = program.settings.listen_pause
        super().__init__(
            llm=llm_model,
            instructions=self._build_instructions(),
            # The streaming turn detector's default (0.3 s) cut hosts off mid-sentence.
            # A request the detector thinks is unfinished waits up to max_delay.
            turn_handling={
                "endpointing": {"min_delay": pause, "max_delay": pause + 2.0}
            },
        )

    async def on_enter(self) -> None:
        @self.session.on("user_input_transcribed")
        def _on_transcript(ev) -> None:
            self._last_heard = time.monotonic()

        @self.session.on("conversation_item_added")
        def _on_item(ev) -> None:
            item = ev.item
            if getattr(item, "role", None) != "assistant":
                return
            text = (item.text_content or "").strip()
            if (
                text
                and text not in self._prompts
                and all(text not in said for _, said in self._last_said)
            ):
                # A reply the model wrote: "please repeat" says that again.
                self._last_said = [("en", text)]

    def _line(self, english: str) -> str:
        """One of Tina's own short lines, in the host's language."""
        return REPLIES.get(self._host_language, {}).get(english, english)

    async def stt_node(
        self, audio: AsyncIterable[rtc.AudioFrame], model_settings: ModelSettings
    ) -> AsyncIterable[stt.SpeechEvent]:
        # The multilingual STT labels everything English: label transcripts in another
        # script with their language, so the English turn model doesn't misjudge them.
        async for event in Agent.default.stt_node(self, audio, model_settings):
            if isinstance(event, stt.SpeechEvent):
                for alternative in event.alternatives:
                    language = script_language(alternative.text)
                    if language != "en":
                        alternative.language = LanguageCode(language)
            yield event

    async def llm_node(
        self,
        chat_ctx: llm.ChatContext,
        tools: list[llm.Tool],
        model_settings: ModelSettings,
    ) -> AsyncIterable[llm.ChatChunk | str]:
        async for chunk in Agent.default.llm_node(
            self, _tool_calls_last(chat_ctx), tools, model_settings
        ):
            yield chunk

    async def tts_node(
        self, text: AsyncIterable[str], model_settings: ModelSettings
    ) -> AsyncIterable[rtc.AudioFrame]:
        """Speaks a reply in another language (e.g. Tamil) with that language's voice."""
        chunks = text.__aiter__()
        head: list[str] = []
        # Enough of the start to tell the language (a reply may start with a name).
        async for chunk in chunks:
            head.append(chunk)
            if sum(c.isalpha() for c in "".join(head)) >= 12:
                break
        language = script_language("".join(head))

        async def whole() -> AsyncIterable[str]:
            for chunk in head:
                yield chunk
            async for chunk in chunks:
                yield chunk

        if language == "en":
            async for frame in Agent.default.tts_node(self, whole(), model_settings):
                yield frame
            return
        async with self._tts_for(language).stream() as stream:

            async def push() -> None:
                async for chunk in whole():
                    stream.push_text(chunk)
                stream.end_input()

            pushing = asyncio.create_task(push())
            try:
                async for audio in stream:
                    yield audio.frame
            finally:
                await utils.aio.cancel_and_wait(pushing)

    def _run(self, coro) -> None:
        task = asyncio.create_task(coro)
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    @property
    def on_hold(self) -> bool:
        return not self._resumed.is_set()

    def _new_request(self, text: str) -> bool:
        """During a video: an award, an event, a listed song or "play <something else>"
        is a new request rather than a video control."""
        said = _phrase(text)
        if re.search(r"award|விருது", said):
            return True
        names = [n for n, _ in self._program.settings.songs]
        names += [e.name for e in self._program.events_on("called")]
        if any(f" {_phrase(n)} " in f" {said} " for n in names):
            return True
        return video_control(text) == "play" and bool(
            re.search(r"\bplay (?!(it|again|on|the video|video|please)\b)\w", said)
        )

    def media_playing(self, kind: str, playing: bool) -> None:
        """The stage started or stopped a video or the walk-up music."""
        if playing:
            if kind == "video":
                self._video_started = time.monotonic()
            self._media.add(kind)
            # The soundtrack isn't the host: only a request with Tina's name counts.
            self._wake.close()
        else:
            self._media.discard(kind)
        logger.info("media %s %s", kind, "playing" if playing else "stopped")

    async def on_user_turn_completed(
        self, turn_ctx: llm.ChatContext, new_message: llm.ChatMessage
    ) -> None:
        text = (new_message.text_content or "").strip()
        if self._pending_task:
            self._pending_task.cancel()
            self._pending_task = None
        if self._pending and time.monotonic() - self._pending_at < 15:
            # The rest of a request the host paused in the middle of.
            text = f"{self._pending} {text}"
            new_message.content = [text]
            logger.info("joined a paused request: %s", text)
        self._pending = ""
        # Speech-to-text may write the name in Tamil script ("டீனா, how are you?"):
        # that doesn't make an English request Tamil.
        language = script_language(without_name(text))
        if language == "en" and script_language(text) != "en":
            text = name_in_english(text)
            new_message.content = [text]
        if language in self._program.settings.conversation_languages:
            self._host_language = language
        settings = self._program.settings
        action = settings.keyword(text)
        # Over music or a video, or in an audience question during Ask AI, a keyword
        # counts only when it's all that was said ("please hold"), not inside a lyric or
        # a longer sentence ("Hold on, can I ask..." put Tina on hold mid Ask AI).
        if (self._media or self._ask_ai) and action and not settings.only_keyword(text):
            action = None
        session = self.session
        if self.on_hold:
            if action == "continue":
                logger.info("resumed")
                self._resumed.set()
                await self._send_status({"type": "hold", "on": False})
                session.say(self._line(RESUME_REPLY), allow_interruptions=False)
                self._wake.open()
            raise StopResponse()
        if action == "hold":
            logger.info("on hold")
            self._resumed.clear()
            await self._send_status({"type": "hold", "on": True})
            session.say(self._line(HOLD_REPLY), allow_interruptions=False)
            raise StopResponse()
        if action == "repeat":
            logger.info("repeat")
            if self._last_said:
                self.say_parts(session, self._last_said)
            else:
                session.say(self._line(NOTHING_TO_REPEAT), allow_interruptions=False)
            raise StopResponse()
        if action == "continue" and settings.only_keyword(text):
            # "Please continue" with nothing on hold: not a request to Tina (it once
            # announced the next award).
            raise StopResponse()
        if self._media:
            if not mentions_name(text):
                raise StopResponse()
            change = volume_change(text)
            if change:
                # "Tina, louder": adjust straight away and stay quiet over the music.
                logger.info("volume %s", change)
                await self._send_status({"type": "volume", "change": change})
                raise StopResponse()
            if "video" in self._media and self._new_request(text):
                # "Tina, the next award please" or "Tina, play Jai Ho": end the video
                # and carry on with the request.
                logger.info("video stopped for a new request")
                self._media.discard("video")
                await self._send_status({"type": "video_control", "action": "stop"})
            elif "video" in self._media:
                # During a video Tina only takes video controls, and stays quiet.
                control = video_control(text)
                if control:
                    logger.info("video %s", control)
                    if control == "stop":
                        self._media.discard("video")
                    await self._send_status(
                        {"type": "video_control", "action": control}
                    )
                raise StopResponse()
        if self._ask_ai:
            # Anyone on stage may ask, without the name; "okay thanks" is chatter.
            words = [w for w in _phrase(text).split() if not mentions_name(w)]
            if len(words) <= ASK_AI_CHATTER_MAX_WORDS and all(
                w in ASK_AI_CHATTER for w in words
            ):
                raise StopResponse()
            await self._trim_history(turn_ctx)
            return
        # In the hall Tina only reacts when called by name (plus a short follow-up window).
        if not self._wake.accepts(text):
            raise StopResponse()
        if self._greeting:
            # The host's first call: Tina's first words are the greeting.
            logger.info("first call: %s", text)
            parts, self._greeting = self._greeting, []
            self.say_parts(session, parts)
            # A greeting starts a conversation: follow-ups don't need the name.
            self._wake.open()
            if just_salutation(text):
                raise StopResponse()
            # Otherwise answer the request too, right after the greeting.
        if unfinished(text):
            logger.info("waiting for the rest of: %s", text)
            self._pending = text
            self._pending_at = time.monotonic()
            self._wake.open()
            self._pending_task = asyncio.create_task(self._answer_pending_later())
            raise StopResponse()
        await self._trim_history(turn_ctx)

    async def _trim_history(self, turn_ctx: llm.ChatContext) -> None:
        """Keeps an hour-long ceremony's replies fast: once the conversation is long, only
        its recent part is kept (for this reply too)."""
        if len(turn_ctx.items) <= HISTORY_MAX_ITEMS:
            return
        logger.info("trimming the conversation from %d items", len(turn_ctx.items))
        turn_ctx.truncate(max_items=HISTORY_KEEP_ITEMS)
        await self.update_chat_ctx(
            self.chat_ctx.copy().truncate(max_items=HISTORY_KEEP_ITEMS)
        )

    async def _answer_pending_later(self) -> None:
        """Nothing followed the unfinished request: answer what was said."""
        # Wait while the host is still talking: the rest usually arrives as the next turn,
        # which cancels this task.
        while (
            self.session.user_state == "speaking"
            or time.monotonic() - max(self._pending_at, self._last_heard)
            < UNFINISHED_WAIT_SECONDS
        ):
            await asyncio.sleep(0.25)
        text, self._pending = self._pending, ""
        self._pending_task = None
        if text and not self.on_hold:
            self.session.generate_reply(user_input=text)

    def greet_on_first_call(self, parts: list[tuple[str, str]]) -> None:
        self._greeting = parts

    def _tts_for(self, language: str) -> tts.TTS:
        if language not in self._voices:
            self._voices[language] = self._make_tts(language)
        return self._voices[language]

    def say_parts(
        self, session: AgentSession, parts: list[tuple[str, str]]
    ) -> SpeechHandle | None:
        """Says each (language, text) in turn; other languages use their own voice model.

        These are approved texts (introduction, greeting, welcome note), not a
        conversation: afterwards the host calls Tina by name again."""
        self._wake.close()
        handle = None
        for language, text in parts:
            if language == "en":
                handle = session.say(text, allow_interruptions=False)
                continue
            synthesizer = self._tts_for(language)

            async def frames(text: str = text, synthesizer: tts.TTS = synthesizer):
                async with synthesizer.synthesize(text) as stream:
                    async for audio in stream:
                        yield audio.frame

            handle = session.say(text, audio=frames(), allow_interruptions=False)
        self._last_said = list(parts)
        return handle

    async def multilingual(
        self, english: str, languages: list[str], translations: dict[str, str], fill
    ) -> list[tuple[str, str]]:
        """(language, spoken text) for each language; fill() adds e.g. the host's name."""
        parts = []
        for language in languages:
            text = english if language == "en" else translations.get(language, "")
            if not text:
                try:
                    text = await translate(english, language, self._usage)
                except anthropic.APIError as e:
                    logger.warning("translation to %s failed: %s", language, e)
                    continue
            parts.append((language, self._program.settings.spoken(fill(text))))
        return parts

    def _build_instructions(self) -> str:
        lines = []
        for category in self._program.categories():
            entries = self._program.entries(category)
            done = sum(a.announced for a in entries)
            count = f", {len(entries)} winners" if len(entries) > 1 else ""
            status = (
                " (announced)"
                if done == len(entries)
                else f" ({done} of {len(entries)} winners announced)"
                if done
                else ""
            )
            lines.append(f"- {category}{count}{status}")
        categories = "\n".join(lines) or "- (no awards loaded yet)"
        return (
            textwrap.dedent(
                """\
                You are Tina, the AI co-host at a live award ceremony, speaking to the host and the audience through a microphone and speakers. Speak warm, clear English.

                {style}

                # How to behave on stage

                - Keep anything you say yourself very short: one sentence, plain text, no lists or formatting.
                - To announce a specific award, call announce_award with its category. When the host asks for "the next award" without naming it, call announce_next_award. These speak the approved announcement and show the slide. Never announce, guess or mention a winner's name yourself: you do not know the winners.
                - The programme also has events (listed below), such as the lamp lighting, a speech or a performance. The host calls them by name, in any order ("Tina, the lamp lighting please", "Tina, let's begin the fashion walk"): call start_event with the closest event name (e.g. "the welcome note" or "the welcome address" is the Welcome Message), which speaks the event's approved text word-for-word. For "the next event", call start_next_event. Events are not awards: never use announce_award for an event, or start_event for an award. If the host asks for an event that's already done, start it again.
                - When an announce tool succeeds it returns nothing; the announcement you then see in the conversation (ending with the congratulations to the winner) is the approved text and was spoken successfully. The same goes for the events. Never apologise for it, comment on it or repeat it.
                - Some categories have several winners: one announce call announces all of them, one after another, each with its slide. Some categories also have an introduction (what the award recognises), which the announce tools say first.
                - If the host asks for a category that isn't in the list, say so briefly and mention the closest category names.
                - If a category is fully announced and the host asks for it again, confirm first; if they confirm, call announce_award with repeat set to true.
                - Use show_slide when the host asks to show a particular slide (the title slide is slide one), and hide_slides when they ask to hide the slide or show you instead.
                - You can't see the screen; trust the host about it. If the host says the slide didn't come up properly (blank, black, dark, garbled, upside down, still blurred, frozen) or asks to show, reload or refresh the slide again, call reload_slide, then say a few words, e.g. "Sorry about that, here it is again." Never repeat the announcement for this.
                - For "the next slide" or "the previous slide", call change_slide. If the host says the wrong award's slide is up, call show_award_slide with the right category.
                - When the host says to end, close or wrap up the award ceremony, call end_ceremony. If it reports awards not yet announced, remind the host of them in one short sentence and ask whether to end anyway. If the host says to end again or confirms, call end_ceremony again: the host's decision is final, so never remind twice.
                - Between awards, reply briefly and graciously if the host speaks to you, for example "Thank you!".
                - If the host asks a general question (facts, news, sports scores, weather, a person or company), call web_search and answer in one or two short sentences. Never use web search to find award winners.
                - When the host asks for one of the songs listed below by name ("Tina, play Jai Ho"), call play_song; it plays to the end. Then say at most two words, e.g. "Enjoy, everyone!" "Stop the music" calls stop_music.
                - For a lucky draw or an on-the-spot award, when the host asks for suspense music or a drum roll ("Tina, play the suspense music"), call play_suspense_music, then say one short, excited line, e.g. "Let's find out who the lucky one is!"
                - When the host asks for the music or video to be louder or softer, call change_volume, then say at most two words, e.g. "Sure!"
                - When the host asks you to play or show any other video, clip or song, call play_video with a short YouTube search query. While it plays you stay silent.
                - Spell out numbers.
                {host}{languages}
                # Award categories, in presentation order
                """
            )
            .replace("{style}", HOST_STYLES[self._program.settings.style])
            .replace("{host}", self._host_rule())
            .replace("{languages}", self._language_rule())
            + categories
            + "\n\n# Events the host can call by name, in any order\n"
            + (
                "\n".join(
                    f"- {e.name}{' (done)' if e.done else ''}"
                    for e in self._program.events_on("called")
                )
                or "- (none)"
            )
            + "\n\n# Songs the host can ask for by name\n"
            + (
                "\n".join(f"- {name}" for name, _ in self._program.settings.songs)
                or "- (none)"
            )
            + "\n"
            + (ASK_AI_RULES if self._ask_ai else "")
        )

    def _host_rule(self) -> str:
        # During Ask AI the audience asks: their questions aren't the host's.
        if not self._host_name or self._ask_ai:
            return ""
        return (
            f"- The host's name is {self._host_name}. Address them by name now and then, "
            f'for example "Sure, {self._host_name}!", but not in every reply.\n'
        )

    def _language_rule(self) -> str:
        others = [
            LANGUAGE_NAMES[c]
            for c in self._program.settings.conversation_languages
            if c != "en"
        ]
        if not others:
            return ""
        names = " or ".join(others)
        return (
            f"- The host may speak English or {names}; {names} can come written in its "
            f"own script or in English letters, often mixed with English words. Reply in "
            f"the language of the host's latest request: {names} in its own script (never "
            f"in English letters), with names kept as written. The tools speak the approved "
            f"announcements and events as configured: never translate or redo them.\n"
        )

    async def _refresh(self) -> None:
        await self.update_instructions(self._build_instructions())

    async def _speak(self, session: AgentSession, award: Award) -> SpeechHandle:
        logger.info(
            "announcing %s: %s (slide %d)", award.category, award.winner, award.slide
        )
        # After an announcement the MC turns to the audience and the winner: Tina
        # waits to be called by name again.
        self._wake.close()
        settings = self._program.settings
        lead, reveal = settings.announcement_parts(award)
        # A new slide: hide the winner until Tina says the name. Further winners on
        # the same slide (a team) are named straight away.
        suspense = settings.suspense and bool(lead) and award.slide != self._shown_slide
        await self._send_slide(award.slide, hidden=suspense, title=award.category)
        self._shown_slide = award.slide
        award.announced = True
        if not suspense:
            # The approved text, exactly as written; applause must not cut it off.
            handle = self.say_parts(session, [("en", settings.announcement(award))])
            self._run(self._applause_after(handle, award))
            return handle
        # All three are queued now, so nothing can come in between.
        first = session.say(lead, allow_interruptions=False)
        pause = session.say(
            " ",
            audio=silence(settings.suspense_seconds),
            allow_interruptions=False,
            add_to_chat_ctx=False,
        )
        handle = session.say(reveal, allow_interruptions=False)
        self._last_said = [("en", settings.announcement(award))]
        self._run(self._reveal_after(first, pause, settings.suspense_seconds))
        self._run(self._applause_after(handle, award))
        return handle

    async def _reveal_after(
        self, lead: SpeechHandle, pause: SpeechHandle, seconds: float
    ) -> None:
        """Drum-roll countdown during the pause, then the slide is revealed."""
        await lead.wait_for_playout()
        await self._send_status({"type": "suspense", "seconds": seconds})
        await pause.wait_for_playout()
        await self._send_status({"type": "reveal"})

    async def _applause_after(self, handle: SpeechHandle, award: Award) -> None:
        """Once the announcement ends: the ovation and the award's walk-up music."""
        await handle.wait_for_playout()
        await self._send_status(
            {"type": "applause", "category": award.category, "winner": award.winner}
        )

    async def _continue_category(
        self, session: AgentSession, first: SpeechHandle, rest: list[Award]
    ) -> None:
        """Announces the remaining winners of a category, each with its slide, after a
        short pause."""
        previous = first
        for award in rest:
            await previous.wait_for_playout()
            await asyncio.sleep(self._program.settings.pause_seconds)
            # "please hold" pauses the remaining winners too.
            await self._resumed.wait()
            previous = await self._speak(session, award)
        await self._refresh()

    async def _announce(self, ctx: RunContext, category: str, repeat: bool) -> str:
        entries = self._program.entries(category)
        pending = [a for a in entries if not a.announced]
        if not pending:
            if not repeat:
                return f"{category} was already announced. Ask the host whether to announce it again."
            for a in entries:
                a.announced = False
            pending = entries

        session = ctx.session
        if self._ask_ai:
            await self._end_ask_ai()
        intro = self._program.intro(category) if pending[0] is entries[0] else ""
        if intro:
            # What the award stands for, with Tina on screen; then the winners.
            logger.info("introducing %s", category)
            await self._send_view("tina")
            await self._send_status({"type": "event", "name": category})
            handle = self.say_parts(
                session, [("en", self._program.settings.spoken(intro))]
            )
            self._run(self._announce_after(session, handle, pending))
        else:
            first = await self._speak(session, pending[0])
            if pending[1:]:
                self._run(self._continue_category(session, first, pending[1:]))
        await self._refresh()
        # The announcement is the whole reply: don't let the model add anything.
        raise StopResponse()

    async def _announce_after(
        self, session: AgentSession, intro: SpeechHandle | None, pending: list[Award]
    ) -> None:
        """The category's winners, once its introduction has been said."""
        if intro:
            await intro.wait_for_playout()
        # "please hold" during the introduction holds the announcement too.
        await self._resumed.wait()
        first = await self._speak(session, pending[0])
        if pending[1:]:
            await self._continue_category(session, first, pending[1:])
        else:
            await self._refresh()

    @function_tool()
    async def announce_award(self, ctx: RunContext, category: str, repeat: bool) -> str:
        """Announce the winner(s) of a named award category, word-for-word, with the slide.

        Args:
            category: The award category the host asked for, as close to the list as possible.
            repeat: True only if the host confirmed they want a fully announced category repeated.
        """
        matched = self._program.match(category)
        if matched is None:
            names = ", ".join(self._program.categories())
            return f"No category matches {category!r}. Categories are: {names}."
        return await self._announce(ctx, matched, repeat)

    async def _start_event(self, session: AgentSession, event: CeremonyEvent) -> None:
        logger.info("event: %s (slide %d)", event.name, event.slide)
        # Ask AI runs until the host moves on to another event.
        self._ask_ai = event.kind == "ask_ai"
        # The stage stops any music or video for an event; don't wait for it to say so
        # (a missed "stopped" left Tina requiring her name from the audience).
        self._media.clear()
        if event.slide:
            await self._send_slide(event.slide)
            self._shown_slide = event.slide
        else:
            await self._send_view("tina")
        # The stage shows the event's name (through Ask AI) and ends any music or video.
        await self._send_status(
            {"type": "event", "name": event.name, "sticky": self._ask_ai}
        )
        self.say_parts(session, await self.event_parts(event))
        event.done = True
        await self._refresh()

    async def event_parts(self, event: CeremonyEvent) -> list[tuple[str, str]]:
        """(language, spoken text) for each of the event's languages."""
        return await self.multilingual(
            event.script,
            event.languages,
            event.translations,
            lambda text: text.replace("{name}", self._host_name or "everyone"),
        )

    async def translate_events(self) -> None:
        """Translates the events' empty translations up front, so a called event isn't
        held up by translating it."""

        async def one(event: CeremonyEvent, language: str) -> None:
            try:
                event.translations[language] = await translate(
                    event.script, language, self._usage
                )
            except anthropic.APIError as e:
                logger.warning("translation of %s failed: %s", event.name, e)

        await asyncio.gather(
            *(
                one(e, language)
                for e in self._program.events
                for language in e.languages
                if language != "en" and not e.translations.get(language)
            )
        )

    @function_tool()
    async def start_event(self, ctx: RunContext, name: str) -> str:
        """Begin one of the programme's events (listed in the instructions) when the
        host calls it by name, e.g. "Tina, the lamp lighting please": speaks its approved
        text word-for-word. Events are not awards.

        Args:
            name: The event's name as the host said it, as close to the list as possible.
        """
        event = self._program.match_event(name)
        if event is None:
            names = ", ".join(e.name for e in self._program.events) or "none"
            return (
                f"No event matches {name!r}. The events are: {names}. Say so briefly."
            )
        await self._start_event(ctx.session, event)
        # The event's text is the whole reply.
        raise StopResponse()

    async def _end_ask_ai(self) -> None:
        logger.info("Ask AI ended")
        self._ask_ai = False
        await self._send_status({"type": "event_end"})
        await self._refresh()

    @function_tool()
    async def end_ask_ai(self, ctx: RunContext) -> str:
        """End Ask AI (the audience's questions on stage) when the host says so, e.g.
        "Tina, end Ask AI" or "thank you all, let's move on"."""
        if not self._ask_ai:
            return "Ask AI isn't on."
        await self._end_ask_ai()
        return "Ask AI has ended. Thank the audience for their questions in one short, cheerful line."

    @function_tool()
    async def start_next_event(self, ctx: RunContext) -> str:
        """Begin the next event that hasn't been done yet, in programme order, when the
        host asks for "the next event" without naming it."""
        event = self._program.next_event()
        if event is None:
            return "Every event has been done."
        await self._start_event(ctx.session, event)
        raise StopResponse()

    @function_tool()
    async def web_search(self, ctx: RunContext, query: str) -> str:
        """Search the web for current information, e.g. news, facts, scores or weather.

        Args:
            query: The question or topic to search for.
        """
        logger.info("web_search: %s", query)
        # Spoken but kept out of the conversation: saved between the search's call and
        # its result, it made the follow-up request end with Tina's words, which the
        # model rejects ("Let me check that for you", then silence).
        filler = self._line(SEARCH_FILLER)
        async with ctx.with_filler(
            lambda step: ctx.session.say(filler, add_to_chat_ctx=False), delay=1.5
        ):
            try:
                result = await run_web_search(
                    query, LANGUAGE_NAMES[self._host_language], self._usage
                )
            except anthropic.APIError as e:
                logger.warning("web_search failed: %s", e)
                return "The search failed. Say so briefly."
        return result.answer

    @function_tool()
    async def announce_next_award(self, ctx: RunContext) -> str:
        """Announce the next award that hasn't been announced yet, in presentation order."""
        category = self._program.next_category()
        if category is None:
            return "Every award has been announced."
        return await self._announce(ctx, category, False)

    @function_tool()
    async def show_slide(self, ctx: RunContext, slide_number: int) -> str:
        """Show a slide of the presentation on the screen.

        Args:
            slide_number: The slide to show, starting from 1.
        """
        await self._send_slide(max(1, slide_number))
        return f"Slide {slide_number} is on screen."

    @function_tool()
    async def reload_slide(self, ctx: RunContext) -> str:
        """Show the current slide again, freshly drawn, when the host says it didn't
        come up right: blank, black, garbled, upside down, blurred, stuck, or "show the
        slide again". This never repeats an announcement."""
        logger.info("reload_slide")
        await self._send_status({"type": "slide_reload"})
        return "The slide is shown again."

    @function_tool()
    async def change_slide(
        self, ctx: RunContext, direction: Literal["next", "previous"]
    ) -> str:
        """Move one slide forward or back when the host asks for the next or the
        previous slide, without announcing anything.

        Args:
            direction: next or previous.
        """
        logger.info("change_slide %s", direction)
        await self._send_status(
            {"type": "slide_step", "step": 1 if direction == "next" else -1}
        )
        return f"The {direction} slide is on screen."

    @function_tool()
    async def show_award_slide(self, ctx: RunContext, category: str) -> str:
        """Show the slide of an award that has already been announced, without
        announcing it again, e.g. "that's the wrong slide, show the Best Team slide".

        Args:
            category: The award category, as close to the list as possible.
        """
        matched = self._program.match(category)
        if matched is None:
            names = ", ".join(self._program.categories())
            return f"No category matches {category!r}. Categories are: {names}."
        announced = [a for a in self._program.entries(matched) if a.announced]
        if not announced:
            # Its slide shows the winner.
            return (
                f"{matched} hasn't been announced yet, so its slide stays hidden. "
                "Offer to announce it instead."
            )
        logger.info("show_award_slide %s", matched)
        await self._send_slide(announced[-1].slide)
        return f"The {matched} slide is on screen."

    @function_tool()
    async def play_video(self, ctx: RunContext, query: str) -> str:
        """Find a video on YouTube and play it full screen, e.g. "Tina, play the
        Kerala boat race video". It replaces any music or video that is playing: never
        stop anything first.

        Args:
            query: A short YouTube search query for the video the host wants.
        """
        logger.info("play_video: %s", query)
        try:
            videos = await search_videos(query)
        except Exception as e:
            logger.warning("YouTube search failed: %s", e)
            videos = []
        if not videos:
            return "No video was found. Say so in one short sentence."
        self.media_playing("video", True)
        title = short_title(videos[0].title)
        intro = f"இதோ, {title}." if self._host_language == "ta" else f"Here's {title}."
        self._prompts.add(intro)
        handle = ctx.session.say(intro, allow_interruptions=False)
        # The video starts once Tina has introduced it.
        self._run(self._play_after(handle, videos))
        raise StopResponse()

    async def _play_after(self, intro: SpeechHandle, videos: list) -> None:
        await intro.wait_for_playout()
        if "video" in self._media:
            await self._send_status(
                {"type": "video", "videos": [vars(v) for v in videos], "index": 0}
            )

    @function_tool()
    async def play_song(self, ctx: RunContext, name: str) -> str:
        """Play one of the host's songs (listed in the instructions) by its name, e.g.
        during a break: "Tina, play Jai Ho". It replaces any music or video that is
        playing: never stop anything first.

        Args:
            name: The song's name as the host said it.
        """
        song = self._program.settings.song(name)
        if not song:
            names = ", ".join(n for n, _ in self._program.settings.songs) or "none"
            return f"There is no song called {name}. The songs are: {names}. Say so briefly."
        logger.info("play_song: %s", song[0])
        await self._send_status({"type": "song", "name": song[0], "url": song[1]})
        return f"{song[0]} is now playing."

    @function_tool()
    async def play_suspense_music(self, ctx: RunContext) -> str:
        """Play the suspense music (a one-minute build-up ending on a reveal) when the
        host asks for suspense music, a drum roll or lucky draw music, e.g. before an
        on-the-spot award or a lucky draw. It replaces any music or video playing."""
        # A different track from last time.
        url = random.choice(
            [t for t in SUSPENSE_TRACKS if t != self._last_suspense] or SUSPENSE_TRACKS
        )
        self._last_suspense = url
        logger.info("play_suspense_music: %s", url)
        await self._send_status({"type": "song", "name": "Suspense music", "url": url})
        return "The suspense music is now playing."

    @function_tool()
    async def change_volume(
        self, ctx: RunContext, direction: Literal["up", "down"]
    ) -> str:
        """Make the music or video louder (up) or softer (down) when the host asks.

        Args:
            direction: up for louder, down for softer.
        """
        await self._send_status({"type": "volume", "change": direction})
        return "The volume is changed."

    @function_tool()
    async def stop_music(self, ctx: RunContext) -> str:
        """Stop the music, only when the host asks for that ("Tina, stop the music")."""
        await self._send_status({"type": "music_stop"})
        return "The music is stopped."

    @function_tool()
    async def stop_video(self, ctx: RunContext) -> str:
        """Stop the video, only when the host asks for that ("Tina, stop the video")."""
        if "video" not in self._media:
            return "No video is playing."
        if time.monotonic() - self._video_started < 10:
            return "The video has just started; leave it playing."
        self.media_playing("video", False)
        await self._send_status({"type": "video_control", "action": "stop"})
        return "The video is stopped."

    @function_tool()
    async def hide_slides(self, ctx: RunContext) -> str:
        """Hide the slide and show Tina large on the screen, e.g. "Tina, hide the slide"."""
        await self._send_view("tina")
        return "Tina is now shown full screen."

    @function_tool()
    async def end_ceremony(self, ctx: RunContext) -> str:
        """End the award ceremony when the host says so, e.g. "Tina, let's end the
        award ceremony". The first time, it reports awards not yet announced instead."""
        pending = [
            c
            for c in self._program.categories()
            if any(not a.announced for a in self._program.entries(c))
        ]
        if pending and not self._end_reminded:
            self._end_reminded = True
            logger.info("end_ceremony: reminded of %d awards", len(pending))
            return (
                f"Not ended yet. Awards not yet announced: {', '.join(pending)}. "
                "Remind the host and ask whether to end anyway."
            )
        logger.info("end_ceremony")
        self._ask_ai = False
        await self._send_status({"type": "ceremony_end"})
        await self._refresh()
        return (
            "The award ceremony has ended. Thank everyone graciously in one or two short "
            "sentences."
        )

    @function_tool()
    async def remaining_awards(self, ctx: RunContext) -> str:
        """List which award categories have and haven't been announced yet."""
        pending, done = [], []
        for category in self._program.categories():
            entries = self._program.entries(category)
            (done if all(a.announced for a in entries) else pending).append(category)
        return f"Not yet announced: {', '.join(pending) or 'none'}. Announced: {', '.join(done) or 'none'}."
