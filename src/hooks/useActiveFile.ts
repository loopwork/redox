import { useEffect, useState } from "react";

// The active file id is kept in the URL hash so collab links are shareable and
// the selection survives a reload.
export function useActiveFile(): [string | null, (id: string) => void] {
  const [id, setId] = useState<string | null>(
    () => window.location.hash.slice(1) || null,
  );
  useEffect(() => {
    const onHash = () => setId(window.location.hash.slice(1) || null);
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  const select = (next: string) => {
    window.location.hash = next;
  };
  return [id, select];
}
