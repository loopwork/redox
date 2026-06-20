import { useEffect, useState } from "react";

// The active file id (a store path like "notes/My Note.md") is kept in the URL
// hash so collab links are shareable and the selection survives a reload. The
// hash percent-encodes spaces and slashes, so we decode on read and let the
// browser encode on write — otherwise the decoded id wouldn't match the file id.
function readHash(): string | null {
  const raw = window.location.hash.slice(1);
  if (!raw) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw; // malformed escape: fall back to the raw value
  }
}

export function useActiveFile(): [string | null, (id: string) => void] {
  const [id, setId] = useState<string | null>(readHash);
  useEffect(() => {
    const onHash = () => setId(readHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  const select = (next: string) => {
    window.location.hash = encodeURIComponent(next);
  };
  return [id, select];
}
