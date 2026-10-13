"""Travel research with Claude's web search: fares, hotels, trains, buses and
itineraries. Results come from public web pages, so every price is an estimate;
booking always happens on the provider's own site."""

import json
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Literal
from urllib.parse import quote_plus, urlencode

from claude import HELPER_MODEL, HelperUsage, get_client

TravelKind = Literal["flights", "hotels", "trains", "buses"]

_OPTIONS_SCHEMA = {
    "type": "object",
    "properties": {
        "summary": {"type": "string"},
        "options": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "details": {"type": "string"},
                    "price": {"type": "string"},
                    "source_url": {"type": "string"},
                },
                "required": ["name", "details", "price", "source_url"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["summary", "options"],
    "additionalProperties": False,
}

_ITINERARY_SCHEMA = {
    "type": "object",
    "properties": {
        "title": {"type": "string"},
        "summary": {"type": "string"},
        "days": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "day": {"type": "string"},
                    "title": {"type": "string"},
                    "plan": {"type": "string"},
                },
                "required": ["day", "title", "plan"],
                "additionalProperties": False,
            },
        },
        "budget": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "item": {"type": "string"},
                    "amount": {"type": "string"},
                },
                "required": ["item", "amount"],
                "additionalProperties": False,
            },
        },
        "total_estimate": {"type": "string"},
    },
    "required": ["title", "summary", "days", "budget", "total_estimate"],
    "additionalProperties": False,
}


@dataclass
class TravelOptions:
    kind: str
    title: str
    summary: str
    options: list[dict[str, str]]
    booking_links: list[dict[str, str]]
    retrieved_at: str
    sources: list[str] = field(default_factory=list)


@dataclass
class Itinerary:
    title: str
    summary: str
    days: list[dict[str, str]]
    budget: list[dict[str, str]]
    total_estimate: str
    retrieved_at: str


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="minutes")


def booking_links(
    kind: str,
    origin: str,
    destination: str,
    depart_date: str,
    return_date: str,
    travelers: int,
) -> list[dict[str, str]]:
    """Search pages on booking sites, prefilled where the site allows it."""
    if kind == "flights":
        query = f"flights from {origin} to {destination} on {depart_date}"
        if return_date:
            query += f" returning {return_date}"
        return [
            {
                "label": "Google Flights",
                "url": f"https://www.google.com/travel/flights?q={quote_plus(query)}",
            },
            {"label": "MakeMyTrip", "url": "https://www.makemytrip.com/flights/"},
        ]
    if kind == "hotels":
        params = {"ss": destination, "group_adults": max(travelers, 1)}
        if depart_date:
            params["checkin"] = depart_date
        if return_date:
            params["checkout"] = return_date
        return [
            {
                "label": "Booking.com",
                "url": f"https://www.booking.com/searchresults.html?{urlencode(params)}",
            },
            {
                "label": "Google Hotels",
                "url": "https://www.google.com/travel/search?q="
                + quote_plus(f"hotels in {destination}"),
            },
        ]
    if kind == "trains":
        return [
            {"label": "IRCTC", "url": "https://www.irctc.co.in/nget/train-search"},
            {
                "label": "Google",
                "url": "https://www.google.com/search?q="
                + quote_plus(f"trains from {origin} to {destination} on {depart_date}"),
            },
        ]
    return [
        {"label": "redBus", "url": "https://www.redbus.in/"},
        {
            "label": "Google",
            "url": "https://www.google.com/search?q="
            + quote_plus(f"buses from {origin} to {destination} on {depart_date}"),
        },
    ]


async def _research(prompt: str, usage: HelperUsage) -> tuple[str, list[str]]:
    """Web-search step: returns the research notes and the URLs it used."""
    response = await get_client().messages.create(
        model=HELPER_MODEL,
        max_tokens=3000,
        # Haiku supports only the basic web search tool.
        tools=[{"type": "web_search_20250305", "name": "web_search", "max_uses": 5}],
        messages=[{"role": "user", "content": prompt}],
    )
    usage.add(response.usage)
    usage.searches += 1
    notes: list[str] = []
    urls: list[str] = []
    for block in response.content:
        if block.type == "text":
            notes.append(block.text)
        elif block.type == "web_search_tool_result" and isinstance(block.content, list):
            for result in block.content:
                url = getattr(result, "url", None)
                if url and url not in urls:
                    urls.append(url)
    return " ".join(" ".join(notes).split()), urls


async def _structure(
    notes: str, urls: list[str], instructions: str, schema: dict, usage: HelperUsage
) -> dict:
    """Extraction step: turns the research notes into the card's JSON."""
    response = await get_client().messages.create(
        model=HELPER_MODEL,
        max_tokens=3000,
        output_config={
            "effort": "low",
            "format": {"type": "json_schema", "schema": schema},
        },
        messages=[
            {
                "role": "user",
                "content": (
                    f"{instructions}\n\nUse only facts from these research notes. "
                    "Never invent prices, times or availability; write 'not found' "
                    "when the notes don't say.\n\n"
                    f"<notes>\n{notes}\n</notes>\n\n<source_urls>\n"
                    + "\n".join(urls)
                    + "\n</source_urls>"
                ),
            }
        ],
    )
    usage.add(response.usage)
    text = next(b.text for b in response.content if b.type == "text")
    return json.loads(text)


async def search_travel(
    *,
    kind: str,
    origin: str,
    destination: str,
    depart_date: str,
    return_date: str,
    travelers: int,
    preferences: str,
    language: str,
    today: str,
    usage: HelperUsage,
) -> TravelOptions:
    what = {
        "flights": f"flights from {origin} to {destination} departing {depart_date}"
        + (f", returning {return_date}" if return_date else ""),
        "hotels": f"hotels in {destination}, check-in {depart_date}"
        + (f", check-out {return_date}" if return_date else ""),
        "trains": f"trains from {origin} to {destination} on {depart_date}",
        "buses": f"buses from {origin} to {destination} on {depart_date}",
    }[kind]
    notes, urls = await _research(
        f"Today is {today}. Research {what} for {travelers} traveler(s)."
        + (f" Preferences: {preferences}." if preferences else "")
        + " Find up to five good options with name/operator, timings or location, "
        "key conditions (baggage, cancellation, rating, amenities as relevant) and the "
        "price shown, with the page each came from.",
        usage,
    )
    data = await _structure(
        notes,
        urls,
        f"List up to five {kind} options. Write the summary (two or three sentences "
        f"comparing the best options, suitable for reading aloud) and every field in "
        f"{language}. 'price' must quote the price as found, with currency.",
        _OPTIONS_SCHEMA,
        usage,
    )
    return TravelOptions(
        kind=kind,
        title=what[0].upper() + what[1:],
        summary=data["summary"],
        options=data["options"][:5],
        booking_links=booking_links(
            kind, origin, destination, depart_date, return_date, travelers
        ),
        retrieved_at=_now(),
        sources=urls[:5],
    )


async def plan_itinerary(
    *,
    destination: str,
    origin: str,
    start_date: str,
    days: int,
    travelers: int,
    budget: str,
    interests: str,
    language: str,
    today: str,
    usage: HelperUsage,
) -> Itinerary:
    notes, urls = await _research(
        f"Today is {today}. Research a {days}-day trip to {destination}"
        + (f" from {origin}" if origin else "")
        + (f" starting {start_date}" if start_date else "")
        + f" for {travelers} traveler(s)."
        + (f" Budget: {budget}." if budget else "")
        + (f" Interests: {interests}." if interests else "")
        + " Find top things to do, typical current costs of travel to get there, "
        "hotels per night, local transport, food and entry fees.",
        usage,
    )
    data = await _structure(
        notes,
        urls,
        f"Write a day-by-day itinerary for {days} day(s) and an estimated budget for "
        f"{travelers} traveler(s) with line items and a total, all amounts with currency. "
        "Budget lines may be approximate ranges based on the costs in the notes; the "
        "total is the sum of the line items, marked as approximate. "
        f"Write every field in {language}; the summary is two or three sentences for "
        "reading aloud.",
        _ITINERARY_SCHEMA,
        usage,
    )
    return Itinerary(
        title=data["title"],
        summary=data["summary"],
        days=data["days"][:14],
        budget=data["budget"],
        total_estimate=data["total_estimate"],
        retrieved_at=_now(),
    )
