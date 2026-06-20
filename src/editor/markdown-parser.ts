import { MarkdownParser } from "prosemirror-markdown";
import { getSchema } from "./schema";
import { buildTokenizer } from "./markdown-tokenizer";

// Parser: markdown-it tokens -> ProseMirror nodes/marks (our schema names).
// Mirrors prosemirror-markdown's default token spec, retargeted to the remirror
// schema's node/mark names (bulletList, bold, italic, ... not bullet_list,
// strong, em).

function listIsTight(
  tokens: readonly { type: string; hidden?: boolean }[],
  i: number,
): boolean {
  while (++i < tokens.length) {
    if (tokens[i].type !== "list_item_open") return !!tokens[i].hidden;
  }
  return false;
}

function buildParser(): MarkdownParser {
  const schema = getSchema();
  return new MarkdownParser(schema, buildTokenizer(), {
    blockquote: { block: "blockquote" },
    paragraph: { block: "paragraph" },
    list_item: { block: "listItem" },
    bullet_list: {
      block: "bulletList",
      getAttrs: (_tok, tokens, i) => ({ tight: listIsTight(tokens, i) }),
    },
    ordered_list: {
      block: "orderedList",
      getAttrs: (tok, tokens, i) => ({
        order: +(tok.attrGet("start") ?? "") || 1,
        tight: listIsTight(tokens, i),
      }),
    },
    heading: {
      block: "heading",
      getAttrs: (tok) => ({ level: +tok.tag.slice(1) }),
    },
    code_block: { block: "codeBlock", noCloseToken: true },
    fence: {
      block: "codeBlock",
      getAttrs: (tok) => ({ language: tok.info || "" }),
      noCloseToken: true,
    },
    // GFM tables. thead/tbody have no ProseMirror counterpart (a table is just
    // rows), so they're ignored; cells were paragraph-wrapped by the tokenizer.
    table: { block: "table" },
    thead: { ignore: true },
    tbody: { ignore: true },
    tr: { block: "tableRow" },
    th: { block: "tableHeaderCell" },
    td: { block: "tableCell" },
    hr: { node: "horizontalRule" },
    image: {
      node: "image",
      getAttrs: (tok) => ({
        src: tok.attrGet("src"),
        title: tok.attrGet("title") || null,
        alt: (tok.children?.[0] && tok.children[0].content) || null,
      }),
    },
    hardbreak: { node: "hardBreak" },
    em: { mark: "italic" },
    strong: { mark: "bold" },
    s: { mark: "strike" },
    // Paired underline_open/underline_close tokens synthesized from <u>/</u>
    // inline HTML by underlineHtmlPlugin (see ./markdown-tokenizer), so the
    // underline mark round-trips through markdown.
    underline: { mark: "underline" },
    link: {
      mark: "link",
      getAttrs: (tok) => ({
        href: tok.attrGet("href"),
        title: tok.attrGet("title") || null,
      }),
    },
    code_inline: { mark: "code", noCloseToken: true },
  });
}

// Lazily built singleton (building constructs the schema).
let parser: MarkdownParser | null = null;
export function getParser(): MarkdownParser {
  if (parser === null) parser = buildParser();
  return parser;
}
