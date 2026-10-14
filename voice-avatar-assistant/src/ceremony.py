"""Award ceremony mode: Tina announces winners word-for-word and shows each slide.

Winners are never put in Tina's instructions; the announce tools look them up only
when the host asks, so she can't reveal one early. A category can have several
winners (one entry each, in presentation order).
"""

import asyncio
import difflib
import json
import logging
import re
import textwrap
from dataclasses import dataclass, field
from typing import Literal

from livekit.agents import (
    Agent,
    AgentSession,
    RunContext,
    StopResponse,
    function_tool,
    llm,
)
from livekit.agents.voice import SpeechHandle

from wake_word import WakeWord

logger = logging.getLogger("agent.ceremony")

# {name} is replaced by the host's name.
DEFAULT_GREETING = "Hi {name}, good day! I am happy to be your co-host."
DEFAULT_WELCOME_NOTE = (
    "Good evening, esteemed UST leaders and dear colleagues. A warm welcome to the PACS "
    "Annual Rewards and Recognition Ceremony. We sincerely thank our leaders for taking "
    "time out of their busy schedules to join us. Your presence and continued support "
    "make this occasion truly special. Let us celebrate excellence and achievement together!"
)


@dataclass
class Award:
    category: str
    winner: str
    script: str
    slide: int
    announced: bool = False


@dataclass
class CeremonySettings:
    # With several winners in a category: "ask" the host before each next winner,
    # or continue "auto"matically after a pause.
    multi_winner: Literal["ask", "auto"] = "ask"
    pause_seconds: float = 8.0
    greeting: str = DEFAULT_GREETING
    welcome_note: str = DEFAULT_WELCOME_NOTE
    # Written name -> how Tina should say it, e.g. "Soumya" -> "Sow-mya".
    pronunciations: dict[str, str] = field(default_factory=dict)

    def greeting_for(self, host_name: str) -> str:
        return self.greeting.replace("{name}", host_name or "everyone")

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

    @classmethod
    def from_json(cls, text: str) -> "CeremonyProgram":
        data = json.loads(text)
        # Older pages sent just the award list.
        items = data if isinstance(data, list) else data.get("awards", [])
        raw = {} if isinstance(data, list) else data.get("settings", {}) or {}
        settings = CeremonySettings(
            multi_winner="auto" if raw.get("multi_winner") == "auto" else "ask",
            pause_seconds=min(max(float(raw.get("pause_seconds", 8)), 2), 60),
            greeting=str(raw.get("greeting") or DEFAULT_GREETING).strip(),
            welcome_note=str(raw.get("welcome_note") or DEFAULT_WELCOME_NOTE).strip(),
            pronunciations={
                str(p["written"]).strip(): str(p["spoken"]).strip()
                for p in raw.get("pronunciations", []) or []
                if str(p.get("written", "")).strip()
                and str(p.get("spoken", "")).strip()
            },
        )
        awards = [
            Award(
                category=str(item["category"]).strip(),
                winner=str(item.get("winner", "")).strip(),
                script=str(item["script"]).strip(),
                slide=int(item.get("slide", 1)),
            )
            for item in items
            if str(item.get("category", "")).strip()
            and str(item.get("script", "")).strip()
        ]
        return cls(awards=awards, settings=settings)

    def categories(self) -> list[str]:
        """Category names in presentation order, each once."""
        seen: dict[str, str] = {}
        for a in self.awards:
            seen.setdefault(_norm(a.category), a.category)
        return list(seen.values())

    def entries(self, category: str) -> list[Award]:
        key = _norm(category)
        return [a for a in self.awards if _norm(a.category) == key]

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


class CeremonyHost(Agent):
    def __init__(
        self,
        *,
        program: CeremonyProgram,
        llm_model: llm.LLM,
        send_slide,
        send_view,
        wake: WakeWord,
    ) -> None:
        self._program = program
        self._send_slide = send_slide
        self._send_view = send_view
        self._wake = wake
        self._tasks: set[asyncio.Task] = set()
        # Not named _instructions: the Agent base class stores its text under that name.
        super().__init__(llm=llm_model, instructions=self._build_instructions())

    async def on_user_turn_completed(
        self, turn_ctx: llm.ChatContext, new_message: llm.ChatMessage
    ) -> None:
        # In the hall Tina only reacts when called by name (plus a short follow-up window).
        if not self._wake.accepts(new_message.text_content or ""):
            raise StopResponse()

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

                # How to behave on stage

                - Keep anything you say yourself very short: one sentence, plain text, no lists or formatting.
                - When the host asks you to give the welcome note, welcome address or opening speech, call say_welcome_note. It speaks the approved text word-for-word.
                - To announce a specific award, call announce_award with its category. When the host asks for "the next award" without naming it, call announce_next_award. These speak the approved announcement and show the slide. Never announce, guess or mention a winner's name yourself: you do not know the winners.
                - When an announce tool succeeds it returns nothing; the announcement you then see in the conversation was spoken successfully. Never apologise for it, comment on it or repeat it.
                - Some categories have several winners. If you asked whether to announce the next winner of a category and the host agrees, call announce_award with that same category.
                - If the host asks for a category that isn't in the list, say so briefly and mention the closest category names.
                - If a category is fully announced and the host asks for it again, confirm first; if they confirm, call announce_award with repeat set to true.
                - Use show_slide when the host asks to show a particular slide (the title slide is slide one), and hide_slides when they ask to hide the slide or show you instead.
                - Between awards, reply briefly and graciously if the host speaks to you, for example "Thank you!".
                - Spell out numbers.

                # Award categories, in presentation order
                """
            )
            + categories
            + "\n"
        )

    async def _refresh(self) -> None:
        await self.update_instructions(self._build_instructions())

    async def _speak(self, session: AgentSession, award: Award) -> SpeechHandle:
        logger.info(
            "announcing %s: %s (slide %d)", award.category, award.winner, award.slide
        )
        await self._send_slide(award.slide)
        # The approved text, exactly as written; applause must not cut it off.
        handle = session.say(
            self._program.settings.spoken(award.script), allow_interruptions=False
        )
        award.announced = True
        return handle

    async def _continue_category(
        self, session: AgentSession, first: SpeechHandle, rest: list[Award]
    ) -> None:
        """Auto mode: after each winner, pause for applause, then the next winner."""
        previous = first
        for award in rest:
            await previous.wait_for_playout()
            await asyncio.sleep(self._program.settings.pause_seconds)
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
        first = await self._speak(session, pending[0])
        rest = pending[1:]
        if rest and self._program.settings.multi_winner == "auto":
            task = asyncio.create_task(self._continue_category(session, first, rest))
            self._tasks.add(task)
            task.add_done_callback(self._tasks.discard)
        elif rest:
            more = "one more winner" if len(rest) == 1 else f"{len(rest)} more winners"
            session.say(
                f"There is {more} for {category}. Shall I announce the next one?",
                allow_interruptions=False,
            )
            # The host's "yes" doesn't need the name again.
            self._wake.extend()
        await self._refresh()
        # The announcement is the whole reply: don't let the model add anything.
        raise StopResponse()

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

    @function_tool()
    async def say_welcome_note(self, ctx: RunContext) -> str:
        """Give the approved welcome note to the audience, word-for-word."""
        logger.info("welcome note")
        await self._send_view("tina")
        ctx.session.say(
            self._program.settings.spoken(self._program.settings.welcome_note),
            allow_interruptions=False,
        )
        # The welcome note is the whole reply.
        raise StopResponse()

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
    async def hide_slides(self, ctx: RunContext) -> str:
        """Hide the slide and show Tina large on the screen, e.g. "Tina, hide the slide"."""
        await self._send_view("tina")
        return "Tina is now shown full screen."

    @function_tool()
    async def remaining_awards(self, ctx: RunContext) -> str:
        """List which award categories have and haven't been announced yet."""
        pending, done = [], []
        for category in self._program.categories():
            entries = self._program.entries(category)
            (done if all(a.announced for a in entries) else pending).append(category)
        return f"Not yet announced: {', '.join(pending) or 'none'}. Announced: {', '.join(done) or 'none'}."
