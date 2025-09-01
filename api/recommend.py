from flask import Blueprint, request, jsonify, current_app
from openai import OpenAI
import os, time, requests
from urllib.parse import urlparse
import math, re

recommend_bp = Blueprint("recommend_bp", __name__)

# --- Shared with verify.py (you could import from one place if you like)
PUBMED_RX = re.compile(r"pubmed\.ncbi\.nlm\.nih\.gov/(\d+)")
ALTERNATE_PUBMED_RX = re.compile(r"ncbi\.nlm\.nih\.gov/pubmed/(\d+)")

DOMAIN_WEIGHTS = {
    "pubmed.ncbi.nlm.nih.gov": 3.0,
    "nih.gov": 2.0,
    "ncbi.nlm.nih.gov": 2.0,
    "nature.com": 2.0,
    "science.org": 2.0,
    "thelancet.com": 2.0,
    "nejm.org": 2.0,
}

REL_DEFAULTS = ["AFFECTS","BENEFITS","INTERACTS","PROTECTS","REDUCES","MODULATES","ASSOCIATED_WITH"]

def _domain_weight(url: str) -> float:
    try:
        host = urlparse(url).netloc.lower()
        if host in DOMAIN_WEIGHTS:
            return DOMAIN_WEIGHTS[host]
        for key, w in DOMAIN_WEIGHTS.items():
            if host.endswith(key):
                return w
        return 1.0
    except Exception:
        return 1.0

def _extract_pubmed_ids(url: str):
    ids = []
    m = PUBMED_RX.search(url)
    if m: ids.append(m.group(1))
    m2 = ALTERNATE_PUBMED_RX.search(url)
    if m2: ids.append(m2.group(1))
    return ids

def _serper_search(serper_key: str, query: str):
    resp = requests.post(
        "https://google.serper.dev/search",
        headers={"X-API-KEY": serper_key, "Content-Type": "application/json"},
        json={"q": query, "num": 10}
    )
    if resp.status_code != 200:
        raise RuntimeError(f"Serper error {resp.status_code}: {resp.text}")
    return resp.json()

def _verify_pair(serper_key: str, head: str, relation: str, tail: str):
    # simple one-pass query; reuse logic from verify.py if you prefer
    q = f"\"{head}\" \"{tail}\" {relation}"
    data = _serper_search(serper_key, q)
    organic = data.get("organic") or []

    seen = set()
    wsum = 0.0
    pubmed = set()
    urls = []
    for item in organic:
        url = (item.get("link") or "").strip()
        if not url or url in seen:
            continue
        seen.add(url)
        urls.append(url)
        wsum += _domain_weight(url)
        for pid in _extract_pubmed_ids(url):
            pubmed.add(pid)

    alpha = 6.0
    confidence = 1.0 - math.exp(-(wsum / alpha))
    if wsum == 0:
        ui_hint = "missing"
    elif wsum < 4:
        ui_hint = "weak"
    else:
        ui_hint = "strong"

    return {
        "weighted_count": wsum,
        "count": int(round(wsum)),
        "confidence": confidence,
        "ui_hint": ui_hint,
        "papers": sorted(pubmed)[:20],
        "sources": urls[:20],
    }

def _heuristic_candidates(head: str, whitelist):
    h = head.lower()
    # A tiny heuristic seed list. You can expand or replace with dictionaries.
    seeds = []
    if "omega-3" in h or "fish oil" in h or "epa" in h or "dha" in h:
        seeds = [
            ("BENEFITS","Cognitive decline"),
            ("REDUCES","Triglycerides"),
            ("PROTECTS","Neurons"),
            ("ASSOCIATED_WITH","Cardiovascular health"),
            ("INTERACTS","Inflammation"),
        ]
    elif "curcumin" in h or "turmeric" in h:
        seeds = [
            ("REDUCES","Inflammation"),
            ("PROTECTS","Neurons"),
            ("MODULATES","Amyloid-beta"),
            ("ASSOCIATED_WITH","Oxidative stress"),
            ("BENEFITS","Cognition"),
        ]
    else:
        seeds = [
            ("ASSOCIATED_WITH","Oxidative stress"),
            ("AFFECTS","Neuroinflammation"),
            ("BENEFITS","Cognition"),
            ("INTERACTS","Microglia"),
            ("MODULATES","Synaptic plasticity"),
        ]
    if whitelist:
        seeds = [(r,t) for (r,t) in seeds if r in whitelist]
    return seeds[:12]

def _openai_candidates(openai_key: str, head: str, whitelist):
    client = OpenAI(api_key=openai_key)
    rels = whitelist or REL_DEFAULTS
    sys = (
        "You are helping generate candidate biomedical relation targets. "
        "Given a HEAD entity and a set of RELATION types, propose plausible TAIL entities "
        "across Disease, Symptom, Gene, Drug, or Dietary Supplement. "
        "Return STRICT JSON: [{\"relation\":\"...\",\"tail\":\"...\"}, ...] with <= 15 items."
    )
    user = f"HEAD: {head}\nRELATIONS: {', '.join(rels)}"
    try:
        r = client.chat.completions.create(
            model="gpt-4o-mini",
            temperature=0.4,
            messages=[
                {"role":"system","content":sys},
                {"role":"user","content":user}
            ]
        )
        txt = r.choices[0].message.content.strip()
        import json
        arr = json.loads(txt)
        out = []
        for item in arr:
            rel = str(item.get("relation","")).upper().strip()
            tail = str(item.get("tail","")).strip()
            if not rel or not tail:
                continue
            out.append((rel, tail))
        if whitelist:
            out = [(r,t) for (r,t) in out if r in whitelist]
        # cap to ~20 before verification
        return out[:20]
    except Exception as e:
        current_app.logger.warning("[recommend] OpenAI generation failed, falling back: %s", e)
        return _heuristic_candidates(head, whitelist)

@recommend_bp.route("/api/recommend", methods=["POST"])
def recommend():
    t0 = time.time()
    data = request.get_json(force=True) or {}

    head = (data.get("head") or "").strip()
    if not head:
        return jsonify({"error": "head (node name) is required"}), 400

    k = int(data.get("k", 5))
    whitelist = [str(w).upper() for w in (data.get("whitelist") or [])]
    per_type_cap = int(data.get("per_type_cap", 2))  # not used here; types not inferred
    exclude = [str(x).strip().lower() for x in (data.get("exclude") or [])]

    openai_key = (request.headers.get("x-openai-key") or "").strip()
    serper_key = (request.headers.get("x-serper-key") or "").strip()
    if not serper_key:
        return jsonify({"error": "Missing Serper API key"}), 400

    # 1) Get candidate pairs (relation, tail)
    if openai_key:
        candidates = _openai_candidates(openai_key, head, whitelist)
    else:
        candidates = _heuristic_candidates(head, whitelist)

    # 2) Verify each candidate via Serper and score
    scored = []
    seen_tail = set()
    for rel, tail in candidates:
        tnorm = tail.lower()
        if tnorm in exclude or (head.lower() == tnorm):
            continue
        if (rel, tnorm) in seen_tail:
            continue
        seen_tail.add((rel, tnorm))

        try:
            ev = _verify_pair(serper_key, head, rel, tail)
        except Exception as e:
            current_app.logger.warning("[recommend] verify failed for %s -%s-> %s: %s", head, rel, tail, e)
            continue

        scored.append({
            "relation": rel,
            "tail": tail,
            "count": ev["count"],
            "confidence": ev["confidence"],
            "ui_hint": ev["ui_hint"],
            "papers": ev["papers"],
            "sources": ev["sources"],
        })

    # 3) Rank by evidence count then confidence
    scored.sort(key=lambda x: (x["count"], x["confidence"]), reverse=True)
    picked = scored[:k]

    # 4) Shape for UI
    suggestions = [{
        "text": f"Show me more about {head} and {p['tail']}",
        "head": {"id": "", "name": head, "types": []},
        "relation": {"type": p["relation"], "direction": "any"},
        "tail": {"id": "", "name": p["tail"], "types": []},
        "count": p["count"],
        "source": "web-verified",
        "confidence": p["confidence"],
        "ui_hint": p["ui_hint"],
        "papers": p["papers"],
        "sources": p["sources"],
    } for p in picked]

    current_app.logger.info("[recommend] head=%s -> %d suggestions in %dms",
                            head, len(suggestions), int((time.time()-t0)*1000))

    return jsonify({"suggestions": suggestions})
