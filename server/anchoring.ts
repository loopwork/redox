// Annotation anchor translation (SERVER-ONLY).
//
// The live Yjs annotations array stores ABSOLUTE ProseMirror offsets
// { id, from, to, className?, comment? } — that is exactly what the unchanged
// client reads/writes. The on-disk sidecar instead stores resilient text
// anchors { id, quote, prefix, suffix, posHint, className?, comment?, orphaned? }
// so an annotation can survive edits made while the file was closed.
//
// This module translates ONLY at the file boundary:
//   - flush  (offsets -> anchors): offsetsToAnchors()
//   - load   (anchors -> offsets): anchorsToOffsets()
//
// Both directions need a text view of the document with a stable mapping back to
// ProseMirror positions. We derive that from the same headless schema the client
// uses (via the step-1 markdown/ydoc helpers), so positions line up with what
// y-prosemirror produced in the live room.
import type { Node as PMNode } from "@remirror/pm/model";

// Sidecar (on-disk) annotation shape.
export interface AnchoredAnnotation {
  id: string;
  quote: string; // the annotated text itself
  prefix: string; // up to CONTEXT chars immediately before `from`
  suffix: string; // up to CONTEXT chars immediately after `to`
  posHint: number; // the ProseMirror `from` at flush time, a search hint
  className?: string;
  comment?: string;
  orphaned?: boolean; // true if the quote could not be relocated on load
}

// Live (in-Yjs / client) annotation shape: absolute ProseMirror offsets.
export interface OffsetAnnotation {
  id: string;
  from: number;
  to: number;
  className?: string;
  comment?: string;
}

const CONTEXT = 32; // max chars of prefix/suffix context to store

// ---------------------------------------------------------------------------
// Flat text <-> ProseMirror position map.
//
// We walk every text node in document order, concatenating its characters into
// a flat string. `posOfIndex[i]` is the ProseMirror position of flat char `i`
// (so a half-open text range [i, j) maps to PM range [posOfIndex[i],
// posOfIndex[j-1] + 1)). A single "\n" separator is inserted between
// non-contiguous text runs (i.e. across block boundaries) so quotes/prefixes
// read naturally; the separator maps to the end of the preceding run.
// ---------------------------------------------------------------------------
interface TextMap {
  text: string;
  posOfIndex: number[]; // length === text.length
}

function buildTextMap(doc: PMNode): TextMap {
  let text = "";
  const posOfIndex: number[] = [];
  let lastEnd: number | null = null;
  doc.descendants((node, pos) => {
    if (node.isText && node.text) {
      if (lastEnd !== null && pos > lastEnd) {
        text += "\n";
        posOfIndex.push(lastEnd);
      }
      for (let i = 0; i < node.text.length; i++) {
        text += node.text[i];
        posOfIndex.push(pos + i);
      }
      lastEnd = pos + node.nodeSize;
    }
    return true;
  });
  return { text, posOfIndex };
}

// Convert a PM position to the nearest flat-text index (used to slice
// prefix/suffix around an annotation's from/to). Returns a clamped index in
// [0, text.length].
function indexOfPos(map: TextMap, pos: number): number {
  const { posOfIndex } = map;
  if (posOfIndex.length === 0) return 0;
  // posOfIndex is non-decreasing; find first index whose pos >= target.
  let lo = 0;
  let hi = posOfIndex.length; // text.length is a valid "end" index
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (posOfIndex[mid] < pos) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// ---------------------------------------------------------------------------
// flush: offsets -> anchors
// ---------------------------------------------------------------------------
export function offsetsToAnchors(
  doc: PMNode,
  annotations: readonly OffsetAnnotation[],
): AnchoredAnnotation[] {
  const map = buildTextMap(doc);
  const { text } = map;
  return annotations.map((a) => {
    // Clamp offsets into the document; defensive against stale ranges.
    const docMax = doc.content.size;
    const from = Math.max(0, Math.min(a.from, docMax));
    const to = Math.max(from, Math.min(a.to, docMax));
    const fromIdx = indexOfPos(map, from);
    const toIdx = indexOfPos(map, to);
    const quote = text.slice(fromIdx, toIdx);
    const prefix = text.slice(Math.max(0, fromIdx - CONTEXT), fromIdx);
    const suffix = text.slice(toIdx, toIdx + CONTEXT);
    const anchor: AnchoredAnnotation = {
      id: a.id,
      quote,
      prefix,
      suffix,
      posHint: a.from,
    };
    if (a.className !== undefined) anchor.className = a.className;
    if (a.comment !== undefined) anchor.comment = a.comment;
    return anchor;
  });
}

// ---------------------------------------------------------------------------
// load: anchors -> offsets
// ---------------------------------------------------------------------------
// Score a candidate match at flat-text index `idx` by how much of the stored
// prefix/suffix context it agrees with. Higher is better; used to disambiguate
// when a quote occurs more than once.
function contextScore(
  text: string,
  idx: number,
  quoteLen: number,
  prefix: string,
  suffix: string,
): number {
  let score = 0;
  // Compare prefix from the boundary backwards.
  for (let i = 1; i <= prefix.length; i++) {
    const t = text[idx - i];
    const p = prefix[prefix.length - i];
    if (t === p) score++;
    else break;
  }
  const after = idx + quoteLen;
  for (let i = 0; i < suffix.length; i++) {
    if (text[after + i] === suffix[i]) score++;
    else break;
  }
  return score;
}

// Find all occurrences of `quote` in `text` (overlapping not needed).
function allOccurrences(text: string, quote: string): number[] {
  const out: number[] = [];
  if (quote === "") return out;
  let i = text.indexOf(quote);
  while (i !== -1) {
    out.push(i);
    i = text.indexOf(quote, i + 1);
  }
  return out;
}

export function anchorsToOffsets(
  doc: PMNode,
  anchors: readonly AnchoredAnnotation[],
): OffsetAnnotation[] {
  const map = buildTextMap(doc);
  const { text, posOfIndex } = map;
  const hintIndex = (posHint: number) => indexOfPos(map, posHint);

  return anchors.map((anchor) => {
    const base: OffsetAnnotation = {
      id: anchor.id,
      from: 0,
      to: 0,
    };
    if (anchor.className !== undefined) base.className = anchor.className;
    if (anchor.comment !== undefined) base.comment = anchor.comment;

    // An empty quote (e.g. an annotation that was already orphaned, or a
    // zero-width mark) cannot be located by content; keep it orphaned at 0.
    if (!anchor.quote) {
      return { ...base, orphaned: true } as OffsetAnnotation & {
        orphaned?: boolean;
      };
    }

    const occ = allOccurrences(text, anchor.quote);
    if (occ.length === 0) {
      // Quote no longer present: never drop user data — mark orphaned.
      return { ...base, orphaned: true } as OffsetAnnotation & {
        orphaned?: boolean;
      };
    }

    // Pick the best occurrence: maximize context agreement, break ties by
    // proximity to the position hint.
    const targetIdx = hintIndex(anchor.posHint);
    let best = occ[0];
    let bestScore = -1;
    let bestDist = Infinity;
    for (const idx of occ) {
      const score = contextScore(
        text,
        idx,
        anchor.quote.length,
        anchor.prefix ?? "",
        anchor.suffix ?? "",
      );
      const dist = Math.abs(idx - targetIdx);
      if (score > bestScore || (score === bestScore && dist < bestDist)) {
        best = idx;
        bestScore = score;
        bestDist = dist;
      }
    }

    const fromIdx = best;
    const toIdx = best + anchor.quote.length;
    const from = posOfIndex[fromIdx];
    // Exclusive end: position just after the last quoted char.
    const to =
      toIdx <= posOfIndex.length - 1
        ? posOfIndex[toIdx]
        : posOfIndex[posOfIndex.length - 1] + 1;
    return { ...base, from, to } as OffsetAnnotation;
  });
}

// Helper for callers that have a Y.Doc / markdown rather than a PM node.
export { buildTextMap };
