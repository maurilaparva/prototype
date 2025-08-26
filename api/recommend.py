from flask import Blueprint, request, jsonify
from neo4j import GraphDatabase
import os

recommend_bp = Blueprint("recommend_bp", __name__)

NEO4J_URI = os.getenv("NEO4J_URI", "bolt://localhost:7687")
NEO4J_USER = os.getenv("NEO4J_USER", "neo4j")
NEO4J_PASSWORD = os.getenv("NEO4J_PASSWORD", "passwordknow")
_driver = GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USER, NEO4J_PASSWORD))

def _primary_type(labels):
    # Prefer a non-generic label if available (deterministic)
    generic = {"Entity", "Thing", "Concept"}
    specific = [l for l in labels if l not in generic]
    return sorted(specific)[0] if specific else (sorted(labels)[0] if labels else "Entity")

@recommend_bp.route("/api/recommend", methods=["POST"])
def recommend():
    data = request.get_json(force=True) or {}
    head = (data.get("head") or "").strip()
    k = int(data.get("k", 5))
    direction = (data.get("direction") or "any").lower()   # "out" | "in" | "any"
    whitelist = [w.upper() for w in (data.get("whitelist") or [])]
    per_type_cap = int(data.get("per_type_cap", 2))
    exclude = [str(x).strip().lower() for x in (data.get("exclude") or [])]

    if not head:
        return jsonify({"error": "head (node name) is required"}), 400

    pool_limit = max(k * 6, 30)

    cypher = """
    MATCH (h:Entity)
    WHERE toLower(h.name) = toLower($head)

    // candidate 1-hop neighbors, both directions; we'll filter by 'direction' below
    CALL {
      WITH h
      MATCH (h)-[r]->(t:Entity)
      RETURN h AS H, t AS T, r AS R, 'out' AS dir
      UNION
      WITH h
      MATCH (t:Entity)-[r]->(h)
      RETURN h AS H, t AS T, r AS R, 'in'  AS dir
    }

    WITH H, T, R, dir
    WHERE ($direction = 'any' OR dir = $direction)
      AND NOT toLower(T.name) IN $exclude
      AND ($whitelist = [] OR toUpper(type(R)) IN $whitelist)

    WITH H, T, type(R) AS rtype,
         coalesce(R.count, CASE WHEN R.papers IS NULL THEN 0 ELSE size(R.papers) END) AS evidence,
         labels(T) AS tail_labels
    ORDER BY evidence DESC, rtype ASC, toLower(T.name) ASC
    LIMIT $limit

    RETURN H.name AS head_name, id(H) AS head_id,
           T.name AS tail_name, id(T) AS tail_id,
           rtype AS relation, tail_labels, evidence
    """

    params = {
        "head": head,
        "direction": direction,
        "whitelist": whitelist,
        "exclude": exclude,
        "limit": pool_limit,
    }

    with _driver.session() as session:
        rows = session.run(cypher, **params).data()

    # Enforce diversity by primary tail type (deterministic round-robin)
    buckets = {}
    for r in rows:
        ttype = _primary_type(r.get("tail_labels") or [])
        buckets.setdefault(ttype, []).append(r)

    picked, type_counts = [], {t: 0 for t in buckets.keys()}
    while len(picked) < k:
        progressed = False
        for t in sorted(buckets.keys()):
            if type_counts[t] >= per_type_cap:
                continue
            if buckets[t]:
                picked.append(buckets[t].pop(0))
                type_counts[t] += 1
                progressed = True
                if len(picked) >= k:
                    break
        if not progressed:
            break

    # Fallback fill if needed
    if len(picked) < k:
        used = {(p["head_id"], p["relation"], p["tail_id"]) for p in picked}
        for r in rows:
            key = (r["head_id"], r["relation"], r["tail_id"])
            if key not in used:
                picked.append(r)
                if len(picked) >= k:
                    break

    suggestions = [{
        "text": f"Show me more about {r['head_name']} and {r['tail_name']}",
        "head": {"id": f"neo4j:{r['head_id']}", "name": r["head_name"], "types": ["Entity"]},
        "relation": {"type": r["relation"], "direction": "->"},
        "tail": {"id": f"neo4j:{r['tail_id']}", "name": r["tail_name"], "types": r.get("tail_labels") or ["Entity"]},
        "count": int(r["evidence"] or 0),
        "source": "1-hop"
    } for r in picked]

    return jsonify({"suggestions": suggestions})
