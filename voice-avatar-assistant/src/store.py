"""Upstash Redis (REST) storage for caller memory and call records.

Every function is a no-op when Redis isn't configured, so the agent keeps
working without a database.
"""

import json
import logging
import os
import re
from typing import Any

import httpx

logger = logging.getLogger("agent.store")

MEMORY_TTL_SECONDS = 90 * 24 * 60 * 60
MAX_CALL_RECORDS = 500
_VISITOR_ID_RE = re.compile(r"^[A-Za-z0-9-]{8,64}$")

_client: httpx.AsyncClient | None = None


def _config() -> tuple[str, str] | None:
    # The Vercel Marketplace integration names these KV_*; plain Upstash uses UPSTASH_*.
    url = os.environ.get("KV_REST_API_URL") or os.environ.get("UPSTASH_REDIS_REST_URL")
    token = os.environ.get("KV_REST_API_TOKEN") or os.environ.get(
        "UPSTASH_REDIS_REST_TOKEN"
    )
    return (url.rstrip("/"), token) if url and token else None


async def _pipeline(*commands: list[str]) -> list[Any] | None:
    config = _config()
    if config is None:
        return None
    global _client
    if _client is None:
        _client = httpx.AsyncClient(timeout=5.0)
    url, token = config
    try:
        resp = await _client.post(
            f"{url}/pipeline",
            json=list(commands),
            headers={"Authorization": f"Bearer {token}"},
        )
        resp.raise_for_status()
        return [item.get("result") for item in resp.json()]
    except (httpx.HTTPError, ValueError) as e:
        logger.warning("redis request failed: %s", e)
        return None


def valid_visitor_id(visitor_id: str) -> bool:
    return bool(_VISITOR_ID_RE.match(visitor_id))


async def load_memory(visitor_id: str) -> str:
    result = await _pipeline(["GET", f"memory:{visitor_id}"])
    return result[0] if result and isinstance(result[0], str) else ""


async def save_memory(visitor_id: str, memory: str) -> None:
    await _pipeline(
        ["SET", f"memory:{visitor_id}", memory, "EX", str(MEMORY_TTL_SECONDS)]
    )


async def record_call(record: dict[str, Any]) -> None:
    await _pipeline(
        ["LPUSH", "calls", json.dumps(record)],
        ["LTRIM", "calls", "0", str(MAX_CALL_RECORDS - 1)],
    )
