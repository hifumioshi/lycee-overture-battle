import { useEffect, useMemo, useState } from 'react';
import {
  Card,
  cardImageUrl,
  TYPE_LABELS,
  ELEMENT_LABELS,
  ELEMENT_COLORS,
  RARITY_COLORS,
  parseBasicAbilities,
  ABILITY_GLOSSARY,
  formatAbilityText,
} from '../core/cards';

function cardSortKey(c: Card): [number, string] {
  const m = /^LO-(\d+)(?:-([A-Z]))?$/i.exec(c.id);
  return m ? [parseInt(m[1], 10), m[2] ?? ''] : [0, c.id];
}

export default function Gallery({ cards }: { cards: Card[] }) {
  const [query, setQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState('all');
  const [elementFilter, setElementFilter] = useState('all');
  const [selected, setSelected] = useState<Card | null>(null);

  // 调试用：地址栏带 #debug-detail 时自动打开第一张卡的详情（供截图自检）
  useEffect(() => {
    if (window.location.hash === '#debug-detail' && cards.length > 0) {
      setSelected(cards[0]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return cards
      .filter((c) => (typeFilter === 'all' ? true : c.type === typeFilter))
      .filter((c) => (elementFilter === 'all' ? true : c.elements.includes(elementFilter)))
      .filter((c) =>
        q === ''
          ? true
          : c.id.toLowerCase().includes(q) ||
            c.name.toLowerCase().includes(q) ||
            c.ability.toLowerCase().includes(q) ||
            c.cardSet.toLowerCase().includes(q),
      )
      .sort((a, b) => {
        const [an, as] = cardSortKey(a);
        const [bn, bs] = cardSortKey(b);
        return an - bn || as.localeCompare(bs);
      });
  }, [cards, query, typeFilter, elementFilter]);

  return (
    <div className="gallery">
      <header className="gallery-header">
        <h1>🎴 卡牌图鉴</h1>
        <span className="count">共 {filtered.length} / {cards.length} 张（测试区间 LO-6845 ~ LO-6971）</span>
      </header>

      <div className="toolbar">
        <input
          className="search"
          placeholder="搜索卡号 / 卡名 / 效果文本 / 卡包…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
          <option value="all">全部类型</option>
          <option value="character">角色卡</option>
          <option value="event">事件卡</option>
          <option value="item">道具卡</option>
        </select>
        <select value={elementFilter} onChange={(e) => setElementFilter(e.target.value)}>
          <option value="all">全部属性</option>
          {Object.keys(ELEMENT_LABELS).map((el) => (
            <option key={el} value={el}>
              {ELEMENT_LABELS[el]}属性
            </option>
          ))}
        </select>
      </div>

      <div className="card-grid">
        {filtered.map((c) => (
          <button key={c.id} className="card-cell" onClick={() => setSelected(c)}>
            <div
              className="card-thumb"
              style={{ borderColor: RARITY_COLORS[c.rarity] ?? '#33445e' }}
            >
              <img src={cardImageUrl(c.id)} alt={c.name} loading="lazy" />
            </div>
            <div className="card-cell-info">
              <span className="card-cell-id">{c.id}</span>
              <span className="card-cell-name">{c.name}</span>
              <span className="card-cell-type">
                {c.elements && (
                  <em style={{ color: ELEMENT_COLORS[c.elements] ?? '#ccc' }}>{c.elements}</em>
                )}
                {' · '}
                {TYPE_LABELS[c.type] ?? c.typeRaw}
              </span>
            </div>
          </button>
        ))}
      </div>

      {filtered.length === 0 && <div className="empty">没有符合条件的卡牌</div>}

      {selected && <CardDetail card={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}

function Stat({ label, value, color }: { label: string; value: string | number; color?: string }) {
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <span className="stat-value" style={color ? { color } : undefined}>
        {value}
      </span>
    </div>
  );
}

function CardDetail({ card, onClose }: { card: Card; onClose: () => void }) {
  const abilities = parseBasicAbilities(card.basicAbilities);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose}>
          ✕
        </button>
        <div className="modal-body">
          <div className="modal-image">
            <img src={cardImageUrl(card.id)} alt={card.name} />
          </div>
          <div className="modal-info">
            <h2>
              {card.name}
              <span className="modal-id">{card.id}</span>
            </h2>
            {card.abilityName && <div className="ability-name">〔{card.abilityName}〕</div>}

            <div className="stats-grid">
              <Stat label="类型" value={TYPE_LABELS[card.type] ?? card.typeRaw} />
              <Stat
                label="属性"
                value={card.elements || '—'}
                color={ELEMENT_COLORS[card.elements] ?? undefined}
              />
              <Stat label="稀有度" value={card.rarity || '—'} />
              <Stat label="EX" value={card.ex} />
              <Stat label="费用" value={card.cost || '—'} />
              {card.type === 'character' && (
                <>
                  <Stat label="配置" value={card.positionFlags || '—'} />
                  <Stat label="AP" value={card.ap} />
                  <Stat label="DP" value={card.dp} />
                  <Stat label="SP" value={card.sp} />
                  <Stat label="伤害" value={card.dmg} />
                </>
              )}
            </div>

            {abilities.length > 0 && (
              <div className="basic-abilities">
                <span className="section-title">基本能力</span>
                <div className="ability-tags">
                  {abilities.map((a, i) => {
                    const info = ABILITY_GLOSSARY[a.tag];
                    const tip = info
                      ? `【${info.kind}】${info.desc}`
                      : undefined;
                    return (
                      <span
                        key={i}
                        className="ability-tag"
                        title={tip}
                        style={tip ? { cursor: 'help' } : undefined}
                      >
                        {a.tag}
                        {a.value && <em>{a.value}</em>}
                      </span>
                    );
                  })}
                </div>
                <div className="ability-hint">（鼠标悬停可查看能力说明）</div>
              </div>
            )}

            {card.ability && (
              <div className="ability-text">
                <span className="section-title">效果文本</span>
                <pre>{formatAbilityText(card.ability)}</pre>
              </div>
            )}

            <div className="meta">
              {card.cardSet && <div>卡包：{card.cardSet}</div>}
              {card.cardSet2 && <div>卡包 2：{card.cardSet2}</div>}
              {card.brand && <div>作品：{card.brand}</div>}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
