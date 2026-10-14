"""Award ceremony mode: Tina announces winners word-for-word and shows each slide.

Winners are never put in Tina's instructions; announce_award looks them up only
when the host asks for a category, so she can't reveal one early.
"""

import difflib
import json
import logging
import re
import textwrap
from dataclasses import dataclass, field

from livekit.agents import Agent, RunContext, StopResponse, function_tool, llm

from wake_word import WakeWord

logger = logging.getLogger("agent.ceremony")


@dataclass
class Award:
    category: str
    winner: str
    script: str
    slide: int
    announced: bool = False


@dataclass
class CeremonyProgram:
    awards: list[Award] = field(default_factory=list)

    @classmethod
    def from_json(cls, text: str) -> "CeremonyProgram":
        items = json.loads(text)
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
        return cls(awards=awards)

    def find(self, category: str) -> Award | None:
        """Matches what the host said to a category, tolerating small differences."""

        def norm(s: str) -> str:
            s = re.sub(r"[^a-z0-9 ]", " ", s.lower())
            s = re.sub(r"\b(the|award|awards|for|category|of)\b", " ", s)
            return " ".join(s.split())

        wanted = norm(category)
        by_norm = {norm(a.category): a for a in self.awards}
        if wanted in by_norm:
            return by_norm[wanted]
        contains = [
            a for n, a in by_norm.items() if wanted and (wanted in n or n in wanted)
        ]
        if len(contains) == 1:
            return contains[0]
        close = difflib.get_close_matches(wanted, list(by_norm), n=1, cutoff=0.6)
        return by_norm[close[0]] if close else None


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
        super().__init__(llm=llm_model, instructions=self._instructions())

    async def on_user_turn_completed(
        self, turn_ctx: llm.ChatContext, new_message: llm.ChatMessage
    ) -> None:
        # In the hall Tina only reacts when called by name (plus a short follow-up window).
        if not self._wake.accepts(new_message.text_content or ""):
            raise StopResponse()

    def _instructions(self) -> str:
        lines = [
            f"- {a.category}{' (already announced)' if a.announced else ''}"
            for a in self._program.awards
        ]
        categories = "\n".join(lines) or "- (no awards loaded yet)"
        return (
            textwrap.dedent(
                """\
                You are Tina, the AI co-host at a live award ceremony, speaking to the host and the audience through a microphone and speakers. Speak warm, clear English.

                # How to behave on stage

                - Keep anything you say yourself very short: one sentence, plain text, no lists or formatting.
                - To announce an award, always call announce_award with the category. It speaks the approved announcement and shows the slide. Never announce, guess or mention a winner's name yourself: you do not know the winners.
                - If the host asks for a category that isn't in the list, say so briefly and mention the closest category names.
                - If a category was already announced and the host asks again, confirm first whether they want it announced again; if yes, call announce_award with repeat set to true.
                - Use show_slide when the host asks to show a particular slide (for example the title slide is slide one), and hide_slides when they ask to hide the slide or show you instead.
                - Between awards, reply briefly and graciously if the host speaks to you, for example "Thank you!".
                - Spell out numbers.

                # Award categories
                """
            )
            + categories
            + "\n"
        )

    @function_tool()
    async def announce_award(self, ctx: RunContext, category: str, repeat: bool) -> str:
        """Announce the winner of an award category, word-for-word, and show its slide.

        Args:
            category: The award category the host asked for, as close to the list as possible.
            repeat: True only if the host confirmed they want an already-announced award repeated.
        """
        award = self._program.find(category)
        if award is None:
            names = ", ".join(a.category for a in self._program.awards)
            return f"No category matches {category!r}. Categories are: {names}."
        if award.announced and not repeat:
            return f"{award.category} was already announced. Ask the host whether to announce it again."

        logger.info("announcing %s (slide %d)", award.category, award.slide)
        await self._send_slide(award.slide)
        # The approved text, exactly as written; applause must not cut it off.
        ctx.session.say(award.script, allow_interruptions=False)
        award.announced = True
        await self.update_instructions(self._instructions())
        # The announcement is the whole reply: don't let the model add anything.
        raise StopResponse()

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
        pending = [a.category for a in self._program.awards if not a.announced]
        done = [a.category for a in self._program.awards if a.announced]
        return f"Not yet announced: {', '.join(pending) or 'none'}. Announced: {', '.join(done) or 'none'}."
