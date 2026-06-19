interface EmptyStateProps {
  hasFiles: boolean;
  onCreate: () => void;
}

export const EmptyState: React.FC<EmptyStateProps> = ({ hasFiles, onCreate }) => (
  <div className="empty-state">
    <p>{hasFiles ? "Select a file from the left." : "No files yet."}</p>
    <button onClick={onCreate}>Create a file</button>
  </div>
);
