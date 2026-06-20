import MarkdownIt from "markdown-it";
import type { StateCore } from "markdown-it/index.js";

// markdown-it tokenizer for the redox markdown bridge (see ./markdown.ts).
//
// CommonMark + GFM strikethrough (~~) so the editor's `strike` mark round-trips.
// We also enable inline HTML solely so the underline mark — which has no
// CommonMark syntax and is serialized as <u>...</u> — round-trips. A core rule
// rewrites just the <u>/</u> inline-html tokens into paired underline_open/
// underline_close tokens the parser maps to the underline mark; any OTHER raw
// HTML is converted to plain text so we don't smuggle arbitrary markup into the
// schema-constrained document.

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

// GFM tables: prosemirror-tables cells hold block content (`block+`), but
// markdown-it emits a cell's content as a bare `inline` token between th/td
// open+close. Wrap that inline run in paragraph_open/paragraph_close tokens so
// the parser builds tableCell > paragraph > inline (a valid cell).
function tableCellParagraphPlugin(md: MarkdownIt): void {
  md.core.ruler.push("redox_table_cell_paragraphs", (state: StateCore) => {
    const out: (typeof state.tokens)[number][] = [];
    for (const tok of state.tokens) {
      if (tok.type === "th_open" || tok.type === "td_open") {
        out.push(tok, new state.Token("paragraph_open", "p", 1));
      } else if (tok.type === "th_close" || tok.type === "td_close") {
        out.push(new state.Token("paragraph_close", "p", -1), tok);
      } else {
        out.push(tok);
      }
    }
    state.tokens = out;
    return false;
  });
}

export function buildTokenizer(): MarkdownIt {
  // html:true lets the <u> underline tokens through; underlineHtmlPlugin then
  // narrows raw HTML handling to only the underline mark.
  const md = MarkdownIt("commonmark", { html: true });
  // CommonMark preset disables strikethrough + tables; re-enable both (strike
  // mark, GFM pipe tables).
  md.enable(["strikethrough", "table"]);
  // Disable the block-level HTML rule so a line that is just <u>..</u> is parsed
  // as a paragraph (its <u> becoming an inline-HTML token we handle) rather than
  // an opaque html_block the ProseMirror parser has no mapping for.
  md.disable(["html_block"]);
  md.use(underlineHtmlPlugin);
  md.use(tableCellParagraphPlugin);
  return md;
}
