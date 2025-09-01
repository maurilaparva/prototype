from flask import Blueprint, request, jsonify, current_app
import os, re, time, math, requests
from urllib.parse import urlparse
from collections import OrderedDict

verify_bp = Blueprint("verify_bp", __name__)

# ---- Config knobs
LIGHT_SITES = ["pubmed.ncbi.nlm.nih.gov", "nih.gov"]
RESULTS_PER_QUERY = 5          # num=5 keeps it cheap
STRONG_THRESHOLD = 4.0         # weighted hits >= 4 => stop early
CACHE_TTL_SECONDS = 7 * 24 * 3600
CACHE_MAX_ENTRIES = 1000

PUBMED_RX = re.compile(r"pubmed\.ncbi\.nlm\.nih\.gov/(\d+)")
ALT_PUBMED_RX = re.compile(r"ncbi\.nlm\.nih\.gov/pubmed/(\d+)")

DOMAIN_WEIGHTS = {
    "pubmed.ncbi.nlm.nih.gov": 3.0,
    "nih.gov": 2.0,
    "ncbi.nlm.nih.gov": 2.0,
    "nature.com": 2.0,
    "science.org": 2.0,
    "thelancet.com": 2.0,
    "nejm.org": 2.0,
}

# Simple LRU-ish cache with TTL
class TTLCache:
    def __init__(self, max_entries=1000, ttl=CACHE_TTL_SECONDS):
        self.store = OrderedDict()
        self.max_entries = max_entries
        self.ttl = ttl

    def get(self, key):
        now = time.time()
        item = self.store.get(key)
        if not item: return None
        ts, val = item
        if now - ts > self.ttl:
            self.store.pop(key, None)
            return None
        # move to end (LRU)
        self.store.move_to_end(key)
        return val

    def set(self, key, val):
        now = time.time()
        self.store[key] = (now, val)
        self.store.move_to_end(key)
        if len(self.store) > self.max_entries:
            self.store.popitem(last=False)

_cache = TTLCache(CACHE_MAX_ENTRIES, CACHE_TTL_SECONDS)

def _domain_weight(url: str) -> float:
    try:
        host = urlparse(url).netloc.lower()
        if host in DOMAIN_WEIGHTS: return DOMAIN_WEIGHTS[host]
        for key, w in DOMAIN_WEIGHTS.items():
            if host.endswith(key): return w
        return 1.0
    except Exception:
        return 1.0

def _pubmed_ids(url: str):
    ids = []
    m = PUBMED_RX.search(url)
    if m: ids.append(m.group(1))
    m2 = ALT_PUBMED_RX.search(url)
    if m2: ids.append(m2.group(1))
    return ids

def _serper(serper_key: str, query: str):
    resp = requests.post(
        "https://google.serper.dev/search",
        headers={"X-API-KEY": serper_key, "Content-Type": "application/json"},
        json={"q": query, "num": RESULTS_PER_QUERY}
    )
    if resp.status_code != 200:
        raise RuntimeError(f"Serper error {resp.status_code}: {resp.text}")
    return resp.json()

def _queries(head, relation, tail, mode: str):
    headq = f"\"{head}\""
    tailq = f"\"{tail}\""
    relq  = relation if relation else ""

    if mode == "light":
        # Only trusted sites; 1–2 queries max
        return [
            f"{headq} {tailq} site:pubmed.ncbi.nlm.nih.gov",
            f"{headq} {tailq} site:nih.gov",
        ]
    elif mode == "standard":
        return [
            f"{headq} {tailq}",
            f"{headq} {tailq} {relq}",
            f"{headq} {tailq} site:pubmed.ncbi.nlm.nih.gov",
            f"{headq} {tailq} site:nih.gov",
        ]
    else:  # deep
        return [
            f"{headq} {tailq}",
            f"{headq} {tailq} {relq}",
            f"{headq} {tailq} {relq} site:pubmed.ncbi.nlm.nih.gov",
            f"{headq} {tailq} site:nih.gov",
            f"{headq} {tailq} {relq} site:ncbi.nlm.nih.gov",
            f"{headq} {tailq} {relq} site:nature.com",
        ]

def _aggregate(serper_key, head, relation, tail, mode: str):
    total_w = 0.0
    seen = set()
    urls, pmids = [], set()

    for i, q in enumerate(_queries(head, relation, tail, mode)):
        try:
            data = _serper(serper_key, q)
        except Exception as e:
            current_app.logger.warning("[verify] serper failed (%s): %s", q, e)
            continue

        for item in (data.get("organic") or []):
            url = (item.get("link") or "").strip()
            if not url or url in seen: continue
            seen.add(url)
            urls.append(url)
            total_w += _domain_weight(url)
            for pid in _pubmed_ids(url): pmids.add(pid)

        # EARLY STOP: once we’re “strong”, don’t fire more queries
        if total_w >= STRONG_THRESHOLD and mode == "light":
            break

    alpha = 6.0
    conf = 1.0 - math.exp(-(total_w / alpha))
    if total_w == 0: ui = "missing"
    elif total_w < STRONG_THRESHOLD: ui = "weak"
    else: ui = "strong"

    return {
        "count": int(round(total_w)),
        "confidence": conf,
        "ui_hint": ui,
        "papers": sorted(pmids)[:20],
        "sources": urls[:20],
    }

@verify_bp.route("/api/verify", methods=["POST"])
def verify_route():
    data = request.get_json(force=True) or {}
    triples = data.get("triples") or []
    mode = (data.get("mode") or "light").lower()

    serper_key = (request.headers.get("x-serper-key") or "").strip()
    if not serper_key:
        return jsonify({"error": "Missing OpenAI or Serper API key"}), 400

    out = []
    for t in triples:
        try:
            head, relation, tail = t
        except Exception:
            continue
        key = f"{(head or '').lower()}|{(relation or '').lower()}|{(tail or '').lower()}"

        cached = _cache.get(key)
        if cached:
            out.append({"head": head, "relation": relation, "tail": tail, **cached})
            continue

        ev = _aggregate(serper_key, head, relation, tail, mode)
        _cache.set(key, ev)
        out.append({"head": head, "relation": relation, "tail": tail, **ev})

    return jsonify({"results": out})
