import {
  MarkdownSerializer,
  type MarkdownSerializerState,
} from "prosemirror-markdown";
import type { Node as PMNode, Mark } from "@remirror/pm/model";
import { getSchema } from "./schema";

// Serializer: ProseMirror nodes/marks (our schema names) -> markdown. Node/mark
// functions mirror prosemirror-markdown's defaults, retargeted to our node names
// and attribute keys (e.g. codeBlock.language, orderedList.order).

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

// Render one table cell's content to a single GFM cell: reuse the full
// serializer (so marks like bold/code/links survive) on the cell's block
// content, then flatten to one line — GFM cells can't span lines — and escape
// pipes so they don't break the column structure.
function cellToMarkdown(cell: PMNode): string {
  const doc = getSchema().node("doc", null, cell.content);
  const md = getSerializer().serialize(doc, { tightLists: true });
  return md.replace(/\s*\n+\s*/g, " ").replace(/\|/g, "\\|").trim() || " ";
}

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
      table(state, node) {
        // Render the whole grid here; the first row is treated as the header,
        // followed by the GFM separator row. tableRow/cell handlers below exist
        // only so the serializer never sees an unmapped node.
        node.forEach((row, _off, ri) => {
          state.write("|");
          row.forEach((cell) => state.write(` ${cellToMarkdown(cell)} |`));
          state.write("\n");
          if (ri === 0) {
            state.write("|");
            for (let c = 0; c < row.childCount; c++) state.write(" --- |");
            state.write("\n");
          }
        });
        state.closeBlock(node);
      },
      tableRow(state, node) {
        state.renderContent(node);
      },
      tableCell(state, node) {
        state.renderContent(node);
      },
      tableHeaderCell(state, node) {
        state.renderContent(node);
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

// Lazily built singleton. cellToMarkdown recurses through this same getter, so
// the table serializer can re-serialize each cell's content.
let serializer: MarkdownSerializer | null = null;
export function getSerializer(): MarkdownSerializer {
  if (serializer === null) serializer = buildSerializer();
  return serializer;
}
