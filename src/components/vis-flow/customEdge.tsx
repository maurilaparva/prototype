import { EdgeLabelRenderer, EdgeProps } from "reactflow";
import { FC, useState } from "react";
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
const labelPrefix = (label?: string) => (label === "support" ? "S: " : label === "refute" ? "R: " : "N: ");

const CustomEdge: FC<EdgeProps> = ({
  sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition,
  style, data, label, id, markerEnd
}) => {
  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition
  });

  const status = (data as any)?.verification?.status;
  const finalDash =
    status === "missing" ? "2 4" :
    status === "weak"    ? "6 4" :
    undefined;
  const finalWidth =
    status === "verified" || status === "supported" ? 2.5 : 2;

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
        stroke="#000"
        strokeWidth={finalWidth}
        strokeDasharray={revealed ? finalDash : undefined}
        markerEnd={markerEnd as any}
        initial={{ pathLength: 0, opacity: 0.95 }}
        animate={{ pathLength: 1, opacity: 1 }}
        transition={{ duration: 0.70, ease: "easeInOut", delay: edgeDelay }}
        onAnimationComplete={() => setRevealed(true)}
      />

      {/* Clickable label + evidence popover */}
      <EdgeLabelRenderer>
        <Popover placement="top">
          <PopoverHandler>
            <div
              style={{
                ...style,
                position: 'absolute',
                transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
                backgroundColor: 'white',
                pointerEvents: 'all',
                cursor: 'pointer',
                borderRadius: 6,
                padding: '2px 6px',
                boxShadow: '0 1px 3px rgba(0,0,0,0.1)',
                fontSize: 12,
                userSelect: 'none'
              }}
              className="nodrag nopan"
              title="See evidence"
            >
              {label?.toString()}
            </div>
          </PopoverHandler>

          <PopoverContent className="z-[1000] max-w-xs p-2">
            {sources.length ? (
              <div className="flex flex-wrap items-center gap-1.5">
                {sources.map((s, idx) => {
                  const title = s.title || `Source ${idx + 1}`;
                  const prefix = labelPrefix(s.label);
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
                      <span className="truncate max-w-[180px]">{prefix}{title}</span>
                    </a>
                  ) : (
                    <span
                      key={idx}
                      title={s.snippet || title}
                      className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs leading-none ${badgeClass(s.label)}`}
                    >
                      <span className={`inline-block h-2 w-2 rounded-full ${dotClass(s.label)}`} />
                      <span className="truncate max-w-[180px]">{prefix}{title}</span>
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
