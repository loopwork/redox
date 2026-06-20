import type { Annotation } from "@remirror/extension-annotation";

// A follow-up message in an annotation's conversation thread.
export interface AnnotationReply {
  id: string;
  author: string;
  text: string;
  createdAt: number;
}

// Editor-side annotation: the base Annotation plus our custom fields. The
// AnnotationExtension is generic over this, so commands/helpers carry these
// through unchanged.
export interface MyAnnotation extends Annotation {
  className?: string;
  comment?: string;
  author?: string;
  createdAt?: number;
  replies?: AnnotationReply[];
}

// Positional shape persisted into Yjs (text is recomputed from the document).
export interface StoredAnnotation {
  id: string;
  from: number;
  to: number;
  className?: string;
  comment?: string;
  author?: string;
  createdAt?: number;
  replies?: AnnotationReply[];
}
