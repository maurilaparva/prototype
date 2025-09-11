'use Client'
import { ChatPanel } from './chat-panel.tsx';
// import { useChat } from 'ai/react';
import { useLocalStorage } from '../lib/hooks/use-local-storage.ts';
import { toast } from 'react-hot-toast';
import { type Message } from 'ai/react';
import React, { useState, useRef, useEffect, useCallback } from 'react';
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
const ENABLE_VERIFY = false;
const ENABLE_RECOMMEND = false;
// -----------------------------------

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
  dagreGraph.setGraph({ rankdir: direction });

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

export function Chat({ id, initialMessages }: ChatProps) {
  const lastEntityCategoriesRef = useRef<Record<string, string>>({});
  const reloadFlag = useRef(false);
  const initialRender = useRef(true);
  const sentForVerification = useRef<Set<string>>(new Set());
  const aborterRef = useRef<AbortController | null>(null);

  const [previewToken, setPreviewToken] = useLocalStorage<string | null>('ai-token', null);
  const [serperToken, setSerperToken] = useLocalStorage<string | null>('serper-token', null);
  const [previewTokenDialog, setPreviewTokenDialog] = useState(false);
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
      const txt = await res.text().catch(()=>'');
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

  useEffect(() => {
    if (!ENABLE_RECOMMEND) { setActiveNodeRecs([]); return; }
    if (!clickedNode) { setActiveNodeRecs([]); return; }
  }, [clickedNode]);

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
