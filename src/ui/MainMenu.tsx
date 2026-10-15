import VersionBadge from './VersionBadge';

export default function MainMenu({
  onMultiplayer,
  onDeckBuilder,
  onGallery,
  onDevTest,
}: {
  onMultiplayer: () => void;
  onDeckBuilder: () => void;
  onGallery: () => void;
  /** 单人测试模式（仅开发构建：由 App 在 VITE_DEV_TOOLS 条件下传入；不传则不显示按钮） */
  onDevTest?: () => void;
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
        {/* 🧪 单人测试模式：只有开发构建（App 传了 onDevTest）才显示。
            正式构建里 App 不传这个 prop，按钮与相关代码都不会出现在产物里。 */}
        {onDevTest && (
          <button className="menu-btn" onClick={onDevTest}>
            <span className="menu-icon">🧪</span>
            <span className="menu-label">单人测试模式</span>
            <span className="menu-desc">不选卡组，直接从全卡表取牌测试（开发版限定）</span>
          </button>
        )}
      </div>
      {/* 左下角：版本号 + 在线更新 */}
      <VersionBadge />
    </div>
  );
}
