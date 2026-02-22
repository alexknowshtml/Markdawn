import { createReactBlockSpec } from "@blocknote/react";
import { ChevronRight } from "lucide-react";

export const toggleBlockSpec = createReactBlockSpec(
  {
    type: "toggle",
    propSchema: {
      isOpen: {
        default: true,
      },
    },
    content: "inline",
  },
  {
    render: ({ block, editor, contentRef }) => {
      const isOpen = block.props.isOpen;
      const handleToggle = () => {
        editor.updateBlock(block, { props: { isOpen: !isOpen } });
      };

      return (
        <div className="flex items-start gap-2 rounded-md border border-zinc-200 bg-white/60 px-3 py-2 dark:border-zinc-800 dark:bg-zinc-900/40">
          <button
            className="mt-0.5 flex h-5 w-5 items-center justify-center text-zinc-600 transition hover:text-zinc-900 dark:text-zinc-300 dark:hover:text-white"
            type="button"
            contentEditable={false}
            aria-expanded={isOpen}
            aria-label={isOpen ? "Collapse toggle" : "Expand toggle"}
            onClick={handleToggle}
          >
            <ChevronRight
              size={16}
              className={`transition-transform duration-200 ${isOpen ? "rotate-90" : "rotate-0"}`}
            />
          </button>
          <div
            className="min-w-0 flex-1"
            ref={contentRef}
            style={{ display: isOpen ? "block" : "none" }}
          />
        </div>
      );
    },
  }
)();
