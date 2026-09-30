import { useEffect, useState } from 'react';
import { Card, loadCards } from './core/cards';
import { loadDecks } from './core/deckStorage';
import { getPlayerName, setPlayerName } from './core/profile';
import MainMenu from './ui/MainMenu';
import Battlefield from './ui/Battlefield';
import DeckBuilder from './ui/DeckBuilder';
import Gallery from './ui/Gallery';
import Multiplayer from './ui/Multiplayer';
import PlayerBadge from './ui/PlayerBadge';
import type { NetMode } from './net/protocol';

type View = 'menu' | 'battle' | 'deck' | 'gallery' | 'multi';

interface BattleInit {
  mode: NetMode;
  address?: string;
}

// 主应用：主菜单 → 多人游戏（房间列表 → 房间内选卡组）/ 卡组制作 / 图鉴
export default function App() {
  const [cards, setCards] = useState<Card[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>('menu');
  const [battleInit, setBattleInit] = useState<BattleInit | null>(null);
  const [battleSeq, setBattleSeq] = useState(0); // 每次进房间都重建战场组件（避免残留状态）
  const [deck, setDeck] = useState<string[]>([]);
  const [deckSong, setDeckSong] = useState('');
  const [playerName, setPlayerNameState] = useState(() => getPlayerName());

  useEffect(() => {
    loadCards()
      .then((c) => {
        setCards(c);
        const decks = loadDecks(c);
        if (decks.length > 0) {
          setDeck(decks[decks.length - 1].ids); // 默认用最近保存的卡组（卡组制作里编辑用）
          setDeckSong(decks[decks.length - 1].song ?? '');
        }
      })
      .catch((e) => setError(e.message));
  }, []);

  // 调试钩子：暴露当前使用的卡组（供自动化测试检查）
  useEffect(() => {
    (window as unknown as { __activeDeck?: string[] }).__activeDeck = deck;
  }, [deck]);

  const changeName = (n: string) => setPlayerNameState(setPlayerName(n));

  if (error) return <div className="loading-box">⚠️ 卡牌数据加载失败：{error}</div>;
  if (!cards) return <div className="loading-box">正在加载卡牌数据…</div>;

  const enterBattle = (mode: NetMode, address?: string) => {
    setBattleInit({ mode, address });
    setBattleSeq((n) => n + 1);
    setView('battle');
  };

  return (
    <div className="app">
      <nav className="top-nav">
        <span className="nav-brand">🎴 Lycee Overture 对战平台</span>
        {view !== 'menu' && <button onClick={() => setView('menu')}>← 主菜单</button>}
        <PlayerBadge name={playerName} onChange={changeName} />
      </nav>

      {view === 'menu' && (
        <MainMenu
          onMultiplayer={() => setView('multi')}
          onDeckBuilder={() => setView('deck')}
          onGallery={() => setView('gallery')}
        />
      )}

      {view === 'multi' && (
        <Multiplayer
          playerName={playerName}
          onEnter={(role, roomLabel) => enterBattle(role, roomLabel)}
          onBack={() => setView('menu')}
        />
      )}

      {view === 'battle' && battleInit && (
        <Battlefield
          key={`${battleSeq}-${battleInit.mode}-${battleInit.address ?? ''}`}
          cards={cards}
          deck={deck}
          deckSong={deckSong}
          playerName={playerName}
          initialMode={battleInit.mode}
          initialAddress={battleInit.address}
        />
      )}

      {view === 'deck' && (
        <DeckBuilder cards={cards} deck={deck} onSave={(d) => setDeck(d)} onBack={() => setView('menu')} />
      )}

      {view === 'gallery' && <Gallery cards={cards} />}
    </div>
  );
}
