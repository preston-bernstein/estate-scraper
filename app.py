#!/usr/bin/env python3
"""
Estate sale findings dashboard — live web UI.

Usage:
    python app.py
    open http://localhost:5000
"""

import json
import os
import threading
import time
from pathlib import Path

from flask import Flask, Response, jsonify, request, stream_with_context

from scraper import scrape_city
from vision import (
    DEFAULT_MODEL,
    OLLAMA_HOST,
    check_model_available,
    load_processed_urls,
    process_sales_stream,
)

app = Flask(__name__)
FINDINGS_FILE = Path("findings.json")
RESULTS_FILE = Path("results.json")


# ---------------------------------------------------------------------------
# Job state — shared between vision thread and SSE clients
# ---------------------------------------------------------------------------

class Job:
    def __init__(self):
        self._cv = threading.Condition()
        self.running = False
        self.events: list[dict] = []   # append-only; SSE clients read by index
        self.phase = "idle"            # idle | scraping | analyzing | done
        self.status_msg = ""

    def reset(self):
        with self._cv:
            self.running = True
            self.events = []
            self.phase = "idle"
            self.status_msg = ""
            self._cv.notify_all()

    def push(self, event: dict):
        with self._cv:
            self.events.append(event)
            self._cv.notify_all()

    def finish(self, msg: str = ""):
        with self._cv:
            self.running = False
            self.status_msg = msg
            self._cv.notify_all()

    def wait_for_event(self, after_idx: int, timeout: float = 15.0) -> int:
        """Block until events[after_idx] exists. Returns new length."""
        with self._cv:
            self._cv.wait_for(lambda: len(self.events) > after_idx or not self.running, timeout=timeout)
            return len(self.events)


job = Job()


# ---------------------------------------------------------------------------
# Background job thread
# ---------------------------------------------------------------------------

def run_job(state: str, city: str, max_sales: int, max_images: int | None,
            model: str, ollama_host: str):
    try:
        job.phase = "scraping"
        job.push({"type": "phase", "phase": "scraping", "msg": f"Scraping {city}, {state}…"})

        sales = scrape_city(state, city, max_sales=max_sales)

        if not sales:
            job.push({"type": "error", "msg": "No sales found."})
            job.finish("No sales found.")
            return

        with open(RESULTS_FILE, "w") as f:
            json.dump(
                [{"sale_id": s.sale_id, "title": s.title, "url": s.url,
                  "image_urls": s.image_urls} for s in sales],
                f, indent=2,
            )

        job.push({
            "type": "scrape_done",
            "count": len(sales),
            "sales": [{"sale_id": s.sale_id, "title": s.title, "url": s.url,
                        "image_count": len(s.image_urls)} for s in sales],
        })

        if not check_model_available(model, ollama_host):
            job.push({"type": "error", "msg": f"Model {model} not available on {ollama_host}"})
            job.finish("Model unavailable.")
            return

        job.phase = "analyzing"
        job.push({"type": "phase", "phase": "analyzing", "msg": "Running vision analysis…"})

        sales_dicts = [
            {"sale_id": s.sale_id, "title": s.title, "url": s.url, "image_urls": s.image_urls}
            for s in sales
        ]

        all_results: list[dict] = []
        for event in process_sales_stream(sales_dicts, model, ollama_host, max_images):
            job.push(event)
            if event["type"] == "sale_done":
                result = {k: v for k, v in event.items() if k != "type"}
                all_results.append(result)

        with open(FINDINGS_FILE, "w") as f:
            json.dump(all_results, f, indent=2)

        total_imgs = sum(r["images_processed"] for r in all_results)
        total_found = sum(r["images_with_findings"] for r in all_results)
        job.finish(f"Done — {total_found} findings across {total_imgs} images.")

    except Exception as e:
        job.push({"type": "error", "msg": str(e)})
        job.finish(f"Error: {e}")


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.route("/")
def index():
    return DASHBOARD_HTML


@app.route("/api/run", methods=["POST"])
def api_run():
    if job.running:
        return jsonify({"error": "A job is already running."}), 409

    data = request.json or {}
    state = (data.get("state") or "GA").upper().strip()
    city = (data.get("city") or "Atlanta").strip()
    max_sales = int(data.get("max_sales") or 10)
    max_images = data.get("max_images")
    if max_images:
        max_images = int(max_images)
    model = data.get("model") or DEFAULT_MODEL
    ollama_host = data.get("ollama_host") or OLLAMA_HOST

    job.reset()
    t = threading.Thread(
        target=run_job,
        args=(state, city, max_sales, max_images, model, ollama_host),
        daemon=True,
    )
    t.start()
    return jsonify({"ok": True})


@app.route("/stream")
def stream():
    start_idx = request.args.get("from", 0, type=int)

    def generate():
        idx = start_idx
        # send a comment to open the connection immediately
        yield ": connected\n\n"
        while True:
            new_len = job.wait_for_event(idx, timeout=15.0)
            if new_len > idx:
                batch = job.events[idx:new_len]
                idx = new_len
                for evt in batch:
                    yield f"data: {json.dumps(evt)}\n\n"
            else:
                # keepalive comment
                yield ": ping\n\n"
            if not job.running and idx >= len(job.events):
                break

    return Response(
        stream_with_context(generate()),
        mimetype="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.route("/api/findings")
def api_findings():
    try:
        with open(FINDINGS_FILE) as f:
            return jsonify(json.load(f))
    except FileNotFoundError:
        return jsonify([])


@app.route("/api/status")
def api_status():
    return jsonify({
        "running": job.running,
        "phase": job.phase,
        "status_msg": job.status_msg,
        "event_count": len(job.events),
    })


# ---------------------------------------------------------------------------
# Dashboard HTML
# ---------------------------------------------------------------------------

DASHBOARD_HTML = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Estate Sale Scanner</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#111;color:#e0e0e0;min-height:100vh}

/* header */
#header{position:sticky;top:0;z-index:200;background:#1a1a1a;border-bottom:1px solid #2a2a2a;padding:10px 18px;display:flex;align-items:center;gap:14px;flex-wrap:wrap}
#header h1{font-size:.95rem;font-weight:700;letter-spacing:.02em;white-space:nowrap}
#header h1 span{color:#7cb8ff}

/* progress bar */
#progress-wrap{flex:1;min-width:160px;display:flex;flex-direction:column;gap:4px}
#progress-bar-bg{height:4px;background:#2a2a2a;border-radius:2px;overflow:hidden}
#progress-bar{height:100%;width:0%;background:#7cb8ff;border-radius:2px;transition:width .4s ease}
#progress-text{font-size:.72rem;color:#888}

/* controls */
#filter-input{background:#222;border:1px solid #333;color:#e0e0e0;padding:5px 10px;border-radius:4px;font-size:.82rem;width:180px}
#filter-input:focus{outline:none;border-color:#555}
#scan-btn{background:#2563eb;color:#fff;border:none;padding:6px 14px;border-radius:4px;font-size:.82rem;cursor:pointer;white-space:nowrap}
#scan-btn:hover{background:#1d4ed8}
#scan-btn:disabled{background:#333;color:#666;cursor:not-allowed}

/* phase badge */
#phase-badge{font-size:.72rem;padding:3px 8px;border-radius:10px;background:#222;color:#888;white-space:nowrap}
#phase-badge.scraping{background:#1a3a1a;color:#4ade80}
#phase-badge.analyzing{background:#1a2a3a;color:#60a5fa}
#phase-badge.done{background:#1a1a2a;color:#a78bfa}

/* modal */
#modal-bg{display:none;position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:500;align-items:center;justify-content:center}
#modal-bg.open{display:flex}
#modal{background:#1e1e1e;border:1px solid #333;border-radius:8px;padding:24px;width:360px;max-width:95vw}
#modal h2{font-size:1rem;margin-bottom:16px}
.form-row{display:flex;flex-direction:column;gap:4px;margin-bottom:12px}
.form-row label{font-size:.75rem;color:#888}
.form-row input{background:#2a2a2a;border:1px solid #3a3a3a;color:#e0e0e0;padding:7px 10px;border-radius:4px;font-size:.85rem}
.form-row input:focus{outline:none;border-color:#555}
.form-actions{display:flex;gap:8px;margin-top:16px}
.btn-primary{flex:1;background:#2563eb;color:#fff;border:none;padding:8px;border-radius:4px;font-size:.85rem;cursor:pointer}
.btn-primary:hover{background:#1d4ed8}
.btn-cancel{background:#2a2a2a;color:#aaa;border:none;padding:8px 14px;border-radius:4px;font-size:.85rem;cursor:pointer}
.btn-cancel:hover{background:#333}

/* main */
#main{padding:16px 18px;max-width:1600px;margin:0 auto}
.empty-state{text-align:center;color:#444;padding:60px 20px;font-size:.9rem}
.empty-state p{margin-top:8px;font-size:.8rem;color:#333}

/* sale sections */
.sale-section{margin-bottom:32px}
.sale-header{display:flex;align-items:baseline;gap:10px;margin-bottom:10px;padding-bottom:8px;border-bottom:1px solid #222}
.sale-header h2{font-size:.9rem;font-weight:600}
.sale-header h2 a{color:#7cb8ff;text-decoration:none}
.sale-header h2 a:hover{text-decoration:underline}
.sale-stats{font-size:.72rem;color:#555;margin-left:auto;white-space:nowrap}

/* card grid */
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:8px}
.card{background:#1a1a1a;border:1px solid #252525;border-radius:6px;overflow:hidden;animation:fadein .35s ease}
@keyframes fadein{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
.card:hover{border-color:#444}
.card-img{display:block;aspect-ratio:4/3;overflow:hidden;background:#0d0d0d}
.card-img img{width:100%;height:100%;object-fit:cover;display:block}
.card-body{padding:7px 9px}
.card-findings{font-size:.75rem;color:#ccc;line-height:1.45;margin-bottom:6px}
.card-foot{display:flex;justify-content:space-between;align-items:center}
.card-foot a{font-size:.7rem;color:#7cb8ff;text-decoration:none}
.card-foot a:hover{text-decoration:underline}
.card-dur{font-size:.65rem;color:#444}

/* live indicator */
.live-dot{width:7px;height:7px;border-radius:50%;background:#4ade80;display:inline-block;animation:pulse 1.2s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}

.hidden{display:none!important}
</style>
</head>
<body>

<div id="header">
  <h1>Estate <span>Sale</span> Scanner</h1>
  <div id="progress-wrap" class="hidden">
    <div id="progress-bar-bg"><div id="progress-bar"></div></div>
    <div id="progress-text"></div>
  </div>
  <span id="phase-badge"></span>
  <input id="filter-input" type="text" placeholder="Filter findings…" oninput="filterCards(this.value)">
  <button id="scan-btn" onclick="openModal()">New Scan</button>
</div>

<div id="main">
  <div id="empty-state" class="empty-state">
    No findings yet.<p>Click <strong>New Scan</strong> to scrape a city and analyze images.</p>
  </div>
</div>

<!-- modal -->
<div id="modal-bg">
  <div id="modal">
    <h2>New Scan</h2>
    <div class="form-row"><label>State (2-letter)</label><input id="f-state" value="GA" maxlength="2"></div>
    <div class="form-row"><label>City</label><input id="f-city" value="Atlanta"></div>
    <div class="form-row"><label>Max sales to scrape</label><input id="f-max-sales" type="number" value="10" min="1" max="50"></div>
    <div class="form-row"><label>Max images per sale (blank = all)</label><input id="f-max-images" type="number" placeholder="e.g. 50"></div>
    <div class="form-row"><label>Model</label><input id="f-model" value="llava:13b"></div>
    <div class="form-actions">
      <button class="btn-primary" onclick="startScan()">Scrape &amp; Analyze</button>
      <button class="btn-cancel" onclick="closeModal()">Cancel</button>
    </div>
  </div>
</div>

<script>
// ---- state ----
const sections = {};    // sale_id → {el, grid, statsEl, found, total}
let totalProcessed = 0;
let totalImages = 0;
let totalFound = 0;
let startTime = null;
let eventSource = null;

// ---- init: load existing findings ----
(async () => {
  const res = await fetch('/api/findings');
  const data = await res.json();
  if (data.length) {
    hideEmpty();
    for (const sale of data) {
      ensureSection(sale.sale_id, sale.title, sale.url);
      for (const item of sale.findings) {
        addCard(sale.sale_id, item.image_url, item.sale_url || sale.url, item.findings, item.duration_s);
      }
      updateSaleStats(sale.sale_id, sale.images_with_findings, sale.images_processed);
    }
  }
  // check if a job is already running
  const status = await (await fetch('/api/status')).json();
  if (status.running) connectStream(status.event_count);
})();

// ---- SSE ----
function connectStream(fromIdx = 0) {
  if (eventSource) eventSource.close();
  startTime = Date.now();
  setPhase('analyzing');
  document.getElementById('scan-btn').disabled = true;
  showProgress();

  eventSource = new EventSource(`/stream?from=${fromIdx}`);
  eventSource.onmessage = (e) => {
    const evt = JSON.parse(e.data);
    handleEvent(evt);
  };
  eventSource.onerror = () => {
    // SSE closed (job done) — reconnect check after delay
    setTimeout(async () => {
      const s = await (await fetch('/api/status')).json();
      if (!s.running) finishStream(s.status_msg);
    }, 1000);
  };
}

function handleEvent(evt) {
  if (evt.type === 'phase') {
    setPhase(evt.phase, evt.msg);
  } else if (evt.type === 'scrape_done') {
    for (const s of evt.sales) {
      ensureSection(s.sale_id, s.title, s.url);
      totalImages += s.image_count;
    }
    setPhase('analyzing');
  } else if (evt.type === 'sale_start') {
    ensureSection(evt.sale_id, evt.title, evt.url);
  } else if (evt.type === 'finding') {
    hideEmpty();
    addCard(evt.sale_id, evt.image_url, evt.sale_url, evt.findings, evt.duration_s);
    totalFound++;
  } else if (evt.type === 'progress') {
    totalProcessed = (sections[evt.sale_id]?.processed || 0);
    updateProgress(evt);
  } else if (evt.type === 'sale_done') {
    if (sections[evt.sale_id]) sections[evt.sale_id].processed = evt.images_processed;
    updateSaleStats(evt.sale_id, evt.images_with_findings, evt.images_processed);
  } else if (evt.type === 'done') {
    finishStream('Analysis complete.');
  } else if (evt.type === 'error') {
    setPhase('idle', evt.msg);
    finishStream(evt.msg);
  }
}

function finishStream(msg) {
  if (eventSource) { eventSource.close(); eventSource = null; }
  setPhase('done', msg);
  hideProgress();
  document.getElementById('scan-btn').disabled = false;
}

// ---- DOM helpers ----
function hideEmpty() {
  const el = document.getElementById('empty-state');
  if (el) el.remove();
}

function ensureSection(saleId, title, url) {
  if (sections[saleId]) return;
  const section = document.createElement('div');
  section.className = 'sale-section';
  section.dataset.saleId = saleId;
  section.innerHTML = `
    <div class="sale-header">
      <h2><a href="${esc(url)}" target="_blank" rel="noopener">${esc(title)}</a></h2>
      <span class="sale-stats" id="stats-${saleId}"></span>
    </div>
    <div class="grid" id="grid-${saleId}"></div>`;
  document.getElementById('main').appendChild(section);
  sections[saleId] = {
    el: section,
    grid: section.querySelector('.grid'),
    statsEl: section.querySelector(`#stats-${saleId}`),
    found: 0,
    processed: 0,
  };
}

function addCard(saleId, imgUrl, saleUrl, findings, duration) {
  const s = sections[saleId];
  if (!s) return;
  s.found++;
  const card = document.createElement('div');
  card.className = 'card';
  card.dataset.findings = findings.toLowerCase();
  card.innerHTML = `
    <a class="card-img" href="${esc(imgUrl)}" target="_blank" rel="noopener">
      <img loading="lazy" src="${esc(imgUrl)}" alt="estate sale item">
    </a>
    <div class="card-body">
      <p class="card-findings">${esc(findings)}</p>
      <div class="card-foot">
        <a href="${esc(saleUrl)}" target="_blank" rel="noopener">View listing</a>
        <span class="card-dur">${duration}s</span>
      </div>
    </div>`;
  s.grid.prepend(card);
}

function updateSaleStats(saleId, found, processed) {
  const s = sections[saleId];
  if (!s || !s.statsEl) return;
  const rate = processed ? Math.round(100 * found / processed) : 0;
  s.statsEl.textContent = `${found} findings / ${processed} images (${rate}%)`;
}

function updateProgress(evt) {
  const pct = evt.total ? Math.round(100 * evt.done / evt.total) : 0;
  document.getElementById('progress-bar').style.width = pct + '%';

  const elapsed = startTime ? (Date.now() - startTime) / 1000 : 0;
  const rate = elapsed > 0 ? (evt.done / elapsed).toFixed(1) : '…';
  const remaining = (evt.total - evt.done);
  const eta = elapsed > 0 && evt.done > 0
    ? fmtTime(remaining / (evt.done / elapsed))
    : '…';
  document.getElementById('progress-text').textContent =
    `${evt.done}/${evt.total} images · ${totalFound} findings · ${rate} img/s · ETA ${eta}`;
}

function fmtTime(secs) {
  if (secs < 60) return Math.round(secs) + 's';
  if (secs < 3600) return Math.round(secs/60) + 'm';
  return (secs/3600).toFixed(1) + 'h';
}

function setPhase(phase, msg) {
  const badge = document.getElementById('phase-badge');
  const labels = {scraping:'Scraping…', analyzing:'Analyzing…', done:'Done', idle:''};
  badge.className = 'phase-badge ' + phase;
  badge.textContent = msg || labels[phase] || '';
  if (phase === 'analyzing') {
    badge.innerHTML = `<span class="live-dot"></span> Analyzing…`;
  }
}

function showProgress() { document.getElementById('progress-wrap').classList.remove('hidden'); }
function hideProgress() { document.getElementById('progress-wrap').classList.add('hidden'); }

function filterCards(q) {
  q = q.toLowerCase().trim();
  document.querySelectorAll('.card').forEach(c => {
    c.classList.toggle('hidden', q !== '' && !c.dataset.findings.includes(q));
  });
  document.querySelectorAll('.sale-section').forEach(s => {
    const anyVisible = [...s.querySelectorAll('.card')].some(c => !c.classList.contains('hidden'));
    s.classList.toggle('hidden', q !== '' && !anyVisible);
  });
}

// ---- modal ----
function openModal() {
  document.getElementById('modal-bg').classList.add('open');
  document.getElementById('f-city').focus();
}
function closeModal() {
  document.getElementById('modal-bg').classList.remove('open');
}
document.getElementById('modal-bg').addEventListener('click', e => {
  if (e.target === e.currentTarget) closeModal();
});

async function startScan() {
  const body = {
    state: document.getElementById('f-state').value.trim(),
    city: document.getElementById('f-city').value.trim(),
    max_sales: document.getElementById('f-max-sales').value,
    max_images: document.getElementById('f-max-images').value || null,
    model: document.getElementById('f-model').value.trim(),
  };
  closeModal();
  // clear existing sections
  document.getElementById('main').innerHTML = '';
  Object.keys(sections).forEach(k => delete sections[k]);
  totalProcessed = 0; totalImages = 0; totalFound = 0;

  const res = await fetch('/api/run', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json();
    alert(err.error || 'Failed to start scan.');
    return;
  }
  connectStream(0);
}

function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
</script>
</body>
</html>"""


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    print(f"Dashboard: http://localhost:{port}")
    app.run(host="0.0.0.0", port=port, threaded=True, debug=False)
