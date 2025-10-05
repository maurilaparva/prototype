import { NodeProps, NodeToolbar, Handle, Position } from "reactflow";
import { FC } from "react";
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
    case "support":
      return "bg-emerald-500";
    case "refute":
      return "bg-rose-500";
    default:
      return "bg-zinc-400";
  }
};

const badgeClass = (label?: string) => {
  switch (label) {
    case "support":
      return "border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100";
    case "refute":
      return "border-rose-200 bg-rose-50 text-rose-700 hover:bg-rose-100";
    default:
      return "border-zinc-200 bg-zinc-50 text-zinc-700 hover:bg-zinc-100";
  }
};

// Prefix marker
const labelPrefix = (label?: string) => {
  switch (label) {
    case "support":
      return "S: ";
    case "refute":
      return "R: ";
    default:
      return "N: ";
  }
};

const CustomNode: FC<NodeProps> = ({
  sourcePosition,
  targetPosition,
  data
}) => {
  const sources: EvidenceItem[] = (data?.sources || []).slice(0, 5);

  return (
    <>
      <motion.div
        initial={{ opacity: 0, scale: 0.98, backgroundColor: data?.bgColor || "transparent" }}
        animate={{ opacity: 1, scale: 1, backgroundColor: data?.bgColor || "transparent" }}
        transition={{
          duration: 0.7,
          ease: "easeOut",
          delay: data?.animationOrder ? data.animationOrder * 0.12 : 0
        }}
        style={{
          overflow: "hidden",
          borderColor: "#d1d5db",
          borderWidth: "1px",
          borderStyle: "solid",
          borderRadius: "5px",
          boxShadow: "0px 10px 20px rgba(0, 0, 0, 0.07)",
          padding: "10px",
          minWidth: "150px",
          minHeight: "40px",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          alignItems: "center",
          gap: "10px",
          boxSizing: "border-box"
        }}
      >
        {/* Compact, minimal toolbar */}
        <NodeToolbar
          position={Position.Top}
          className="rounded-md border border-zinc-200/70 bg-white/90 backdrop-blur px-2 py-1 shadow-sm"
        >
          {sources.length > 0 ? (
            <div className="flex max-w-[210px] flex-wrap items-center gap-1.5">
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
                    className={`group inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs leading-none transition ${badgeClass(
                      s.label
                    )}`}
                  >
                    <span className={`inline-block h-2 w-2 rounded-full ${dotClass(s.label)}`} />
                    <span className="truncate max-w-[180px]">
                      {prefix}{title}
                    </span>
                  </a>
                ) : (
                  <span
                    key={idx}
                    title={s.snippet || title}
                    className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs leading-none ${badgeClass(
                      s.label
                    )}`}
                  >
                    <span className={`inline-block h-2 w-2 rounded-full ${dotClass(s.label)}`} />
                    <span className="truncate max-w-[180px]">
                      {prefix}{title}
                    </span>
                  </span>
                );
              })}
            </div>
          ) : (
            <span className="text-[11px] text-zinc-500">No evidence yet</span>
          )}
        </NodeToolbar>

        <div className="reactflow">{data.label}</div>

        <Handle type="target" position={targetPosition || Position.Top} />
        <Handle type="source" position={sourcePosition || Position.Bottom} />
      </motion.div>
    </>
  );
};

export default CustomNode;
