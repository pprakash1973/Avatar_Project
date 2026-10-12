"""Direct Claude Messages API calls made outside the LiveKit LLM plugin
(web search, file reading, memory), plus the token counts they use."""

import os
from dataclasses import dataclass, field

from anthropic import AsyncAnthropic

HELPER_MODEL = "claude-haiku-5-5"

_client: AsyncAnthropic | None = None


def get_client() -> AsyncAnthropic:
    global _client
    if _client is None:
        _client = AsyncAnthropic(api_key=os.environ["ANTHROPIC_API_KEY"])
    return _client


@dataclass
class HelperUsage:
    """Token usage of direct Claude calls during one call, for the cost dashboard."""

    input_tokens: int = 0
    output_tokens: int = 0
    web_search_requests: int = 0
    searches: int = 0
    files: int = 0
    file_names: list[str] = field(default_factory=list)

    def add(self, usage) -> None:
        self.input_tokens += usage.input_tokens or 0
        self.output_tokens += usage.output_tokens or 0
        server_tool_use = getattr(usage, "server_tool_use", None)
        if server_tool_use is not None:
            self.web_search_requests += server_tool_use.web_search_requests or 0
