export default function MainMenu({
  onMultiplayer,
  onDeckBuilder,
  onGallery,
}: {
  onMultiplayer: () => void;
  onDeckBuilder: () => void;
  onGallery: () => void;
}) {
  return (
    <div className="main-menu">
      <div className="menu-title">
        <h1>🎴 Lycee Overture 对战平台</h1>
        <p className="menu-sub">开始你的对战</p>
      </div>
      <div className="menu-buttons">
        <button className="menu-btn" onClick={onMultiplayer}>
          <span className="menu-icon">🌐</span>
          <span className="menu-label">多人游戏</span>
          <span className="menu-desc">开房间 / 加入房间（联网对战）</span>
        </button>
        <button className="menu-btn" onClick={onDeckBuilder}>
          <span className="menu-icon">🃏</span>
          <span className="menu-label">卡组制作</span>
          <span className="menu-desc">构建你的 60 张卡组</span>
        </button>
        <button className="menu-btn" onClick={onGallery}>
          <span className="menu-icon">📖</span>
          <span className="menu-label">卡牌图鉴</span>
          <span className="menu-desc">浏览与查看卡牌</span>
        </button>
      </div>
    </div>
  );
}
