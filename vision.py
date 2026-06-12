#!/usr/bin/env python3
"""
Ollama vision layer for estate sale images.

CLI usage:
    python vision.py results.json
    python vision.py results.json --model llava:13b --output findings.json
    python vision.py results.json --max-images 20 --resume findings.json

Importable: process_sales_stream() is a generator that yields event dicts in real-time.
"""

import argparse
import base64
import json
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from typing import Iterator, Optional

import requests

OLLAMA_HOST = "http://YOUR_DESKTOP_IP:11434"
DEFAULT_MODEL = "llava:13b"
WORKERS = 6  # each worker: download + infer; natural pipelining

PROMPT = (
    "You are scanning an estate sale photo for valuable items. "
    "Respond with a short list of the specific valuable objects you actually see — "
    "e.g. 'Stickley armchair', 'oil painting', 'grandfather clock', 'silver candlesticks'. "
    "Only name objects physically visible in the image. "
    "Do NOT list categories, do NOT say 'none', do NOT use key:value format. "
    "If nothing valuable is visible, respond with exactly one word: NOTHING."
)

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    )
}


@dataclass
class ImageResult:
    url: str
    sale_id: str
    response: str = ""
    error: str = ""
    duration_s: float = 0.0

    @property
    def has_findings(self) -> bool:
        if self.error or not self.response.strip():
            return False
        r = self.response.strip().upper()
        if r == "NOTHING":
            return False
        lines = [l.strip() for l in r.splitlines() if l.strip()]
        junk = sum(1 for l in lines if l.endswith(": 0") or l.endswith(": NONE") or l.endswith(": NONE VISIBLE"))
        return junk < len(lines)


def fetch_image_b64(url: str, timeout: int = 15) -> str:
    resp = requests.get(url, headers=HEADERS, timeout=timeout)
    resp.raise_for_status()
    return base64.b64encode(resp.content).decode()


def run_vision(img_b64: str, model: str, ollama_host: str) -> str:
    payload = {
        "model": model,
        "prompt": PROMPT,
        "images": [img_b64],
        "stream": False,
        "options": {"temperature": 0.1},
    }
    resp = requests.post(f"{ollama_host}/api/generate", json=payload, timeout=120)
    resp.raise_for_status()
    return resp.json().get("response", "").strip()


def process_image(url: str, sale_id: str, model: str, ollama_host: str) -> ImageResult:
    result = ImageResult(url=url, sale_id=sale_id)
    t0 = time.monotonic()
    try:
        b64 = fetch_image_b64(url)
        result.response = run_vision(b64, model, ollama_host)
    except requests.exceptions.Timeout:
        result.error = "timeout"
    except requests.RequestException as e:
        result.error = str(e)[:120]
    result.duration_s = round(time.monotonic() - t0, 2)
    return result


def check_model_available(model: str, ollama_host: str) -> bool:
    try:
        resp = requests.get(f"{ollama_host}/api/tags", timeout=5)
        models = [m["name"] for m in resp.json().get("models", [])]
        return any(m == model or m.startswith(model.split(":")[0]) for m in models)
    except Exception:
        return False


def load_processed_urls(findings_path: str) -> set[str]:
    try:
        with open(findings_path) as f:
            data = json.load(f)
        return {item["image_url"] for sale in data for item in sale.get("findings", [])}
    except (FileNotFoundError, json.JSONDecodeError):
        return set()


def process_sales_stream(
    sales: list[dict],
    model: str = DEFAULT_MODEL,
    ollama_host: str = OLLAMA_HOST,
    max_images: Optional[int] = None,
    skip_urls: Optional[set] = None,
) -> Iterator[dict]:
    """
    Generator that yields event dicts as images are processed.
    Event types: sale_start | progress | finding | sale_done | done
    Designed to be consumed by app.py's SSE endpoint or main().
    """
    skip_urls = skip_urls or set()
    total_sales = len(sales)

    for sale_idx, sale in enumerate(sales):
        sale_id = sale["sale_id"]
        img_urls = [u for u in sale["image_urls"] if u not in skip_urls]
        if max_images:
            img_urls = img_urls[:max_images]

        total = len(img_urls)
        if not img_urls:
            continue

        yield {
            "type": "sale_start",
            "sale_idx": sale_idx,
            "total_sales": total_sales,
            "sale_id": sale_id,
            "title": sale["title"],
            "url": sale["url"],
            "total": total,
        }

        findings: list[dict] = []
        errors = 0
        done = 0

        with ThreadPoolExecutor(max_workers=WORKERS) as pool:
            futures = {
                pool.submit(process_image, url, sale_id, model, ollama_host): url
                for url in img_urls
            }
            for fut in as_completed(futures):
                result: ImageResult = fut.result()
                done += 1

                if result.error:
                    errors += 1
                elif result.has_findings:
                    finding = {
                        "image_url": result.url,
                        "sale_url": sale["url"],
                        "sale_title": sale["title"],
                        "findings": result.response,
                        "duration_s": result.duration_s,
                    }
                    findings.append(finding)
                    yield {"type": "finding", "sale_id": sale_id, **finding}

                yield {
                    "type": "progress",
                    "sale_id": sale_id,
                    "done": done,
                    "total": total,
                    "found": len(findings),
                    "errors": errors,
                }

        sale_result = {
            "sale_id": sale_id,
            "title": sale["title"],
            "url": sale["url"],
            "images_processed": total,
            "images_with_findings": len(findings),
            "errors": errors,
            "findings": findings,
        }
        yield {"type": "sale_done", **sale_result}

    yield {"type": "done"}


def main():
    parser = argparse.ArgumentParser(description="Run Ollama vision over estate sale images")
    parser.add_argument("input", help="scraper results JSON")
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--ollama-host", default=OLLAMA_HOST)
    parser.add_argument("--max-images", type=int, default=None)
    parser.add_argument("--resume", metavar="FINDINGS_JSON")
    parser.add_argument("--output", default="findings.json")
    args = parser.parse_args()

    print(f"Checking {args.model} on {args.ollama_host}...")
    if not check_model_available(args.model, args.ollama_host):
        print(f"ERROR: model '{args.model}' not found. Run: ollama pull {args.model}")
        sys.exit(1)

    skip_urls = load_processed_urls(args.resume) if args.resume else set()
    if skip_urls:
        print(f"Resume: skipping {len(skip_urls)} already-processed URLs")

    with open(args.input) as f:
        sales = json.load(f)

    existing: dict[str, dict] = {}
    if args.resume:
        try:
            with open(args.resume) as f:
                for s in json.load(f):
                    existing[s["sale_id"]] = s
        except (FileNotFoundError, json.JSONDecodeError):
            pass

    all_results: list[dict] = []
    total_done = 0
    total_found = 0

    for event in process_sales_stream(sales, args.model, args.ollama_host, args.max_images, skip_urls):
        t = event["type"]
        if t == "sale_start":
            print(f"\n[{event['sale_idx']+1}/{event['total_sales']}] {event['title'][:60]}")
            print(f"  {event['total']} images...")
        elif t == "finding":
            total_found += 1
            print(f"  FOUND: {event['findings'][:80]}")
        elif t == "progress":
            if event["done"] % 25 == 0:
                print(f"  [{event['done']}/{event['total']}] {event['found']} found so far")
        elif t == "sale_done":
            result = {k: v for k, v in event.items() if k != "type"}
            if args.resume and result["sale_id"] in existing:
                prev = existing[result["sale_id"]]
                result["findings"] = prev.get("findings", []) + result["findings"]
                result["images_processed"] += prev.get("images_processed", 0)
                result["images_with_findings"] = len(result["findings"])
                result["errors"] += prev.get("errors", 0)
            all_results.append(result)
            total_done += event["images_processed"]
            print(f"  Done: {event['images_with_findings']} findings / {event['images_processed']} images")
        elif t == "done":
            print(f"\n=== Complete: {total_found} findings across {total_done} images ===")
            with open(args.output, "w") as f:
                json.dump(all_results, f, indent=2)
            print(f"Written to {args.output}")


if __name__ == "__main__":
    main()
