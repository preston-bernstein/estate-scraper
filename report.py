#!/usr/bin/env python3
"""
Generate a self-contained HTML report from findings.json.

Usage:
    python report.py findings.json
    python report.py findings.json --output report.html
"""

import argparse
import html
import json
from datetime import datetime


def render_report(data: list[dict]) -> str:
    total_processed = sum(s["images_processed"] for s in data)
    total_findings = sum(s["images_with_findings"] for s in data)
    hit_rate = f"{100 * total_findings / total_processed:.1f}%" if total_processed else "—"
    generated = datetime.now().strftime("%Y-%m-%d %H:%M")

    sale_options = "\n".join(
        f'<option value="{html.escape(s["sale_id"])}">{html.escape(s["title"][:60])}</option>'
        for s in data
    )

    sale_sections = ""
    for sale in data:
        sid = html.escape(sale["sale_id"])
        title = html.escape(sale["title"])
        url = html.escape(sale["url"])
        imgs_processed = sale["images_processed"]
        imgs_found = sale["images_with_findings"]
        errors = sale["errors"]
        rate = f"{100 * imgs_found / imgs_processed:.0f}%" if imgs_processed else "—"

        cards = ""
        for item in sale["findings"]:
            img_url = html.escape(item["image_url"])
            findings_text = html.escape(item["findings"])
            duration = item.get("duration_s", "")
            cards += f"""
            <div class="card">
                <a href="{img_url}" target="_blank" rel="noopener">
                    <img loading="lazy" src="{img_url}" alt="estate sale item">
                </a>
                <div class="card-body">
                    <p class="findings">{findings_text}</p>
                    <div class="card-footer">
                        <a class="listing-link" href="{url}" target="_blank" rel="noopener">View listing</a>
                        <span class="dur">{duration}s</span>
                    </div>
                </div>
            </div>"""

        sale_sections += f"""
        <section class="sale" data-sale-id="{sid}">
            <div class="sale-header">
                <div>
                    <h2><a href="{url}" target="_blank" rel="noopener">{title}</a></h2>
                    <div class="sale-meta">
                        Sale {sid} &nbsp;·&nbsp;
                        {imgs_found} findings / {imgs_processed} images ({rate}) &nbsp;·&nbsp;
                        {errors} errors
                    </div>
                </div>
            </div>
            <div class="grid">{cards}</div>
        </section>"""

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Estate Sale Findings</title>
<style>
  *, *::before, *::after {{ box-sizing: border-box; margin: 0; padding: 0; }}
  body {{
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    background: #111;
    color: #e0e0e0;
    min-height: 100vh;
  }}
  header {{
    position: sticky;
    top: 0;
    z-index: 100;
    background: #1a1a1a;
    border-bottom: 1px solid #333;
    padding: 12px 20px;
    display: flex;
    align-items: center;
    gap: 20px;
    flex-wrap: wrap;
  }}
  header h1 {{ font-size: 1rem; font-weight: 600; white-space: nowrap; }}
  .summary {{ font-size: 0.8rem; color: #888; white-space: nowrap; }}
  .controls {{ display: flex; gap: 10px; align-items: center; flex: 1; flex-wrap: wrap; }}
  select, input {{
    background: #2a2a2a;
    border: 1px solid #444;
    color: #e0e0e0;
    padding: 5px 10px;
    border-radius: 4px;
    font-size: 0.85rem;
  }}
  select {{ cursor: pointer; }}
  input {{ width: 220px; }}
  main {{ padding: 20px; max-width: 1600px; margin: 0 auto; }}
  .sale {{ margin-bottom: 40px; }}
  .sale-header {{
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    margin-bottom: 12px;
    padding-bottom: 10px;
    border-bottom: 1px solid #2a2a2a;
  }}
  .sale-header h2 {{ font-size: 1rem; font-weight: 600; }}
  .sale-header h2 a {{ color: #7cb8ff; text-decoration: none; }}
  .sale-header h2 a:hover {{ text-decoration: underline; }}
  .sale-meta {{ font-size: 0.75rem; color: #666; margin-top: 4px; }}
  .grid {{
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
    gap: 10px;
  }}
  .card {{
    background: #1a1a1a;
    border: 1px solid #2a2a2a;
    border-radius: 6px;
    overflow: hidden;
    transition: border-color 0.15s;
  }}
  .card:hover {{ border-color: #555; }}
  .card a {{ display: block; aspect-ratio: 4/3; overflow: hidden; background: #0d0d0d; }}
  .card img {{
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
    transition: opacity 0.2s;
  }}
  .card img:not([src]) {{ opacity: 0; }}
  .card-body {{ padding: 8px 10px; }}
  .findings {{ font-size: 0.78rem; color: #ccc; line-height: 1.4; }}
  .card-footer {{ display: flex; justify-content: space-between; align-items: center; margin-top: 6px; }}
  .listing-link {{ font-size: 0.72rem; color: #7cb8ff; text-decoration: none; }}
  .listing-link:hover {{ text-decoration: underline; }}
  .dur {{ font-size: 0.68rem; color: #555; }}
  .hidden {{ display: none !important; }}
  footer {{ text-align: center; color: #444; font-size: 0.75rem; padding: 30px; }}
</style>
</head>
<body>
<header>
  <h1>Estate Sale Findings</h1>
  <span class="summary">{len(data)} sales &nbsp;·&nbsp; {total_findings} findings / {total_processed} images ({hit_rate}) &nbsp;·&nbsp; {generated}</span>
  <div class="controls">
    <select id="sale-filter" onchange="filterSale(this.value)">
      <option value="">All sales</option>
      {sale_options}
    </select>
    <input type="text" id="text-filter" placeholder="Filter findings…" oninput="filterText(this.value)">
  </div>
</header>
<main>{sale_sections}
</main>
<footer>Generated {generated}</footer>
<script>
  function filterSale(saleId) {{
    document.querySelectorAll('.sale').forEach(el => {{
      el.classList.toggle('hidden', saleId !== '' && el.dataset.saleId !== saleId);
    }});
  }}
  function filterText(q) {{
    q = q.toLowerCase().trim();
    document.querySelectorAll('.card').forEach(card => {{
      const text = card.querySelector('.findings')?.textContent.toLowerCase() ?? '';
      card.classList.toggle('hidden', q !== '' && !text.includes(q));
    }});
    // hide empty sale sections
    document.querySelectorAll('.sale').forEach(sale => {{
      if (sale.classList.contains('hidden')) return;
      const anyVisible = [...sale.querySelectorAll('.card')].some(c => !c.classList.contains('hidden'));
      sale.classList.toggle('hidden', !anyVisible);
    }});
  }}
</script>
</body>
</html>"""


def main():
    parser = argparse.ArgumentParser(description="Generate HTML report from findings.json")
    parser.add_argument("input", help="findings JSON (from vision.py)")
    parser.add_argument("--output", default="report.html", help="Output HTML file (default: report.html)")
    args = parser.parse_args()

    with open(args.input) as f:
        data = json.load(f)

    html_out = render_report(data)
    with open(args.output, "w") as f:
        f.write(html_out)

    total = sum(s["images_with_findings"] for s in data)
    print(f"Report written to {args.output} ({total} findings across {len(data)} sales)")


if __name__ == "__main__":
    main()
