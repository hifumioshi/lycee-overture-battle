import { useState } from 'react';

/** 右上角「我的 ID」：点一下即可修改，改完自动记住（本地保存） */
export default function PlayerBadge({ name, onChange }: { name: string; onChange: (n: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);

  const commit = () => {
    onChange(draft);
    setEditing(false);
  };

  if (!editing) {
    return (
      <button className="player-badge" title="点击修改我的 ID" onClick={() => { setDraft(name); setEditing(true); }}>
        👤 我的ID：<b>{name}</b>
        <span className="player-badge-edit">✎</span>
      </button>
    );
  }

  return (
    <span className="player-badge editing">
      <span className="player-badge-label">👤 我的ID</span>
      <input
        className="player-badge-input"
        value={draft}
        maxLength={12}
        autoFocus
        placeholder="最多12个字"
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
          if (e.key === 'Escape') setEditing(false);
        }}
      />
      <button className="primary" onClick={commit}>
        保存
      </button>
    </span>
  );
}
