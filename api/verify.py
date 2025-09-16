from flask import Blueprint, request, jsonify
from neo4j import GraphDatabase
from flask_cors import cross_origin
import traceback, os, re

verify_bp = Blueprint("verify_bp", __name__)

NEO4J_URI = os.getenv("NEO4J_URI", "bolt://localhost:7687")
NEO4J_USER = os.getenv("NEO4J_USER", "neo4j")
NEO4J_PASSWORD = os.getenv("NEO4J_PASSWORD", "passwordknow")
driver = GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USER, NEO4J_PASSWORD))

# Natural phrasing → canonical KG relation
REL_MAP = {
  # INTERACTS_WITH
  "interact": "INTERACTS_WITH", "interacts": "INTERACTS_WITH",
  "interacts with": "INTERACTS_WITH", "binds": "INTERACTS_WITH", "binding": "INTERACTS_WITH",
  "complexes with": "INTERACTS_WITH",

  # AFFECTS / AUGMENTS / STIMULATES / INHIBITS / DISRUPTS
  "affect": "AFFECTS", "affects": "AFFECTS", "impact": "AFFECTS", "impacts": "AFFECTS",
  "increase": "AUGMENTS", "increases": "AUGMENTS", "enhance": "AUGMENTS", "enhances": "AUGMENTS",
  "stimulate": "STIMULATES", "stimulates": "STIMULATES", "activate": "STIMULATES", "activates": "STIMULATES",
  "inhibit": "INHIBITS", "inhibits": "INHIBITS", "suppress": "INHIBITS", "suppresses": "INHIBITS",
  "disrupt": "DISRUPTS", "disrupts": "DISRUPTS", "impair": "DISRUPTS", "impairs": "DISRUPTS",

  # TREATS / PREVENTS / CAUSES / PREDISPOSES / COMPLICATES / PRODUCES / COEXISTS_WITH / ASSOCIATED_WITH
  "treat": "TREATS", "treats": "TREATS",
  "prevent": "PREVENTS", "prevents": "PREVENTS", "protect": "PREVENTS", "protects": "PREVENTS",
  "cause": "CAUSES", "causes": "CAUSES",
  "predispose": "PREDISPOSES", "predisposes": "PREDISPOSES",
  "complicate": "COMPLICATES", "complicates": "COMPLICATES",
  "produce": "PRODUCES", "produces": "PRODUCES",
  "coexists with": "COEXISTS_WITH",
  "associated with": "ASSOCIATED_WITH", "associate": "ASSOCIATED_WITH", "associates with": "ASSOCIATED_WITH",
}

def normalize_relation(rel: str) -> str:
    if not rel:
        return ""
    s = rel.strip().lower()
    s = re.sub(r"[^\w\s-]", "", s)      # drop punctuation
    s = re.sub(r"[_\s]+", " ", s).strip()
    if s in REL_MAP:
        return REL_MAP[s]
    if s.endswith("ing") and s[:-3] in REL_MAP:
        return REL_MAP[s[:-3]]
    if s.endswith("ed") and s[:-2] in REL_MAP:
        return REL_MAP[s[:-2]]
    if s.endswith("s") and s[:-1] in REL_MAP:
        return REL_MAP[s[:-1]]
    return s.upper().replace(" ", "_")  # fallback e.g. "associated with" → "ASSOCIATED_WITH"

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

                # 1) Exact relation match (align with recommend.py: label :Entity, property .name)
                q_exact = """
                MATCH (h:Entity)-[r]->(t:Entity)
                WHERE toLower(h.name) = toLower($head)
                  AND toLower(t.name) = toLower($tail)
                  AND toUpper(type(r)) = toUpper($relCanon)
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

                # 2) Same entities but different relation → relevant
                q_alt_rel = """
                MATCH (h:Entity)-[r]->(t:Entity)
                WHERE toLower(h.name) = toLower($head)
                  AND toLower(t.name) = toLower($tail)
                  AND toUpper(type(r)) <> toUpper($relCanon)
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

                # 3) Two-hop head → X → tail → relevant
                q_two_hop = """
                MATCH (h:Entity)-[r1]->(m)-[r2]->(t:Entity)
                WHERE toLower(h.name) = toLower($head)
                  AND toLower(t.name) = toLower($tail)
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

                # 4) Nothing → unsure
                results.append({
                    "head": head, "relation": rel, "tail": tail,
                    "rel_norm": rel_norm,
                    "status": "unsure", "count": 0, "papers": [], "ui_hint": "missing"
                })

        return jsonify({"results": results}), 200

    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500
