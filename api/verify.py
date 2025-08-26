from flask import Blueprint, request, jsonify
from neo4j import GraphDatabase
from flask_cors import cross_origin
import traceback, os, re

verify_bp = Blueprint("verify_bp", __name__)

NEO4J_URI = os.getenv("NEO4J_URI", "bolt://localhost:7687")
NEO4J_USER = os.getenv("NEO4J_USER", "neo4j")
NEO4J_PASSWORD = os.getenv("NEO4J_PASSWORD", "passwordknow")
driver = GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USER, NEO4J_PASSWORD))

# Map a bunch of natural phrasing to KG relation types
REL_MAP = {
    # PROTECTS
    "protect": "PROTECTS", "protects": "PROTECTS", "protecting": "PROTECTS",
    "protection": "PROTECTS", "neuroprotective": "PROTECTS", "neuroprotection": "PROTECTS",
    # REDUCES
    "reduce": "REDUCES", "reduces": "REDUCES", "reducing": "REDUCES",
    "decrease": "REDUCES", "decreases": "REDUCES", "lower": "REDUCES", "lowers": "REDUCES",
    "attenuate": "REDUCES", "attenuates": "REDUCES", "mitigate": "REDUCES", "mitigates": "REDUCES",
    # MODULATES
    "modulate": "MODULATES", "modulates": "MODULATES", "modulating": "MODULATES",
    "anti inflammatory": "MODULATES", "antiinflammatory": "MODULATES",
    "regulate": "MODULATES", "regulates": "MODULATES",
    # SUPPORTS
    "support": "SUPPORTS", "supports": "SUPPORTS", "supporting": "SUPPORTS",
    "enhance": "SUPPORTS", "enhances": "SUPPORTS", "improve": "SUPPORTS", "improves": "SUPPORTS",
    "promote": "SUPPORTS", "promotes": "SUPPORTS",
    # ASSOCIATED_WITH
    "associated with": "ASSOCIATED_WITH", "associate": "ASSOCIATED_WITH", "associates with": "ASSOCIATED_WITH",
    "linked to": "ASSOCIATED_WITH", "linked with": "ASSOCIATED_WITH", "correlates with": "ASSOCIATED_WITH",
    "related to": "ASSOCIATED_WITH", "relation with": "ASSOCIATED_WITH",
    # MEDIATES
    "mediate": "MEDIATES", "mediates": "MEDIATES", "drives": "MEDIATES", "contributes to": "MEDIATES",
    # DAMAGES
    "damage": "DAMAGES", "damages": "DAMAGES", "harm": "DAMAGES", "harms": "DAMAGES",
    "toxicity": "DAMAGES", "injures": "DAMAGES"
}

def normalize_relation(rel: str) -> str:
    if not rel:
        return ""
    s = rel.strip().lower()
    s = re.sub(r"[^\w\s-]", "", s)      # drop punctuation
    s = re.sub(r"[_\s]+", " ", s).strip()
    # exact map hit?
    if s in REL_MAP:
        return REL_MAP[s]
    # try singular->canonical heuristics
    if s.endswith("ing") and s[:-3] in REL_MAP:
        return REL_MAP[s[:-3]]
    if s.endswith("ed") and s[:-2] in REL_MAP:
        return REL_MAP[s[:-2]]
    if s.endswith("s") and s[:-1] in REL_MAP:
        return REL_MAP[s[:-1]]
    # fallback: uppercase with underscores, so "associated with" -> "ASSOCIATED_WITH"
    return s.upper().replace(" ", "_")

@verify_bp.route("/api/verify", methods=["POST"])
@cross_origin(origins="*", methods=["POST"], allow_headers=["Content-Type"])
def verify_triples():
    try:
        data = request.get_json(force=True) or {}
        triples = data.get("triples", [])
        if not isinstance(triples, list):
            return jsonify({"error": "triples must be a list of [head, relation, tail]"}), 400

        results = []
        with driver.session() as session:
            for triple in triples:
                if not isinstance(triple, (list, tuple)) or len(triple) != 3:
                    results.append({"head": None, "relation": None, "tail": None,
                                    "status": "unsure", "count": 0, "papers": [], "ui_hint": "missing"})
                    continue

                head, rel, tail = (triple[0] or "").strip(), (triple[1] or "").strip(), (triple[2] or "").strip()
                rel_norm = normalize_relation(rel)

                # 1) Exact relation match?
                q_exact = """
                MATCH (h:Entity),(t:Entity)
                WHERE toLower(h.name)=toLower($head) AND toLower(t.name)=toLower($tail)
                MATCH (h)-[r]->(t)
                WHERE toLower(type(r)) = toLower($relCanon)
                RETURN coalesce(r.count, CASE WHEN r.papers IS NULL THEN 0 ELSE size(r.papers) END) AS count,
                       coalesce(r.papers, []) AS papers
                LIMIT 1
                """
                rec = session.run(q_exact, head=head, tail=tail, relCanon=rel_norm).single()
                if rec:
                    count = int(rec["count"] or 0)
                    papers = rec["papers"] or []
                    results.append({
                        "head": head, "relation": rel, "tail": tail,
                        "rel_norm": rel_norm,
                        "status": "supported", "count": count, "papers": papers, "ui_hint": "solid"
                    })
                    continue

                # 2) Same entities but different relation? -> relevant
                q_alt_rel = """
                MATCH (h:Entity)-[r]->(t:Entity)
                WHERE toLower(h.name)=toLower($head) AND toLower(t.name)=toLower($tail)
                      AND toLower(type(r)) <> toLower($relCanon)
                RETURN type(r) AS alt_rel,
                       coalesce(r.count, CASE WHEN r.papers IS NULL THEN 0 ELSE size(r.papers) END) AS count
                ORDER BY count DESC
                LIMIT 1
                """
                alt = session.run(q_alt_rel, head=head, tail=tail, relCanon=rel_norm).single()
                if alt:
                    results.append({
                        "head": head, "relation": rel, "tail": tail,
                        "rel_norm": rel_norm,
                        "status": "relevant", "count": 0, "papers": [], "ui_hint": "weak"
                    })
                    continue

                # 3) Two-hop bridge head -> X -> tail? -> relevant
                q_two_hop = """
                MATCH (h:Entity),(t:Entity)
                WHERE toLower(h.name)=toLower($head) AND toLower(t.name)=toLower($tail)
                MATCH (h)-[r1]->(m)-[r2]->(t)
                RETURN m.name AS bridge,
                       type(r1) AS r1_type, type(r2) AS r2_type,
                       coalesce(r1.count, CASE WHEN r1.papers IS NULL THEN 0 ELSE size(r1.papers) END) +
                       coalesce(r2.count, CASE WHEN r2.papers IS NULL THEN 0 ELSE size(r2.papers) END) AS total_weight
                ORDER BY total_weight DESC
                LIMIT 1
                """
                two_hop = session.run(q_two_hop, head=head, tail=tail).single()
                if two_hop:
                    results.append({
                        "head": head, "relation": rel, "tail": tail,
                        "rel_norm": rel_norm,
                        "status": "relevant", "count": 0, "papers": [], "ui_hint": "weak"
                    })
                    continue

                # 4) Nothing useful -> unsure
                results.append({
                    "head": head, "relation": rel, "tail": tail,
                    "rel_norm": rel_norm,
                    "status": "unsure", "count": 0, "papers": [], "ui_hint": "missing"
                })

        return jsonify({"results": results}), 200

    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500
