'use Client'
import { ChatPanel } from './chat-panel.tsx';
// import { useChat } from 'ai/react';
import { useLocalStorage } from '../lib/hooks/use-local-storage.ts';
import { toast } from 'react-hot-toast';
import { type Message } from 'ai/react';
import React, { useState, useRef, useEffect, useCallback, useMemo} from 'react';
import { EmptyScreen } from './empty-screen.tsx';
import { ChatList } from './chat-list.tsx';
import { useNavigate, useLocation } from 'react-router-dom';
import { ViewModeProvider } from './ui/view-mode.tsx';
import { ReactFlowProvider } from 'reactflow';
import { ChatScrollAnchor } from './chat-scroll-anchors.tsx';
import { CustomGraphNode, CustomGraphEdge, BackendData } from '../lib/types.ts';
import Slider from './chat-slider.tsx';
import {
  useNodesState,
  Position,
  ReactFlowInstance,
  useEdgesState,
  addEdge
} from 'reactflow';
import dagre from 'dagre';
import { useAtom } from 'jotai';
import { gptTriplesAtom, recommendationsAtom, backendDataAtom } from '../lib/state.ts';
import { /* fetchBackendData, */ highLevelNodes, colorForCategory, normalizeCategory } from '../lib/utils.tsx';

import FlowComponent from './vis-flow/index.tsx';
import { Button } from './ui/button.tsx';
import { IconRefresh, IconStop } from './ui/icons.tsx';
import 'reactflow/dist/style.css'

// ---------- Phase switches ----------
const ENABLE_VERIFY = true;
const ENABLE_RECOMMEND = false;
// -----------------------------------
// ---- Search scope (default PubMed-only top 5) ----
type SearchScope = 'pubmed';
const SEARCH_TOP_N = 5;

// Simple positive/negative cue phrases for rule-based labeling
const POS_CUES = [
  'associated with a reduction',
  'reduces', 'decreases', 'improves', 'beneficial',
  'protective', 'lower risk', 'improved outcomes',
  'positively associated', 'effective', 'efficacy'
];
const NEG_CUES = [
  'no association', 'not associated', 'does not', 'did not',
  'no significant', 'insignificant', 'null finding',
  'increases', 'worsens', 'harmful', 'adverse'
];

const dagreGraph = new dagre.graphlib.Graph();
dagreGraph.setDefaultEdgeLabel(() => ({}));
const nodeWidth = 172;
const nodeHeight = 86;

const getLayoutedElements = (
  nodes: CustomGraphNode[],
  edges: CustomGraphEdge[],
  direction = 'TB'
) => {
  const isHorizontal = direction === 'LR';
  dagreGraph.setGraph({ rankdir: direction,
                        ranksep: 120,
                        nodesep: 80,
                        edgesep: 30,
                        });

  nodes.forEach(node => {
    dagreGraph.setNode(node.id, { width: nodeWidth, height: nodeHeight });
  });
  edges.forEach(edge => {
    dagreGraph.setEdge(edge.source, edge.target);
  });
  dagre.layout(dagreGraph);

  const { minX, minY, maxX, maxY } = nodes.reduce(
    (acc, node) => {
      const nodeWithPosition = dagreGraph.node(node.id);
      const nodeMinX = nodeWithPosition.x - nodeWidth / 2;
      const nodeMinY = nodeWithPosition.y - nodeHeight / 2;
      const nodeMaxX = nodeWithPosition.x + nodeWidth / 2;
      const nodeMaxY = nodeWithPosition.y + nodeHeight / 2;
      return {
        minX: Math.min(acc.minX, nodeMinX),
        minY: Math.min(acc.minY, nodeMinY),
        maxX: Math.max(acc.maxX, nodeMaxX),
        maxY: Math.max(acc.maxY, nodeMaxY)
      };
    },
    { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }
  );

  const graphWidth = maxX - minX + nodeWidth;
  const graphHeight = maxY - minY + nodeHeight;
  const offsetX = (window.innerWidth - graphWidth) / 2;
  const offsetY = (window.innerHeight - graphHeight) / 2;

  nodes.forEach(node => {
    const nodeWithPosition = dagreGraph.node(node.id);
    node.targetPosition = isHorizontal ? Position.Left : Position.Top;
    node.sourcePosition = isHorizontal ? Position.Right : Position.Bottom;
    node.position = {
      x: nodeWithPosition.x - nodeWidth / 2 - offsetX,
      y: nodeWithPosition.y - nodeHeight / 2 - offsetY
    };
  });

  return { nodes, edges };
};

const updateStyle = (nodes: any[], edges: any[], activeStep: number) => {
  nodes.forEach(node => {
    const currentOpacity = node.step === activeStep ? 1 : 0.6;
    node.style = { ...node.style, opacity: currentOpacity };
  });
  edges.forEach(edge => {
    edge.style = {
      ...edge.style,
      opacity: edge.step === activeStep ? 1 : 0.4
    };
  });
  return { nodes, edges };
};

export interface ChatProps extends React.ComponentProps<'div'> {
  initialMessages?: Message[];
  id?: string;
}

// tiny helper to timestamp without changing the imported type
type Msg = Message & { createdAt?: string };
// --- Phase 3 helpers ---

// Safe localStorage read (handles raw or JSON'ed values)
const readLSString = (k: string): string | null => {
  const v = localStorage.getItem(k);
  if (v == null) return null;
  try { return JSON.parse(v); } catch { return v; }
};

// Build a compact query for a triple
const buildQuery = (head: string, rel: string, tail: string) => {
  return `${head} ${rel} ${tail}`;
};
// --- tiny text utils ---
const norm = (s?: string) => (s || '').toLowerCase();
const containsAll = (text: string, parts: string[]) =>
  parts.every(p => norm(text).includes(norm(p)));
// --- Add this helper (near embeddings) ---
const marginToProb = (m: number, alpha = 4) => 1 / (1 + Math.exp(-alpha * m)); // m = sPos - sNeg

const embeddingBinaryScore = async (
  apiKey: string,
  candidate: string,
  ePos: number[],
  eNeg: number[]
): Promise<{ label: 'support' | 'refute'; p: number }> => {
  const eCand = await embedText(apiKey, candidate);
  const sPos = cosine(eCand, ePos);
  const sNeg = cosine(eCand, eNeg);
  const probSupport = marginToProb(sPos - sNeg); // 0..1
  const label = probSupport >= 0.5 ? 'support' : 'refute';
  const p = label === 'support' ? probSupport : (1 - probSupport);
  return { label, p };
};

// --- (Optional) Embeddings fallback via OpenAI (small + cheap) ---
const embedText = async (apiKey: string, text: string): Promise<number[]> => {
  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'text-embedding-3-small',
      input: text.slice(0, 1200) // tighter cap for cost control
    })
  });
  if (!res.ok) throw new Error('Embedding failed');
  const j = await res.json();
  return j?.data?.[0]?.embedding ?? [];
};

const cosine = (a: number[], b: number[]) => {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    dot += a[i]*b[i]; na += a[i]*a[i]; nb += b[i]*b[i];
  }
  return (na && nb) ? dot / (Math.sqrt(na)*Math.sqrt(nb)) : 0;
};

// Make a short "canonical relation" sentence from the triple
const relationTemplate = (head: string, rel: string, tail: string) =>
  `${head} ${rel} ${tail}`;

// --- Rule-based first pass: Support / Refute / Neutral (neutral will be resolved later) ---
const ruleLabel = (text: string, head: string, rel: string, tail: string): 'support'|'refute'|'neutral' => {
  const t = norm(text);
  const h = norm(head), r = norm(rel), ta = norm(tail);

  // Must mention head & tail at minimum
  if (!(t.includes(h) && t.includes(ta))) return 'neutral';

  // Strong negation cues override
  if (NEG_CUES.some(c => t.includes(c))) return 'refute';

  // Positive cues
  if (POS_CUES.some(c => t.includes(c))) return 'support';

  // Heuristic: if relation verb appears near both entities
  if (t.includes(r)) return 'support';

  return 'neutral';
};

// ---------- NEW: Abstract helpers (cheap snip) ----------
const smartAbstract = (abs: string, head: string, rel: string, tail: string) => {
  try {
    const cues = [...POS_CUES, ...NEG_CUES, head.toLowerCase(), tail.toLowerCase(), rel.toLowerCase()];
    const sents = abs.split(/(?<=[.?!])\s+/).slice(0, 8); // small window
    const keep: number[] = [];
    for (let i = 0; i < Math.min(2, sents.length); i++) keep.push(i); // always first 1–2
    sents.forEach((s, i) => {
      const t = s.toLowerCase();
      if (cues.some(c => t.includes(c))) keep.push(i);
    });
    const joined = Array.from(new Set(keep)).sort((a,b)=>a-b).map(i => sents[i]).join(' ');
    return (joined || sents.slice(0, 2).join(' ')).slice(0, 800); // hard cap
  } catch { return abs.slice(0, 800); }
};

const extractPmidFromLink = (link?: string): string | null => {
  if (!link) return null;
  // pubmed.ncbi.nlm.nih.gov/PMID/...
  const m = link.match(/pubmed\.ncbi\.nlm\.nih\.gov\/(\d+)/i);
  return m?.[1] ?? null;
};

const fetchPubMedAbstract = async (pmid: string, timeoutMs = 3500): Promise<string | null> => {
  // Light HTML fetch; we’ll extract abstract text via regex (best-effort)
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`https://pubmed.ncbi.nlm.nih.gov/${pmid}/?format=abstract`, { signal: controller.signal });
    if (!res.ok) return null;
    const html = await res.text();
    // crude strip: inside <div class="abstract"> ... </div>
    const block = html.match(/<div[^>]*class="abstract"[^>]*>([\s\S]*?)<\/div>/i)?.[1]
               || html.match(/<div[^>]*id="abstract"[^>]*>([\s\S]*?)<\/div>/i)?.[1];
    if (!block) return null;
    const text = block
      .replace(/<[^>]+>/g, ' ')   // strip tags
      .replace(/\s+/g, ' ')       // collapse spaces
      .trim();
    return text || null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
};

type CseItem = { title?: string; link?: string; snippet?: string; abstract?: string };

// Enrich top-N items with short abstract snippets (best-effort, bounded)
const enrichItemsWithAbstracts = async (
  items: CseItem[],
  head: string, rel: string, tail: string
): Promise<CseItem[]> => {
  const MAX_ENRICH = Math.min(items.length, SEARCH_TOP_N);
  const targets = items.slice(0, MAX_ENRICH);
  const enriched = await Promise.all(targets.map(async (it) => {
    const pmid = extractPmidFromLink(it.link);
    if (!pmid) return it;
    const abs = await fetchPubMedAbstract(pmid);
    if (!abs) return it;
    return { ...it, abstract: smartAbstract(abs, head, rel, tail) };
  }));
  return enriched.concat(items.slice(MAX_ENRICH));
};

// --- Embedding fallback: force a binary decision (reusing hypotheses) ---
const embeddingBinaryLabel = async (
  apiKey: string,
  candidate: string,
  ePos: number[],
  eNeg: number[]
): Promise<'support'|'refute'> => {
  const eCand = await embedText(apiKey, candidate);
  const sPos = cosine(eCand, ePos);
  const sNeg = cosine(eCand, eNeg);
  return (sPos >= sNeg) ? 'support' : 'refute';
};

// Label a single CSE item using rules, with embedding fallback (binary only)
// Uses title + (abstract if available, else snippet) for embeddings
// Change return type and logic
const labelItem = async (
  item: CseItem,
  head: string,
  rel: string,
  tail: string,
  openaiKey: string | undefined,
  ePos?: number[],
  eNeg?: number[]
): Promise<{ label: 'support' | 'refute'; p?: number }> => {
  if (!openaiKey || !ePos || !eNeg) {
    // cannot embed → neutral fallback
    return { label: 'refute', p: 0.5 };
  }

  try {
    // Combine title + abstract/snippet as candidate text
    const candidate = `${item.title || ''}. ${item.abstract || item.snippet || ''}`.slice(0, 1200);
    const eCand = await embedText(openaiKey, candidate);

    const sPos = cosine(eCand, ePos);
    const sNeg = cosine(eCand, eNeg);

    // Normalize similarity → probability-like score
    const p = 1 / (1 + Math.exp(-(sPos - sNeg) * 8)); // sharpen sigmoid
    const label = p >= 0.5 ? 'support' : 'refute';
    return { label, p: Math.round(p * 100) }; // percent format
  } catch (err) {
    console.error('[labelItem] embedding failed:', err);
    return { label: 'refute', p: 50 };
  }
};



// Call Google Programmable Search for *top N* PubMed hits
const fetchCseTopN = async ({
  apiKey, cx, q, n = SEARCH_TOP_N
}: { apiKey: string; cx: string; q: string; n?: number }) => {
  const scopedQ = `(${q}) site:pubmed.ncbi.nlm.nih.gov`;

  const url = new URL('https://www.googleapis.com/customsearch/v1');
  url.searchParams.set('key', apiKey);
  url.searchParams.set('cx', cx);
  url.searchParams.set('q', scopedQ);
  url.searchParams.set('num', String(Math.min(Math.max(n,1),10)));

  const res = await fetch(url.toString());
  if (!res.ok) {
    const txt = await res.text().catch(()=> '');
    throw new Error(`CSE error ${res.status}: ${txt}`);
  }
  const data = await res.json();
  const items = Array.isArray(data?.items) ? data.items : [];
  return { items };
};


// Normalize a relation label in the graph (we stored the human text in label)
const getEdgeRelationBase = (e: any) => {
  return (e.data && (e.data as any).relation) ? (e.data as any).relation : (e.label as string);
};

export function Chat({ id, initialMessages }: ChatProps) {
  const lastEntityCategoriesRef = useRef<Record<string, string>>({});
  const reloadFlag = useRef(false);
  const initialRender = useRef(true);
  const sentForVerification = useRef<Set<string>>(new Set());
  const aborterRef = useRef<AbortController | null>(null);

  const [previewToken, setPreviewToken] = useLocalStorage<string | null>('ai-token', null);
  const [serperToken, setSerperToken] = useLocalStorage<string | null>('serper-token', null);
  const [previewTokenDialog, setPreviewTokenDialog] = useState(false);
  const [searchScope] = useLocalStorage<SearchScope>('search-scope', 'pubmed');
  const navigate = useNavigate();
  const location = useLocation();

  const [recommendations] = useAtom(recommendationsAtom);
  const recommendationMaxLen = useRef(0);

  const [reactFlowInstance, setReactFlowInstance] =
    useState<ReactFlowInstance | null>(null);

  const [gptTriples, setGptTriples] = useAtom(gptTriplesAtom);
  const gptTriplesRef = useRef(gptTriples);
  const [, setBackendData] = useAtom(backendDataAtom);
  const [isLoadingBackendData, setIsLoadingBackendData] = useState(true);

  const [messages, setMessages] = useState<Msg[]>(initialMessages as Msg[] ?? []);
  const [input, setInput] = useState<string>('');
  const [isLoading, setIsLoading] = useState<boolean>(false);

  const entityPattern = /\[([^\]\|]+)(?:\|([^\]]+))?\]\(\$N(\d+)\)/g;
  // ✅ Fixed: removed the extra `)` before the final `\)`
  const relationPattern = /\[([^\]]+)\]\((\$R\d+), (.+?)\)/g;
  // Collect top-5 deduped evidence for each node from the current edges
  const aggregateEvidenceForNodes = (nodesArr: any[], edgesArr: any[]) => {
    const byNode: Record<string, any[]> = {};

    edgesArr.forEach(e => {
      const rel = (e.data && e.data.relation) || e.label || '';
      const srcs = (e.data && e.data.sources) || [];
      const decorate = (nodeId: string, direction: 'in' | 'out') => {
        if (!byNode[nodeId]) byNode[nodeId] = [];
        byNode[nodeId].push(
          ...srcs.map((s: any) => ({
            relation: rel,
            direction,
            title: s?.title,
            link: s?.link,
            snippet: s?.snippet,
            label: s?.label
          }))
        );
      };
      decorate(e.source, 'out');
      decorate(e.target, 'in');
    });

    // de-dupe by link + cap at 5
    const dedupe = (arr: any[]) => {
      const seen = new Set<string>();
      const out: any[] = [];
      for (const x of arr) {
        const key = x.link || x.title || JSON.stringify(x);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(x);
        if (out.length >= 5) break;
      }
      return out;
    };

    return nodesArr.map(n => ({
      ...n,
      data: {
        ...n.data,
        sources: dedupe(byNode[n.id] || [])
      }
    }));
  };

  const extractRelations = (text: string): {
    relations: Array<[string, string, string]>,
    entityCategories: Record<string, string>
  } => {
    let entityMatch: RegExpExecArray | null;
    const entitiesByCode: Record<string, { name: string, category?: string }> = {};
    const entityCategoriesByName: Record<string, string> = {};

    while ((entityMatch = entityPattern.exec(text)) !== null) {
      const [, name, category, code] = entityMatch;
      const ncode = `$N${code}`;
      entitiesByCode[ncode] = { name, category: category?.trim() };
      if (category) entityCategoriesByName[name] = category.trim();
    }

    let relationMatch: RegExpExecArray | null;
    const outputRelations: Array<[string, string, string]> = [];
    while ((relationMatch = relationPattern.exec(text)) !== null) {
      const [, relationName, _relationCode, relationDetails] = relationMatch;
      const details = relationDetails.split(';');
      details.forEach(detail => {
        const codes = detail.trim().split(', ').map(s => s.trim());
        if (codes.every(c => entitiesByCode[c]?.name)) {
          const e1 = entitiesByCode[codes[0]].name;
          const e2 = entitiesByCode[codes[1]].name;
          outputRelations.push([e1, relationName, e2]);
        }
      });
    }
    if (typeof window !== 'undefined') {
      (window as any).__kn_lastEntityCategories = entityCategoriesByName;
    }
    return { relations: outputRelations, entityCategories: entityCategoriesByName };
  };

  // ===== Streaming OpenAI call =====
  const callOpenAIStream = async (
    allMessages: Message[],
    apiKey: string,
    onFirstToken: () => void,
    onDelta: (deltaText: string) => void
  ) => {
    const qaPrompt = `
You are an expert in healthcare and dietary supplements and need to help users answer related questions.
Please return your response in a format where all entities and their relations are clearly defined in the response.
Specifically, use [] to identify all entities and relations in the response,
add () after identified entities and relations to assign unique ids to entities ($N1, $N2, ..) and relations ($R1, $R2, ...).
When annotating an entity, append its category before the ID, separated by a vertical bar "|". The category must be one of: Dietary Supplement, Drugs, Disease, Symptom, Gene. For example: [Fish Oil|Dietary Supplement]($N1), [Alzheimer's disease|Disease]($N2).
For the relation, also add the entities it connects to. Use ; to separate if this relation exists in more than one triple.
The entities can only be the following types: Dietary Supplement, Drugs, Disease, Symptom and Gene.
Each sentence in the response must include a clearly defined relation between entities, and this relation must be annotated.
Identified entities must have relations with other entities in the response.
Each sentence in the response should not include more than one relation.
When answering a question, focus on identifying and annotating only the entities and relations that are directly relevant to the user's query. Avoid including additional entities that are not closely related to the core question.
Try to provide context in your response.
Relations must be a single, meaningful verb that expresses a biomedical connection (e.g., "prevent", "reduce", "increase", "support", "cause", "treat", "improve", "protect"). Do not use vague or nonsensical words like "thought", "studied", or "related". Only choose from this style of clear biomedical verbs.

After your response, also add the identified entities in the user question, in the format of a JSON string list;
Please use " || " to split the two parts.

Example 1,
if the question is "Can Ginkgo biloba prevent Alzheimer's Disease?"
Your response could be:
"Gingko biloba is a plant extract...
Some studies have suggested that [Gingko biloba]($N1) may [improve]($R1, $N1, $N2) cognitive function and behavior in people with [Alzheimer's disease]($N2)... ||
["Ginkgo biloba", "Alzheimer's Disease"]"

Example 2,
If the question is "What are the benefits of fish oil?"
Your response could be:
"[Fish oil]($N1) is known for its [rich content of]($R1, $N1, $N2) [Omega-3 fatty acids]($N2)... The benefits of [Fish Oil]($N1): [Fish Oil]($N1) can [reduce]($R2, $N1, $N3) the risk of [cognitive decline]($N3).
[Fight]($R3, $N2, $N4) [Inflammation]($N4): [Omega-3 fatty acids]($N2) has potent... || ["Fish Oil", "Omega-3 fatty acids", "cognitive decline", "Inflammation"]"

Example 3,
If the question is "Can Coenzyme Q10 prevent Heart disease?"
Your response could be:
"Some studies have suggested that [Coenzyme Q10]($N1) supplementation may [have potential benefits]($R1, $N1, $N2) for [heart health]($N2)... [Coenzyme Q10]($N1) [has]($R2, $N1, $N2) [antioxidant properties]($N2)... ||
["Coenzyme Q10", "heart health", "antioxidant", "Heart disease"]"

Example 4,
If the question is "Can taking Choerospondias axillaris slow the progression of Alzheimer's disease?"
Your response could be:
"
[Choerospondias axillaris]($N1), also known as Nepali hog plum, is a fruit that is used in traditional medicine in some Asian countries. It is believed to have various health benefits due to its [antioxidant]($N2) properties. However, there is limited scientific research on its effects on [Alzheimer's disease]($N3) specifically.

Some studies have suggested that [antioxidant]($N2) can help [reduce]($R1, $N2, $N3) oxidative stress, which is a factor in the development and progression of [Alzheimer's disease]($N3). Therefore, it is possible that the antioxidant properties of Choerospondias axillaris might have some protective effects against the disease. However, more research is needed to determine its efficacy and the appropriate dosage.  ||
["Choerospondias axillaris", "antioxidant", "Alzheimer's disease"]"

Example 5,
If the question is "What Complementary and Integrative Health Interventions are beneficial for people with Alzheimer's disease?"
Your response could be:
"Some Complementary and Integrative Health Interventions have been explored for their potential benefits in individuals with [Alzheimer's disease]($N1).

[Mind-body practices]($N2), such as yoga and meditation, are examples of interventions that may [improve]($R1, $N2, $N1) cognitive function and quality of life in people with [Alzheimer's disease]($N1). These practices can help reduce stress and improve emotional well-being.

Dietary supplements, including [omega-3 fatty acids]($N3) and [vitamin E]($N4), have been studied for their potential to [slow]($R2, $N3, $N2; $R3, $N4, $N2) cognitive decline in [Alzheimer's disease]($N2). [Omega-3 fatty acids]($N3) are known for their anti-inflammatory and neuroprotective properties, while [vitamin E]($N4) is an antioxidant that may [protect]($R3, $N4, $N5) [neurons]($N5) from damage.

[Aromatherapy]($N6) using essential oils, such as lavender, has been suggested to [help]($R4, $N6, $N1) with anxiety and improve sleep quality in individuals with [Alzheimer's disease]($N1).
|| ["Alzheimer's disease", "Mind-body practices", "omega-3 fatty acids", "vitamin E", "Aromatherapy"]"

Use the above examples only as a guide for format and structure. Do not reuse their exact wording. Always generate a unique, original response that follows the annotated format.
`;

    const openaiMessages = [
      { role: 'assistant', content: qaPrompt },
      ...allMessages.map(m => ({ role: m.role, content: m.content }))
    ];

    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: openaiMessages,
        temperature: 1,
        stream: true
      }),
      signal: aborterRef.current?.signal
    });

    if (!res.ok || !res.body) {
      const txt = await res.text().catch(()=> '');
      throw new Error(txt || `OpenAI error ${res.status}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let first = true;

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });

      for (const line of chunk.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data:')) continue;
        const dataStr = trimmed.slice(5).trim();
        if (dataStr === '[DONE]') continue;

        try {
          const json = JSON.parse(dataStr);
          const delta = json?.choices?.[0]?.delta?.content ?? '';
          if (delta) {
            if (first) { onFirstToken(); first = false; }
            onDelta(delta);
          }
        } catch {
          // ignore partial JSON frames
        }
      }
    }
  };

  // ===== append() with streaming =====
  const append = async (msg: Partial<Message> | string) => {
    const userContent = typeof msg === 'string' ? msg : (msg.content || '');
    if (!userContent.trim()) return;

    // push user message (with createdAt)
    const userMsg: Msg = {
      id: crypto.randomUUID(),
      role: 'user',
      content: userContent,
      createdAt: new Date().toISOString()
    };
    setMessages(prev => [...prev, userMsg]);
    setInput('');

    // key
    const apiKey = previewToken || (() => {
      try { return JSON.parse(localStorage.getItem('ai-token') || 'null'); } catch { return localStorage.getItem('ai-token'); }
    })();
    if (!apiKey) {
      toast.error('Missing OpenAI API key');
      return;
    }

    // assistant placeholder (with createdAt)
    const assistantMsgId = crypto.randomUUID();
    const assistantPlaceholder: Msg = {
      id: assistantMsgId,
      role: 'assistant',
      content: '',
      createdAt: new Date().toISOString()
    };
    setMessages(prev => [...prev, assistantPlaceholder]);

    // compute the current pair index (0-based)
    const pairIndex = Math.floor(([...messages, userMsg, assistantPlaceholder].length) / 2) - 1;

    try {
      setIsLoading(true);
      aborterRef.current = new AbortController();
      let buffered = '';

      await callOpenAIStream(
        [...messages, userMsg],
        apiKey as string,
        // onFirstToken — set to the computed pair index (do NOT +1)
        () => {
          setActiveStep(pairIndex);
          if (!location.pathname.includes('chat')) {
            navigate(`/chat/${id}`, { replace: true });
          }
        },
        // onDelta
        (delta) => {
          buffered += delta;
          // replace assistant msg immutably so memoized children update
          setMessages(prev =>
            prev.map(m =>
              m.id === assistantMsgId
                ? { ...m, content: (m.content || '') + delta }
                : m
            )
          );
        }
      );

      // final parse
      const parts = (buffered || '').split('||');
      const { relations: triples, entityCategories } = extractRelations(parts[0] || '');
      if (triples?.length) setGptTriples(triples);
      lastEntityCategoriesRef.current = entityCategories;

    } catch (err: any) {
      if (err?.name === 'AbortError') {
        console.warn('[chat] aborted');
      } else {
        console.error(err);
        toast.error('OpenAI request failed. Check your key and network.');
      }
    } finally {
      setIsLoading(false);
      aborterRef.current = null;
    }
  };

  const stop = () => {
    aborterRef.current?.abort();
  };

  const reload = async () => {
    const lastUser = [...messages].reverse().find(m => m.role === 'user');
    if (lastUser) {
      await append({ role: 'user', content: lastUser.content });
    }
  };

  useEffect(() => {
    gptTriplesRef.current = gptTriples;
  }, [gptTriples]);

  useEffect(() => {
    if (initialRender.current) {
      const tokenSet = localStorage.getItem('has-token-been-set') === 'true';
      setPreviewTokenDialog(!tokenSet || !previewToken || !serperToken);
      initialRender.current = false;
    }
  }, [previewToken, serperToken]);

  const seenTriples = useRef<Set<string>>(new Set());
  useEffect(() => {
    const latestAssistantMsg = [...messages].reverse().find(m => m.role === 'assistant');
    if (!latestAssistantMsg) return;
    const parts = (latestAssistantMsg.content || '').split('||');
    const { relations: triples, entityCategories } = extractRelations(parts[0] || '');

    const newTriples = triples.filter(triple => {
      const key = triple.join('|');
      return !seenTriples.current.has(key);
    });

    if (newTriples.length > 0) {
      lastEntityCategoriesRef.current = {
        ...lastEntityCategoriesRef.current,
        ...entityCategories
      };
      newTriples.forEach(t => seenTriples.current.add(t.join('|')));
      setGptTriples(prev => [...prev, ...newTriples]);
    }
  }, [messages, setGptTriples]);

  const convertBackendDataToFlowElements = (
    data: BackendData["data"],
    currentStep: number
  ) => {
    const nodes: CustomGraphNode[] = [];
    const edges: CustomGraphEdge[] = [];
    setIsLoadingBackendData(false);
    return { nodes, edges };
  };

  const convertGptDataToFlowElements = (
    data: string[][],
    currentStep: number,
    entityCategories: Record<string, string>
  ) => {
    const nodes: CustomGraphNode[] = [];
    const edges: CustomGraphEdge[] = [];
    const nodeIds = new Set();
    const edgeIds = new Set();

    if (!data) return { nodes, edges };

    data.forEach(([subject, predicate, object], index) => {
      const subjectId = `node-${subject}`;
      const objectId = `node-${object}`;

      if (!nodeIds.has(subjectId)) {
        const subjectCategoryRaw = entityCategories[subject] ?? "Objects";
        const normSubjectCat = normalizeCategory(subject, subjectCategoryRaw);
        const subjectBg = colorForCategory(normSubjectCat, subject);
        nodes.push({
          id: subjectId,
          data: { label: subject, animationOrder: index, bgColor: subjectBg },
          position: { x: 0, y: 0 },
          style: { opacity: 1, background: subjectBg, borderRadius: '5px' },
          type: 'custom',
          step: currentStep,
          category: normSubjectCat
        });
        nodeIds.add(subjectId);
      }

      if (!nodeIds.has(objectId)) {
        const objectCategoryRaw = entityCategories[object] ?? "Objects";
        const normObjectCat = normalizeCategory(object, objectCategoryRaw);
        const objectBg = colorForCategory(normObjectCat, object);
        nodes.push({
          id: objectId,
          data: { label: object, animationOrder: index + 0.5, bgColor: objectBg },
          position: { x: 0, y: 0 },
          style: { opacity: 1, background: objectBg, borderRadius: '5px' },
          type: 'custom',
          step: currentStep,
          category: normObjectCat
        });
        nodeIds.add(objectId);
      }

      const edgeId = `edge-${subject}-${object}`;
      if (!edgeIds.has(edgeId)) {
        edges.push({
          id: edgeId,
          source: subjectId,
          target: objectId,
          label: predicate,
          type: 'custom',
          style: { stroke: 'black', opacity: 1 },
          step: currentStep
        });
        edgeIds.add(edgeId);
      }
    });

    setIsLoadingBackendData(false);
    return { nodes, edges };
  };

  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [layoutDirection, setLayoutDirection] = useState('TB');
  const [activeStep, setActiveStep] = useState(0);

  const updateLayout = useCallback(
    (direction = layoutDirection) => {
      const { nodes: layoutedNodes, edges: layoutedEdges } =
        getLayoutedElements(nodes as CustomGraphNode[], edges as CustomGraphEdge[], direction);
      setNodes(layoutedNodes);
      setEdges(layoutedEdges);
      if (reactFlowInstance) {
        reactFlowInstance.fitView({ duration: 300, padding: 0.2 });
      }
    },
    [nodes, edges, setNodes, setEdges, layoutDirection, reactFlowInstance]
  );

  useEffect(() => { updateLayout(); }, [reactFlowInstance, nodes, edges]); // eslint-disable-line

  useEffect(() => {
    const { nodes: layoutedNodes, edges: layoutedEdges } = updateStyle(nodes, edges, activeStep);
    setNodes(layoutedNodes);
    setEdges(layoutedEdges);
  }, [activeStep]); // eslint-disable-line

  const appendDataToFlow1 = useCallback(
    (newData: string[][], currentStep: number, entityCategories: Record<string, string>) => {
      const { nodes: newNodes, edges: newEdges } =
        convertGptDataToFlowElements(newData, currentStep, entityCategories);

      const isUpgrade = (oldCat?: string, newCat?: string, oldBg?: string) => {
        const oldIsObjects = !oldCat || oldCat === 'Objects';
        const newIsObjects = !newCat || newCat === 'Objects';
        const oldIsGrayish = !oldBg || oldBg === '#e5e7eb' || oldBg === '#dddddd';
        return (oldIsObjects && !newIsObjects) || (!newIsObjects && newCat !== oldCat) || oldIsGrayish;
      };

      setNodes(currentNodes => {
        const byId = new Map<string, CustomGraphNode>(currentNodes.map(n => [n.id, n]));
        newNodes.forEach(nn => {
          const existing = byId.get(nn.id);
          if (!existing) {
            byId.set(nn.id, {
              ...nn,
              position: { x: Math.random() * 400, y: Math.random() * 400 },
              step: currentStep
            });
          } else {
            const oldCat = existing.category;
            const oldBg = existing.data?.bgColor as string | undefined;
            const newCat = nn.category;
            if (isUpgrade(oldCat, newCat, oldBg)) {
              const newBg = colorForCategory(newCat, nn.data?.label as string | undefined);
              byId.set(nn.id, {
                ...existing,
                category: newCat,
                data: { ...existing.data, bgColor: newBg, label: existing.data?.label ?? nn.data?.label },
                style: { ...existing.style, background: newBg }
              });
            } else {
              byId.set(nn.id, { ...existing, step: currentStep });
            }
          }
        });

        const filtered = Array.from(byId.values()).filter(node => {
          const label = (node.data?.label || '').toLowerCase();
          return !highLevelNodes.some(d => label.includes(d));
        });

        return filtered;
      });

      setEdges(currentEdges => {
        const updatedEdges = [...currentEdges];
        newEdges.forEach(newEdge => {
          const edgeS = newEdge.source.substring(5);
          const edgeT = newEdge.target.substring(5);
          const edgeId = `edge-${edgeS}-${edgeT}`;
          if (!updatedEdges.find(e => e.id === edgeId)) {
            updatedEdges.push({ ...newEdge, step: currentStep });
          }
        });
        return updatedEdges;
      });
    },
    [setNodes, setEdges]
  );

  useEffect(() => {
    if (gptTriples) {
      appendDataToFlow1(gptTriples, activeStep, lastEntityCategoriesRef.current);
    }
  }, [gptTriples, appendDataToFlow1, activeStep]);

  useEffect(() => {
    if (!ENABLE_VERIFY) return;
  }, [gptTriples]);

  useEffect(() => {
    const handleResize = () => { updateLayout(); };
    window.addEventListener('resize', handleResize);
    return () => { window.removeEventListener('resize', handleResize); };
  }, [updateLayout]);

  const handleConnect = useCallback((params: any) => {
    setEdges((eds) => addEdge(params, eds));
  }, [setEdges]);

  // clamp activeStep so chat never vanishes if something drifts
  useEffect(() => {
    setActiveStep(s => Math.min(s, Math.max(0, Math.floor(messages.length / 2) - 1)));
  }, [messages.length]);

  const [clickedNode, setClickedNode] = useState<any>(null);
  const [activeNodeRecs, setActiveNodeRecs] = useState<any[]>([]);

  const evidenceForClickedNode = useMemo(() => {
    if (!clickedNode) return [];

    const nodeId = clickedNode.id ?? '';
    // find incident edges
    const incident = edges.filter(e => e.source === nodeId || e.target === nodeId);

    // collect labeled sources from each edge (added in verification useEffect)
    const all = incident.flatMap(e => {
      const rel = (e.data && (e.data as any).relation) || e.label || '';
      const sources = (e.data && (e.data as any).sources) || [];
      // decorate each item with relation + which side of edge the node is
      return sources.map((s: any) => ({
        relation: rel,
        direction: e.source === nodeId ? 'out' : 'in',
        title: s?.title,
        link: s?.link,
        snippet: s?.snippet,
        label: s?.label // 'support' | 'refute'
      }));
    });

    // de-dupe by link, keep order
    const seen = new Set<string>();
    const deduped = all.filter(x => {
      if (!x.link) return true;
      if (seen.has(x.link)) return false;
      seen.add(x.link);
      return true;
    });

    return deduped.slice(0, 5);
  }, [clickedNode, edges]);

  useEffect(() => {
    if (!ENABLE_RECOMMEND) { setActiveNodeRecs([]); return; }
    if (!clickedNode) { setActiveNodeRecs([]); return; }
  }, [clickedNode]);
  // --- Phase 3: verify edges with PubMed top-5 + semantic labels (binary) + abstract enrichment ---
useEffect(() => {
  if (!ENABLE_VERIFY) return;
  if (!edges.length) return;

  // keys
  const googleKey = readLSString('serper-token');   // Google CSE key
  const cx        = readLSString('google-cx');      // your CSE id
  if (!googleKey || !cx) {
    console.warn('[verify] Missing google key or cx');
    return;
  }

  // Only verify edges that don't already have a semantic tally
  const unverified = edges.filter(e => {
    const known = (e.data && (e.data as any).semantic);
    return !known;
  });
  if (!unverified.length) return;

  const BATCH = 6; // keep UI snappy
  const todo = unverified.slice(0, BATCH);

  let cancelled = false;

  (async () => {
    try {
      const results = await Promise.all(todo.map(async (e) => {
        const head = String(e.source).replace(/^node-/, '');
        const tail = String(e.target).replace(/^node-/, '');
        const rel  = getEdgeRelationBase(e);
        const q    = buildQuery(head, rel, tail);

        try {
          // 1) PubMed-only top N via CSE
          const { items } = await fetchCseTopN({ apiKey: googleKey!, cx, q, n: SEARCH_TOP_N });

          // 2) (NEW) Best-effort abstract enrichment for better semantics
          const enriched = await enrichItemsWithAbstracts(items, head, rel, tail);

          // 3) Label each item (rules → optional embeddings)
          const openaiKey = readLSString('ai-token') || undefined; // optional; only if rules inconclusive

          // Precompute hypotheses ONCE per edge if we will embed
          let ePos: number[] | undefined;
          let eNeg: number[] | undefined;
          if (openaiKey) {
            const queryPos = relationTemplate(head, rel, tail);
            const queryNeg = `${head} not ${rel} ${tail}`;
            [ePos, eNeg] = await Promise.all([
              embedText(openaiKey, queryPos),
              embedText(openaiKey, queryNeg)
            ]);
          }

          // labels now: Array<{label, p?}>
          const labels = await Promise.all(
            enriched.map(it => labelItem(it, head, rel, tail, openaiKey as string | undefined, ePos, eNeg))
          );

          // Tally with labels[i].label
          const support = labels.filter(x => x.label === 'support').length;
          const refute  = labels.filter(x => x.label === 'refute').length;

          // Attach per-source p
          const sources = enriched.map((it, idx) => ({
            title: it?.title,
            link: it?.link,
            snippet: it?.snippet,
            label: labels[idx].label,   // 'support' | 'refute'
            p: labels[idx].p            // number | undefined
          }));


          return { id: e.id, support, refute, sources, rel };
        } catch (err) {
          console.error('[verify] PubMed top-N failed for', q, err);
          return { id: e.id, support: 0, refute: 0, sources: [], rel };
        }
      }));

      if (cancelled) return;

      // 5) Paint semantic tallies into the graph
      setEdges(prev => {
        const nextEdges = prev.map(e => {
          const r = results.find(x => x.id === e.id);
          if (!r) return e;

          const baseRel = getEdgeRelationBase(e);
          const newLabel = `${baseRel} | S:${r.support} R:${r.refute}`;

          const style = { ...(e.style || {}) };
          if (r.support === 0 && r.refute > 0) {
            style.strokeDasharray = '4 4';
            style.opacity = 0.9;
          } else if (r.support === 0 && r.refute === 0) {
            // No hits at all — dim the edge slightly
            style.opacity = 0.6;
          } else {
            delete (style as any).strokeDasharray;
            style.opacity = 1;
          }

          const data = {
            ...(e.data || {}),
            relation: baseRel,
            verificationCount: r.support,
            semantic: { support: r.support, refute: r.refute }, // binary only
            sources: r.sources
          };

          return {
            ...e,
            label: newLabel,
            data,
            style,
            labelStyle: { fontSize: 10, lineHeight: '1' },
            labelBgStyle: { fill: 'rgba(255,255,255,0.85)' },
            labelBgPadding: [2, 3],
            labelBgBorderRadius: 4,
          };
        });

        // ⬇️ propagate edge evidence onto nodes so CustomNode sees data.sources
        setNodes(oldNodes => aggregateEvidenceForNodes(oldNodes, nextEdges));

        return nextEdges;
      });

    } catch (err) {
      console.error('[verify] batch failed', err);
    }
  })();

  return () => { cancelled = true; };
}, [edges, setEdges]);


  const StopRegenerateButton = isLoading ? (
    <Button variant="outline" onClick={() => stop()} className="relative left-[60%]">
      <IconStop className="mr-2" /> Stop
    </Button>
  ) : (
    <Button
      variant="outline"
      onClick={() => {
        reloadFlag.current = true;
        reload();
      }}
      className="relative left-[60%]"
    >
      <IconRefresh className="mr-2" /> Regenerate
    </Button>
  );

  const r = 18,
        c = Math.PI * (r * 2),
        val = (recommendations.length - 1) / recommendationMaxLen.current,
        pct = val * c;

  const circleProgress =
    recommendationMaxLen.current > 0 && recommendations.length >= 0 ? (
      <svg id="svg" width="40" height="40">
        <g transform={`rotate(-90 20 20)`}>
          <circle r={r} cx="20" cy="20" fill="transparent" strokeDasharray={c} strokeDashoffset="0" stroke="#aaa" strokeWidth="5px"></circle>
          <circle id="bar" r={r} cx="20" cy="20" fill="transparent" strokeDasharray={c} strokeDashoffset={pct} stroke="#111" strokeWidth="5px"></circle>
        </g>
        <text x="50%" y="50%" textAnchor="middle" fontSize="12px" dy=".3em">
          {recommendationMaxLen.current - recommendations.length + 1}/{recommendationMaxLen.current}
        </text>
      </svg>
    ) : null;

  return (
    <div className="max-w-[100vw] rounded-lg border bg-background p-4">
      {messages.length ? (
        <>
          {/* GRID: [chat | graph] */}
          <div className="pt-4 md:pt-10 md:grid md:grid-cols-[2fr_3fr] gap-4">
            {/* LEFT: chat list */}
            <div className="overflow-auto min-w-0">
              <ViewModeProvider>
                <ChatList
                  key={messages.map(m => m.id).join('|')}  // force rerender on stream
                  messages={messages as Message[]}
                  activeStep={activeStep}
                  nodes={nodes}
                  edges={edges}
                  clickedNode={clickedNode}
                />
              </ViewModeProvider>
              {activeStep === Math.floor(messages.length / 2) - 1 && StopRegenerateButton}
              <ChatScrollAnchor trackVisibility={isLoading} />
            </div>

            {/* MIDDLE: graph */}
            <div className="min-w-0">
              <ReactFlowProvider>
                <FlowComponent
                  nodes={nodes}
                  edges={edges}
                  onNodesChange={onNodesChange}
                  onEdgesChange={onEdgesChange}
                  proOptions={{ hideAttribution: true }}
                  onConnect={handleConnect}
                  onInit={setReactFlowInstance}
                  setClickedNode={setClickedNode}
                  updateLayout={updateLayout}
                  setLayoutDirection={setLayoutDirection}
                  isLoading={isLoading}
                  isLoadingBackendData={isLoadingBackendData}
                  id={id}
                  append={append}
                  activeStep={activeStep}
                  clickedNode={clickedNode}
                  evidence = {evidenceForClickedNode}
                />
              </ReactFlowProvider>
            </div>
          </div>

          <div className="flex justify-center items-center pt-3">
            <Slider
              messages={messages as Message[]}
              steps={Math.floor(messages.length / 2)}
              activeStep={activeStep}
              handleNext={() => setActiveStep(Math.min(activeStep + 1, nodes.length - 1))}
              handleBack={() => setActiveStep(Math.max(activeStep - 1, 0))}
              jumpToStep={setActiveStep}
            />
            {circleProgress}
          </div>
        </>
      ) : (
        <EmptyScreen
          setInput={setInput}
          id={id!}
          append={append}
          setApiKey={(k: string) => {
            setPreviewToken(k);
            localStorage.setItem('has-token-been-set', 'true');
          }}
          setSerperKey={(s: string) => {
            setSerperToken(s);
            localStorage.setItem('has-token-been-set', 'true');
          }}
          initialOpen={!previewToken || !serperToken}
        />
      )}

      {/* Bottom Chat Panel */}
      <ChatPanel
        id={id}
        isLoading={isLoading}
        stop={stop}
        append={append}
        reload={reload}
        messages={messages as Message[]}
        input={input}
        setInput={setInput}
        recommendations={[]}
        clickedLabel={
          clickedNode?.data?.label ||
          String(clickedNode?.id || '').replace(/^node-/, '') ||
          ''
        }
      />
    </div>
  );
}
