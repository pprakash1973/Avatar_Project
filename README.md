# Voice AI Avatar Assistant

Talk to an AI avatar in the browser: Deepgram STT → Claude Sonnet 5.5 → Cartesia TTS → Anam avatar,
with a `web_search` tool backed by Claude's server-side web search. See [PRD.md](PRD.md) for full details.

- `voice-avatar-assistant/` — Python LiveKit agent (`src/agent.py`, `src/web_search.py`)
- `agent-starter-react/` — Next.js frontend

## Run

```bash
# backend: fill voice-avatar-assistant/.env.local from .env.example
cd voice-avatar-assistant
uv sync
uv run python src/agent.py download-files
uv run python src/agent.py dev

# frontend: fill agent-starter-react/.env.local from .env.example
cd agent-starter-react
pnpm install
pnpm dev
```
