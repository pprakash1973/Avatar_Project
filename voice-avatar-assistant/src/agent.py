import asyncio
import base64
import json
import logging
import os
import time
from datetime import UTC, datetime
from typing import Any, Literal

import anthropic as anthropic_sdk
from dotenv import load_dotenv
from livekit import rtc
from livekit.agents import (
    Agent,
    AgentServer,
    AgentSession,
    APIConnectOptions,
    APIStatusError,
    JobContext,
    RunContext,
    StopResponse,
    TurnHandlingOptions,
    cli,
    function_tool,
    inference,
    llm,
    stt,
    tts,
)
from livekit.plugins import anam, anthropic, cartesia, deepgram, simli
from livekit.plugins.anthropic import llm as _anthropic_llm

import files
import memory
import store
import travel
from ceremony import CeremonyHost, CeremonyProgram
from claude import HelperUsage
from prompts import (
    DEFAULT_STYLE,
    LANGUAGES,
    STYLES,
    build_greeting,
    build_instructions,
)
from vision import VideoWatcher
from wake_word import WakeWord
from web_search import run_web_search

logger = logging.getLogger("agent")

# livekit-plugins-anthropic ships a stale "no prefill" model list, so a filler
# spoken mid-tool-call leaves a trailing assistant message and the next LLM call
# 400s on current Claude models. Remove once the plugin ships a fix.
_anthropic_llm._NO_PREFILL_PATTERNS = (
    *_anthropic_llm._NO_PREFILL_PATTERNS,
    "claude-sonnet-5",
    "claude-opus-5",
    "claude-opus-4-7",
    "claude-opus-4-8",
    "claude-haiku-5",
    "claude-fable-5",
    "claude-mythos-5",
)

load_dotenv(".env.local")

MAIN_MODEL = "claude-sonnet-5-5"

# Topics shared with the frontend (agent-starter-react/lib/agent-channels.ts).
FILE_UPLOAD_TOPIC = "file-upload"
UI_CARD_TOPIC = "ui-card"
UI_STATUS_TOPIC = "ui-status"
CEREMONY_AWARDS_TOPIC = "ceremony-awards"

# Tina's voices (Cartesia). The browser picks one by key; Priya, an Indian-English
# female voice, is the default (TINA_VOICE_ID overrides the default).
VOICES = {
    "priya": "f6141af3-5f94-418c-80ed-a45d450e7e2e",
    "janvi": "7ea5e9c2-b719-4dc3-b870-5ba5f14d31d8",
    "kiara": "f8f5f1b2-f02d-4d8e-a40d-fd850a487b3d",
    "simi": "3b554273-4299-48b9-9aaf-eefd438e3941",
    "katie": "f786b574-daa5-4673-aa0c-cbe3e8534c02",
}
TINA_VOICE_ID = os.environ.get("TINA_VOICE_ID", VOICES["priya"])

# No defaults on enum tool params: LiveKit makes defaulted params nullable, and the
# Claude API rejects an enum typed ["string", "null"], failing every LLM request.
# Both params are required and take an explicit "unchanged" instead.
StyleChoice = Literal["friendly", "professional", "concise", "humorous", "unchanged"]
MoodChoice = Literal["on", "off", "unchanged"]
TOOL_FAILED = "The search failed. Tell the user once and offer to try again."


def make_stt(language: str) -> stt.STT:
    # Deepgram has no Malayalam model; Cartesia's Whisper-based STT does.
    if language == "ml":
        return cartesia.STT(model="ink-whisper", language="ml")
    return deepgram.STT(model="nova-3", language=language)


def make_tts(language: str, voice: str = "") -> tts.TTS:
    # Malayalam voices need Sonic 3.6; the other languages stay on the tested sonic-3.
    return cartesia.TTS(
        model="sonic-3.6" if language == "ml" else "sonic-3",
        language=language,
        voice=VOICES.get(voice, TINA_VOICE_ID),
    )


AVATAR_JOIN_TIMEOUT_SECONDS = 20


def avatar_provider() -> str:
    """AVATAR_PROVIDER picks the avatar; defaults to Simli when its key is set."""
    provider = os.environ.get("AVATAR_PROVIDER", "").lower()
    if provider in ("simli", "anam"):
        return provider
    return "simli" if os.environ.get("SIMLI_API_KEY") else "anam"


async def start_avatar(
    provider: str, session: AgentSession, ctx: JobContext, *, long_event: bool = False
) -> bool:
    """Starts the avatar and waits for it to join; False if it isn't available."""
    if provider == "simli":
        avatar = simli.AvatarSession(
            simli_config=simli.SimliConfig(
                api_key=os.environ["SIMLI_API_KEY"],
                face_id=os.environ["SIMLI_FACE_ID"],
                # Cap call length to protect the plan's minutes, and don't drop
                # the avatar while the user is quietly reading a card. A ceremony
                # runs 30-45 minutes with breaks of a few minutes between awards.
                max_session_length=(75 if long_event else 15) * 60,
                max_idle_time=(10 if long_event else 3) * 60,
            ),
        )
    else:
        avatar = anam.AvatarSession(
            persona_config=anam.PersonaConfig(
                name=os.environ.get("ANAM_AVATAR_NAME", "assistant"),
                avatarId=os.environ["ANAM_AVATAR_ID"],
            ),
            conn_options=APIConnectOptions(max_retry=1),
        )
    try:
        await avatar.start(session, room=ctx.room)
        # The Simli plugin logs failures instead of raising, so confirm the
        # avatar actually joined before going on.
        await asyncio.wait_for(
            ctx.wait_for_participant(
                identity=avatar.avatar_identity,
                kind=rtc.ParticipantKind.PARTICIPANT_KIND_AGENT,
            ),
            AVATAR_JOIN_TIMEOUT_SECONDS,
        )
    except (APIStatusError, TimeoutError) as e:
        logger.warning("%s avatar unavailable: %s", provider, e)
        return False
    return True


async def send_ui(room: rtc.Room, topic: str, payload: dict[str, Any]) -> None:
    try:
        await room.local_participant.send_text(json.dumps(payload), topic=topic)
    except Exception:
        logger.exception("failed to send %s message", topic)


class Assistant(Agent):
    def __init__(
        self,
        *,
        room: rtc.Room,
        usage: HelperUsage,
        video: VideoWatcher,
        user_name: str = "",
        language: str = "en",
        memory_note: str = "",
        style: str = DEFAULT_STYLE,
        adapt_to_mood: bool = True,
        wake: WakeWord | None = None,
    ) -> None:
        self._wake = wake or WakeWord(enabled=False)
        self._room = room
        self._usage = usage
        self._video = video
        self._user_name = user_name
        self._language = language
        self._language_name = LANGUAGES[language]["name"]
        self._checking_phrase = LANGUAGES[language]["checking"]
        self._memory_note = memory_note
        self.style = style
        self.adapt_to_mood = adapt_to_mood
        super().__init__(
            # No temperature: Sonnet 5.5 rejects non-default sampling values.
            # parallel_tool_calls=False avoids duplicate tool calls.
            llm=anthropic.LLM(model=MAIN_MODEL, parallel_tool_calls=False),
            instructions=self._build_instructions(),
        )

    # Not named _instructions: the Agent base class stores its text under that name.
    def _build_instructions(self) -> str:
        return build_instructions(
            user_name=self._user_name,
            language=self._language,
            memory_note=self._memory_note,
            style=self.style,
            adapt_to_mood=self.adapt_to_mood,
        )

    async def on_user_turn_completed(
        self, turn_ctx: llm.ChatContext, new_message: llm.ChatMessage
    ) -> None:
        # With "only respond when called Tina" on, ignore turns not addressed to her.
        if not self._wake.accepts(new_message.text_content or ""):
            raise StopResponse()
        # While the user shares their screen or camera, let the model see it.
        latest = self._video.latest()
        if latest is not None:
            source, frame = latest
            new_message.content.append(f"[Current frame of my {source}:]")
            new_message.content.append(
                llm.ImageContent(
                    image=frame, inference_width=1024, inference_height=1024
                )
            )

    @function_tool()
    async def web_search(self, ctx: RunContext, query: str) -> str:
        """Search the web for current information and return a short, cited summary.

        Use this whenever the user asks about something recent, time-sensitive,
        or that you aren't confident you know accurately.

        Args:
            query: The question or topic to search for.
        """
        logger.info("web_search: %s", query)
        async with ctx.with_filler(self._checking_phrase, delay=1.5):
            result = await run_web_search(query, self._language_name, self._usage)
        await send_ui(
            self._room,
            UI_CARD_TOPIC,
            {
                "type": "search",
                "query": query,
                "answer": result.answer,
                "sources": result.sources,
            },
        )
        if result.sources:
            urls = ", ".join(s["url"] for s in result.sources)
            return f"{result.answer} (sources: {urls})"
        return result.answer

    @function_tool()
    async def search_travel(
        self,
        ctx: RunContext,
        kind: Literal["flights", "hotels", "trains", "buses"],
        destination: str,
        depart_date: str,
        origin: str = "",
        return_date: str = "",
        travelers: int = 1,
        preferences: str = "",
    ) -> str:
        """Research flights, hotels, trains or buses on the web and compare options.

        Results are estimates from public web pages; booking links are shown on screen.

        Args:
            kind: What to search for.
            destination: Destination city (for hotels, where to stay).
            depart_date: Travel date as YYYY-MM-DD (for hotels, the check-in date).
            origin: Departure city; required for flights, trains and buses.
            return_date: Return date as YYYY-MM-DD (for hotels, the check-out date), if any.
            travelers: Number of travelers or guests.
            preferences: Cabin or class, budget, timing, amenities or other preferences.
        """
        logger.info(
            "search_travel: %s %s -> %s on %s", kind, origin, destination, depart_date
        )
        try:
            async with ctx.with_filler(self._checking_phrase, delay=1.5):
                result = await travel.search_travel(
                    kind=kind,
                    origin=origin,
                    destination=destination,
                    depart_date=depart_date,
                    return_date=return_date,
                    travelers=travelers,
                    preferences=preferences,
                    language=self._language_name,
                    today=datetime.now(UTC).date().isoformat(),
                    usage=self._usage,
                )
        except (anthropic_sdk.APIError, ValueError, KeyError) as e:
            logger.warning("search_travel failed: %s", e)
            return TOOL_FAILED
        await send_ui(
            self._room,
            UI_CARD_TOPIC,
            {
                "type": "travel",
                "kind": result.kind,
                "title": result.title,
                "summary": result.summary,
                "options": result.options,
                "booking_links": result.booking_links,
                "retrieved_at": result.retrieved_at,
            },
        )
        options = "; ".join(
            f"{o['name']}: {o['details']} ({o['price']})" for o in result.options
        )
        return (
            f"{result.summary}\nOptions: {options}\n"
            f"Prices are estimates retrieved at {result.retrieved_at} UTC; "
            "booking links are on screen."
        )

    @function_tool()
    async def plan_itinerary(
        self,
        ctx: RunContext,
        destination: str,
        days: int,
        start_date: str = "",
        origin: str = "",
        travelers: int = 1,
        budget: str = "",
        interests: str = "",
    ) -> str:
        """Create a day-by-day trip itinerary with an estimated budget.

        Args:
            destination: Where the trip is to.
            days: Number of days.
            start_date: First day as YYYY-MM-DD, if known.
            origin: Where the travelers start from, to include travel costs.
            travelers: Number of travelers.
            budget: Budget limit or level, if mentioned.
            interests: Interests or must-sees, if mentioned.
        """
        logger.info("plan_itinerary: %s for %d days", destination, days)
        try:
            async with ctx.with_filler(self._checking_phrase, delay=1.5):
                result = await travel.plan_itinerary(
                    destination=destination,
                    origin=origin,
                    start_date=start_date,
                    days=max(1, min(days, 14)),
                    travelers=travelers,
                    budget=budget,
                    interests=interests,
                    language=self._language_name,
                    today=datetime.now(UTC).date().isoformat(),
                    usage=self._usage,
                )
        except (anthropic_sdk.APIError, ValueError, KeyError) as e:
            logger.warning("plan_itinerary failed: %s", e)
            return TOOL_FAILED
        await send_ui(
            self._room,
            UI_CARD_TOPIC,
            {
                "type": "itinerary",
                "title": result.title,
                "summary": result.summary,
                "days": result.days,
                "budget": result.budget,
                "total_estimate": result.total_estimate,
                "retrieved_at": result.retrieved_at,
            },
        )
        return (
            f"{result.summary}\nEstimated total: {result.total_estimate}. The full "
            "day-by-day plan and budget are on screen; costs are estimates."
        )

    @function_tool()
    async def set_conversation_style(
        self,
        ctx: RunContext,
        style: StyleChoice,
        adapt_to_mood: MoodChoice,
    ) -> str:
        """Change how you talk when the user asks, e.g. "be more professional",
        "keep it short", "be funny", or "stop adapting to my mood".

        Args:
            style: The new style, or "unchanged" to keep the current one.
            adapt_to_mood: "on" or "off" to adapt tone to cues like urgency or frustration, or "unchanged".
        """
        if style in STYLES:
            self.style = style
        if adapt_to_mood != "unchanged":
            self.adapt_to_mood = adapt_to_mood == "on"
        await self.update_instructions(self._build_instructions())
        await send_ui(
            self._room,
            UI_STATUS_TOPIC,
            {"type": "style", "style": self.style, "adapt": self.adapt_to_mood},
        )
        return f"Style is now {self.style}; mood adaptation is {'on' if self.adapt_to_mood else 'off'}."


class FileReader:
    """Receives files the user uploads during a call and feeds them to the agent."""

    def __init__(
        self,
        *,
        session: AgentSession,
        assistant: Assistant,
        room: rtc.Room,
        usage: HelperUsage,
        language: str,
    ) -> None:
        self._session = session
        self._assistant = assistant
        self._room = room
        self._usage = usage
        self._language = language
        self._tasks: set[asyncio.Task] = set()

    def on_stream(
        self, reader: rtc.ByteStreamReader, participant_identity: str
    ) -> None:
        task = asyncio.create_task(self._handle(reader))
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    async def _reject(self, name: str, reason: str) -> None:
        await send_ui(
            self._room,
            UI_CARD_TOPIC,
            {"type": "file_error", "name": name, "reason": reason},
        )
        self._session.generate_reply(
            instructions=f"Briefly tell the user their file {name!r} couldn't be read: {reason}"
        )

    async def _handle(self, reader: rtc.ByteStreamReader) -> None:
        name = reader.info.name or "file"
        try:
            kind, media_type = files.file_kind(name)
        except files.UnsupportedFileError:
            await self._reject(
                name, "only PDF, Word (.docx), JPG and PNG files are supported"
            )
            return
        if reader.info.size and reader.info.size > files.MAX_FILE_BYTES:
            await self._reject(name, "it is larger than the one megabyte limit")
            return

        data = bytearray()
        async for chunk in reader:
            data.extend(chunk)
            if len(data) > files.MAX_FILE_BYTES:
                await self._reject(name, "it is larger than the one megabyte limit")
                return

        logger.info("received file %s (%d bytes)", name, len(data))
        self._session.say(LANGUAGES[self._language]["reading_file"])
        try:
            digest = await files.summarize_file(
                name, bytes(data), LANGUAGES[self._language]["name"], self._usage
            )
        except files.UnsupportedFileError:
            await self._reject(name, "it doesn't contain any readable text")
            return
        except (anthropic_sdk.APIError, ValueError) as e:
            logger.warning("failed to read file %s: %s", name, e)
            await self._reject(name, "something went wrong while reading it")
            return

        self._usage.files += 1
        self._usage.file_names.append(name)
        await send_ui(
            self._room,
            UI_CARD_TOPIC,
            {
                "type": "file",
                "name": name,
                "title": digest.title,
                "summary": digest.summary,
                "key_points": digest.key_points,
            },
        )

        content: list[llm.ChatContent] = [
            f"[I uploaded a file named {name!r}. Notes on its contents:]\n"
            f"Title: {digest.title}\nSummary: {digest.summary}\n{digest.notes}"
        ]
        if kind == "image":
            # Keep the image itself so follow-up questions can look at the details.
            encoded = base64.standard_b64encode(bytes(data)).decode("ascii")
            content.append(
                llm.ImageContent(image=f"data:{media_type};base64,{encoded}")
            )
        chat_ctx = self._assistant.chat_ctx.copy()
        chat_ctx.add_message(role="user", content=content)
        await self._assistant.update_chat_ctx(chat_ctx)
        self._session.generate_reply(
            instructions=(
                "The user just uploaded a file; its notes are in the conversation. "
                "Give a brief spoken summary in two or three sentences, then ask what "
                "they would like to know about it."
            )
        )


def _usage_totals(session: AgentSession) -> dict[str, float]:
    totals = {
        "llm_input_tokens": 0,
        "llm_cached_input_tokens": 0,
        "llm_output_tokens": 0,
        "stt_seconds": 0.0,
        "tts_characters": 0,
    }
    for usage in session.usage.model_usage:
        if usage.type == "llm_usage":
            totals["llm_input_tokens"] += usage.input_tokens
            totals["llm_cached_input_tokens"] += usage.input_cached_tokens
            totals["llm_output_tokens"] += usage.output_tokens
        elif usage.type == "stt_usage":
            totals["stt_seconds"] += usage.audio_duration
        elif usage.type == "tts_usage":
            totals["tts_characters"] += usage.characters_count
    return totals


async def run_ceremony(
    ctx: JobContext,
    session: AgentSession,
    wake: WakeWord,
    record: dict[str, Any],
    started_at: float,
) -> None:
    """Award ceremony: get the approved awards from the browser, then host."""
    loop = asyncio.get_running_loop()
    program_future: asyncio.Future[CeremonyProgram] = loop.create_future()
    tasks: set[asyncio.Task] = set()

    async def read_awards(reader: rtc.TextStreamReader) -> None:
        try:
            program = CeremonyProgram.from_json(await reader.read_all())
        except (ValueError, KeyError, TypeError) as e:
            logger.warning("invalid ceremony awards: %s", e)
            program = CeremonyProgram()
        if not program_future.done():
            program_future.set_result(program)

    def on_awards(reader: rtc.TextStreamReader, participant_identity: str) -> None:
        task = asyncio.create_task(read_awards(reader))
        tasks.add(task)
        task.add_done_callback(tasks.discard)

    ctx.room.register_text_stream_handler(CEREMONY_AWARDS_TOPIC, on_awards)
    # Ask the browser for the award list; it is only kept on the host laptop.
    await send_ui(ctx.room, UI_STATUS_TOPIC, {"type": "ceremony_ready"})
    try:
        program = await asyncio.wait_for(program_future, 30)
    except TimeoutError:
        logger.warning("no ceremony awards received")
        program = CeremonyProgram()
    logger.info("ceremony with %d awards", len(program.awards))

    async def send_slide(slide: int) -> None:
        await send_ui(ctx.room, UI_STATUS_TOPIC, {"type": "slide", "slide": slide})

    async def send_view(view: str) -> None:
        await send_ui(ctx.room, UI_STATUS_TOPIC, {"type": "view", "view": view})

    host = CeremonyHost(
        program=program,
        llm_model=anthropic.LLM(model=MAIN_MODEL, parallel_tool_calls=False),
        send_slide=send_slide,
        send_view=send_view,
        wake=wake,
    )
    await session.start(agent=host, room=ctx.room)
    # Greet the room as soon as Tina is on screen; the hall can't interrupt it.
    greeting = program.settings.greeting_for(record.get("name", ""))
    session.say(program.settings.spoken(greeting), allow_interruptions=False)
    wake.extend()
    await send_ui(
        ctx.room,
        UI_STATUS_TOPIC,
        {"type": "ceremony_live", "awards": len(program.awards)},
    )

    async def finish_ceremony() -> None:
        await store.record_call(
            {
                **record,
                "status": "ok",
                "duration_s": round(time.time() - started_at, 1),
                "awards_announced": sum(a.announced for a in program.awards),
                "llm_model": MAIN_MODEL,
                **_usage_totals(session),
            }
        )

    ctx.add_shutdown_callback(finish_ceremony)


server = AgentServer()


@server.rtc_session(agent_name="voice-avatar-assistant")
async def entrypoint(ctx: JobContext) -> None:
    ctx.log_context_fields = {"room": ctx.room.name}
    started_at = time.time()

    await ctx.connect()

    # The frontend sends the name typed on the welcome screen as the participant
    # name, and the language, style and a per-browser visitor id as attributes.
    # The avatar joins as an "agent" participant, so it is never matched here.
    try:
        participant = await asyncio.wait_for(ctx.wait_for_participant(), 60)
    except (TimeoutError, RuntimeError) as e:
        # The visitor gave up before the agent joined (e.g. while it was waking up).
        logger.info("no participant to talk to: %s", e)
        ctx.shutdown("participant left")
        return
    attributes = participant.attributes
    user_name = participant.name.strip()
    language = attributes.get("language", "en")
    if language not in LANGUAGES:
        language = "en"
    style = attributes.get("style", DEFAULT_STYLE)
    if style not in STYLES:
        style = DEFAULT_STYLE
    adapt_to_mood = attributes.get("adapt", "1") != "0"
    visitor_id = attributes.get("visitor_id", "")
    if not store.valid_visitor_id(visitor_id):
        visitor_id = ""
    is_ceremony = attributes.get("mode") == "ceremony"
    if is_ceremony:
        language = "en"
    # In a ceremony Tina must ignore the hall unless called; elsewhere it's optional.
    wake = WakeWord(enabled=is_ceremony or attributes.get("wake") == "1")

    usage = HelperUsage()
    record: dict[str, Any] = {
        "id": ctx.job.id,
        "room": ctx.room.name,
        "name": user_name,
        "visitor_id": visitor_id,
        "language": language,
        "style": style,
        "mode": "ceremony" if is_ceremony else "assistant",
        "started_at": datetime.fromtimestamp(started_at, UTC).isoformat(),
    }

    session = AgentSession(
        stt=make_stt(language),
        tts=make_tts(language, attributes.get("voice", "")),
        turn_handling=TurnHandlingOptions(
            turn_detection=inference.TurnDetector(),
            interruption={"mode": "adaptive"},
            # With the wake word on, most turns are ignored: don't pre-generate them.
            preemptive_generation={"enabled": not wake.enabled},
        ),
    )

    # Keep the follow-up window open while Tina talks and just after she finishes.
    @session.on("agent_state_changed")
    def _on_agent_state(ev) -> None:
        if "speaking" in (ev.old_state, ev.new_state):
            wake.extend()

    # The avatar was started after ctx.connect() above: it needs a connected room
    # to join, otherwise it hangs and can time out the whole session.
    provider = avatar_provider()
    record["avatar_provider"] = provider
    if not await start_avatar(provider, session, ctx, long_event=is_ceremony):
        # Usually the provider's plan limit (concurrent sessions or free minutes):
        # tell the browser and end this call instead of leaving it spinning.
        await send_ui(ctx.room, UI_STATUS_TOPIC, {"type": "busy"})
        await store.record_call({**record, "status": "busy", "duration_s": 0})
        ctx.shutdown("avatar unavailable")
        return

    if is_ceremony:
        await run_ceremony(ctx, session, wake, record, started_at)
        return

    video = VideoWatcher(ctx.room)
    video.start()

    memory_note = await store.load_memory(visitor_id) if visitor_id else ""
    assistant = Assistant(
        room=ctx.room,
        usage=usage,
        video=video,
        user_name=user_name,
        language=language,
        memory_note=memory_note,
        style=style,
        adapt_to_mood=adapt_to_mood,
        wake=wake,
    )
    await session.start(agent=assistant, room=ctx.room)

    file_reader = FileReader(
        session=session,
        assistant=assistant,
        room=ctx.room,
        usage=usage,
        language=language,
    )
    ctx.room.register_byte_stream_handler(FILE_UPLOAD_TOPIC, file_reader.on_stream)

    async def finish_call() -> None:
        await video.aclose()
        if visitor_id:
            transcript = memory.transcript_text(session.history)
            if "user:" in transcript:
                try:
                    note = await memory.update_memory(
                        memory_note, transcript, user_name, usage
                    )
                    if note:
                        await store.save_memory(visitor_id, note)
                except anthropic_sdk.APIError as e:
                    logger.warning("failed to update memory: %s", e)
        await store.record_call(
            {
                **record,
                "status": "ok",
                "style": assistant.style,
                "duration_s": round(time.time() - started_at, 1),
                "searches": usage.searches,
                "web_search_requests": usage.web_search_requests,
                "files": usage.files,
                "llm_model": MAIN_MODEL,
                **_usage_totals(session),
                "helper_input_tokens": usage.input_tokens,
                "helper_output_tokens": usage.output_tokens,
            }
        )

    ctx.add_shutdown_callback(finish_call)

    session.say(build_greeting(user_name, language, returning=bool(memory_note)))


if __name__ == "__main__":
    cli.run_app(server)
