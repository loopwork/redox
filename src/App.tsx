import "@remirror/styles/all.css";
import "./annotations.css";
import "./App.css";
import { createFile, useFiles } from "./collab";
import { useActiveFile } from "./hooks/useActiveFile";
import { Sidebar } from "./components/Sidebar";
import { FileEditor } from "./components/FileEditor";
import { EmptyState } from "./components/EmptyState";

const App: React.FC = () => {
  const files = useFiles();
  const [activeId, setActiveId] = useActiveFile();

  // Fall back to nothing when the hash points at a file that no longer exists.
  const active = files.find((f) => f.id === activeId) ?? null;

  return (
    <div className="layout">
      <Sidebar files={files} activeId={active?.id ?? null} onSelect={setActiveId} />
      <main className="content">
        {active ? (
          <FileEditor key={active.id} file={active} />
        ) : (
          <EmptyState
            hasFiles={files.length > 0}
            onCreate={() => setActiveId(createFile("Untitled").id)}
          />
        )}
      </main>
    </div>
  );
};

export default App;
