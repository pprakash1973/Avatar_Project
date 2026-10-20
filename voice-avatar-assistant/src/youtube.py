"""YouTube search for the ceremony's video player (YouTube Data API v3)."""

import html
import logging
import os
from dataclasses import dataclass

import aiohttp
from livekit.agents.utils import http_context

logger = logging.getLogger("agent.youtube")

SEARCH_URL = "https://www.googleapis.com/youtube/v3/search"
VIDEOS_URL = "https://www.googleapis.com/youtube/v3/videos"


@dataclass
class Video:
    id: str
    title: str
    channel: str


async def search_videos(query: str, max_results: int = 8) -> list[Video]:
    """Embeddable HD videos for the query, best match first; [] without an API key.

    Each search costs 100 of the free 10,000 daily quota units.
    """
    key = os.environ.get("YOUTUBE_API_KEY")
    if not key:
        logger.warning("YOUTUBE_API_KEY is not set")
        return []
    params = {
        "part": "snippet",
        "q": query,
        "type": "video",
        # Only videos that may be played in our page, in HD, safe for a stage.
        "videoEmbeddable": "true",
        "videoDefinition": "high",
        "safeSearch": "strict",
        "regionCode": "IN",
        "maxResults": str(max_results),
        "key": key,
    }
    async with http_context.http_session().get(
        SEARCH_URL, params=params, timeout=aiohttp.ClientTimeout(total=10)
    ) as response:
        if response.status != 200:
            logger.warning(
                "YouTube search failed: %s %s", response.status, await response.text()
            )
            return []
        data = await response.json()
    videos = [
        Video(
            id=item["id"]["videoId"],
            # The API returns HTML-escaped text ("Rock &amp; Roll").
            title=html.unescape(item["snippet"]["title"]),
            channel=html.unescape(item["snippet"]["channelTitle"]),
        )
        for item in data.get("items", [])
        if item.get("id", {}).get("videoId")
        # Shorts are vertical clips, not stage videos.
        and "#short" not in item["snippet"]["title"].lower()
    ]
    # Landscape first: a vertical phone clip looks poor on the stage screen.
    portrait = await _portrait_ids([v.id for v in videos], key)
    return sorted(videos, key=lambda v: v.id in portrait)


async def _portrait_ids(ids: list[str], key: str) -> set[str]:
    """The videos taller than wide (1 quota unit for all of them)."""
    if not ids:
        return set()
    params = {"part": "player", "id": ",".join(ids), "maxWidth": "640", "key": key}
    try:
        async with http_context.http_session().get(
            VIDEOS_URL, params=params, timeout=aiohttp.ClientTimeout(total=5)
        ) as response:
            data = await response.json() if response.status == 200 else {}
    except (aiohttp.ClientError, TimeoutError) as e:
        logger.warning("YouTube video sizes failed: %s", e)
        return set()
    return {
        item["id"]
        for item in data.get("items", [])
        if int(item["player"].get("embedHeight", 0))
        > int(item["player"].get("embedWidth", 1))
    }
