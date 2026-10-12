"""Long-term memory: a short note about each caller, updated after every call."""

from livekit.agents import llm

from claude import HELPER_MODEL, HelperUsage, get_client


def transcript_text(chat_ctx: llm.ChatContext) -> str:
    lines = []
    for item in chat_ctx.items:
        if item.type == "message" and item.role in ("user", "assistant"):
            text = (item.text_content or "").strip()
            if text:
                lines.append(f"{item.role}: {text}")
    return "\n".join(lines)


async def update_memory(
    previous: str, transcript: str, user_name: str, usage: HelperUsage
) -> str:
    response = await get_client().messages.create(
        model=HELPER_MODEL,
        max_tokens=1000,
        output_config={"effort": "low"},
        messages=[
            {
                "role": "user",
                "content": (
                    "You maintain a short memory note about a returning user of a voice "
                    "assistant. Merge the previous note with what was learned in the new "
                    "conversation. Keep durable facts about the user (preferences, "
                    "location, interests, ongoing tasks) and a one-line summary of what "
                    "they asked about recently. Drop small talk. Plain text, at most 120 "
                    "words, written in English.\n\n"
                    f"User's name: {user_name or 'unknown'}\n\n"
                    f"<previous_note>\n{previous or '(none)'}\n</previous_note>\n\n"
                    f"<conversation>\n{transcript}\n</conversation>"
                ),
            }
        ],
    )
    usage.add(response.usage)
    return "".join(b.text for b in response.content if b.type == "text").strip()
