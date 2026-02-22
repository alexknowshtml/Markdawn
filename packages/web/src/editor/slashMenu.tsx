import type { BlockNoteEditor } from "@blocknote/core";
import { getDefaultReactSlashMenuItems } from "@blocknote/react";
import { ChevronRight, Info, Link } from "lucide-react";

export const getCustomSlashMenuItems = (editor: BlockNoteEditor<any>) => {
  const insertAtCursor = (blocks: Parameters<BlockNoteEditor<any>["insertBlocks"]>[0]) => {
    const cursor = editor.getTextCursorPosition();
    editor.insertBlocks(blocks, cursor.block, "before");
  };

  const calloutItem = {
    title: "Callout",
    aliases: ["callout", "alert", "note"],
    group: "Advanced",
    icon: <Info size={18} />,
    subtext: "Add a callout box",
    onItemClick: () => {
      insertAtCursor([{ type: "callout", props: { variant: "info" } }]);
    },
  };

  const toggleItem = {
    title: "Toggle",
    aliases: ["toggle", "collapse", "expand"],
    group: "Advanced",
    icon: <ChevronRight size={18} />,
    subtext: "Add a collapsible toggle",
    onItemClick: () => {
      insertAtCursor([{ type: "toggle" }]);
    },
  };

  const embedItem = {
    title: "Embed",
    aliases: ["embed", "youtube", "iframe", "x", "twitter"],
    group: "Advanced",
    icon: <Link size={18} />,
    subtext: "Embed YouTube, X, or iframe content",
    onItemClick: () => {
      insertAtCursor([{ type: "embed" }]);
    },
  };

  return [...getDefaultReactSlashMenuItems(editor), calloutItem, toggleItem, embedItem];
};
