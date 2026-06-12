#!/usr/bin/env python3
"""
estatesales.net scraper — fetches sale listings for a state/city and extracts image URLs.
Phase 1: validate scraping before adding Ollama vision layer.

Usage:
    python scraper.py GA Atlanta
    python scraper.py GA Atlanta --max-sales 10 --output results.json
"""

import argparse
import json
import re
import time
import random
from dataclasses import dataclass, field
from typing import Optional
import requests
from bs4 import BeautifulSoup

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": "https://www.estatesales.net/",
}

BASE_URL = "https://www.estatesales.net"
IMG_CDN = "picturescdn.estatesales.net"
SKIP_PATTERNS = ["logo", "icon", "orglogo", "avatar", "pixel", "blank", "badge"]


@dataclass
class Sale:
    title: str
    url: str
    sale_id: str
    image_urls: list[str] = field(default_factory=list)


def polite_delay(min_s: float = 1.2, max_s: float = 3.5) -> None:
    time.sleep(random.uniform(min_s, max_s))


def get(url: str, session: requests.Session) -> Optional[requests.Response]:
    try:
        resp = session.get(url, headers=HEADERS, timeout=15)
        resp.raise_for_status()
        return resp
    except requests.RequestException as e:
        print(f"  [error] {url}: {e}")
        return None


def get_soup(url: str, session: requests.Session) -> Optional[BeautifulSoup]:
    resp = get(url, session)
    return BeautifulSoup(resp.text, "html.parser") if resp else None


def parse_sale_listings(soup: BeautifulSoup) -> list[dict]:
    """Extract sale cards from a city search page."""
    sales = []
    # site uses <app-sale-row> Angular components; links follow /STATE/City/ZIP/SALEID pattern
    for tag in soup.find_all("a", href=True):
        href = tag["href"]
        # match /XX/City/NNNNN/NNNNN
        if not re.match(r"^/[A-Z]{2}/.+/\d{5}/\d+$", href):
            continue
        sale_id = href.rstrip("/").split("/")[-1]
        full_url = BASE_URL + href

        parent = tag.parent
        text = parent.get_text(separator=" ", strip=True)
        # title is usually the first meaningful chunk of text
        title = text[:80] if text else href

        sales.append({"title": title, "url": full_url, "sale_id": sale_id})

    # deduplicate by sale_id preserving first-seen order
    seen = set()
    result = []
    for s in sales:
        if s["sale_id"] not in seen:
            seen.add(s["sale_id"])
            result.append(s)
    return result


def extract_images_from_sale(url: str, session: requests.Session) -> list[str]:
    """Visit a sale detail page and extract listing image URLs from page source."""
    resp = get(url, session)
    if not resp:
        return []

    # images live in picturescdn.estatesales.net — pull them from raw HTML
    # (Angular SSR embeds them in JSON/script or inline img tags)
    raw_urls = re.findall(
        r'(https?://picturescdn\.estatesales\.net/[^\"\' >]+\.(?:jpg|jpeg|png|webp))',
        resp.text,
        re.I,
    )

    result = []
    seen = set()
    for u in raw_urls:
        if any(skip in u.lower() for skip in SKIP_PATTERNS):
            continue
        if u not in seen:
            seen.add(u)
            result.append(u)

    return result


def scrape_city(state: str, city: str, max_sales: int = 10) -> list[Sale]:
    session = requests.Session()
    city_slug = city.replace(" ", "-")
    url = f"{BASE_URL}/{state.upper()}/{city_slug}"
    print(f"Fetching listings: {url}")

    soup = get_soup(url, session)
    if not soup:
        print("Failed to load search page.")
        return []

    raw_sales = parse_sale_listings(soup)
    print(f"Found {len(raw_sales)} sales on page.")

    sales: list[Sale] = []
    for i, raw in enumerate(raw_sales[:max_sales]):
        label = raw["title"][:60]
        print(f"  [{i+1}/{min(len(raw_sales), max_sales)}] {label}")
        polite_delay()
        imgs = extract_images_from_sale(raw["url"], session)
        print(f"    -> {len(imgs)} images")
        sales.append(Sale(
            title=raw["title"],
            url=raw["url"],
            sale_id=raw["sale_id"],
            image_urls=imgs,
        ))
        polite_delay()

    return sales


def main():
    parser = argparse.ArgumentParser(description="Scrape estate sale listings + images")
    parser.add_argument("state", help="2-letter state code (e.g. GA)")
    parser.add_argument("city", help="City name (e.g. Atlanta)")
    parser.add_argument("--max-sales", type=int, default=5, help="Max sales to detail-scrape")
    parser.add_argument("--output", default="results.json", help="JSON output file")
    args = parser.parse_args()

    sales = scrape_city(args.state, args.city, max_sales=args.max_sales)

    out = [
        {
            "sale_id": s.sale_id,
            "title": s.title,
            "url": s.url,
            "image_count": len(s.image_urls),
            "image_urls": s.image_urls,
        }
        for s in sales
    ]

    with open(args.output, "w") as f:
        json.dump(out, f, indent=2)

    print(f"\nWrote {len(out)} sales to {args.output}")
    total_imgs = sum(len(s.image_urls) for s in sales)
    print(f"Total images found: {total_imgs}")


if __name__ == "__main__":
    main()
