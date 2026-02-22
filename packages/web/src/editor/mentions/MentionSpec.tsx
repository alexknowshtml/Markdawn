import { createReactInlineContentSpec } from "@blocknote/react";

export const mentionSpec = createReactInlineContentSpec(
  {
    type: "mention" as const,
    propSchema: {
      userId: { default: "" },
      userName: { default: "" },
    },
    content: "none",
  },
  {
    render: ({ inlineContent }) => (
      <span className="inline-flex items-center rounded bg-blue-100 px-1 text-blue-700 dark:bg-blue-900 dark:text-blue-300">
        @{inlineContent.props.userName}
      </span>
    ),
  }
);
