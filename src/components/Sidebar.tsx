import { useState } from "react";
import {
  createFile,
  deleteFile,
  getLocalUser,
  renameFile,
  type FileMeta,
} from "../collab";

interface SidebarProps {
  files: FileMeta[];
  activeId: string | null;
  onSelect: (id: string) => void;
}

const initials = (name: string): string =>
  name
    .split(/\s+/)
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase() || "?";

// A small document glyph for each file row.
const FileIcon: React.FC = () => (
  <svg className="file-icon" viewBox="0 0 16 16" aria-hidden>
    <path
      d="M4 1.5h5L13 5.5V14a.5.5 0 0 1-.5.5h-9A.5.5 0 0 1 3 14V2a.5.5 0 0 1 .5-.5Z"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.1"
    />
    <path d="M9 1.5V5.5h4" fill="none" stroke="currentColor" strokeWidth="1.1" />
  </svg>
);

// File list with create / rename / delete, a search filter, and the local user.
export const Sidebar: React.FC<SidebarProps> = ({
  files,
  activeId,
  onSelect,
}) => {
  const user = getLocalUser();
  const [query, setQuery] = useState("");
  const shown = files.filter((f) =>
    f.name.toLowerCase().includes(query.trim().toLowerCase()),
  );

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <div className="brand">
          <span className="brand-logo">R</span>
          <strong>Files</strong>
        </div>
        <button
          className="btn-new"
          onClick={() => {
            const name = window.prompt("New file name");
            if (name == null) return; // cancelled
            onSelect(createFile(name).id);
          }}
        >
          + New
        </button>
      </div>

      <div className="sidebar-search">
        <svg viewBox="0 0 16 16" className="search-icon" aria-hidden>
          <circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" />
          <path d="M11 11l3 3" stroke="currentColor" strokeWidth="1.2" />
        </svg>
        <input
          value={query}
          placeholder="Search files…"
          onChange={(e) => setQuery(e.target.value)}
        />
        <span className="kbd">⌘K</span>
      </div>

      <div className="sidebar-section">Documents</div>

      <ul className="file-list">
        {shown.map((f) => (
          <li
            key={f.id}
            className={f.id === activeId ? "file active" : "file"}
            onClick={() => onSelect(f.id)}
          >
            <FileIcon />
            <span className="file-name" title={f.name}>
              {f.name}
            </span>
            <span className="file-actions">
              <button
                title="Rename"
                onClick={(e) => {
                  e.stopPropagation();
                  const name = window.prompt("Rename file", f.name);
                  if (name != null) renameFile(f.id, name);
                }}
              >
                ✎
              </button>
              <button
                title="Delete"
                onClick={(e) => {
                  e.stopPropagation();
                  if (window.confirm(`Delete "${f.name}"?`)) deleteFile(f.id);
                }}
              >
                ✕
              </button>
            </span>
          </li>
        ))}
        {shown.length === 0 && (
          <li className="file-empty">
            {query ? "No matching files." : "No files yet."}
          </li>
        )}
      </ul>

      <div className="sidebar-foot">
        <span className="avatar" style={{ background: user.color }}>
          {initials(user.name)}
        </span>
        <span className="user-name">{user.name}</span>
        <span className="foot-gear" aria-hidden>
          ⚙
        </span>
      </div>
    </aside>
  );
};
