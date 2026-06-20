import { useState } from "react";

// Document header above the editor: title, a saved indicator, and Share (which
// copies the file's collaborative URL — anyone with it joins the live session).
export const TopBar: React.FC<{ name: string }> = ({ name }) => {
  const [copied, setCopied] = useState(false);

  const share = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  };

  return (
    <header className="topbar">
      <div className="topbar-title">
        <h2 className="doc-title">{name}</h2>
        <span className="saved">
          <span className="saved-check">✓</span> Saved
        </span>
      </div>
      <div className="topbar-actions">
        <button className="btn-share" onClick={share}>
          {copied ? "Link copied" : "Share"}
        </button>
      </div>
    </header>
  );
};
