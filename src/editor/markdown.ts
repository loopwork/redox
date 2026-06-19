import MarkdownIt from "markdown-it";
import type { StateCore } from "markdown-it/index.js";
import {
  MarkdownParser,
  MarkdownSerializer,
  type MarkdownSerializerState,
} from "prosemirror-markdown";
import type { Node as PMNode, Mark } from "@remirror/pm/model";
import { getSchema } from "./schema";

// Markdown <-> ProseMirror bridge for the redox content schema.
//
// We do NOT reuse prosemirror-markdown's `defaultMarkdownParser` /
// `defaultMarkdownSerializer`: those target the CommonMark demo schema whose
// node/mark names (bullet_list, strong, em, ...) differ from the remirror schema
// produced by buildSchema() (bulletList, bold, italic, ...). Instead we build a
// custom parser + serializer bound to OUR schema's names, mirroring the default
// implementations where the behavior is the same.
//
// The remirror MarkdownExtension's own helpers were avoided on purpose: they go
// markdown -> HTML (marked) -> ProseMirror (DOMParser) and back via turndown,
// all of which require DOM globals that don't exist in headless Node.
// prosemirror-markdown + markdown-it run purely on strings, no DOM needed.

// ---------------------------------------------------------------------------
// markdown-it tokenizer: CommonMark + GFM strikethrough (~~) so the editor's
// `strike` mark round-trips. We also enable inline HTML solely so the underline
// mark — which has no CommonMark syntax and is serialized as <u>...</u> — round-
// trips. A core rule rewrites just the <u>/</u> inline-html tokens into paired
// underline_open/underline_close tokens the parser maps to the underline mark;
// any OTHER raw HTML is converted to plain text so we don't smuggle arbitrary
// markup into the schema-constrained document.
// ---------------------------------------------------------------------------
const U_OPEN = /^<u(?:\s[^>]*)?>$/i;
const U_CLOSE = /^<\/u\s*>$/i;

function underlineHtmlPlugin(md: MarkdownIt): void {
  md.core.ruler.push("redox_underline_html", (state: StateCore) => {
    for (const block of state.tokens) {
      if (block.type !== "inline" || !block.children) continue;
      for (const tok of block.children) {
        if (tok.type !== "html_inline") continue;
        if (U_OPEN.test(tok.content)) {
          tok.type = "underline_open";
          tok.tag = "u";
          tok.nesting = 1;
          tok.content = "";
        } else if (U_CLOSE.test(tok.content)) {
          tok.type = "underline_close";
          tok.tag = "u";
          tok.nesting = -1;
          tok.content = "";
        } else {
          // Any other raw inline HTML: degrade to its literal text so it is not
          // dropped, rather than injecting unsupported markup.
          tok.type = "text";
        }
      }
    }
    return false;
  });
}

function buildTokenizer(): MarkdownIt {
  // html:true lets the <u> underline tokens through; underlineHtmlPlugin then
  // narrows raw HTML handling to only the underline mark.
  const md = MarkdownIt("commonmark", { html: true });
  // CommonMark preset disables strikethrough; re-enable it for the strike mark.
  md.enable(["strikethrough"]);
  // Disable the block-level HTML rule so a line that is just <u>..</u> is parsed
  // as a paragraph (its <u> becoming an inline-HTML token we handle) rather than
  // an opaque html_block the ProseMirror parser has no mapping for.
  md.disable(["html_block"]);
  md.use(underlineHtmlPlugin);
  return md;
}

// ---------------------------------------------------------------------------
// Parser: markdown-it tokens -> ProseMirror nodes/marks (our schema names).
// ---------------------------------------------------------------------------
function listIsTight(tokens: readonly { type: string; hidden?: boolean }[], i: number): boolean {
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
    // inline HTML by underlineHtmlPlugin (see buildTokenizer), so the underline
    // mark round-trips through markdown.
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

// ---------------------------------------------------------------------------
// Serializer: ProseMirror nodes/marks (our schema names) -> markdown.
// Node/mark functions mirror prosemirror-markdown's defaults, retargeted to our
// node names and attribute keys (e.g. codeBlock.language, orderedList.order).
// ---------------------------------------------------------------------------
function backticksFor(node: PMNode, side: number): string {
  const ticks = /`+/g;
  let m: RegExpExecArray | null;
  let len = 0;
  if (node.isText && node.text) {
    while ((m = ticks.exec(node.text))) len = Math.max(len, m[0].length);
  }
  let result = len > 0 && side > 0 ? " `" : "`";
  for (let i = 0; i < len; i++) result += "`";
  if (len > 0 && side < 0) result += " ";
  return result;
}

function isPlainURL(link: Mark, parent: PMNode, index: number): boolean {
  if (link.attrs.href == null) return false;
  if (link.attrs.title || !/^\w+:/.test(link.attrs.href as string)) return false;
  const content = parent.child(index);
  if (
    !content.isText ||
    content.text !== link.attrs.href ||
    content.marks[content.marks.length - 1] !== link
  ) {
    return false;
  }
  return (
    index === parent.childCount - 1 ||
    !link.isInSet(parent.child(index + 1).marks)
  );
}

// `inAutolink` is an internal field prosemirror-markdown sets on the state; we
// reuse the same convention via a loosely typed alias.
type SerState = MarkdownSerializerState & { inAutolink?: boolean };

function buildSerializer(): MarkdownSerializer {
  return new MarkdownSerializer(
    {
      blockquote(state, node) {
        state.wrapBlock("> ", null, node, () => state.renderContent(node));
      },
      codeBlock(state, node) {
        const backticks = node.textContent.match(/`{3,}/gm);
        const fence = backticks ? backticks.sort().slice(-1)[0] + "`" : "```";
        const lang = (node.attrs.language as string) || "";
        state.write(fence + lang + "\n");
        state.text(node.textContent, false);
        state.write("\n");
        state.write(fence);
        state.closeBlock(node);
      },
      heading(state, node) {
        state.write(state.repeat("#", node.attrs.level as number) + " ");
        state.renderInline(node, false);
        state.closeBlock(node);
      },
      horizontalRule(state, node) {
        state.write((node.attrs.markup as string) || "---");
        state.closeBlock(node);
      },
      bulletList(state, node) {
        // Default to "-" (the most common bullet convention); honor an explicit
        // bullet attr if a node carries one.
        state.renderList(node, "  ", () => ((node.attrs.bullet as string) || "-") + " ");
      },
      orderedList(state, node) {
        const start = (node.attrs.order as number) || 1;
        const maxW = String(start + node.childCount - 1).length;
        const space = state.repeat(" ", maxW + 2);
        state.renderList(node, space, (i) => {
          const nStr = String(start + i);
          return state.repeat(" ", maxW - nStr.length) + nStr + ". ";
        });
      },
      listItem(state, node) {
        state.renderContent(node);
      },
      taskList(state, node) {
        // GFM task list. Each item's checkbox comes from taskListItem.checked.
        // (On reload this parses back as a plain bullet list — text preserved,
        // checkbox state lost — which is acceptable degradation, not data loss.)
        state.renderList(node, "  ", (i) => {
          const item = node.maybeChild(i);
          const checked = item?.attrs.checked === true;
          return `- [${checked ? "x" : " "}] `;
        });
      },
      taskListItem(state, node) {
        state.renderContent(node);
      },
      iframe(state, node) {
        // No portable markdown form; emit a traceable comment instead of
        // throwing (the strict serializer would otherwise abort the whole flush).
        state.write(`<!-- iframe: ${(node.attrs.src as string) || ""} -->`);
        state.closeBlock(node);
      },
      paragraph(state, node) {
        state.renderInline(node);
        state.closeBlock(node);
      },
      image(state, node) {
        state.write(
          "![" +
            state.esc((node.attrs.alt as string) || "") +
            "](" +
            (node.attrs.src as string).replace(/[()]/g, "\\$&") +
            (node.attrs.title
              ? ' "' + (node.attrs.title as string).replace(/"/g, '\\"') + '"'
              : "") +
            ")",
        );
      },
      hardBreak(state, node, parent, index) {
        for (let i = index + 1; i < parent.childCount; i++) {
          if (parent.child(i).type !== node.type) {
            state.write("\\\n");
            return;
          }
        }
      },
      text(state, node) {
        state.text(node.text ?? "", !(state as SerState).inAutolink);
      },
    },
    {
      italic: { open: "*", close: "*", mixable: true, expelEnclosingWhitespace: true },
      bold: { open: "**", close: "**", mixable: true, expelEnclosingWhitespace: true },
      strike: { open: "~~", close: "~~", mixable: true, expelEnclosingWhitespace: true },
      // No CommonMark syntax for underline; emit HTML. The tokenizer enables
      // inline HTML and underlineHtmlPlugin maps <u>/</u> back to this mark, so
      // underline now round-trips.
      underline: { open: "<u>", close: "</u>", mixable: true },
      link: {
        open(state, mark, parent, index) {
          (state as SerState).inAutolink = isPlainURL(mark, parent, index);
          return (state as SerState).inAutolink ? "<" : "[";
        },
        close(state, mark) {
          const inAutolink = (state as SerState).inAutolink;
          (state as SerState).inAutolink = undefined;
          return inAutolink
            ? ">"
            : "](" +
                (mark.attrs.href as string).replace(/[()"]/g, "\\$&") +
                (mark.attrs.title
                  ? ` "${(mark.attrs.title as string).replace(/"/g, '\\"')}"`
                  : "") +
                ")";
        },
        mixable: true,
      },
      code: {
        open(_state, _mark, parent, index) {
          return backticksFor(parent.child(index), -1);
        },
        close(_state, _mark, parent, index) {
          return backticksFor(parent.child(index - 1), 1);
        },
        escape: false,
      },
    },
  );
}

// Lazily built singletons (building involves constructing the schema).
let parser: MarkdownParser | null = null;
let serializer: MarkdownSerializer | null = null;

function getParser(): MarkdownParser {
  if (parser === null) parser = buildParser();
  return parser;
}
function getSerializer(): MarkdownSerializer {
  if (serializer === null) serializer = buildSerializer();
  return serializer;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Parse markdown into a ProseMirror document JSON (using the redox schema). */
export function markdownToProsemirrorJSON(md: string): Record<string, unknown> {
  const doc = getParser().parse(md ?? "");
  return doc.toJSON() as Record<string, unknown>;
}

/** Serialize a ProseMirror document JSON back to markdown. */
export function prosemirrorJSONToMarkdown(json: Record<string, unknown>): string {
  const schema = getSchema();
  const doc = schema.nodeFromJSON(json);
  return getSerializer().serialize(doc, { tightLists: true });
}

/** Parse markdown into a ProseMirror document Node (using the redox schema). */
export function markdownToProsemirrorNode(md: string): PMNode {
  return getParser().parse(md ?? "");
}

/** Serialize a ProseMirror document Node back to markdown. */
export function prosemirrorNodeToMarkdown(doc: PMNode): string {
  return getSerializer().serialize(doc, { tightLists: true });
}
