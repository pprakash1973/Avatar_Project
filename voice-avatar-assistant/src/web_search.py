import logging
from dataclasses import dataclass, field

from claude import HELPER_MODEL, HelperUsage, get_client

logger = logging.getLogger("agent.web_search")


@dataclass
class SearchResult:
    answer: str
    sources: list[dict[str, str]] = field(default_factory=list)


async def run_web_search(query: str, language: str, usage: HelperUsage) -> SearchResult:
    """Call the Claude Messages API with the server-side web search tool enabled
    and return a short answer plus the sources it used."""
    response = await get_client().messages.create(
        model=HELPER_MODEL,
        max_tokens=1024,
        # Haiku supports only the basic web search tool; the dynamic-filtering
        # web_search_20260209 variant fails on it with invalid_tool_input.
        tools=[{"type": "web_search_20250305", "name": "web_search", "max_uses": 3}],
        messages=[
            {
                "role": "user",
                "content": (
                    f"Search the web and answer this question in 2-3 sentences of plain "
                    f"text in {language}, no markdown and no URLs.\n\nQuestion: {query}"
                ),
            }
        ],
    )
    usage.add(response.usage)
    usage.searches += 1

    answer_parts: list[str] = []
    sources: list[dict[str, str]] = []
    seen_urls: set[str] = set()
    for block in response.content:
        if block.type == "text":
            answer_parts.append(block.text)
        elif block.type == "web_search_tool_result":
            content = block.content
            if isinstance(content, list):
                for result in content:
                    url = getattr(result, "url", None)
                    if url and url not in seen_urls:
                        seen_urls.add(url)
                        sources.append(
                            {"url": url, "title": getattr(result, "title", "") or url}
                        )
            else:
                logger.warning("web_search tool error: %s", content)

    # Cited answers arrive as several text blocks; join and collapse the spacing.
    answer = " ".join(" ".join(answer_parts).split()) or "I couldn't find anything on that."
    return SearchResult(answer=answer, sources=sources[:3])
