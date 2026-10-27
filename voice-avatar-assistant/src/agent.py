import asyncio
import base64
import json
import logging
import os
import time
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Literal
from xml.sax.saxutils import escape as xml_escape

import anthropic as anthropic_sdk
from dotenv import load_dotenv
from livekit import api, rtc
from livekit.agents import (
    Agent,
    AgentServer,
    AgentSession,
    APIConnectionError,
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
    room_io,
    stt,
    tts,
)
from livekit.plugins import (
    ai_coustics,
    anam,
    anthropic,
    azure,
    cartesia,
    deepgram,
    simli,
)
from livekit.plugins.anthropic import llm as _anthropic_llm

import files
import memory
import store
import travel
from ceremony import CeremonyHost, CeremonyProgram
from claude import HelperUsage
from diagnostics import CallLog
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
# The stage tells Tina about media it plays ({"type": "media", ...}).
CEREMONY_EVENTS_TOPIC = "ceremony-events"

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
# Azure voices (AZURE_SPEECH_KEY / AZURE_SPEECH_REGION): Neerja HD speaks English and
# the Indian languages in the same voice. Cartesia (Priya) takes over if Azure fails.
AZURE_VOICES = {"neerja": "en-IN-Neerja:DragonHDLatestNeural"}
AZURE_LANGUAGES = {"en": "en-IN", "hi": "hi-IN", "ta": "ta-IN", "ml": "ml-IN"}

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


def make_ceremony_stt(languages: list[str]) -> stt.STT:
    """Hearing for a ceremony; with other languages than English, one model for all."""
    if languages == ["en"]:
        return make_stt("en")
    # Gemini detects the language itself: English, Tamil and mixed Tamil-English were
    # transcribed correctly, while Deepgram's multilingual model doesn't know Tamil.
    # It finalizes about half a second later than Deepgram. Billed via LiveKit Cloud.
    return inference.STT(
        model="google/gemini-3.5-transcribe-live",
        extra_kwargs={"custom_vocabulary": ["Tina", "டீனா"]},
        fallback=["deepgram/nova-3"],
    )


class AzureTTS(azure.TTS):
    """The plugin puts the text into its SSML as-is, so an "&" (e.g. "Growth & Market
    Impact") made Azure reject the sentence and Tina switch to the backup voice."""

    def synthesize(self, text: str, **kwargs: Any) -> tts.ChunkedStream:
        return super().synthesize(xml_escape(text), **kwargs)


def make_tts(language: str, voice: str = "") -> tts.TTS:
    # Malayalam voices need Sonic 3.6; the other languages stay on the tested sonic-3.
    voice_cartesia = cartesia.TTS(
        model="sonic-3.6" if language == "ml" else "sonic-3",
        language=language,
        voice=VOICES.get(voice, TINA_VOICE_ID),
    )
    if voice not in AZURE_VOICES or not os.environ.get("AZURE_SPEECH_KEY"):
        return voice_cartesia
    voice_azure = AzureTTS(
        voice=AZURE_VOICES[voice], language=AZURE_LANGUAGES.get(language, "en-IN")
    )
    return tts.FallbackAdapter([voice_azure, voice_cartesia])


def room_options(*, ceremony: bool) -> room_io.RoomOptions:
    """Noise suppression on what Tina hears (ai-coustics, via LiveKit Cloud).

    In a hall the "voice focus" model also removes background voices (audience
    chatter, applause), keeping the main speaker near the microphone.
    """
    model = (
        ai_coustics.EnhancerModel.QUAIL_VF_L
        if ceremony
        else ai_coustics.EnhancerModel.QUAIL_L
    )
    return room_io.RoomOptions(
        audio_input=room_io.AudioInputOptions(
            noise_cancellation=ai_coustics.audio_enhancement(model=model)
        )
    )


AVATAR_JOIN_TIMEOUT_SECONDS = 20
# Simli streams frames as soon as it joins; none within this long means it's stuck.
AVATAR_VIDEO_TIMEOUT_SECONDS = 12
# Ceremony: how long after Tina's reply the MC may follow up without her name.
CEREMONY_FOLLOW_UP_SECONDS = 8.0
# Ceremony: the pause between Tina appearing and her introduction.
INTRODUCTION_DELAY_SECONDS = 1.5
# Ceremony: her magical entrance (a hologram materializing on the stage), before she
# speaks; matches the stage animation and its sound's chime.
INTRO_REVEAL_SECONDS = 6.0


AVATAR_KEYS = {"anam": "ANAM_API_KEY", "simli": "SIMLI_API_KEY"}


@dataclass
class FramedSimliConfig(simli.SimliConfig):
    """Adds the video size Trinity-2 faces stream at (they show the upper body, so
    the frame can be wide or tall), e.g. SIMLI_STREAM_SIZE=1280x720."""

    stream_size: str = ""

    def create_json(self) -> dict[str, Any]:
        result = super().create_json()
        # SIMLI_EMOTION_ID=none: a face without emotions takes just its ID.
        if self.emotion_id == "none":
            result["faceId"] = self.face_id
        if self.stream_size:
            width, height = (int(n) for n in self.stream_size.lower().split("x"))
            result["streaming_width"] = width
            result["streaming_height"] = height
        return result


def avatar_providers() -> list[str]:
    """The avatars to try in order: AVATAR_PROVIDER (Anam by default), then the
    other one as a backup, each only if its key is set."""
    first = os.environ.get("AVATAR_PROVIDER", "").lower()
    if first not in AVATAR_KEYS:
        first = "anam"
    order = [first] + [p for p in AVATAR_KEYS if p != first]
    return [p for p in order if os.environ.get(AVATAR_KEYS[p])]


async def start_avatar(
    provider: str, session: AgentSession, ctx: JobContext, *, long_event: bool = False
) -> bool:
    """Starts the avatar and waits for it to join; False if it isn't available."""
    if provider == "simli":
        avatar = simli.AvatarSession(
            simli_config=FramedSimliConfig(
                api_key=os.environ["SIMLI_API_KEY"],
                face_id=os.environ["SIMLI_FACE_ID"],
                # Trinity faces: the expression between sentences. Happy #0 by default;
                # see https://docs.simli.com/emotions for the other IDs.
                emotion_id=os.environ.get("SIMLI_EMOTION_ID")
                or "92f24a0c-f046-45df-8df0-af7449c04571",
                # Cap call length to protect the plan's minutes, and don't drop
                # the avatar while the user is quietly reading a card. A ceremony
                # runs 30-45 minutes with breaks of a few minutes between awards.
                max_session_length=(75 if long_event else 15) * 60,
                max_idle_time=(10 if long_event else 3) * 60,
                # The ceremony stage fits any shape; the call page shows a square.
                stream_size=os.environ.get("SIMLI_STREAM_SIZE", "")
                if long_event
                else "",
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
    except (APIStatusError, APIConnectionError, TimeoutError) as e:
        logger.warning("%s avatar unavailable: %s", provider, e)
        return False
    # Simli has joined and then sent no picture: check its video really starts (it
    # streams frames even while silent), else drop it so the backup avatar can start.
    if provider == "simli" and not await _sends_video(ctx, avatar.avatar_identity):
        logger.warning("%s avatar sent no video; removing it", provider)
        try:
            await ctx.api.room.remove_participant(
                api.RoomParticipantIdentity(
                    room=ctx.room.name, identity=avatar.avatar_identity
                )
            )
        except Exception as e:
            logger.warning("could not remove the silent avatar: %s", e)
        return False
    return True


async def _sends_video(ctx: JobContext, identity: str) -> bool:
    """True once the avatar's first video frame arrives (within the timeout)."""
    deadline = time.monotonic() + AVATAR_VIDEO_TIMEOUT_SECONDS
    track = None
    while track is None and time.monotonic() < deadline:
        participant = ctx.room.remote_participants.get(identity)
        for publication in (
            participant.track_publications.values() if participant else []
        ):
            if publication.kind == rtc.TrackKind.KIND_VIDEO and publication.track:
                track = publication.track
        if track is None:
            await asyncio.sleep(0.2)
    if track is None:
        return False
    stream = rtc.VideoStream(track)
    try:
        await asyncio.wait_for(
            stream.__anext__(), max(0.5, deadline - time.monotonic())
        )
        return True
    except (TimeoutError, StopAsyncIteration):
        return False
    finally:
        await stream.aclose()


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
    usage: HelperUsage,
    voice: str,
    call_log: CallLog,
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
    logger.info(
        "ceremony with %d awards, %d events", len(program.awards), len(program.events)
    )

    async def send_slide(slide: int, hidden: bool = False, title: str = "") -> None:
        # hidden: blur the slide until the winner's name is revealed.
        await send_ui(
            ctx.room,
            UI_STATUS_TOPIC,
            {"type": "slide", "slide": slide, "hidden": hidden, "title": title},
        )

    async def send_view(view: str) -> None:
        await send_ui(ctx.room, UI_STATUS_TOPIC, {"type": "view", "view": view})

    async def send_status(status: dict[str, Any]) -> None:
        await send_ui(ctx.room, UI_STATUS_TOPIC, status)

    host = CeremonyHost(
        program=program,
        # Cached instructions, tools and history: replies stay quick through an hour.
        llm_model=anthropic.LLM(
            model=MAIN_MODEL, parallel_tool_calls=False, caching="ephemeral"
        ),
        send_slide=send_slide,
        send_view=send_view,
        send_status=send_status,
        make_tts=lambda language: make_tts(language, voice),
        usage=usage,
        wake=wake,
        host_name=record.get("name", ""),
        note=call_log.turn,
    )

    async def read_event(reader: rtc.TextStreamReader) -> None:
        try:
            event = json.loads(await reader.read_all())
        except ValueError:
            return
        if event.get("type") == "media":
            host.media_playing(str(event.get("kind")), bool(event.get("playing")))

    def on_event(reader: rtc.TextStreamReader, participant_identity: str) -> None:
        task = asyncio.create_task(read_event(reader))
        tasks.add(task)
        task.add_done_callback(tasks.discard)

    ctx.room.register_text_stream_handler(CEREMONY_EVENTS_TOPIC, on_event)
    await session.start(
        agent=host, room=ctx.room, room_options=room_options(ceremony=True)
    )
    # Tina introduces herself as soon as she appears (non-interruptible, so the host
    # waits for it); she greets the host by name when they first call her ("Hello Tina").
    introduction: list[tuple[str, str]] = []
    for event in program.events_on("appear"):
        introduction += await host.event_parts(event)
    if program.settings.intro_reveal:
        # Her entrance plays on the stage; she speaks once she has materialized.
        call_log.add("entrance")
        await send_ui(
            ctx.room,
            UI_STATUS_TOPIC,
            {"type": "intro_reveal", "seconds": INTRO_REVEAL_SECONDS},
        )
        await asyncio.sleep(INTRO_REVEAL_SECONDS)
    else:
        # Give the stage a moment to show her video before she speaks.
        await asyncio.sleep(INTRODUCTION_DELAY_SECONDS)
    if introduction:
        call_log.add("introduction")
        host.say_parts(session, introduction)
    greeting: list[tuple[str, str]] = []
    for event in program.events_on("first_call"):
        greeting += await host.event_parts(event)
    host.greet_on_first_call(greeting)
    # The other events' translations, while Tina waits for the host.
    task = asyncio.create_task(host.translate_events())
    tasks.add(task)
    task.add_done_callback(tasks.discard)
    await send_ui(
        ctx.room,
        UI_STATUS_TOPIC,
        {"type": "ceremony_live", "awards": len(program.awards)},
    )

    async def finish_ceremony(reason: str) -> None:
        summary = call_log.summary(reason)
        await store.record_call(
            {
                **record,
                **summary,
                "status": "error" if summary["ended_by"].startswith("error") else "ok",
                "duration_s": round(time.time() - started_at, 1),
                "awards_announced": sum(a.announced for a in program.awards),
                "llm_model": MAIN_MODEL,
                **_usage_totals(session),
            }
        )

    call_log.recorded = True
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
    # Languages the ceremony host may speak to Tina in, e.g. "en,ta".
    listen = ["en"] + [
        c
        for c in attributes.get("listen", "").split(",")
        if c in LANGUAGES and c != "en"
    ]
    if is_ceremony:
        language = "en"
    # In a ceremony Tina must ignore the hall unless called; elsewhere it's optional.
    # On stage the MC soon turns to the audience, so follow-ups without her name are
    # taken only briefly after she replies.
    wake = WakeWord(
        enabled=is_ceremony or attributes.get("wake") == "1",
        window_seconds=CEREMONY_FOLLOW_UP_SECONDS if is_ceremony else 20.0,
    )

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
        stt=make_ceremony_stt(listen) if is_ceremony else make_stt(language),
        tts=make_tts(language, attributes.get("voice", "")),
        turn_handling=TurnHandlingOptions(
            turn_detection=inference.TurnDetector(),
            interruption={"mode": "adaptive"},
            # With the wake word on, most turns are ignored: don't pre-generate them.
            preemptive_generation={"enabled": not wake.enabled},
        ),
    )

    # Why the call ends, kept in its record (LiveKit doesn't keep the agent's logs).
    call_log = CallLog(started_at)
    call_log.add("host joined", identity=participant.identity)
    call_log.watch(ctx.room, session)

    # A call that ends early (e.g. before the award list arrives) is still recorded;
    # once the full record is set up (finish_call / finish_ceremony), it takes over.
    async def record_early_end(reason: str) -> None:
        if not call_log.recorded:
            await store.record_call(
                {
                    **record,
                    **call_log.summary(reason),
                    "status": "ended early",
                    "duration_s": round(time.time() - started_at, 1),
                }
            )

    ctx.add_shutdown_callback(record_early_end)

    # Keep the follow-up window open while Tina talks and just after she finishes.
    @session.on("agent_state_changed")
    def _on_agent_state(ev) -> None:
        if "speaking" in (ev.old_state, ev.new_state):
            wake.extend()

    # The avatar was started after ctx.connect() above: it needs a connected room
    # to join, otherwise it hangs and can time out the whole session.
    provider = ""
    for candidate in avatar_providers():
        if await start_avatar(candidate, session, ctx, long_event=is_ceremony):
            provider = candidate
            call_log.add("avatar started", provider=candidate)
            break
        logger.warning("%s avatar failed; trying the backup", candidate)
        call_log.add("avatar failed to start", provider=candidate)
    record["avatar_provider"] = provider
    if not provider:
        # Usually the provider's plan limit (concurrent sessions or free minutes):
        # tell the browser and end this call instead of leaving it spinning.
        await send_ui(ctx.room, UI_STATUS_TOPIC, {"type": "busy"})
        call_log.recorded = True
        await store.record_call(
            {
                **record,
                **call_log.summary("avatar unavailable"),
                "status": "busy",
                "duration_s": 0,
            }
        )
        ctx.shutdown("avatar unavailable")
        return

    if is_ceremony:
        await run_ceremony(
            ctx,
            session,
            wake,
            record,
            started_at,
            usage,
            attributes.get("voice", ""),
            call_log,
        )
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
    await session.start(
        agent=assistant, room=ctx.room, room_options=room_options(ceremony=False)
    )

    file_reader = FileReader(
        session=session,
        assistant=assistant,
        room=ctx.room,
        usage=usage,
        language=language,
    )
    ctx.room.register_byte_stream_handler(FILE_UPLOAD_TOPIC, file_reader.on_stream)

    async def finish_call(reason: str) -> None:
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
        summary = call_log.summary(reason)
        await store.record_call(
            {
                **record,
                **summary,
                "status": "error" if summary["ended_by"].startswith("error") else "ok",
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

    call_log.recorded = True
    ctx.add_shutdown_callback(finish_call)

    session.say(build_greeting(user_name, language, returning=bool(memory_note)))


if __name__ == "__main__":
    cli.run_app(server)
