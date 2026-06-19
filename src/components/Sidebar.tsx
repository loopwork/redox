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

// File list with create / rename / delete, plus the local user badge.
export const Sidebar: React.FC<SidebarProps> = ({ files, activeId, onSelect }) => {
  const user = getLocalUser();
  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <strong>Files</strong>
        <button onClick={() => onSelect(createFile("Untitled").id)}>+ New</button>
      </div>
      <ul className="file-list">
        {files.map((f) => (
          <li
            key={f.id}
            className={f.id === activeId ? "file active" : "file"}
            onClick={() => onSelect(f.id)}
          >
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
        {files.length === 0 && <li className="file-empty">No files yet.</li>}
      </ul>
      <div className="sidebar-foot">
        <span className="user-dot" style={{ background: user.color }} />
        {user.name}
      </div>
    </aside>
  );
};
