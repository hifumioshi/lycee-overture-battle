/*
 * 单人测试模式：卡牌检索二级界面（**仅开发构建**）
 *
 * 只有 VITE_DEV_TOOLS=1 时才会被动态 import（见 src/ui 里的接线点），
 * 正式构建不会产出这个 chunk，玩家版里不存在这个界面。
 *
 * 用法：进战场后点「我方卡组」位置 → 打开本界面 → 按属性/类别筛选 → 点卡即加入手牌。
 * 样式全部内联，避免依赖正式版的 CSS（开发工具不值得污染正式样式）。
 */
import { useMemo, useState } from 'react';
import type { Card } from '../../core/cards';

export type TestModeTarget = 'hand' | 'field';

export type TestModeProps = {
  cards: Card[]; // 全卡表
  onPick: (cardId: string, target: TestModeTarget) => void;
  onUntap: () => void;
  onFillHand: () => void;
  onClose: () => void;
};

const ELEMENTS = ['雪', '花', '宙', '日', '月'] as const;
const TYPES: { key: string; label: string }[] = [
  { key: 'character', label: '角色' },
  { key: 'item', label: '道具' },
  { key: 'area', label: '场地' },
];

/** 卡牌图片路径（与正式版一致：相对 index.html 的 ./images/<卡号>.png） */
const imgOf = (id: string) => `./images/${id}.png`;

export default function TestMode(props: TestModeProps) {
  const [elems, setElems] = useState<string[]>([]);
  const [types, setTypes] = useState<string[]>([]);
  const [q, setQ] = useState('');
  const [target, setTarget] = useState<TestModeTarget>('hand');

  const toggle = (arr: string[], set: (v: string[]) => void, v: string) =>
    set(arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);

  const list = useMemo(() => {
    const kw = q.trim().toLowerCase();
    return props.cards.filter((c) => {
      if (elems.length > 0 && !elems.some((e) => (c.elements ?? '').includes(e))) return false;
      if (types.length > 0 && !types.includes(c.type)) return false;
      if (kw) {
        const hay = `${c.id} ${c.name ?? ''}`.toLowerCase();
        if (!hay.includes(kw)) return false;
      }
      return true;
    });
  }, [props.cards, elems, types, q]);

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(8,12,20,0.86)',
        zIndex: 9999,
        display: 'flex',
        flexDirection: 'column',
        padding: 12,
        gap: 8,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <b style={{ fontSize: 16 }}>🧪 测试模式：卡牌检索</b>
        <span style={{ opacity: 0.7, fontSize: 12 }}>共 {list.length} 张（全卡表 {props.cards.length} 张）</span>
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          <button onClick={props.onUntap}>重置我方行动状态</button>
          <button onClick={props.onFillHand}>补满手牌</button>
          <button onClick={props.onClose}>关闭（Esc）</button>
        </span>
      </div>

      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'center', fontSize: 13 }}>
        <span>
          属性：
          {ELEMENTS.map((e) => (
            <button
              key={e}
              onClick={() => toggle(elems, setElems, e)}
              style={{ marginLeft: 4, opacity: elems.length === 0 || elems.includes(e) ? 1 : 0.4 }}
            >
              {e}
            </button>
          ))}
        </span>
        <span>
          类别：
          {TYPES.map((t) => (
            <button
              key={t.key}
              onClick={() => toggle(types, setTypes, t.key)}
              style={{ marginLeft: 4, opacity: types.length === 0 || types.includes(t.key) ? 1 : 0.4 }}
            >
              {t.label}
            </button>
          ))}
        </span>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="搜索卡号或卡名，例如 6845 / 涼花"
          style={{ minWidth: 240, padding: '4px 8px' }}
        />
        <span>
          点击后：
          <button onClick={() => setTarget('hand')} style={{ marginLeft: 4, opacity: target === 'hand' ? 1 : 0.4 }}>
            加入手牌
          </button>
          <button onClick={() => setTarget('field')} style={{ marginLeft: 4, opacity: target === 'field' ? 1 : 0.4 }}>
            直接放到我方场上（AF 空位）
          </button>
        </span>
        {(elems.length > 0 || types.length > 0 || q) && (
          <button
            onClick={() => {
              setElems([]);
              setTypes([]);
              setQ('');
            }}
          >
            清空筛选
          </button>
        )}
      </div>

      <div style={{ overflow: 'auto', display: 'grid', gridTemplateColumns: 'repeat(auto-fill, 108px)', gap: 6 }}>
        {list.map((c) => (
          <button
            key={c.id}
            title={`${c.id} ${c.name ?? ''}\n${c.type} ${c.elements ?? ''} ${c.cost ?? ''}`}
            onClick={() => props.onPick(c.id, target)}
            style={{ padding: 2, display: 'flex', flexDirection: 'column', gap: 2, cursor: 'pointer' }}
          >
            <img src={imgOf(c.id)} alt={c.id} style={{ width: 100, height: 140, objectFit: 'contain' }} />
            <span style={{ fontSize: 10, lineHeight: 1.2 }}>{c.name ?? c.id}</span>
            <span style={{ fontSize: 10, opacity: 0.7 }}>{c.id}</span>
          </button>
        ))}
        {list.length === 0 && <div style={{ opacity: 0.7 }}>没有符合条件的卡</div>}
      </div>
    </div>
  );
}
