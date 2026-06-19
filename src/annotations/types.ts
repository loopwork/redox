import type { Annotation } from "@remirror/extension-annotation";

// Editor-side annotation: the base Annotation plus our custom fields. The
// AnnotationExtension is generic over this, so commands/helpers carry `comment`
// and `className` through.
export interface MyAnnotation extends Annotation {
  className?: string;
  comment?: string;
}

// Positional shape persisted into Yjs (text is recomputed from the document).
export interface StoredAnnotation {
  id: string;
  from: number;
  to: number;
  className?: string;
  comment?: string;
}
