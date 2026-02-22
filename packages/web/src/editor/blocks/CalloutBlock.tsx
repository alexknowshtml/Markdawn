import { defaultProps } from "@blocknote/core";
import { createReactBlockSpec } from "@blocknote/react";
import { AlertCircle, AlertTriangle, CheckCircle2, Info } from "lucide-react";

const CALLOUT_VARIANTS = ["info", "warning", "success", "error"] as const;

const CALLOUT_STYLES = {
  info: {
    label: "Info",
    icon: Info,
    color: "#3b82f6",
    background: "#eff6ff",
  },
  warning: {
    label: "Warning",
    icon: AlertTriangle,
    color: "#f59e0b",
    background: "#fffbeb",
  },
  success: {
    label: "Success",
    icon: CheckCircle2,
    color: "#10b981",
    background: "#ecfdf5",
  },
  error: {
    label: "Error",
    icon: AlertCircle,
    color: "#ef4444",
    background: "#fef2f2",
  },
} as const;

export const calloutBlockSpec = createReactBlockSpec(
  {
    type: "callout",
    propSchema: {
      textAlignment: defaultProps.textAlignment,
      textColor: defaultProps.textColor,
      variant: {
        default: "info",
        values: CALLOUT_VARIANTS,
      },
    },
    content: "inline",
  },
  {
    render: ({ block, contentRef }) => {
      const style = CALLOUT_STYLES[block.props.variant];
      const Icon = style.icon;

      return (
        <div
          className="flex items-start gap-3 rounded-md border px-4 py-3"
          data-callout-variant={block.props.variant}
          style={{ borderColor: style.color, backgroundColor: style.background }}
        >
          <div className="mt-0.5" contentEditable={false}>
            <Icon size={20} color={style.color} aria-label={style.label} />
          </div>
          <div className="min-w-0 flex-1" ref={contentRef} />
        </div>
      );
    },
  }
)();
