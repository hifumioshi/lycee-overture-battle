import { useEffect, useState } from 'react';
import { Card, cardImageUrl } from '../core/cards';
import { loadDecks, SavedDeck } from '../core/deckStorage';

export interface DeckChoice {
  deckName: string;
  ids: string[]; // 空数组 = 随机测试牌组
  song: string;
  voice: string; // 绑定的语音包名（空 = 无语音）
}

/** 房间大厅里选卡组（弹窗）：用保存的卡组，或随机测试牌组 */
export default function DeckPick({
  cards,
  current,
  onPick,
  onCancel,
}: {
  cards: Card[];
  current?: string;
  onPick: (c: DeckChoice) => void;
  onCancel: () => void;
}) {
  const [decks, setDecks] = useState<SavedDeck[]>([]);

  useEffect(() => {
    setDecks(loadDecks(cards));
  }, [cards]);

  return (
    <div className="deck-pick-layer" onClick={onCancel}>
      <div className="deck-pick-box" onClick={(e) => e.stopPropagation()}>
        <div className="deck-pick-head">
          <h2>🃏 选择这局使用的卡组</h2>
          <button onClick={onCancel}>✕ 关闭</button>
        </div>

        <div className="deck-select-grid">
          {decks.length === 0 && (
            <div className="deck-select-empty">还没有保存的卡组，可先用随机测试牌组，或去「卡组制作」构建。</div>
          )}

          {decks.map((d) => (
            <button
              key={d.name}
              className={`deck-select-card${current === d.name ? ' picked' : ''}`}
              onClick={() => onPick({ deckName: d.name, ids: d.ids, song: d.song ?? '', voice: d.voice ?? '' })}
            >
              <div className="deck-select-thumbs">
                {d.ids.slice(0, 5).map((id) => {
                  const c = cards.find((x) => x.id === id);
                  return c ? <img key={id} src={cardImageUrl(id)} alt={c.name} /> : null;
                })}
              </div>
              <div className="deck-select-name">
                {d.name} {d.song && <span className="deck-song-mark">♪</span>}
              </div>
              <div className="deck-select-count">
                {d.ids.length} 张{d.song ? ` · 战歌：${d.song.replace(/\.[^.]+$/, '')}` : ''}
                {d.voice ? ` · 🎤 ${d.voice}` : ''}
              </div>
            </button>
          ))}

          <button
            className={`deck-select-card random${current === '随机测试牌组' ? ' picked' : ''}`}
            onClick={() => onPick({ deckName: '随机测试牌组', ids: [], song: '', voice: '' })}
          >
            <div className="deck-select-random-icon">🎲</div>
            <div className="deck-select-name">随机测试牌组</div>
            <div className="deck-select-count">系统自动生成 60 张</div>
          </button>
        </div>

        <div className="deck-pick-note">选好后点「准备」，双方都准备好就会自动开始对局。</div>
      </div>
    </div>
  );
}
