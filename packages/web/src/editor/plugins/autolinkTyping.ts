import type { Ctx } from '@milkdown/kit/ctx';
import { InputRule } from '@milkdown/kit/prose/inputrules';
import type { MarkType } from '@milkdown/kit/prose/model';
import type { EditorView } from '@milkdown/kit/prose/view';
import { $inputRule } from '@milkdown/kit/utils';
import { linkSchema } from '@milkdown/preset-commonmark';
import { findHttpUrls, type HttpUrlMatch } from '../../utils/url';
import { isEligibleAutolinkRange } from '../utils/textRunUrls';

// Newlines are left to the editor's normal block/list keymaps; matching one
// here would consume Enter as inline text instead of splitting the block.
const URL_DELIMITER_PATTERN = /(\S+)([ \t])$/u;

function getTrailingHttpUrl(value: string): HttpUrlMatch | undefined {
  const match = findHttpUrls(value).at(-1);
  if (!match) return undefined;
  return /^[,.;:!?)]*$/u.test(value.slice(match.to)) ? match : undefined;
}

export function createAutolinkInputRule(linkMarkType: MarkType): InputRule {
  return new InputRule(
    URL_DELIMITER_PATTERN,
    (state, match, start, end) => {
      const urlText = match[1];
      const delimiter = match[2];
      if (!urlText || !delimiter) return null;

      const url = getTrailingHttpUrl(urlText);
      if (!url) return null;

      const linkFrom = start + url.from;
      const linkTo = start + url.to;
      if (!isEligibleAutolinkRange(state.doc, linkFrom, linkTo, linkMarkType)) return null;
      return state.tr
        .insertText(delimiter, end, end)
        .addMark(linkFrom, linkTo, linkMarkType.create({ href: url.href }));
    },
    { inCodeMark: false },
  );
}

/** Marks the known URL range, then lets the editor's normal Enter keymap split it. */
export function handleAutolinkEnter(view: EditorView, event: KeyboardEvent): boolean {
  if (event.key !== 'Enter' || event.shiftKey) return false;

  const { selection, storedMarks } = view.state;
  const linkMarkType = view.state.schema.marks.link;
  if (
    !linkMarkType ||
    !selection.empty ||
    selection.$from.parent.type.spec.code ||
    selection.$from.marks().some((mark) => mark.type.spec.code) ||
    storedMarks?.some((mark) => mark.type.spec.code)
  ) {
    return false;
  }

  const textBeforeCursor = selection.$from.parent.textBetween(0, selection.$from.parentOffset);
  const url = getTrailingHttpUrl(textBeforeCursor);
  if (!url) return false;

  const from = selection.from - textBeforeCursor.length + url.from;
  const to = selection.from - textBeforeCursor.length + url.to;
  if (!isEligibleAutolinkRange(view.state.doc, from, to, linkMarkType)) return false;
  view.dispatch(view.state.tr.addMark(from, to, linkMarkType.create({ href: url.href })));
  return false;
}

const autolinkInputRule = $inputRule((ctx: Ctx) => createAutolinkInputRule(linkSchema.type(ctx)));

export const autolinkTyping = [autolinkInputRule].flat();
