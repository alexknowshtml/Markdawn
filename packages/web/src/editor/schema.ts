import { BlockNoteSchema } from "@blocknote/core";
import { calloutBlockSpec } from "./blocks/CalloutBlock";
import { embedBlockSpec } from "./blocks/EmbedBlock";
import { toggleBlockSpec } from "./blocks/ToggleBlock";
import { mentionSpec } from "./mentions/MentionSpec";

const defaultSchema = BlockNoteSchema.create();
const extendedSchema = defaultSchema.extend({
  blockSpecs: {
    callout: calloutBlockSpec,
    embed: embedBlockSpec,
    toggle: toggleBlockSpec,
  },
  inlineContentSpecs: {
    mention: mentionSpec,
  },
});

export const schema = extendedSchema;
export const customSchema = schema;

export const tableOptions = {
  splitCells: true,
  cellBackgroundColor: true,
  cellTextColor: true,
  headers: true,
};

const fileToDataUrl = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
        return;
      }
      reject(new Error("File reader did not return a string."));
    };
    reader.onerror = () => {
      reject(new Error("Failed to read file."));
    };
    reader.readAsDataURL(file);
  });

export const uploadFile = async (file: File) => {
  return fileToDataUrl(file);
};
