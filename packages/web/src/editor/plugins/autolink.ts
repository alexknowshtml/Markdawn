import type { Ctx } from '@milkdown/kit/ctx';
import { InputRule } from '@milkdown/kit/prose/inputrules';
import { linkSchema } from '@milkdown/preset-commonmark';
import { $inputRule } from '@milkdown/utils';

const URL_INPUT_REGEX = /(https?:\/\/[^\s]+)\s$/;

export const autoLinkInputRule = $inputRule((ctx: Ctx) => {
  const linkMarkType = linkSchema.type(ctx);

  return new InputRule(URL_INPUT_REGEX, (state, match, _start, end) => {
    const url = match[1];
    if (!url) return null;

    const tr = state.tr;
    const urlStart = end - 1 - url.length;
    const urlEnd = end - 1;
    tr.addMark(urlStart, urlEnd, linkMarkType.create({ href: url }));
    return tr;
  });
});

export const autolink = [autoLinkInputRule];
