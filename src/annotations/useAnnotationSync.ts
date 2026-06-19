import { useEffect, useRef, useState } from "react";
import { useCommands, useRemirrorContext } from "@remirror/react";
import type { Doc, YArrayEvent } from "yjs";
import { ANNOTATIONS_ARRAY, LOCAL_ORIGIN } from "../collab";
import type { MyAnnotation, StoredAnnotation } from "./types";

// Order-independent serialization of an annotation set, for change detection.
const normalize = (xs: StoredAnnotation[]): string =>
  JSON.stringify(
    [...xs]
      .map((a) => ({
        id: a.id,
        from: a.from,
        to: a.to,
        className: a.className,
        comment: a.comment,
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  );

const toStored = (a: MyAnnotation): StoredAnnotation => ({
  id: a.id,
  from: a.from,
  to: a.to,
  className: a.className,
  comment: a.comment,
});

// Two-way sync of annotations through the file's Yjs document. Must be called
// from a component rendered inside the Remirror provider. The two directions use
// different mechanisms on purpose:
//
//   Yjs -> editor (READ): a reactive effect. Annotation ranges only resolve once
//     the Yjs content has rendered into the editor (content size > 2 == more than
//     one empty paragraph), since y-prosemirror applies remote content a tick
//     after the Yjs update. Running setAnnotations from an effect (not from an
//     update listener) dispatches a clean transaction, so dependents like the
//     side-notes panel re-render.
//
//   editor -> Yjs (WRITE): an imperative update listener that reads FRESH state.
//     A render-captured snapshot can be stale exactly when content arrives, so
//     reading via the listener's `helpers` avoids clobbering stored data. The
//     `restored` guard ensures we never write the empty pre-restore state, and
//     the write is deferred to a microtask so it happens OUTSIDE ProseMirror's
//     dispatch stack (y-prosemirror re-dispatches on doc updates; an inline write
//     would recurse). The lastSynced guard stops a stable state from looping.
//
// Positions are absolute; under simultaneous edits they self-heal on convergence.
export function useAnnotationSync(doc: Doc): void {
  const { setAnnotations } = useCommands();
  const { view } = useRemirrorContext({ autoUpdate: true });
  const contentReady = view.state.doc.content.size > 2;
  const restored = useRef(false);
  // Bumped by remote (non-local) changes to re-run the read effect.
  const [remoteRev, setRemoteRev] = useState(0);
  // Serialized value of the last set we read from or wrote to Yjs. Both
  // directions compare against this so a stable state never re-syncs.
  const lastSynced = useRef<string>("");

  // READ: mirror stored annotations into the editor once content is ready, and
  // again whenever a remote peer changes them.
  useEffect(() => {
    if (!contentReady) return;
    const arr = doc.getArray<StoredAnnotation>(ANNOTATIONS_ARRAY);
    const stored = arr.toArray();
    lastSynced.current = normalize(stored);
    setAnnotations(
      stored.map((a) => ({
        id: a.id,
        from: a.from,
        to: a.to,
        className: a.className,
        comment: a.comment,
      })) as Parameters<typeof setAnnotations>[0],
    );
    restored.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contentReady, remoteRev]);

  useEffect(() => {
    const arr = doc.getArray<StoredAnnotation>(ANNOTATIONS_ARRAY);
    const observer = (e: YArrayEvent<StoredAnnotation>) => {
      if (e.transaction.origin === LOCAL_ORIGIN) return; // ignore our echoes
      setRemoteRev((v) => v + 1);
    };
    arr.observe(observer);
    return () => arr.unobserve(observer);
  }, [doc]);

  // WRITE: on every editor update, read fresh annotations and push changes.
  useRemirrorContext((props) => {
    if (!restored.current) return; // wait for the initial restore
    const next = (props.helpers.getAnnotations() as MyAnnotation[]).map(toStored);
    const ser = normalize(next);
    if (ser === lastSynced.current) return; // unchanged since last sync
    lastSynced.current = ser;
    queueMicrotask(() => {
      const arr = doc.getArray<StoredAnnotation>(ANNOTATIONS_ARRAY);
      if (normalize(arr.toArray()) === ser) return;
      doc.transact(() => {
        arr.delete(0, arr.length);
        arr.insert(0, next);
      }, LOCAL_ORIGIN);
    });
  });
}
