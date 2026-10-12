import logging
import os

from anthropic import AsyncAnthropic

logger = logging.getLogger("agent.web_search")

_client: AsyncAnthropic | None = None


def _get_client() -> AsyncAnthropic:
    global _client
    if _client is None:
        _client = AsyncAnthropic(api_key=os.environ["ANTHROPIC_API_KEY"])
    return _client


async def run_web_search(query: str) -> str:
    """Call the Claude Messages API with the server-side web search tool enabled
    and return a short, cited summary of the results."""
    client = _get_client()

    response = await client.messages.create(
        model="claude-haiku-5-5",
        max_tokens=1024,
        tools=[{"type": "web_search_20260209", "name": "web_search"}],
        messages=[
            {
                "role": "user",
                "content": (
                    "Search the web and answer this question in 2-3 sentences, "
                    "plain text, no markdown. End with the source URLs in "
                    f"parentheses.\n\nQuestion: {query}"
                ),
            }
        ],
    )

    answer_parts: list[str] = []
    sources: list[str] = []
    for block in response.content:
        if block.type == "text":
            answer_parts.append(block.text)
        elif block.type == "web_search_tool_result":
            content = block.content
            if isinstance(content, list):
                for result in content:
                    url = getattr(result, "url", None)
                    if url and url not in sources:
                        sources.append(url)
            else:
                logger.warning("web_search tool error: %s", content)

    answer = " ".join(answer_parts).strip() or "I couldn't find anything on that."
    if sources:
        answer += " (source: " + ", ".join(sources[:3]) + ")"
    return answer
