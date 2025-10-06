import { EdgeLabelRenderer, EdgeProps } from "reactflow";
import { FC, useState, useMemo } from "react";
import { getBezierPath } from "reactflow";
import { Popover, PopoverHandler, PopoverContent } from "@material-tailwind/react";
import { motion } from "framer-motion";

type EvidenceItem = {
  title?: string;
  link?: string;
  snippet?: string;
  label?: "support" | "refute" | "neutral";
  relation?: string;
  direction?: "in" | "out";
  p?: number; // ← per-source probability (0..1), if available
};

const dotClass = (label?: string) => {
  switch (label) {
    case "support": return "bg-emerald-500";
    case "refute":  return "bg-rose-500";
    default:        return "bg-zinc-400";
  }
};
const badgeClass = (label?: string) => {
  switch (label) {
    case "support": return "border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100";
    case "refute":  return "border-rose-200 bg-rose-50 text-rose-700 hover:bg-rose-100";
    default:        return "border-zinc-200 bg-zinc-50 text-zinc-700 hover:bg-zinc-100";
  }
};

// Colored S/R prefix to match edge palette (teal/amber)
const Prefix = ({ label }: { label?: "support" | "refute" | "neutral" }) => {
  if (label === "support") return <span className="font-semibold text-teal-600">S:&nbsp;</span>;
  if (label === "refute")  return <span className="font-semibold text-amber-600">R:&nbsp;</span>;
  return <span className="font-semibold text-zinc-500">N:&nbsp;</span>;
};

const CustomEdge: FC<EdgeProps> = ({
  sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition,
  style, data, label, id, markerEnd
}) => {
  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition
  });

  // Tallies from your verify step
  const { S, R } = useMemo(() => {
    const sem = (data as any)?.semantic || {};
    let support = sem.support ?? 0;
    let refute  = sem.refute  ?? 0;

    if ((support + refute) === 0 && Array.isArray((data as any)?.sources)) {
      const arr: EvidenceItem[] = (data as any).sources;
      support = arr.filter(s => s.label === "support").length;
      refute  = arr.filter(s => s.label === "refute").length;
    }
    return { S: support, R: refute };
  }, [data]);

  // Binary winner
  const winner: "support" | "refute" = S >= R ? "support" : "refute";
  const total = S + R;
  const conf = total > 0 ? Math.max(S, R) / total : 0.5;

  // --- TWO VISUAL MODES ---
  const mode: "patternColor" | "iconOnly" = (data as any)?.styleMode ?? "patternColor";

  // Mode 1: muted color + pattern
  const color_support = "#14b8a6"; // teal-500
  const color_refute  = "#f59e0b"; // amber-500
  // Mode 4: neutral edge (slate)
  const color_neutral = "#94a3b8"; // slate-400

  // Stroke config per mode
  const strokeColor =
    mode === "patternColor"
      ? (winner === "support" ? color_support : color_refute)
      : color_neutral;

  // pattern: solid for support, dashed for refute (both modes)
  const dash = winner === "refute" ? "6 4" : undefined;

  // Subtle width/opacity scaling by confidence
  const strokeWidth = 1.6 + conf * 1.4;   // ~1.6 → 3.0
  const baseOpacity = 0.45 + conf * 0.5;  // ~0.45 → 0.95

  const [revealed, setRevealed] = useState(false);
  const edgeDelay = typeof (data as any)?.delay === 'number' ? (data as any).delay : 0.12;

  const sources: EvidenceItem[] = Array.isArray((data as any)?.sources)
    ? (data as any).sources.slice(0, 5)
    : [];

  return (
    <>
      {/* Edge path */}
      <motion.path
        id={id}
        d={edgePath}
        fill="none"
        strokeLinecap="butt"
        stroke={strokeColor}
        strokeWidth={strokeWidth}
        strokeDasharray={revealed ? dash : undefined}
        markerEnd={markerEnd as any}
        initial={{ pathLength: 0, opacity: 0.9 }}
        animate={{ pathLength: 1, opacity: baseOpacity }}
        transition={{ duration: 0.70, ease: "easeInOut", delay: edgeDelay }}
        onAnimationComplete={() => setRevealed(true)}
      />

      {/* Label pill over the edge (unchanged tooltip behavior) */}
      <EdgeLabelRenderer>
        <Popover placement="top">
          <PopoverHandler>
            <div
              style={{
                ...style,
                position: 'absolute',
                transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
                backgroundColor: 'rgba(255,255,255,0.7)',
                backdropFilter: 'blur(6px)',
                WebkitBackdropFilter: 'blur(6px)',
                border: '1px solid #e5e7eb',
                borderRadius: 9999,
                padding: '2px 10px',
                boxShadow: '0 1px 2px rgba(0,0,0,0.08)',
                fontSize: 12,
                fontWeight: 500,
                cursor: 'pointer',
                pointerEvents: 'all',
                userSelect: 'none'
              }}
              className="nodrag nopan"
              title="See evidence"
            >
              {label?.toString()}
            </div>
          </PopoverHandler>

          <PopoverContent className="z-[1000] max-w-[17rem] p-2">
            {sources.length ? (
              <div className="flex flex-wrap items-center gap-1.5">
                {sources.map((s, idx) => {
                  const title = s.title || `Source ${idx + 1}`;
                  const pct = typeof s.p === "number" ? Math.round(s.p) : null;

                  const rightBits = pct !== null ? (
                    <span className="ml-1 text-[10px] text-zinc-500">{pct}%</span>
                  ) : null;

                  return s.link ? (
                    <a
                      key={idx}
                      href={s.link}
                      target="_blank"
                      rel="noopener noreferrer"
                      title={s.snippet || title}
                      className={`group inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs leading-none transition ${badgeClass(s.label)}`}
                    >
                      <span className={`inline-block h-2 w-2 rounded-full ${dotClass(s.label)}`} />
                      <Prefix label={s.label as any} />
                      <span className="truncate max-w-[180px]">{title}</span>
                      {rightBits}
                    </a>
                  ) : (
                    <span
                      key={idx}
                      title={s.snippet || title}
                      className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs leading-none ${badgeClass(s.label)}`}
                    >
                      <span className={`inline-block h-2 w-2 rounded-full ${dotClass(s.label)}`} />
                      <Prefix label={s.label as any} />
                      <span className="truncate max-w-[180px]">{title}</span>
                      {rightBits}
                    </span>
                  );
                })}
              </div>
            ) : (
              <span className="text-[11px] text-zinc-500">No evidence yet</span>
            )}
          </PopoverContent>
        </Popover>
      </EdgeLabelRenderer>
    </>
  );
};

export default CustomEdge;
