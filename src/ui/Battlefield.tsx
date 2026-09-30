import { useEffect, useRef, useState } from 'react';
import { Card, cardImageUrl, parseBasicAbilities, ABILITY_GLOSSARY, ELEMENT_COLORS, formatAbilityText } from '../core/cards';
import {
  GameState,
  PlayerIndex,
  RowName,
  AreaIndex,
  ZoneName,
  CardInstance,
  findInstance,
  moveTo,
  toggleTapped,
  toggleFaceUp,
  pushLog,
} from '../core/game';
import { startGame } from '../core/sampleDeck';
import { effectiveStats } from '../core/effects';
import { getParsed } from '../core/effectEngine';
import { effectiveStats as engStats } from '../core/effectEngine';
import { hasHandDeclare, hasDeclare, hasMoveAbility } from '../core/abilities';
import * as rules from '../core/rules';
import { applyAction, canGuestAct, promptOwner, NetAction, NetState, NetHash, NetAck, NetOp, NetRevReport, NetDesync, NetDesyncReport, NetRoomState, NetMode } from '../net/protocol';
import * as relay from '../net/relay';
import { foldersOf, pickVariant } from '../core/voice';
import { encodeState, decodeState, resetEncode, resetDecode, packetSize, fullSize, stateHash, stateSlotHashes, hashHex, divergentSlots, currentRev, currentSeq, currentDecodeRev } from '../net/gsSync';
import type { VoiceCue } from '../core/game';
import { RoomState, createRoom, roomAddClient, roomRemoveClient, roomSit, roomStand, roomReady, roomUnready, roomSetDeck, bothReady, roomStartGame, roomRematch, seatOf, HOST_CID } from '../core/room';
import RoomLobby from './RoomLobby';
import DeckPick, { DeckChoice } from './DeckPick';

const ZONE_NAMES: Record<ZoneName, string> = {
  deck: '牌堆',
  hand: '手札',
  field: '场上',
  trash: 'ゴミ箱',
  shield: 'シールド',
  special: '特殊置場',
  removed: '除外',
  area: 'エリア',
  equip: '装备中',
};

const AREA_NAMES = ['左', '中', '右'];

const PHASE_LABELS: Record<string, string> = {
  start: '开始阶段（待开始回合）',
  main: '主阶段',
  end: '结束阶段（手牌调整）',
  gameover: '对局结束',
};

const NET_PORT = 9527;

/** 单张卡牌渲染 */
function BoardCard({
  inst,
  card,
  selected,
  onClick,
  onHover,
  size = 'field',
  hidden = false,
  deployBadge = false,
  equipCard,
  onEquipClick,
}: {
  inst: CardInstance;
  card?: Card;
  selected: boolean;
  onClick: (rect: DOMRect) => void;
  onHover?: () => void;
  size?: 'field' | 'hand' | 'zone';
  hidden?: boolean;
  deployBadge?: boolean;
  equipCard?: Card;
  onEquipClick?: (rect: DOMRect) => void;
}) {
  const cls = ['board-card', `size-${size}`];
  if (selected) cls.push('selected');
  if (inst.tapped) cls.push('tapped');
  if (!inst.faceUp || hidden) cls.push('face-down');
  return (
    <div
      className={cls.join(' ')}
      onClick={(e) => {
        e.stopPropagation();
        onClick(e.currentTarget.getBoundingClientRect());
      }}
      onMouseEnter={onHover}
    >
      {inst.faceUp && !hidden && card ? (
        <img src={cardImageUrl(card.id)} alt={card.name} draggable={false} />
      ) : (
        <div className="card-back">LO</div>
      )}
      {deployBadge && <span className="deploy-badge">新</span>}
      {inst.charge.length > 0 && <span className="charge-badge">⚡{inst.charge.length}</span>}
      {inst.under.length > 0 && <span className="under-badge">📥{inst.under.length}</span>}
      {equipCard && !hidden && (
        <span
          className="equip-badge"
          title={`道具：${equipCard.name}（点击查看道具信息）`}
          onClick={(e) => {
            e.stopPropagation();
            onEquipClick?.(e.currentTarget.getBoundingClientRect());
          }}
        >
          <img src={cardImageUrl(equipCard.id)} alt="" draggable={false} />
        </span>
      )}
    </div>
  );
}

/** 带数据的卡牌包装 */
function CardWrap({
  gs,
  inst,
  selected,
  hidden,
  size,
  onCardClick,
  onCardHover,
}: {
  gs: GameState;
  inst: CardInstance;
  selected: boolean;
  hidden?: boolean;
  size?: 'field' | 'hand' | 'zone';
  onCardClick: (uid: string, rect: DOMRect) => void;
  onCardHover: (uid: string | null) => void;
}) {
  const card = gs.cardsById[inst.cardId];
  const deployBadge = card?.type === 'character' && inst.deployedTurn === gs.turn;
  const equipCard = inst.equip ? gs.cardsById[inst.equip.cardId] : undefined;
  return (
    <BoardCard
      inst={inst}
      card={card}
      selected={selected}
      hidden={hidden}
      size={size ?? 'field'}
      deployBadge={deployBadge}
      equipCard={equipCard}
      onClick={(rect) => onCardClick(inst.uid, rect)}
      onHover={() => onCardHover(inst.uid)}
      onEquipClick={(rect) => inst.equip && onCardClick(inst.equip.uid, rect)}
    />
  );
}

export default function Battlefield({
  cards,
  deck,
  initialMode = 'local',
  initialAddress,
  deckSong = '',
  playerName = '玩家',
}: {
  cards: Card[];
  deck: string[];
  initialMode?: NetMode;
  initialAddress?: string;
  deckSong?: string;
  playerName?: string;
}) {
  const [gs, setGs] = useState<GameState>(() => startGame(cards, deck));
  const [selected, setSelected] = useState<string | null>(null);
  const [hoverUid, setHoverUid] = useState<string | null>(null);
  const [moveModeUid, setMoveModeUid] = useState<string | null>(null); // 移动模式：选中要移动的角色
  const [deploySlotUid, setDeploySlotUid] = useState<string | null>(null); // 登场模式：等待玩家选择登场位置
  const [trashView, setTrashView] = useState<PlayerIndex | null>(null); // ゴミ箱查看界面
  const [removedView, setRemovedView] = useState<PlayerIndex | null>(null); // 除外区查看界面
  const [storageView, setStorageView] = useState<{ player: PlayerIndex; name: string } | null>(null); // 置き場查看界面
  const [underView, setUnderView] = useState<string | null>(null); // エリア/角色下方卡查看界面（Bug 10）
  const [menuPos, setMenuPos] = useState<{ uid: string; x: number; y: number } | null>(null); // 卡片旁弹出菜单位置
  const [pendingStat, setPendingStat] = useState<{ stat: string; amount: number } | null>(null); // 手动结算：等待点目标角色
  const [mode, setMode] = useState<NetMode>(initialMode);
  const [netStatus, setNetStatus] = useState(initialMode === 'host' ? '正在创建房间…' : initialMode === 'guest' ? '正在连接…' : '单机模式');
  const [guestConnected, setGuestConnected] = useState(false);
  const [wsInput, setWsInput] = useState('127.0.0.1:9527');
  const [myName, setMyName] = useState(playerName); // 我的显示名（房间里的 ID）
  const [room, setRoom] = useState<RoomState | null>(null); // 房间状态（房主权威；客机/观战者接收）
  const [myCid, setMyCid] = useState<number | null>(null); // 我的客户端 id（客机/观战者来自 welcome）
  // 房间里选的卡组（房内选卡组，不再在进房前选）
  const [myDeckIds, setMyDeckIds] = useState<string[]>(deck.length > 0 ? deck : []);
  const [myDeckName, setMyDeckName] = useState<string>(deck.length > 0 ? '上次用的卡组' : '');
  const myDeckSongRef = useRef<string>(deckSong);
  const myDeckVoiceRef = useRef<string>(''); // 本机卡组绑定的语音包
  // 语音包清单（data/voices）：包名 → 各行为的台词文件
  const [voicePacks, setVoicePacks] = useState<{ name: string; actions: { folder: string; files: { file: string; url: string }[] }[] }[]>([]);
  const [pickDeck, setPickDeck] = useState(false); // 卡组选择弹窗

  const gsRef = useRef(gs);
  useEffect(() => {
    gsRef.current = gs;
    gsLiveRef.current = gs; // 任何 setGs（含直接用 setGs 的地方）都要同步到「即时副本」
  }, [gs]);
  /** 权威状态的即时副本：房主/单机所有改动同步写这里（不等 React 渲染），避免发包/回执用到过期状态 */
  const gsLiveRef = useRef(gs);
  const commitGs = (next: GameState) => {
    gsLiveRef.current = next;
    setGs(next);
  };
  // 增量同步：客机侧的状态基线（立即更新，不等 React 渲染）+ 最近一次重同步请求时间 + 房主侧最近发包信息
  const guestGsRef = useRef<GameState | null>(null);
  const lastResyncRef = useRef(0);
  const lastPktRef = useRef('');
  // ===== 同步诊断 + 操作确认（对齐）=====
  const [diag, setDiag] = useState({
    rtt: -1, // 本机 ↔ 中继服务器往返延迟(ms)
    rev: 0, // 我当前的状态版本
    hash: '', // 我的校验码（8 位十六进制）
    ok: true, // 我的校验码与房主是否一致
    pending: 0, // 等待房主回执的操作数
    peerRev: -1, // 对方已同步到的版本（房主视角）
    peerOk: true, // 对方校验码是否与房主一致
    paths: [] as string[], // 分车时不一致的字段
    warn: '', // 红色警告文字
    empty: 0, // 校验不一致累计次数
  });
  const [diagOpen, setDiagOpen] = useState(false);
  const pktLogRef = useRef<string[]>([]);
  const pushPktLog = (line: string) => {
    pktLogRef.current = [`${new Date().toLocaleTimeString()} ${line}`, ...pktLogRef.current].slice(0, 10);
  };
  const opSeqRef = useRef(0);
  const pendingOpsRef = useRef(new Map<string, { label: string; at: number; resent: boolean }>());
  const [pendingLabel, setPendingLabel] = useState<string>(''); // 等待房主确认的提示文字
  const guestRevReportAtRef = useRef(0);
  const doneOpIdsRef = useRef<string[]>([]); // 房主：处理过的 opId（去重，防连点/重发双执行）
  const pendingAcksRef = useRef<{ opId: string; ok: boolean; reason?: string; message?: string }[]>([]);
  const guestRevRef = useRef<{ rev: number; hash: number }>({ rev: -1, hash: 0 });
  const hashMismatchAtRef = useRef(0);
  const [alignMsg, setAlignMsg] = useState<string | null>(null); // "已自动对齐"等提示
  const staleAskRef = useRef(false); // 房主：需要给客机补发整份
  const lastStateAtRef = useRef(0); // 房主：最近一次广播状态的时间（心跳用）
  // ===== 悔棋（Undo）：记录每次状态变化前的快照；房主/单机权威，客机通过请求让房主恢复 =====
  const undoStackRef = useRef<GameState[]>([]);
  const prevGsRef = useRef<GameState | null>(null);
  const skipUndoRecRef = useRef(false);
  const [undoWait, setUndoWait] = useState(false); // 已发出悔棋请求，等待对方同意
  const [undoAsk, setUndoAsk] = useState<string | null>(null); // 对方请求悔棋（显示"来自谁"）
  const [undoMsg, setUndoMsg] = useState<string | null>(null); // 悔棋提示（如已撤销/对方拒绝）
  useEffect(() => {
    if (!undoMsg) return;
    const t = setTimeout(() => setUndoMsg(null), 5000);
    return () => clearTimeout(t);
  }, [undoMsg]);
  const logRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [gs.log]);

  /* ===== Alt+滚轮 放大卡图（屏幕中央，Alt 松开消失；Bug ⑦） ===== */
  const [zoomOn, setZoomOn] = useState(false);
  const [zoomScale, setZoomScale] = useState(1);
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === 'Alt') setZoomOn(true);
    };
    const up = (e: KeyboardEvent) => {
      if (e.key === 'Alt') setZoomOn(false);
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, []);
  const zoomUid = selected ?? hoverUid;
  const zoomLoc = zoomUid ? findInstance(gs, zoomUid) : null;
  const zoomInst = zoomLoc ? getInstAt(gs, zoomLoc) : undefined;
  const zoomCard: Card | undefined = zoomOn && zoomInst ? gs.cardsById[zoomInst.cardId] : undefined;
  useEffect(() => {
    if (!zoomCard) setZoomScale(1);
  }, [zoomCard]);
  useEffect(() => {
    if (!zoomCard) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      setZoomScale((s) => Math.min(6, Math.max(1, s * (e.deltaY < 0 ? 1.14 : 0.88))));
    };
    window.addEventListener('wheel', onWheel, { passive: false });
    return () => window.removeEventListener('wheel', onWheel);
  }, [zoomCard]);
  /* ===== 点任意卡（ゴミ箱/充能/下方/装备等列表）→ 弹大图查效果（Bug ②） ===== */
  const [peekCard, setPeekCard] = useState<Card | null>(null);
  /* ===== 战歌：切札发动信号 → 播放发动者卡组绑定的歌（双方端本地各播一遍） ===== */
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [songPlaying, setSongPlaying] = useState<string | null>(null);
  const trumpKey = gs.trumpSignal ? `${gs.trumpSignal.owner}:${gs.trumpSignal.turn}` : null;
  useEffect(() => {
    if (!trumpKey || !gs.trumpSignal) return;
    const song = gs.players[gs.trumpSignal.owner as PlayerIndex].song;
    if (!song) return;
    let cancelled = false;
    (async () => {
      try {
        const api = (window as { lyceeSongs?: { list(): Promise<{ file: string; name: string; url: string }[]> } }).lyceeSongs;
        const list = api ? await api.list() : [];
        const it = list.find((x) => x.file === song);
        if (cancelled || !it) return;
        audioRef.current?.pause();
        const a = new Audio(it.url);
        audioRef.current = a;
        setSongPlaying(it.name);
        a.onended = () => {
          if (audioRef.current === a) {
            audioRef.current = null;
            setSongPlaying(null);
          }
        };
        a.onerror = () => {
          if (audioRef.current === a) {
            audioRef.current = null;
            setSongPlaying(null);
          }
        };
        void a.play().catch(() => {
          if (audioRef.current === a) {
            audioRef.current = null;
            setSongPlaying(null);
          }
        });
      } catch {
        /* 忽略 */
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trumpKey]);
  useEffect(
    () => () => {
      audioRef.current?.pause();
      audioRef.current = null;
    },
    [],
  );

  /* ===== 语音（台词）：对局中的行为队列 → 播放「行动者」卡组绑定的语音包对应台词 =====
     一次结算可能连发多条（登场→効果発動→抽牌…），所以按队列顺序逐条播放；
     两台电脑用同一个种子算出同一个文件，所以播的是同一句；多个版本时随机但不连续重复。 */
  const voicePacksRef = useRef<{ name: string; actions: { folder: string; files: { file: string; url: string }[] }[] }[]>([]);
  const playedVoiceSeqRef = useRef(0); // 已播到的队列号（房主/客机一致）
  const voiceQueueRef = useRef<VoiceCue[]>([]); // 待播队列
  const voiceBusyRef = useRef(false); // 正在播（播完再取下一句）
  const voiceAudioRef = useRef<HTMLAudioElement | null>(null); // 台词独立播放（不打断战歌）
  const lastVoiceIdxRef = useRef(new Map<string, number>()); // 上一次播的下标（避免连续重复）
  const gsVoiceNameRef = useRef(new Map<PlayerIndex, string>()); // 各玩家绑定的语音包（同步来的）
  // 载入语音包清单
  useEffect(() => {
    let dead = false;
    const load = async () => {
      try {
        const api = (window as { lyceeVoices?: { list(): Promise<{ name: string; actions: { folder: string; files: { file: string; url: string }[] }[] }[]> } }).lyceeVoices;
        const list = api ? await api.list() : [];
        if (!dead) {
          voicePacksRef.current = list;
          setVoicePacks(list);
        }
      } catch {
        /* 无语音能力 */
      }
    };
    void load();
    return () => {
      dead = true;
    };
  }, []);
  // 播完一句后自动继续取下一句
  const pumpVoice = () => {
    if (voiceBusyRef.current) return;
    const cue = voiceQueueRef.current.shift();
    if (!cue) return;
    const owner = cue.owner as PlayerIndex;
    const packName = gsVoiceNameRef.current.get(owner) ?? '';
    const pack = packName ? voicePacksRef.current.find((p) => p.name === packName) : undefined;
    if (pack) {
      const folders = foldersOf(cue.action);
      const entry = folders.map((f) => pack.actions.find((a) => a.folder === f)).find(Boolean);
      const files = entry?.files ?? [];
      if (files.length > 0) {
        const seed = `${owner}:${cue.turn}:${cue.action}:${cue.seq}`;
        const lastKey = `${packName}:${cue.action}`;
        const idx = pickVariant(files.map((f) => f.file), seed, lastVoiceIdxRef.current.get(lastKey) ?? -1);
        if (idx >= 0) {
          lastVoiceIdxRef.current.set(lastKey, idx);
          const chosen = files[idx];
          try {
            (window as unknown as { __lastVoice?: string }).__lastVoice = `${packName}/${entry?.folder}/${chosen.file}`;
          } catch {
            /* 忽略 */
          }
          try {
            voiceBusyRef.current = true;
            const a = new Audio(chosen.url);
            voiceAudioRef.current = a;
            const done = () => {
              if (voiceAudioRef.current === a) voiceAudioRef.current = null;
              voiceBusyRef.current = false;
              pumpVoice();
            };
            a.onended = done;
            a.onerror = done;
            void a.play().catch(done);
            return; // 等这句播完再继续
          } catch {
            voiceBusyRef.current = false;
          }
        }
      }
    }
    pumpVoice(); // 这一句没有素材 → 直接看下一条
  };
  const voiceQueue = gs.voiceQueue ?? [];
  useEffect(() => {
    // 各玩家绑定的语音包
    const m = new Map<PlayerIndex, string>();
    for (const p of [0, 1] as PlayerIndex[]) {
      const v = gs.players[p]?.voice;
      if (v) m.set(p, v);
    }
    gsVoiceNameRef.current = m;
    // 取出还没播过的 cue（seq 单调递增；悔棋回退时不会重播旧的）
    const fresh = voiceQueue.filter((c) => c.seq > playedVoiceSeqRef.current);
    if (fresh.length === 0) return;
    playedVoiceSeqRef.current = fresh[fresh.length - 1].seq;
    voiceQueueRef.current.push(...fresh);
    pumpVoice();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voiceQueue]);
  const stopSong = () => {
    audioRef.current?.pause();
    audioRef.current = null;
    setSongPlaying(null);
  };
  useEffect(() => {
    if (mode !== 'local' && mode !== 'host') return; // 客机状态来自房主广播，无需本地栈
    const prev = prevGsRef.current;
    prevGsRef.current = gs;
    if (prev === gs || !prev) return;
    if (skipUndoRecRef.current) {
      skipUndoRecRef.current = false;
      return;
    }
    // 不记录：纯展示性/开局洗牌前后（ready/石头剪刀布/起手换牌由同一 setGs 也进入，但无害）
    undoStackRef.current.push(structuredClone(prev));
    if (undoStackRef.current.length > 90) undoStackRef.current.shift();
  }, [gs, mode]);
  // 对局开始（再来一局后）清空旧对局历史
  useEffect(() => {
    if (mode === 'host' && room?.phase === 'playing') {
      undoStackRef.current = [];
      prevGsRef.current = null;
    }
  }, [room?.phase, mode]);
  const undoCount = mode === 'guest' ? -1 : undoStackRef.current.length; // 客机由房主裁决（-1 不显示数字）
  /** 悔棋：恢复到最近的“无提示卡死/可操作”快照（最多回退 8 步），否则退回栈顶一步 */
  const doUndo = () => {
    const stack = undoStackRef.current;
    if (stack.length === 0) {
      setUndoMsg('没有更早的步骤可撤销。');
      return;
    }
    let target = stack.pop()!;
    let depth = 1;
    while (depth < 8 && stack.length > 0 && target.prompt !== null) {
      target = stack.pop()!;
      depth++;
    }
    skipUndoRecRef.current = true;
    prevGsRef.current = null;
    commitGs(structuredClone(target));
    setUndoWait(false);
    setUndoAsk(null);
    setSelected(null);
    setMenuPos(null);
    setDeploySlotUid(null);
    setMoveModeUid(null);
    setPendingStat(null);
    setUndoMsg(`已撤销到上一步（回退 ${depth} 步）。`);
    // 房主：撤销即新状态 → [gs] effect 自动广播；被请求方同为房主时告知对方
    if (mode === 'host') {
      const cid = oppSeatCid();
      try {
        if (cid !== null) relay.sendTo(cid, { type: 'undoReply', ok: true });
      } catch {
        /* 忽略 */
      }
    }
  };
  const oppSeatCid = (): number | null => {
    const r = roomRef.current;
    if (!r) return null;
    const mine = myCidRef.current ?? HOST_CID;
    if (r.seat1?.cid === mine) return r.seat2?.cid ?? null;
    if (r.seat2?.cid === mine) return r.seat1?.cid ?? null;
    return null;
  };
  /** 发起悔棋：本地直接确认；联机需对方同意 */
  const requestUndo = () => {
    if (mode === 'local') {
      if (undoStackRef.current.length === 0) {
        setUndoMsg('没有更早的步骤可撤销。');
        return;
      }
      if (window.confirm('悔棋：恢复到上一步可操作状态？（用于卡死等异常时）')) doUndo();
      return;
    }
    if (mode === 'guest') {
      relay.sendTo(HOST_CID, { type: 'undoRequest' });
      setUndoWait(true);
      setUndoMsg(null);
      return;
    }
    // host 发起
    const cid = oppSeatCid();
    if (cid === null) return;
    try {
      relay.sendTo(cid, { type: 'undoRequest' });
      setUndoWait(true);
      setUndoMsg(null);
    } catch {
      /* 忽略 */
    }
  };
  const guestWsRef = useRef<WebSocket | null>(null);
  /** 同意/拒绝对方的悔棋请求 */
  const replyUndo = (ok: boolean) => {
    if (mode === 'guest') {
      relay.sendTo(HOST_CID, { type: 'undoReply', ok });
      if (ok) setUndoMsg('你同意悔棋，等待房主恢复…');
    } else if (mode === 'host') {
      const cid = oppSeatCid();
      if (cid !== null) {
        try {
          relay.sendTo(cid, { type: 'undoReply', ok });
        } catch {
          /* 忽略 */
        }
      }
      if (ok) doUndo();
      else setUndoMsg('你拒绝了对方的悔棋请求。');
    }
    setUndoAsk(null);
  };
  const myCidRef = useRef<number | null>(null);
  const roomRef = useRef<RoomState | null>(null);
  roomRef.current = room;
  const decksByCid = useRef(new Map<number, string[]>()); // 客机/观战者上桌后准备的卡组
  const songsByCid = useRef(new Map<number, string>()); // 各客户端卡组绑定的战歌
  const voicesByCid = useRef(new Map<number, string>()); // 各客户端卡组绑定的语音包
  const deckSongRef = useRef(deckSong);

  // 身份推导：座位1=玩家0，座位2=玩家1，其余=观战（-1）
  const myCidOrHost: number = mode === 'host' ? HOST_CID : (myCid ?? -2);
  const mySeat = room ? seatOf(room, myCidOrHost) : null;
  const myPlayer: PlayerIndex | -1 = mode === 'local' ? 0 : mySeat === 'seat1' ? 0 : mySeat === 'seat2' ? 1 : -1;
  const selfPlayer: PlayerIndex = (myPlayer >= 0 ? myPlayer : 0) as PlayerIndex; // 自己一方（观战时用 0 渲染，手牌会隐藏）
  const oppPlayer: PlayerIndex = (1 - selfPlayer) as PlayerIndex;
  const spPrompt = gs.prompt?.kind === 'slot-pick' ? gs.prompt : null; // 登场位置选择提示（点场上高亮空格处理）

  const isNet = mode !== 'local';
  const isSpectatorView = mode === 'spectator' || (mode !== 'local' && room !== null && myPlayer < 0 && room.phase === 'playing');
  const showLobby = mode !== 'local' && room !== null && room.phase === 'lobby';

  // 登场位置选择（slot-pick）改为与正常宣言登场一致：点场上高亮空格，而非弹出按钮选项（Bug ①）
  const slotPickActiveRef = useRef(false);
  useEffect(() => {
    const p = gs.prompt;
    const isNow = p?.kind === 'slot-pick';
    const was = slotPickActiveRef.current;
    if (was && !isNow) setDeploySlotUid(null); // slot-pick 刚结算/取消 → 清除高亮
    slotPickActiveRef.current = isNow;
    if (isNow && !isSpectatorView && p.uid && (mode === 'local' || promptOwner(p, gs.turnPlayer) === myPlayer)) {
      setDeploySlotUid(p.uid);
    }
  }, [gs.prompt, gs.turnPlayer, mode, myPlayer, isSpectatorView]);

  /* ===== 统一动作入口 =====
     单机/房主：本地立即应用（房主是权威，不必等）
     上桌客机：发给房主**并等待回执**（带 opId 去重 + 我看到的状态版本），期间按钮显示「等待房主…」
     观战者：不可操作 */
  const doAction = (action: string, ...args: unknown[]) => {
    if (mode === 'guest') {
      sendOp(action, args);
      return;
    }
    if (mode === 'spectator' || isSpectatorView) {
      setNetStatus('观战中：只能观看，不能操作。');
      return;
    }
    commitGs(applyAction(gsLiveRef.current, action, args));
  };

  /** 客机 → 房主：带确认的操作 */
  const sendOp = (action: string, args: unknown[], label?: string) => {
    opSeqRef.current += 1;
    const opId = `${Date.now().toString(36)}-${opSeqRef.current}`;
    pendingOpsRef.current.set(opId, { label: label ?? action, at: Date.now(), resent: false });
    setPendingLabel(label ?? '');
    setDiag((d) => ({ ...d, pending: pendingOpsRef.current.size }));
    relay.sendTo(HOST_CID, { type: 'op', opId, action, args, rev: currentDecodeRev() } satisfies NetOp);
    pushPktLog(`→ 操作 ${action}（opId=${opId}）`);
  };

  /* ===== 房主：广播房间/对局状态（经中继服务器） ===== */
  /** 房主 → 全房：只发对局状态里变化的部分（增量） */
  const sendStateAll = (g: GameState, opts: { full?: boolean } = {}) => {
    if (mode !== 'host') return;
    const pkt = encodeState(g, { full: opts.full });
    relay.broadcast({ type: 'state', pkt } satisfies NetState);
    lastStateAtRef.current = Date.now();
    lastPktRef.current = `${pkt.kind} rev=${pkt.rev} ${packetSize(pkt)}B（整份 ${fullSize(g)}B）`;
    pushPktLog(`→ 状态 ${pkt.kind} rev=${pkt.rev} seq=${pkt.seq} ${packetSize(pkt)}B ${hashHex(pkt.hash)}`);
    setDiag((d) => ({ ...d, rev: pkt.rev, hash: hashHex(pkt.hash), ok: true }));
    // 状态发出去之后，把「等待回执」的操作一次性确认掉（带上真正包含这次改动的版本号）
    const acks = pendingAcksRef.current;
    if (acks.length > 0) {
      pendingAcksRef.current = [];
      for (const a of acks) {
        relay.broadcast({ type: 'ack', opId: a.opId, ok: a.ok, rev: pkt.rev, reason: a.reason, message: a.message } satisfies NetAck);
      }
    }
  };
  /** 房主 → 单个客户端：整份（新加入者/请求重同步）。perRecipient 不影响全体的增量基准 */
  const sendStateTo = (cid: number, g: GameState) => {
    if (mode !== 'host') return;
    const pkt = encodeState(g, { full: true, perRecipient: true });
    relay.sendTo(cid, { type: 'state', pkt } satisfies NetState);
    pushPktLog(`→ 补发整份给 #${cid} rev=${pkt.rev} ${packetSize(pkt)}B`);
  };
  const hostBroadcast = (r: RoomState, msg: string) => {
    try {
      if (mode === 'host') {
        relay.reportMeta({
          phase: r.phase,
          players: (r.seat1 ? 1 : 0) + (r.seat2 ? 1 : 0),
          spectators: r.spectators.length,
        });
        relay.broadcast({ type: 'room', room: r } satisfies NetRoomState);
        if (msg) sendStateAll(gsLiveRef.current);
      }
    } catch {
      /* 忽略 */
    }
  };
  /* 房主更新房间状态的唯一入口：同步写回 roomRef 后广播。
     否则同一时刻连续处理两条客户端消息时，后一条会基于旧状态覆盖前一条的改动
     （客机几乎同时发来「选好卡组」+「准备」就会把卡组名丢掉）。 */
  const applyRoom = (next: RoomState, msg = '') => {
    roomRef.current = next;
    setRoom(next);
    hostBroadcast(next, msg);
  };

  /* ===== 房主：监听中继来的客户端连接/消息/断开（多客户端：玩家2 + 观战者） ===== */
  useEffect(() => {
    if (mode !== 'host') return;
    const commitRoom = applyRoom;
    const offConn = relay.onPeerJoined((id) => {
      const r = roomRef.current;
      if (!r) return;
      const next = roomAddClient(r, id, `玩家${id}`);
      setNetStatus(`有玩家加入（客户端 #${id}）`);
      // 对局中才加入的观战者：补发整份当前对局状态（它没有增量基线）
      if (next.phase === 'playing') {
        try {
          sendStateTo(id, gsRef.current);
        } catch {
          /* 忽略 */
        }
      }
      commitRoom(next);
    });
    const offMsg = relay.onMessage((id, msg) => {
      try {
        const m = JSON.parse(msg) as { type: string; name?: string; deck?: string[]; deckName?: string; count?: number; action?: string; args?: unknown[]; ok?: boolean; song?: string; voice?: string; opId?: string; rev?: number; hash?: number; slots?: [string, number][]; message?: string };
        const r = roomRef.current;
        if (!r) return;
        let next = r;
        if (m.type === 'hello') {
          const name = typeof m.name === 'string' && m.name.trim() ? m.name : `玩家${id}`;
          next = roomAddClient(next, id, name);
          next = { ...next, spectators: next.spectators.map((s) => (s.cid === id ? { ...s, name } : s)) };
          setNetStatus(`「${name}」加入房间`);
        } else if (m.type === 'sit') {
          next = roomSit(next, id);
        } else if (m.type === 'stand') {
          next = roomStand(next, id);
        } else if (m.type === 'deck') {
          // 房内选卡组：记下卡组内容 + 在房间状态里显示卡组名（双方可见）
          const ids = Array.isArray(m.deck) ? m.deck : [];
          decksByCid.current.set(id, ids);
          if (typeof m.song === 'string') songsByCid.current.set(id, m.song);
          if (typeof m.voice === 'string') voicesByCid.current.set(id, m.voice);
          next = roomSetDeck(next, id, m.deckName || '随机测试牌组', typeof m.count === 'number' ? m.count : ids.length);
          setNetStatus(`对方已选好卡组（${m.deckName || '随机测试牌组'}）`);
        } else if (m.type === 'ready') {
          if (Array.isArray(m.deck)) {
            decksByCid.current.set(id, m.deck);
            if (typeof m.song === 'string') songsByCid.current.set(id, m.song);
            if (typeof m.voice === 'string') voicesByCid.current.set(id, m.voice);
          }
          next = roomReady(next, id, typeof m.count === 'number' ? m.count : Array.isArray(m.deck) ? m.deck.length : 0);
        } else if (m.type === 'unready') {
          next = roomUnready(next, id);
        } else if (m.type === 'resync') {
          // 客机基线对不上（漏包/刚进来）→ 补发整份状态
          sendStateTo(id, gsLiveRef.current);
          return;
        } else if (m.type === 'rev') {
          // 客机报告"我到第几版了 + 我的校验码" → 房主界面显示对方是否已同步
          guestRevRef.current = { rev: Number(m.rev) || 0, hash: Number(m.hash) || 0 };
          const mine = hashHex(stateHash(gsLiveRef.current));
          const ok = hashHex(guestRevRef.current.hash) === mine;
          setDiag((d) => ({ ...d, peerRev: guestRevRef.current.rev, peerOk: ok }));
          return;
        } else if (m.type === 'desync') {
          // 客机校验码对不上 → 房主定位分歧字段，同时补发整份让它重新对齐
          const slots = Array.isArray(m.slots) ? (m.slots as [string, number][]) : [];
          const paths = divergentSlots(stateSlotHashes(gsLiveRef.current), slots);
          pushPktLog(`⚠ 分车报告：${paths.slice(0, 4).join('、') || '(字段集合不同)'}`);
          relay.sendTo(id, {
            type: 'desync',
            ok: false,
            hostHash: stateHash(gsLiveRef.current),
            guestHash: Number(m.hash) || 0,
            paths,
          } satisfies NetDesyncReport);
          sendStateTo(id, gsLiveRef.current);
          setDiag((d) => ({ ...d, peerOk: false, warn: `对方校验码不一致，分歧字段：${paths.slice(0, 4).join('、') || '(字段集合不同)'}` }));
          return;
        } else if (m.type === 'op') {
          // 带确认的操作：opId 去重（连点/重发只执行一次），rev 用来判断"你的画面是否过期"
          const opId = String(m.opId ?? '');
          if (!opId) return;
          if (doneOpIdsRef.current.includes(opId)) {
            relay.sendTo(id, { type: 'ack', opId, ok: true, rev: currentRev(), message: '（重复请求已忽略）' } satisfies NetAck);
            return;
          }
          doneOpIdsRef.current = [...doneOpIdsRef.current, opId].slice(-60);
          const seatIdx = next.seat1?.cid === id ? 0 : next.seat2?.cid === id ? 1 : -1;
          const before = gsLiveRef.current;
          if (next.phase !== 'playing') {
            relay.sendTo(id, { type: 'ack', opId, ok: false, rev: currentRev(), reason: 'phase', message: '对局还没开始' } satisfies NetAck);
            return;
          }
          if (seatIdx < 0 || !canGuestAct(before, m.action ?? '', seatIdx as PlayerIndex)) {
            // 画面过期（提示可能已经变了）→ 让客机对齐后重试，而不是静默失败
            pushPktLog(`✗ 拒绝操作 ${m.action}（画面过期或无权）`);
            relay.sendTo(id, {
              type: 'ack',
              opId,
              ok: false,
              rev: currentRev(),
              reason: 'stale',
              message: '你的画面已过期，已自动对齐，请重新操作',
            } satisfies NetAck);
            sendStateTo(id, before);
            return;
          }
          const after = applyAction(before, m.action ?? '', m.args ?? []);
          commitGs(after);
          // 回执等状态广播时一起发（这样 rev 里包含这次改动）
          pendingAcksRef.current.push({ opId, ok: true });
          return;
        } else if (m.type === 'undoRequest') {
          // 客机请求悔棋 → 房主弹确认（同意后恢复房主历史栈并广播）
          setUndoAsk('对方（客机）请求悔棋，是否同意撤销到上一步？');
          return;
        } else if (m.type === 'undoReply') {
          setUndoWait(false);
          if (m.ok) {
            setUndoMsg('对方同意悔棋。');
            doUndo();
          } else {
            setUndoMsg('对方拒绝了悔棋请求。');
          }
          return;
        } else if (m.type === 'action' && next.phase === 'playing') {
          // 兼容旧客户端：不带确认的操作（新客机走上面的 'op'）
          const seatIdx = next.seat1?.cid === id ? 0 : next.seat2?.cid === id ? 1 : -1;
          const before = gsLiveRef.current;
          if (seatIdx < 0 || !canGuestAct(before, m.action ?? '', seatIdx as PlayerIndex)) {
            commitGs(pushLog(before, `对方操作被拒绝（${m.action}）。`));
            return;
          }
          commitGs(applyAction(before, m.action ?? '', m.args ?? []));
          return;
        }
        commitRoom(next);
      } catch {
        /* 忽略坏消息 */
      }
    });
    const offDisc = relay.onPeerLeft((id) => {
      const r = roomRef.current;
      if (!r) return;
      const wasSeated = r.seat1?.cid === id || r.seat2?.cid === id;
      const next = roomRemoveClient(r, id);
      if (wasSeated && next.phase === 'playing') {
        // 对局中的上桌玩家断开 → 对局结束回大厅（再来一局）
        const back = roomRematch(next);
        setNetStatus('对局玩家断开连接，对局结束。');
        commitRoom(back);
        return;
      }
      commitRoom(next);
    });
    return () => {
      offConn();
      offMsg();
      offDisc();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  /* ===== 房主：对局状态广播（对局中发给房内所有人：玩家 + 观战者）
     只发变化的部分（增量同步，见 net/gsSync.ts）：原来每次发整份约 160KB，公网要好几秒，
     会把后面的房间消息堵住十几秒。 ===== */
  useEffect(() => {
    if (mode === 'host' && room?.phase === 'playing') {
      try {
        sendStateAll(gs);
      } catch {
        /* 忽略 */
      }
    }
  }, [gs, mode, room?.phase]);

  /* ===== 房主：双方都准备 → 开始对局 ===== */
  useEffect(() => {
    if (mode !== 'host' || !room || room.phase !== 'lobby') return;
    if (!bothReady(room)) return;
    const seat1Deck = room.seat1?.cid === HOST_CID ? myDeckIds : (decksByCid.current.get(room.seat1?.cid ?? -99) ?? []);
    const seat2Deck = room.seat2?.cid === HOST_CID ? myDeckIds : (decksByCid.current.get(room.seat2?.cid ?? -99) ?? []);
    const seat1Song = room.seat1?.cid === HOST_CID ? myDeckSongRef.current : (songsByCid.current.get(room.seat1?.cid ?? -99) ?? '');
    const seat2Song = room.seat2?.cid === HOST_CID ? myDeckSongRef.current : (songsByCid.current.get(room.seat2?.cid ?? -99) ?? '');
    const seat1Voice = room.seat1?.cid === HOST_CID ? myDeckVoiceRef.current : (voicesByCid.current.get(room.seat1?.cid ?? -99) ?? '');
    const seat2Voice = room.seat2?.cid === HOST_CID ? myDeckVoiceRef.current : (voicesByCid.current.get(room.seat2?.cid ?? -99) ?? '');
    const gs0 = startGame(cards, seat1Deck, seat2Deck);
    gs0.players[0].song = seat1Song || undefined;
    gs0.players[1].song = seat2Song || undefined;
    gs0.players[0].voice = seat1Voice || undefined;
    gs0.players[1].voice = seat2Voice || undefined;
    gs0.players[0].name = room.seat1?.name ?? '玩家1';
    gs0.players[1].name = room.seat2?.name ?? '玩家2';
    const gs1 = rules.markReady(gs0); // 双方已在大厅准备 → 直接石头剪刀布
    commitGs(gs1); // 同步写入即时副本，房主接下来的操作/发包都基于这份
    const next = roomStartGame(room);
    roomRef.current = next;
    setRoom(next);
    setNetStatus('双方已准备，对局开始！');
    try {
      relay.broadcast({ type: 'room', room: next } satisfies NetRoomState);
      sendStateAll(gs1, { full: true }); // 开局发整份（各方建立基线）
    } catch {
      /* 忽略 */
    }
  }, [room, mode, cards, myDeckIds]);

  /* ===== 房间管理（经中继服务器） ===== */
  const onCreateRoom = async () => {
    // 正常流程：Multiplayer 页面已连接服务器并创建好房间；这里只做本地状态初始化
    let st = relay.status();
    if (!st.open || st.roomId === null) {
      // 兜底：直接进入 host 模式（如自动化测试）→ 用保存的地址自行连接并创建房间
      const addr = localStorage.getItem('lycee-relay-url') ?? relay.DEFAULT_RELAY_URL;
      try {
        await relay.connect(addr);
        await relay.createRoom('房间', playerName);
        st = relay.status();
      } catch (e) {
        setNetStatus(`无法连接服务器（${addr}）：${e instanceof Error ? e.message : String(e)}`);
        return;
      }
    }
    setMode('host');
    setGuestConnected(true);
    setMyCid(HOST_CID);
    myCidRef.current = HOST_CID;
    setMyName(playerName);
    resetEncode(); // 新房间：增量基线清零
    resetDecode();
    guestGsRef.current = null;
    const r = createRoom(playerName);
    setRoom(r);
    setNetStatus('房间已创建，等待玩家加入…');
    setSelected(null);
    try {
      relay.reportMeta({ phase: r.phase, players: 1, spectators: 0 });
      relay.broadcast({ type: 'room', room: r } satisfies NetRoomState);
    } catch {
      /* 忽略 */
    }
  };

  const onStopRoom = async () => {
    try {
      relay.leave();
      relay.close();
    } catch {
      /* 忽略 */
    }
    setGuestConnected(false);
    setRoom(null);
    setMyCid(null);
    setMode('local');
    setNetStatus('单机模式');
    setGs(startGame(cards, deck));
    setSelected(null);
  };

  /** 客机：由 Multiplayer 页面完成连接+加入后进入战场 */
  const onJoinRoom = (roomLabel?: string) => {
    const st = relay.status();
    if (!st.open || st.roomId === null) {
      setNetStatus('请从「多人游戏」页面加入房间。');
      return;
    }
    setMode('guest');
    setMyCid(st.myCid);
    myCidRef.current = st.myCid;
    resetDecode(); // 进房：状态基线清零（等房主发整份）
    guestGsRef.current = null;
    setNetStatus(`已加入房间${roomLabel ? `「${roomLabel}」` : ''}，进入房间大厅…`);
    relay.sendTo(HOST_CID, { type: 'hello', name: myName || '玩家' });
  };

  /* ===== 客机/观战者：接收房主经中继发来的消息 ===== */
  useEffect(() => {
    if (mode !== 'guest' && mode !== 'spectator') return;
    /** 应用完状态后回报"我到第几版 + 我的校验码"（房主据此显示对方是否同步） */
    const reportRev = (gsNow: GameState, force = false) => {
      const now = Date.now();
      if (!force && now - guestRevReportAtRef.current < 900) return;
      guestRevReportAtRef.current = now;
      relay.sendTo(HOST_CID, { type: 'rev', rev: currentDecodeRev(), hash: stateHash(gsNow) } satisfies NetRevReport);
    };
    /** 校验码对不上：先自动要整份；如果是整份之后仍不一致 → 报分车让人看得到 */
    const onHashMismatch = (gsNow: GameState, pktKind: string, pktHash: number) => {
      const localHash = stateHash(gsNow);
      const now = Date.now();
      setDiag((d) => ({ ...d, ok: false, hash: hashHex(localHash), empty: d.empty + 1, warn: '校验不一致，正在自动对齐…' }));
      pushPktLog(`⚠ 校验不一致（本地 ${hashHex(localHash)} vs 房主 ${hashHex(pktHash)}）`);
      if (pktKind === 'full') {
        // 整份都对不上 → 真·分车：把逐槽位校验值发给房主定位差异字段
        relay.sendTo(HOST_CID, {
          type: 'desync',
          rev: currentDecodeRev(),
          hash: localHash,
          slots: stateSlotHashes(gsNow),
        } satisfies NetDesync);
      }
      if (now - hashMismatchAtRef.current > 1200) {
        hashMismatchAtRef.current = now;
        relay.sendTo(HOST_CID, { type: 'resync' });
      }
    };
    const off = relay.onMessage((from, msg) => {
      if (from !== HOST_CID) return; // 只接受房主的消息
      try {
        const m = JSON.parse(msg) as
          | NetState
          | NetRoomState
          | NetHash
          | NetAck
          | NetDesyncReport
          | { type: 'undoRequest' }
          | { type: 'undoReply'; ok: boolean };
        if (m.type === 'room') {
          setRoom(m.room);
          setMode(seatOf(m.room, myCidRef.current ?? -2) ? 'guest' : 'spectator');
        } else if (m.type === 'undoRequest') {
          setUndoAsk('对方（房主）请求悔棋，是否同意撤销到上一步？');
        } else if (m.type === 'undoReply') {
          setUndoWait(false);
          setUndoMsg(m.ok ? '房主同意悔棋，已恢复上一步。' : '房主拒绝了悔棋请求。');
        } else if (m.type === 'ack') {
          // 房主回执：ok=false 且 reason=stale 表示"你画面旧了"→ 已自动对齐，请重新操作
          const pend = pendingOpsRef.current.get(m.opId);
          if (pend) {
            pendingOpsRef.current.delete(m.opId);
            setDiag((d) => ({ ...d, pending: pendingOpsRef.current.size, rev: m.rev }));
            setPendingLabel(pendingOpsRef.current.size > 0 ? [...pendingOpsRef.current.values()][0].label : '');
            if (!m.ok) {
              setAlignMsg(m.reason === 'stale' ? '⚠ 你的画面已过期，已自动对齐，请重新操作' : `⚠ 操作未生效：${m.message ?? m.reason ?? '未知原因'}`);
              pushPktLog(`← 回执失败 ${m.opId} reason=${m.reason ?? ''}`);
            } else {
              pushPktLog(`← 回执成功 ${m.opId} rev=${m.rev}`);
            }
          }
        } else if (m.type === 'desync') {
          // 房主定位出的分歧字段
          const paths = (m as NetDesyncReport).paths ?? [];
          setDiag((d) => ({
            ...d,
            ok: false,
            paths,
            warn: `⚠ 不同步（分车）：分歧字段 ${paths.slice(0, 5).join('、') || '(字段集合不同)'}`,
          }));
          pushPktLog(`⚠ 分车：${paths.slice(0, 5).join('、')}`);
        } else if (m.type === 'hash') {
          // 房主定期校验：只带版本号 + 校验码（约 100B）
          const gsNow = guestGsRef.current ?? gsRef.current;
          const mine = stateHash(gsNow);
          const ok = hashHex(mine) === hashHex(m.hash);
          setDiag((d) => ({ ...d, ok, hash: hashHex(mine) }));
          if (!ok) onHashMismatch(gsNow, 'hash', m.hash);
        } else if (m.type === 'state') {
          // 增量同步：本地基线对不上（漏包/刚进房）→ 请房主补发整份
          const base = guestGsRef.current ?? gsRef.current;
          const res = decodeState(base, m.pkt, cards);
          if (res.needResync) {
            const now = Date.now();
            if (now - lastResyncRef.current > 1200) {
              lastResyncRef.current = now;
              relay.sendTo(HOST_CID, { type: 'resync' });
            }
            setNetStatus('正在同步对局状态…');
          } else if (res.gs) {
            guestGsRef.current = res.gs;
            gsLiveRef.current = res.gs;
            setGs(res.gs);
            pushPktLog(`← 状态 ${m.pkt.kind} rev=${m.pkt.rev} seq=${m.pkt.seq} ${packetSize(m.pkt)}B ${hashHex(m.pkt.hash)}`);
            setDiag((d) => ({ ...d, rev: m.pkt.rev, hash: hashHex(res.localHash), ok: res.hashOk, paths: [] }));
            if (res.hashOk) {
              setNetStatus(`已同步对局状态（${m.pkt.kind === 'full' ? '整份' : '增量'} ${packetSize(m.pkt)}B · 校验 ✓）`);
              setDiag((d) => (d.warn && d.warn.startsWith('⚠ 不同步') ? { ...d, warn: '' } : d));
            } else {
              onHashMismatch(res.gs, m.pkt.kind, m.pkt.hash);
            }
            reportRev(res.gs);
          }
        }
      } catch {
        /* 忽略 */
      }
    });
    const offClosed = relay.onClosed(() => {
      setRoom(null);
      setMyCid(null);
      setMode('local');
      setNetStatus('与服务器断开（回到单机模式）');
      setGs(startGame(cards, deck));
      setSelected(null);
    });
    return () => {
      off();
      offClosed();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  // 进入战场时按所选模式初始化（本地则直接双方就位）
  useEffect(() => {
    if (initialMode === 'host') void onCreateRoom();
    else if (initialMode === 'guest') onJoinRoom(initialAddress);
    else if (initialMode === 'local') setGs((g) => { const n = rules.markReady(g); n.players[0].song = deckSongRef.current || undefined; return n; });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ===== 定期校验（房主 → 全体：只发版本号+校验码，约 100 字节） =====
     用极小成本发现"分车"：客机收到后自己算一遍，对不上就自动要整份重对齐。 */
  useEffect(() => {
    if (mode !== 'host' || room?.phase !== 'playing') return;
    const t = setInterval(() => {
      try {
        relay.broadcast({
          type: 'hash',
          rev: currentRev(),
          hash: stateHash(gsLiveRef.current),
          seq: currentSeq(),
        } satisfies NetHash);
      } catch {
        /* 忽略 */
      }
    }, 5000);
    return () => clearInterval(t);
  }, [mode, room?.phase]);

  /* ===== 延迟探测（本机 ↔ 中继服务器，每 3 秒一次） ===== */
  useEffect(() => {
    if (mode === 'local') return;
    let dead = false;
    const tick = async () => {
      const ms = await relay.pingServer();
      if (!dead) setDiag((d) => ({ ...d, rtt: ms }));
    };
    void tick();
    const t = setInterval(() => void tick(), 3000);
    return () => {
      dead = true;
      clearInterval(t);
    };
  }, [mode]);

  /* ===== 客机：操作超时重发（同一个 opId，房主会去重，不会执行两次） ===== */
  useEffect(() => {
    if (mode !== 'guest' && mode !== 'spectator') return;
    const t = setInterval(() => {
      const now = Date.now();
      for (const [opId, info] of pendingOpsRef.current) {
        if (now - info.at > 8000 && !info.resent) {
          info.resent = true;
          info.at = now;
          relay.sendTo(HOST_CID, { type: 'op', opId, action: '', args: [], rev: currentDecodeRev() } satisfies NetOp);
          setAlignMsg('⏳ 房主回执超时，已自动重发一次…');
        }
      }
    }, 2000);
    return () => clearInterval(t);
  }, [mode]);

  /* ===== 提示自动消失 ===== */
  useEffect(() => {
    if (!alignMsg) return;
    const t = setTimeout(() => setAlignMsg(null), 6000);
    return () => clearTimeout(t);
  }, [alignMsg]);

  const onLeaveRoom = () => {
    try {
      relay.leave();
      relay.close();
    } catch {
      /* 忽略 */
    }
    guestWsRef.current = null;
    setRoom(null);
    setMyCid(null);
    setMode('local');
    setNetStatus('已离开房间（单机模式）');
    setGs(startGame(cards, deck));
    setSelected(null);
  };

  /** 客机/观战者：发送房间操作（上桌/起立/准备/取消准备）→ 发给房主 */
  const sendRoomMsg = (obj: { type: 'sit' | 'stand' | 'ready' | 'unready' | 'deck'; deck?: string[]; song?: string; voice?: string; deckName?: string; count?: number }) => {
    relay.sendTo(HOST_CID, obj);
  };

  /** 房主/客机通用：回到大厅再来一局 */
  const onRematch = () => {
    if (mode === 'host' && room) {
      applyRoom(roomRematch(room));
      setNetStatus('回到大厅，双方重新准备即可再来一局。');
    }
  };

  /* ===== 大厅操作（上桌/起立/准备/取消准备）：房主本地改房间，客机发消息 ===== */
  const onSit = () => {
    if (mode === 'host') {
      const r = roomRef.current;
      if (!r) return;
      applyRoom(roomSit(r, HOST_CID));
    } else {
      sendRoomMsg({ type: 'sit' });
    }
  };
  const onStand = () => {
    if (mode === 'host') {
      const r = roomRef.current;
      if (!r) return;
      applyRoom(roomStand(r, HOST_CID));
    } else {
      sendRoomMsg({ type: 'stand' });
    }
  };
  const onReady = () => {
    if (mode === 'host') {
      const r = roomRef.current;
      if (!r) return;
      applyRoom(roomReady(r, HOST_CID, myDeckIds.length));
    } else {
      sendRoomMsg({ type: 'ready', deck: myDeckIds, count: myDeckIds.length, song: myDeckSongRef.current, voice: myDeckVoiceRef.current });
    }
  };
  const onUnready = () => {
    if (mode === 'host') {
      const r = roomRef.current;
      if (!r) return;
      applyRoom(roomUnready(r, HOST_CID));
    } else {
      sendRoomMsg({ type: 'unready' });
    }
  };
  /** 房内选卡组：选好后房主直接更新房间，客机发给房主 */
  const onChooseDeck = (c: DeckChoice) => {
    setPickDeck(false);
    setMyDeckIds(c.ids);
    setMyDeckName(c.deckName);
    myDeckSongRef.current = c.song;
    myDeckVoiceRef.current = c.voice;
    if (mode === 'host') {
      const r = roomRef.current;
      if (!r) return;
      applyRoom(roomSetDeck(r, HOST_CID, c.deckName, c.ids.length));
    } else {
      relay.sendTo(HOST_CID, { type: 'deck', deckName: c.deckName, deck: c.ids, count: c.ids.length, song: c.song, voice: c.voice });
    }
  };

  /* ===== 选中卡信息 ===== */
  const selLoc = selected ? findInstance(gs, selected) : null;
  const selInst = selLoc ? getInstAt(gs, selLoc) : undefined;
  const selCard = selInst ? gs.cardsById[selInst.cardId] : undefined;
  const selInHand = selLoc?.zone === 'hand' && selLoc.player === gs.turnPlayer;
  const selInMyHand = selLoc?.zone === 'hand' && selLoc.player === selfPlayer;
  const mainPhase = gs.phase === 'main' && !gs.battle && !gs.prompt;

  /* ===== 顶部按钮动作 ===== */
  const onBeginTurn = () => doAction('beginTurn');
  const onEndTurn = () => doAction('endTurn');
  const onShuffle = () => {
    if (mode !== 'local') return;
    setGs((g) => {
      const next = structuredClone(g);
      next.players[0].deck = shuffleArr(next.players[0].deck);
      next.players[1].deck = shuffleArr(next.players[1].deck);
      return pushLog(next, '双方牌堆已洗牌');
    });
  };

  const onDeploySelected = () => {
    if (!selected) return;
    const slots = rules.validDeploySlots(gs, gs.turnPlayer, selected);
    if (slots.length === 0) {
      setGs((g) => pushLog(g, '场上没有可配置的空格。'));
      return;
    }
    if (slots.length === 1) {
      doAction('requestPlayCharacter', selected, slots[0].row, slots[0].area);
      setSelected(null);
      return;
    }
    // 多个可登场位置 → 进入位置选择模式（高亮空格，点击放置）
    setDeploySlotUid(selected);
  };

  const onPlayEvent = () => {
    if (!selected) return;
    doAction('requestPlayEvent', selected);
    setSelected(null);
  };

  const onEquipItem = () => {
    if (!selected) return;
    doAction('requestEquipTarget', selected);
  };

  const onAttack = () => {
    if (!selected) return;
    doAction('declareAttack', selected);
    setSelected(null);
  };

  // 进入移动模式：高亮可移动的空位
  const beginMoveMode = (uid: string) => {
    setMoveModeUid(uid);
  };

  const canDeploy = !!selected && selCard?.type === 'character' && selInHand && mainPhase;
  const canPlayEvent = !!selected && selCard?.type === 'event' && selInHand && mainPhase;
  const canPlayArea = !!selected && selCard?.type === 'area' && selInHand && mainPhase;
  const canEquip = !!selected && selCard?.type === 'item' && selInHand && mainPhase;
  const canAttackNow = !!selected && rules.canAttack(gs, selected);
  const canToggle = !!selected && !gs.battle && !gs.prompt && mode === 'local';
  // 手札宣言 / 宣言效果 / 基本能力移动 / コスト能力
  // 手札宣言：自己手牌且非战斗即可（可作对手回合的响应）
  const canHandDeclare = !!selected && selCard && selInMyHand && gs.phase === 'main' && !gs.battle && !gs.prompt && hasHandDeclare(selCard);
  const canDeclare =
    !!selected && !!selCard && (selLoc?.zone === 'field' || selLoc?.zone === 'special' || selLoc?.zone === 'area') && selLoc.player === gs.turnPlayer && mainPhase && hasDeclare(selCard);
  // 装备中的道具宣言
  const equipDeclare = selInst?.equip && gs.cardsById[selInst.equip.cardId] && hasDeclare(gs.cardsById[selInst.equip.cardId]);
  const canItemDeclare = !!selected && !!equipDeclare && selLoc?.zone === 'field' && selLoc.player === gs.turnPlayer && mainPhase;
  const canMove = !!selected && selCard && selLoc?.zone === 'field' && selLoc.player === gs.turnPlayer && mainPhase && hasMoveAbility(selCard);

  const selectedActions: { label: string; fn: () => void }[] = [];
  // 观战者无任何操作
  if (!isSpectatorView) {
    // 对应/时点窗口（Bug ⑤）+ 主阶段结束窗口：可像主阶段一样直接点击卡进行宣言，小窗右上角有取消/结束按钮
    const timingPrompt = gs.prompt;
    const isEndMainWin = !!timingPrompt && timingPrompt.kind === 'end-main';
    const inTimingWin = !!timingPrompt && (timingPrompt.kind === 'response' || timingPrompt.kind === 'battle-timing' || isEndMainWin);
    const winOwner = inTimingWin ? promptOwner(timingPrompt!, gs.turnPlayer) : -1;
    const isMyWin = inTimingWin && (mode === 'local' || winOwner === myPlayer);
    if (inTimingWin && isMyWin && selected) {
      const winAction = timingPrompt!.kind === 'response'
        ? (id: string) => doAction('respond', id)
        : timingPrompt!.kind === 'battle-timing'
          ? (id: string) => doAction('battleTimingAction', id)
          : (id: string) => doAction('endMainAction', id); // end-main：优先权玩家点卡使用宣言/事件
      if (selInHand) {
        if (selCard?.type === 'event') selectedActions.push({ label: '🎴 使用（事件）', fn: () => selected && winAction(`evt:${selected}`) });
        if (selCard && hasHandDeclare(selCard)) selectedActions.push({ label: '📣 手札宣言（用后进ゴミ箱）', fn: () => selected && winAction(`hd:${selected}`) });
        if (selCard && (selCard.basicAbilities ?? '').includes('サプライズ')) selectedActions.push({ label: '🎴 サプライズ登场', fn: () => selected && winAction(`sdp:${selected}`) });
      }
      if (selInst && (selLoc?.zone === 'field' || selLoc?.zone === 'special' || selLoc?.zone === 'area')) {
        if (selCard && hasDeclare(selCard)) selectedActions.push({ label: '📣 宣言效果', fn: () => selected && winAction(`fd:${selected}`) });
        if (timingPrompt!.kind === 'battle-timing' && selLoc?.zone === 'field' && selInst) {
          const sup = rules.canSupportInBattle(gs, selInst.uid);
          for (const s of sup.options) {
            selectedActions.push({ label: `🤝 ${s.label}`, fn: () => selected && winAction(s.id === 'supC' ? `supC:${selected}` : `sup:${selected}`) });
          }
        }
      }
      if (selInst?.equip && gs.cardsById[selInst.equip.cardId] && hasDeclare(gs.cardsById[selInst.equip.cardId])) {
        selectedActions.push({ label: `📣 道具宣言（${gs.cardsById[selInst.equip.cardId]?.name ?? ''}）`, fn: () => selInst!.equip && winAction(`fd:${selInst.equip.uid}`) });
      }
      if (selectedActions.length === 0) selectedActions.push({ label: '该卡当前不能用于对应/时点宣言', fn: () => {} });
    } else if (isEndMainWin && !isMyWin) {
      // 回合玩家：已宣言结束主阶段 → 点小窗“取消”继续；点卡仅查看（不弹主阶段操作）
      if (selected) {
        selectedActions.push({ label: '⏹ 已宣言结束主阶段：点小窗「取消」可继续操作', fn: () => {} });
      }
    } else {
    // === 使用方式（主要操作） ===
    if (canDeploy) selectedActions.push({ label: '🎴 登场', fn: onDeploySelected });
    if (canPlayEvent) selectedActions.push({ label: '🎴 使用（事件）', fn: onPlayEvent });
    if (canPlayArea) selectedActions.push({ label: '🎴 配置（エリア）', fn: () => selected && doAction('requestPlayArea', selected) });
    if (canEquip) selectedActions.push({ label: '🎴 装备…', fn: onEquipItem });
    if (canHandDeclare) selectedActions.push({ label: '📣 手札宣言（用后进ゴミ箱）', fn: () => selected && doAction('requestHandDeclare', selected) });
    if (canDeclare) selectedActions.push({ label: '📣 宣言效果', fn: () => selected && doAction('requestDeclare', selected) });
    if (canItemDeclare && selInst?.equip) selectedActions.push({ label: `📣 道具宣言（${gs.cardsById[selInst.equip.cardId]?.name ?? ''}）`, fn: () => selInst?.equip && doAction('requestDeclare', selInst.equip.uid) });
    if (canAttackNow) selectedActions.push({ label: '⚔ 攻击宣言', fn: onAttack });
    if (canMove) selectedActions.push({ label: '👟 移动（基本能力）', fn: () => selected && beginMoveMode(selected) });
    // エリア/角色下方卡查看（Bug 10）
    if (!!selected && !!selInst && selInst.under.length > 0) {
      selectedActions.push({ label: `📂 查看下方卡（${selInst.under.length} 张）`, fn: () => setUnderView(selected) });
    }
    // === 测试操作（仅单机） ===
    if (canToggle) {
      selectedActions.push({
        label: selInst?.tapped ? '重置(未行动)' : '横置(行动済)',
        fn: () => selected && setGs((g) => toggleTapped(g, selected)),
      });
      selectedActions.push({ label: '翻面', fn: () => selected && setGs((g) => toggleFaceUp(g, selected)) });
    }
    }
  }

  /* ===== 点击处理 ===== */
  const handleCardClick = (uid: string, rect?: DOMRect) => {
    // 配置エリア/登场/复活等 slot-pick：点“该格上的角色”也算选了该格（Bug ①：配置エリア时点不了有角色的格子）
    const slotPrompt = gs.prompt;
    if (slotPrompt?.kind === 'slot-pick' && slotPrompt.uid) {
      const sl = findInstance(gs, uid);
      if (sl && sl.zone === 'field' && sl.player === slotPrompt.owner && sl.row && sl.area !== undefined) {
        const inSlots = slotPrompt.slots.some((s) => s.row === sl.row && s.area === sl.area);
        if (inSlots) {
          doAction('chooseSlot', sl.row, sl.area);
          setDeploySlotUid(null);
          setSelected(null);
          return;
        }
      }
    }
    // 登场模式：点己方场上的角色 → エンゲージ登场（破弃该角色；卡无[エンゲージ]会被规则拒绝）
    if (deploySlotUid) {
      const clickLoc = findInstance(gs, uid);
      if (clickLoc?.zone === 'field' && clickLoc.player === gs.turnPlayer) {
        doAction('requestPlayCharacter', deploySlotUid, clickLoc.row!, clickLoc.area!);
        setDeploySlotUid(null);
        setSelected(null);
        return;
      }
    }
    // 点ゴミ箱里的卡 → 打开查看大界面
    const clickLoc = findInstance(gs, uid);
    if (clickLoc?.zone === 'trash') {
      setTrashView(clickLoc.player);
      return;
    }
    // 点置き場里的卡 → 打开置き場查看大界面
    for (const p of [0, 1] as PlayerIndex[]) {
      for (const [name, list] of Object.entries(gs.players[p].storage)) {
        if (list.some((c) => c.uid === uid)) {
          setStorageView({ player: p, name });
          return;
        }
      }
    }
    // 手动结算：等待选择目标角色时，点击角色应用数值修正
    if (pendingStat) {
      doAction('manualStat', uid, pendingStat.stat, pendingStat.amount);
      setPendingStat(null);
      return;
    }
    // 移动模式下点击其他卡会取消移动
    if (moveModeUid) setMoveModeUid(null);
    if (deploySlotUid) setDeploySlotUid(null);
    setSelected((s) => (s === uid ? null : uid));
    // 在卡片旁边弹出操作菜单（起手换牌期间只查看，不弹菜单）
    if (gs.mulligan) {
      setMenuPos(null);
    } else if (rect) {
      const x = Math.max(4, Math.min(rect.right + 10, window.innerWidth - 200));
      const y = Math.max(4, Math.min(rect.top, window.innerHeight - 260));
      setMenuPos({ uid, x, y });
    } else {
      setMenuPos(null);
    }
  };

  const handleSlotClick = (player: PlayerIndex, row: RowName, area: AreaIndex) => {
    // 登场位置选择提示（searchDeploy/复活/サプライズ等）→ 点高亮空格结算（Bug ①）
    const p = gs.prompt;
    if (p?.kind === 'slot-pick' && p.uid) {
      const valid = p.slots.some((s) => s.row === row && s.area === area && player === p.owner);
      if (valid) doAction('chooseSlot', row, area);
      setDeploySlotUid(null);
      setSelected(null);
      return;
    }
    // 登场模式：点高亮空格登场
    if (deploySlotUid) {
      const valid = rules
        .validDeploySlots(gs, gs.turnPlayer, deploySlotUid)
        .some((t) => t.row === row && t.area === area && player === gs.turnPlayer);
      if (valid) {
        doAction('requestPlayCharacter', deploySlotUid, row, area);
      }
      setDeploySlotUid(null);
      setSelected(null);
      return;
    }
    // 移动模式：点可移动的目标空位 → 移动；点别处取消
    if (moveModeUid) {
      const valid = rules.validMoveTargets(gs, moveModeUid).some((t) => t.row === row && t.area === area && player === gs.turnPlayer);
      if (valid) {
        doAction('moveCharacter', moveModeUid, row, area);
      }
      setMoveModeUid(null);
      setSelected(null);
      return;
    }
    if (!selected) return;
    const loc = findInstance(gs, selected);
    const inst = loc ? getInstAt(gs, loc) : undefined;
    const card = inst ? gs.cardsById[inst.cardId] : undefined;
    if (loc?.zone === 'hand' && card?.type === 'character' && player === gs.turnPlayer) {
      doAction('requestPlayCharacter', selected, row, area);
      setSelected(null);
      return;
    }
    // 自由移动仅单机测试模式可用
    if (mode === 'local') {
      setGs((g) => moveTo(g, selected, { zone: 'field', player, row, area }, { faceUp: true, tapped: false }));
      setSelected(null);
    }
  };

  const handleZoneClick = (player: PlayerIndex, zone: ZoneName) => {
    // 点ゴミ箱 → 打开查看大界面
    if (zone === 'trash') {
      setTrashView(player);
      return;
    }
    // 点除外区 → 打开查看大界面（bug 9：除外区显示）
    if (zone === 'removed') {
      setRemovedView(player);
      return;
    }
    if (!selected || mode !== 'local') return;
    setGs((g) => moveTo(g, selected, { zone, player }, { faceUp: zone !== 'deck', tapped: false, top: zone === 'deck' }));
    setSelected(null);
  };

  const handleDeckClick = (player: PlayerIndex) => {
    if (mode !== 'local') return;
    if (selected) handleZoneClick(player, 'deck');
    else
      setGs((g) => {
        const next = structuredClone(g);
        if (next.players[player].deck.length === 0) return pushLog(next, '牌堆为空，无法抽牌。');
        const top = next.players[player].deck.pop()!;
        top.faceUp = true;
        next.players[player].hand.push(top);
        return pushLog(next, `玩家 ${player + 1} 抽了 1 张（测试操作）。`);
      });
  };

  /* ===== 提示归属与等待遮罩 ===== */
  const owner = promptOwner(gs.prompt, gs.turnPlayer);
  const showPromptModal = !!gs.prompt && !isSpectatorView && (mode === 'local' || owner === myPlayer || owner === -1);
  const showWaitingOverlay =
    isNet &&
    !isSpectatorView &&
    !showPromptModal &&
    (gs.prompt ? true : gs.turnPlayer !== myPlayer || gs.phase === 'gameover');

  const panelUid = selected ?? hoverUid;

  // 联机模式房间尚未就绪（创建中/连接中）→ 占位
  if (mode !== 'local' && room === null) {
    return (
      <div className="battlefield">
        <div className="loading-box">{mode === 'host' ? '正在创建房间…' : '正在连接房间…'}</div>
      </div>
    );
  }

  return (
    <div className="battlefield">
      {zoomCard && (
        <div className="zoom-layer" onClick={() => setZoomOn(false)}>
          <div className="zoom-tip">按住 Alt + 滚轮缩放 · 松开 Alt 或点击关闭</div>
          <img
            className="zoom-img"
            src={cardImageUrl(zoomCard.id)}
            alt={zoomCard.name}
            draggable={false}
            style={{ transform: `scale(${zoomScale})` }}
          />
        </div>
      )}
      {peekCard && (
        <div className="peek-layer" onClick={() => setPeekCard(null)}>
          <div className="peek-box" onClick={(e) => e.stopPropagation()}>
            <img className="peek-img" src={cardImageUrl(peekCard.id)} alt={peekCard.name} draggable={false} />
            <div className="peek-info">
              <div className="peek-name">{peekCard.name}</div>
              <div className="peek-meta">
                {peekCard.id} · {peekCard.typeRaw} · {peekCard.elements || ''} · EX {peekCard.ex}
                {peekCard.cost ? ` · 费用 ${peekCard.cost}` : ''}
              </div>
              <pre className="peek-ability">{formatAbilityText(peekCard.ability ?? '（无效果文本）')}</pre>
            </div>
            <button className="danger peek-close" onClick={() => setPeekCard(null)}>
              关闭
            </button>
          </div>
        </div>
      )}
      {showLobby && room ? (
        <>
          <RoomLobby
            room={room}
            myCid={myCidOrHost}
            myDeckName={myDeckName}
            netStatus={netStatus}
            onSit={onSit}
            onStand={onStand}
            onPickDeck={() => setPickDeck(true)}
            onReady={onReady}
            onUnready={onUnready}
            onLeave={mode === 'host' ? onStopRoom : onLeaveRoom}
          />
          {pickDeck && (
            <DeckPick cards={cards} current={myDeckName} onPick={onChooseDeck} onCancel={() => setPickDeck(false)} />
          )}
        </>
      ) : (
        <>
      <header className="battle-header">
        <h1>⚔️ 战场</h1>
        <div className="turn-info">
          <span className={`turn-p ${gs.turnPlayer === 0 ? 'p1' : 'p2'}`}>
            玩家 {gs.turnPlayer + 1}
            {gs.players[gs.turnPlayer].name ? ` · ${gs.players[gs.turnPlayer].name}` : ''}
          </span>
          <span>回合 {gs.turn}</span>
          <span>{PHASE_LABELS[gs.phase]}</span>
        </div>
        <div className="battle-actions">
          {gs.phase === 'start' && gs.ready && !gs.prompt && !isNet && <button onClick={onBeginTurn}>▶ 开始回合</button>}
          {gs.phase === 'start' && gs.ready && !gs.prompt && isNet && gs.turnPlayer === myPlayer && (
            <button onClick={onBeginTurn}>▶ 开始回合</button>
          )}
          {gs.phase === 'main' && !gs.battle && !gs.prompt && !isNet && <button onClick={onEndTurn}>⏹ 结束回合</button>}
          {gs.phase === 'main' && !gs.battle && !gs.prompt && isNet && gs.turnPlayer === myPlayer && (
            <button onClick={onEndTurn}>⏹ 结束回合</button>
          )}
          {mode === 'local' && <button onClick={onShuffle}>洗牌</button>}
          {!isSpectatorView && (mode === 'local' || mode === 'host' || mode === 'guest') && gs.phase !== 'gameover' && (
            <button
              className="undo-btn"
              onClick={requestUndo}
              title={mode === 'local' ? '恢复到上一步可操作状态（卡死等异常时使用）' : '请求悔棋：需对方同意后恢复到上一步'}
            >
              ↩ 悔棋{undoCount >= 0 ? `（${undoCount}）` : ''}
            </button>
          )}
          {songPlaying && (
            <button className="song-playing-btn" onClick={stopSong} title="停止播放战歌">
              ♪ 停止战歌
            </button>
          )}
          {(selected || menuPos || deploySlotUid || moveModeUid) && (
            <button
              onClick={() => {
                setSelected(null);
                setMenuPos(null);
                setDeploySlotUid(null);
                setMoveModeUid(null);
              }}
            >
              取消选择
            </button>
          )}
        </div>
      </header>

      <div className="net-bar">
        {mode === 'local' && (
          <>
            <button onClick={onCreateRoom}>🌐 创建房间（房主）</button>
            <input
              className="net-input"
              value={myName}
              onChange={(e) => setMyName(e.target.value)}
              placeholder="昵称"
              style={{ width: 90 }}
            />
            <input
              className="net-input"
              value={wsInput}
              onChange={(e) => setWsInput(e.target.value)}
              placeholder="IP:端口"
            />
            <button onClick={() => onJoinRoom()}>加入房间</button>
          </>
        )}
        {mode === 'host' && <button onClick={onStopRoom}>关闭房间</button>}
        {(mode === 'guest' || mode === 'spectator') && <button onClick={onLeaveRoom}>断开连接</button>}
        <span className="net-status">{netStatus}</span>
        {isNet && !isSpectatorView && (
          <span className="net-player">
            你是玩家 {myPlayer === 0 ? 1 : 2}
            {gs.players[myPlayer === 1 ? 1 : 0]?.name ? `（${gs.players[myPlayer === 1 ? 1 : 0].name}）` : ''}
          </span>
        )}
        {isSpectatorView && <span className="net-player spectator">👁 观战中</span>}
        {/* 同步诊断条：延迟 / 版本 / 校验码 / 待确认 / 对方是否已同步 */}
        {isNet && (
          <span className={`sync-diag${diag.ok && diag.peerOk ? '' : ' bad'}`} onClick={() => setDiagOpen((v) => !v)} title="点击查看同步明细">
            {diag.rtt >= 0 ? `延迟 ${diag.rtt}ms` : '延迟 —'}
            {' · '}版本 {mode === 'host' ? currentRev() : currentDecodeRev()}
            {' · '}
            {diag.ok ? `校验 ✓ ${diag.hash || '—'}` : `校验 ✗ ${diag.hash || '—'}`}
            {diag.pending > 0 ? ` · 待确认 ${diag.pending}` : ''}
            {mode === 'host'
              ? guestRevRef.current.rev >= 0
                ? ` · 对方${diag.peerOk ? '已同步 ✓' : `不同步 ✗（第 ${guestRevRef.current.rev} 版）`}`
                : ' · 等待对方进房'
              : ''}
            {' '}
            {diagOpen ? '▾' : '▸'}
          </span>
        )}
      </div>
      {diagOpen && isNet && (
        <div className="sync-diag-panel">
          <div className="sync-diag-row">
            <b>同步明细</b>
            <span>我 {mode === 'host' ? '房主' : '客机'}：版本 {mode === 'host' ? currentRev() : currentDecodeRev()} · 校验 {diag.hash || '—'}</span>
            {mode === 'host' && <span>对方：版本 {guestRevRef.current.rev >= 0 ? guestRevRef.current.rev : '—'} · 校验 {guestRevRef.current.hash ? hashHex(guestRevRef.current.hash) : '—'}</span>}
            <span>往返延迟 {diag.rtt >= 0 ? `${diag.rtt}ms` : '—'}</span>
            <span>校验不一致累计 {diag.empty} 次</span>
            <span>{lastPktRef.current}</span>
          </div>
          {diag.warn && <div className="sync-diag-warn">{diag.warn}</div>}
          <div className="sync-diag-log">
            {pktLogRef.current.length === 0 && <div>（暂无记录）</div>}
            {pktLogRef.current.map((l, i) => (
              <div key={i}>{l}</div>
            ))}
          </div>
        </div>
      )}
      {alignMsg && (
        <div className="sync-align-msg" onClick={() => setAlignMsg(null)}>
          {alignMsg} <span className="sync-align-close">（点击关闭）</span>
        </div>
      )}
      {pendingLabel && (mode === 'guest' || mode === 'spectator') && (
        <div className="sync-pending">⏳ 等待房主确认：{pendingLabel}</div>
      )}

      <div className="battle-hint">
        {isSpectatorView
          ? '👁 观战模式：可查看场上公开信息（双方手牌隐藏），不能操作。'
          : deploySlotUid
            ? '🎴 登场模式：点击高亮的绿色空格选择登场位置；点其他地方取消。'
            : moveModeUid
              ? '👟 移动模式：点击高亮的绿色空格移动角色；点其他地方取消。'
              : isNet
                ? '网络对战：只显示你可见的信息（对手手牌背面）。轮到你时操作，其余时间等待对方。'
                : '点手牌/场上卡 → 旁边弹出操作（登场/手札宣言/宣言效果/攻击/移动…）；点ゴミ箱可查看内容。'}
      </div>

      {undoMsg && (
        <div className="undo-msg" onClick={() => setUndoMsg(null)}>
          ⚠️ {undoMsg}（点击关闭）
        </div>
      )}
      {undoWait && !undoAsk && <div className="undo-msg waiting">⏳ 悔棋请求已发送，等待对方同意…</div>}
      {undoAsk && (
        <div className="undo-ask">
          <div className="undo-ask-box">
            <h3>↩ 悔棋请求</h3>
            <p>{undoAsk}</p>
            <div className="prompt-actions">
              <button onClick={() => replyUndo(true)}>✅ 同意撤销</button>
              <button className="danger" onClick={() => replyUndo(false)}>
                拒绝
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="net-area">
        <div className="battle-layout">
          <div className="battle-log">
            <div className="battle-log-title">📜 对战日志</div>
            <div className="battle-log-scroll" ref={logRef}>
              {gs.log.slice(-60).map((m, i) => (
                <div key={i} className="battle-log-line">
                  {m}
                </div>
              ))}
            </div>
          </div>
          <aside className="side-panel">
            <SideZones
              gs={gs}
              player={oppPlayer}
              selected={selected}
              onCardClick={handleCardClick}
              onCardHover={setHoverUid}
              onZoneClick={handleZoneClick}
              onDeckClick={handleDeckClick}
              onStorageClick={(p, n) => setStorageView({ player: p, name: n })}
            />
            <div className="side-divider" />
            <SideZones
              gs={gs}
              player={selfPlayer}
              selected={selected}
              onCardClick={handleCardClick}
              onCardHover={setHoverUid}
              onZoneClick={handleZoneClick}
              onDeckClick={handleDeckClick}
              onStorageClick={(p, n) => setStorageView({ player: p, name: n })}
              self
            />
          </aside>

          <main className="board-area">
            {gs.battle && <BattleStatusBar gs={gs} />}
            <SideField
              gs={gs}
              player={oppPlayer}
              selected={selected}
              onCardClick={handleCardClick}
              onCardHover={setHoverUid}
              onSlotClick={handleSlotClick}
              opponent
              moveTargets={spPrompt && spPrompt.owner === oppPlayer ? spPrompt.slots : moveModeUid ? rules.validMoveTargets(gs, moveModeUid) : deploySlotUid && selfPlayer === 0 ? rules.validDeploySlots(gs, 0, deploySlotUid) : undefined}
            />
            <SideField
              gs={gs}
              player={selfPlayer}
              selected={selected}
              onCardClick={handleCardClick}
              onCardHover={setHoverUid}
              onSlotClick={handleSlotClick}
              moveTargets={spPrompt && spPrompt.owner === selfPlayer ? spPrompt.slots : moveModeUid ? rules.validMoveTargets(gs, moveModeUid) : deploySlotUid ? rules.validDeploySlots(gs, selfPlayer, deploySlotUid) : undefined}
            />
          </main>

          <CardInfoPanel gs={gs} uid={panelUid} selfPlayer={selfPlayer} onPeek={setPeekCard} />
        </div>

        {isSpectatorView ? (
          <div className="self-hand empty">👁 观战中：双方手牌隐藏</div>
        ) : (
          <SelfHand gs={gs} selfPlayer={selfPlayer} selected={selected} onCardClick={handleCardClick} onCardHover={setHoverUid} />
        )}

        {showWaitingOverlay && (
          <div className="net-waiting">
            <div className="net-waiting-box">
              <span className="net-waiting-icon">⏳</span>
              <div>{gs.prompt ? '等待对方操作…' : '等待对方回合…'}</div>
            </div>
          </div>
        )}
      </div>

      {showPromptModal && gs.prompt && (
        <PromptModal
          gs={gs}
          onAction={doAction}
          onNewGame={onGameOver}
          selfPlayer={selfPlayer}
          mode={mode}
          onPickStat={(s, a) => setPendingStat({ stat: s, amount: a })}
        />
      )}

      {/* 置き場查看大界面 */}
      {storageView !== null && (
        <div className="prompt-backdrop" onClick={() => setStorageView(null)}>
          <div className="trash-view-modal" onClick={(e) => e.stopPropagation()}>
            <h3>📂 {storageView.name}置き場（玩家 {storageView.player + 1} · {gs.players[storageView.player].storage[storageView.name]?.length ?? 0} 张）</h3>
            <div className="trash-grid">
              {(gs.players[storageView.player].storage[storageView.name] ?? []).map((c) => {
                const card = gs.cardsById[c.cardId];
                return (
                  <div key={c.uid} className="trash-item" title={card ? `${card.name}（${card.id}）` : c.cardId} onClick={(e) => { e.stopPropagation(); if (card) setPeekCard(card); }}>
                    <img src={cardImageUrl(card?.id ?? c.cardId)} alt={card?.name ?? ''} draggable={false} />
                    <span>{card?.name ?? c.cardId}</span>
                  </div>
                );
              })}
              {(gs.players[storageView.player].storage[storageView.name] ?? []).length === 0 && <div className="zone-empty">置き場为空</div>}
            </div>
            <div className="prompt-actions">
              <button onClick={() => setStorageView(null)}>关闭</button>
            </div>
          </div>
        </div>
      )}

      {/* エリア/角色下方卡查看界面（Bug 10） */}
      {underView !== null && (
        <div className="prompt-backdrop" onClick={() => setUnderView(null)}>
          <div className="trash-view-modal" onClick={(e) => e.stopPropagation()}>
            {(() => {
              const loc = findInstance(gs, underView);
              const inst = loc ? getInstAt(gs, loc) : undefined;
              const card = inst ? gs.cardsById[inst.cardId] : undefined;
              if (!inst || !card) return <h3>卡不存在</h3>;
              return (
                <>
                  <h3>
                    📂 「{card.name}」下方卡（{inst.under.length} 张）
                  </h3>
                  <div className="trash-grid">
                    {inst.under.map((c) => {
                      const uc = gs.cardsById[c.cardId];
                      return (
                        <div key={c.uid} className="trash-item" title={uc ? `${uc.name}（${uc.id}）` : c.cardId} onClick={(e) => { e.stopPropagation(); if (uc) setPeekCard(uc); }}>
                          <img src={cardImageUrl(uc?.id ?? c.cardId)} alt={uc?.name ?? ''} draggable={false} />
                          <span>{uc?.name ?? c.cardId}</span>
                        </div>
                      );
                    })}
                    {inst.under.length === 0 && <div className="zone-empty">下方没有卡</div>}
                  </div>
                  <div className="prompt-actions">
                    <button onClick={() => setUnderView(null)}>关闭</button>
                  </div>
                </>
              );
            })()}
          </div>
        </div>
      )}

      {/* ゴミ箱查看界面（大图网格） */}
      {trashView !== null && (
        <div className="prompt-backdrop" onClick={() => setTrashView(null)}>
          <div className="trash-view-modal" onClick={(e) => e.stopPropagation()}>
            <h3>🗑 ゴミ箱（玩家 {trashView + 1} · {gs.players[trashView].trash.length} 张）</h3>
            <div className="trash-grid">
              {gs.players[trashView].trash.map((c) => {
                const card = gs.cardsById[c.cardId];
                return (
                  <div key={c.uid} className="trash-item" title={card ? `${card.name}（${card.id}）` : c.cardId} onClick={(e) => { e.stopPropagation(); if (card) setPeekCard(card); }}>
                    <img src={cardImageUrl(card?.id ?? c.cardId)} alt={card?.name ?? ''} draggable={false} />
                    <span>{card?.name ?? c.cardId}</span>
                  </div>
                );
              })}
              {gs.players[trashView].trash.length === 0 && <div className="zone-empty">ゴミ箱为空</div>}
            </div>
            <div className="prompt-actions">
              <button onClick={() => setTrashView(null)}>关闭</button>
            </div>
          </div>
        </div>
      )}

      {/* 除外区查看界面（bug 9） */}
      {removedView !== null && (
        <div className="prompt-backdrop" onClick={() => setRemovedView(null)}>
          <div className="trash-view-modal" onClick={(e) => e.stopPropagation()}>
            <h3>🚫 除外区（玩家 {removedView + 1} · {gs.players[removedView].removed.length} 张）</h3>
            <div className="trash-grid">
              {gs.players[removedView].removed.map((c) => {
                const card = gs.cardsById[c.cardId];
                return (
                  <div key={c.uid} className="trash-item" title={card ? `${card.name}（${card.id}）` : c.cardId} onClick={(e) => { e.stopPropagation(); if (card) setPeekCard(card); }}>
                    <img src={cardImageUrl(card?.id ?? c.cardId)} alt={card?.name ?? ''} draggable={false} />
                    <span>{card?.name ?? c.cardId}</span>
                  </div>
                );
              })}
            </div>
            <div className="prompt-actions">
              <button onClick={() => setRemovedView(null)}>关闭</button>
            </div>
          </div>
        </div>
      )}

      {/* 卡片旁弹出操作菜单 */}
      {menuPos && (
        <>
          <div className="card-menu-backdrop" onClick={() => setMenuPos(null)} />
          <div className="card-menu" style={{ left: menuPos.x, top: menuPos.y }}>
            <div className="card-menu-title">
              {selCard ? `${selCard.name}（${selCard.id}）` : '操作'}
            </div>
            {selectedActions.length === 0 ? (
              <button className="card-menu-item" onClick={() => setMenuPos(null)}>
                无可用操作
              </button>
            ) : (
              selectedActions.map((a, i) => (
                <button
                  key={i}
                  className="card-menu-item"
                  onClick={() => {
                    a.fn();
                    setMenuPos(null);
                  }}
                >
                  {a.label}
                </button>
              ))
            )}
            <button className="card-menu-item cancel" onClick={() => setMenuPos(null)}>
              取消
            </button>
          </div>
        </>
      )}
        </>
      )}
    </div>
  );

  function newGameLocal() {
    setGs(startGame(cards, deck));
    setSelected(null);
  }

  /** 对局结束：房主→回大厅再来一局；客机/观战者→等待房主；单机→直接新开 */
  function onGameOver() {
    if (mode === 'host') onRematch();
    else if (mode === 'local') newGameLocal();
    else setNetStatus('对局结束，等待房主回到大厅再来一局…');
  }
}

/** 窗口选项按钮（対応/战斗时点/回合结束）：事件/手札宣言/场效果带卡图 */
function WindowOptionBtn({ gs, id, label, cardId: givenCardId, onClick }: { gs: GameState; id: string; label: string; cardId?: string; onClick: () => void }) {
  const [kind, uid] = id.split(':');
  let cardId: string | null = givenCardId ?? null;
  if (!cardId && (kind === 'evt' || kind === 'hd' || kind === 'fd' || kind === 'sup' || kind === 'sdp') && uid) {
    const loc = findInstance(gs, uid);
    const inst = loc ? getInstAt(gs, loc) : undefined;
    cardId = inst ? (gs.cardsById[inst.cardId]?.id ?? null) : null;
  }
  // 悬停显示卡效果（对应/时点窗口可查看对手卡效果）
  const effectText = cardId ? (gs.cardsById[cardId]?.ability ?? '').replace(/<br\s*\/>/g, '\n').slice(0, 400) : '';
  // 切札选项：以红色【切札】突出显示（Bug ⑤）
  const TRUMP = '【切札】';
  const isTrump = label.startsWith(TRUMP);
  return (
    <button className="prompt-action" onClick={onClick} title={effectText || undefined}>
      {cardId && <img className="prompt-action-img" src={cardImageUrl(cardId)} alt="" draggable={false} />}
      <span>
        {isTrump && <span className="trump-tag">切札</span>}
        {isTrump ? label.slice(TRUMP.length) : label}
      </span>
    </button>
  );
}

/* ================= 提示弹窗 ================= */
function PromptModal({
  gs,
  onAction,
  onNewGame,
  selfPlayer,
  mode,
  onPickStat,
}: {
  gs: GameState;
  onAction: (action: string, ...args: unknown[]) => void;
  onNewGame: () => void;
  selfPlayer: PlayerIndex;
  mode: NetMode;
  onPickStat: (stat: string, amount: number) => void;
}) {
  const prompt = gs.prompt;
  const [discardSel, setDiscardSel] = useState<string[]>([]);
  const [pickSel, setPickSel] = useState<string[]>([]);
  const [hoverCard, setHoverCard] = useState<Card | null>(null);
  // 新提示出现时重置选择（Bug ⑬：6848 破弃对方角色 残留上一次的 5/2 选择）
  useEffect(() => {
    setDiscardSel([]);
    setPickSel([]);
    setHoverCard(null);
  }, [prompt]);

  // 悬停预览：显示卡图 + 效果文本（Bug ②：检索/选卡/手牌调整可查看卡效果）
  const Preview = hoverCard ? (
    <div className="prompt-card-preview">
      <img src={cardImageUrl(hoverCard.id)} alt={hoverCard.name} draggable={false} />
      <div className="prompt-card-preview-info">
        <div className="prompt-card-preview-name">{hoverCard.name}</div>
        <div className="prompt-card-preview-meta">
          费用 {hoverCard.cost || '—'} · {hoverCard.type === 'character' ? `AP ${hoverCard.ap ?? 0} / DP ${hoverCard.dp ?? 0} / SP ${hoverCard.sp ?? 0} / DMG ${hoverCard.dmg ?? 0}` : ''}
        </div>
        <pre className="prompt-card-preview-ability">{formatAbilityText(hoverCard.ability ?? '（无效果文本）')}</pre>
      </div>
    </div>
  ) : null;

  if (!prompt) return null;

  if (prompt.kind === 'rps') {
    const rps = gs.rps;
    const picks = [
      { v: 'rock' as const, label: '石头' },
      { v: 'paper' as const, label: '布' },
      { v: 'scissors' as const, label: '剪刀' },
    ];
    const myPick = rps ? (selfPlayer === 0 ? rps.p0 : rps.p1) : null;
    const label = (v: 'rock' | 'paper' | 'scissors') => picks.find((p) => p.v === v)?.label ?? '';
    // 本地：依次为两方选择；在线：只为自己选择
    const nextPicker = rps ? (rps.p0 === null ? 0 : rps.p1 === null ? 1 : -1) : -1;
    return (
      <Modal>
        <h3>⚔️ 石头剪刀布</h3>
        <p>双方已就位！石头剪刀布，赢家先攻。</p>
        {mode === 'local' ? (
          nextPicker >= 0 ? (
            <>
              <p>
                玩家 {nextPicker + 1} 请选择：
              </p>
              <div className="prompt-actions">
                {picks.map((p) => (
                  <button key={p.v} onClick={() => onAction('chooseRps', nextPicker, p.v)}>
                    ✊ {p.label}
                  </button>
                ))}
              </div>
            </>
          ) : (
            <p>正在判定…</p>
          )
        ) : myPick ? (
          <p>你出了「{label(myPick)}」，等待对方…</p>
        ) : (
          <>
            <p>你（玩家 {selfPlayer + 1}）请选择：</p>
            <div className="prompt-actions">
              {picks.map((p) => (
                <button key={p.v} onClick={() => onAction('chooseRps', selfPlayer, p.v)}>
                  ✊ {p.label}
                </button>
              ))}
            </div>
          </>
        )}
      </Modal>
    );
  }

  if (prompt.kind === 'rps-result') {
    const winLabel = `玩家 ${prompt.winner + 1}`;
    const you = selfPlayer;
    const youFirst = you === prompt.winner;
    const pickLabel = (v: 'rock' | 'paper' | 'scissors') =>
      ({ rock: '石头', paper: '布', scissors: '剪刀' })[v];
    const p0Label = pickLabel(prompt.p0);
    const p1Label = pickLabel(prompt.p1);
    return (
      <Modal>
        <h3>🎉 石头剪刀布结果</h3>
        <p>
          玩家 1 出「{p0Label}」，玩家 2 出「{p1Label}」。
        </p>
        <p style={{ fontSize: 15, color: '#ffd75e' }}>
          {winLabel} <b>先攻</b>！
        </p>
        <p style={{ fontSize: 15, color: '#e8eef7' }}>
          {youFirst ? '✅ 你是先手（先攻）' : '⏳ 你是后手（后攻）'}
        </p>
        <div className="prompt-actions">
          <button className="primary" onClick={() => onAction('confirmRpsResult')}>
            开始起手换牌
          </button>
        </div>
      </Modal>
    );
  }

  if (prompt.kind === 'damage') {
    return (
      <Modal>
        <h3>💥 掉血提示</h3>
        <p>
          玩家 {prompt.defender + 1} 的牌堆受到 <b>{prompt.dmg}</b> 点伤害，被破弃 <b>{prompt.broken}</b> 张卡。
        </p>
        <div className="prompt-actions">
          <button className="primary" onClick={() => onAction('confirmDamage')}>
            确定
          </button>
        </div>
      </Modal>
    );
  }

  if (prompt.kind === 'defense') {
    return (
      <Modal>
        <h3>防御选择</h3>
        <p>
          「{prompt.attackerName}」发起了攻击（玩家 {gs.turnPlayer + 1}）。请玩家 {2 - gs.turnPlayer} 选择防御角色或放弃防御。
        </p>
        <div className="prompt-actions">
          {prompt.candidates.map((c) => (
            <button key={c.uid} onClick={() => onAction('chooseDefense', c.uid)}>
              以「{c.name}」防御
            </button>
          ))}
          <button className="danger" onClick={() => onAction('chooseDefense', null)}>
            不防御（直接承受牌堆伤害）
          </button>
        </div>
      </Modal>
    );
  }

  if (prompt.kind === 'shield') {
    return (
      <Modal>
        <h3>护盾选择</h3>
        <p>
          牌堆将受到 <b>{prompt.dmg}</b> 点伤害。你有 {prompt.shieldCount} 张护盾，是否用护盾抵挡？
        </p>
        <div className="prompt-actions">
          <button onClick={() => onAction('chooseShield', true)}>用护盾抵挡</button>
          <button className="danger" onClick={() => onAction('chooseShield', false)}>
            不用护盾（牌堆承受伤害）
          </button>
        </div>
      </Modal>
    );
  }

  if (prompt.kind === 'hand-adjust') {
    const hand = gs.players[gs.turnPlayer].hand;
    const ready = discardSel.length === prompt.need;
    return (
      <Modal>
        <h3>手牌调整</h3>
        <p>
          手牌 {hand.length} 张超过 8 张，需破弃 <b>{prompt.need}</b> 张（已选 {discardSel.length}）。点击下方手牌选择。
        </p>
        <div className="adjust-hand">
          {hand.map((c) => {
            const card = gs.cardsById[c.cardId];
            const isSel = discardSel.includes(c.uid);
            return (
              <div
                key={c.uid}
                className={`adjust-card${isSel ? ' selected' : ''}`}
                onClick={() =>
                  setDiscardSel((s) => (isSel ? s.filter((u) => u !== c.uid) : s.length < prompt.need ? [...s, c.uid] : s))
                }
                onMouseEnter={() => setHoverCard(card)}
                onMouseLeave={() => setHoverCard(null)}
              >
                <img src={cardImageUrl(card.id)} alt={card.name} />
                <span>{card.name}</span>
              </div>
            );
          })}
        </div>
        {Preview}
        <div className="prompt-actions">
          <button disabled={!ready} onClick={() => onAction('confirmDiscard', discardSel)}>
            确认破弃
          </button>
        </div>
      </Modal>
    );
  }

  if (prompt.kind === 'equip-target') {
    return (
      <Modal>
        <h3>选择装备目标</h3>
        <p>将道具装备到哪个己方角色？（随后选择费用卡）</p>
        <div className="prompt-actions">
          {prompt.targets.map((t) => (
            <button key={t.uid} onClick={() => onAction('requestEquipItem', prompt.itemUid, t.uid)}>
              「{t.name}」
            </button>
          ))}
          <button className="danger" onClick={() => onAction('cancelPrompt')}>
            取消
          </button>
        </div>
      </Modal>
    );
  }

  if (prompt.kind === 'declare-target') {
    // 目标按钮按“场上 2×3 顺序”排布（Bug ②）：空格显示灰色“空”占位；其余（非场上）候选走附加列表
    const byCell = new Map<string, { uid: string; name: string; cardId: string }[]>();
    const sides: PlayerIndex[] = [];
    const extra: { uid: string; name: string; cardId: string }[] = [];
    for (const c of prompt.candidates) {
      const cl = findInstance(gs, c.uid);
      if (cl && cl.zone === 'field' && cl.row && cl.area !== undefined) {
        const key = `${cl.player}:${cl.row}:${cl.area}`;
        const arr = byCell.get(key) ?? [];
        arr.push(c);
        byCell.set(key, arr);
        if (!sides.includes(cl.player)) sides.push(cl.player);
      } else {
        extra.push(c);
      }
    }
    const sideName = (s: PlayerIndex) => `玩家 ${s + 1}`;
    const gridRows = (side: PlayerIndex) =>
      (['AF', 'DF'] as const).map((row) => (
        <div className="target-grid-row" key={side + row}>
          {([0, 1, 2] as const).map((a) => {
            const cellCands = byCell.get(`${side}:${row}:${a}`) ?? [];
            if (cellCands.length === 0) {
              return (
                <div className="target-cell empty" key={row + a}>
                  <div className="target-cell-pos">
                    {row === 'AF' ? '前' : '后'} {AREA_NAMES[a]}
                  </div>
                  <div className="target-cell-empty-txt">空</div>
                </div>
              );
            }
            return (
              <div className="target-cell" key={row + a}>
                <div className="target-cell-pos">
                  {row === 'AF' ? '前' : '后'} {AREA_NAMES[a]}
                </div>
                {cellCands.map((c) => (
                  <button
                    key={c.uid}
                    className="target-btn"
                    onClick={() => onAction('chooseDeclareTarget', c.uid)}
                    onMouseEnter={() => setHoverCard(c.cardId ? gs.cardsById[c.cardId] ?? null : null)}
                    onMouseLeave={() => setHoverCard(null)}
                  >
                    {c.name}
                  </button>
                ))}
              </div>
            );
          })}
        </div>
      ));
    return (
      <Modal>
        <h3>选择目标</h3>
        <p>{prompt.actionLabel}：请选择目标角色（空位表示场上该格没有角色）。</p>
        {sides.length === 0 ? (
          <div className="prompt-actions">
            {prompt.candidates.map((c) => (
              <WindowOptionBtn key={c.uid} gs={gs} id={c.uid} label={`「${c.name}」`} cardId={(c as any).cardId} onClick={() => onAction('chooseDeclareTarget', c.uid)} />
            ))}
          </div>
        ) : (
          sides.map((s) => (
            <div className="target-grid-wrap" key={s}>
              <div className="target-grid-title">{sideName(s)} 场地</div>
              <div className="target-grid">{gridRows(s)}</div>
            </div>
          ))
        )}
        {extra.length > 0 && (
          <div className="prompt-actions target-extra">
            {extra.map((c) => (
              <WindowOptionBtn key={c.uid} gs={gs} id={c.uid} label={`「${c.name}」`} cardId={c.cardId} onClick={() => onAction('chooseDeclareTarget', c.uid)} />
            ))}
          </div>
        )}
        <div className="prompt-actions">
          <button className="danger" onClick={() => onAction('cancelPrompt')}>
            取消
          </button>
        </div>
      </Modal>
    );
  }

  if (prompt.kind === 'search-deploy') {
    const mode = prompt.mode ?? (prompt.placeMode ? 'place' : 'deploy');
    const modeLabel = { deploy: '登场', place: '配置', hand: '加入手牌', charge: '充能', equip: '装备' }[mode];
    const costNote = mode === 'deploy' && prompt.free === false ? '（需正常支付登场费用）' : mode === 'deploy' ? '（无偿）' : '';
    return (
      <Modal>
        <h3>🔍 检索</h3>
        <p>{prompt.title}</p>
        <div className="prompt-actions">
          {prompt.candidates.map((c) => (
            <button
              key={c.uid}
              onClick={() => onAction('chooseSearchDeploy', c.uid, false)}
              onMouseEnter={() => setHoverCard(c.cardId ? gs.cardsById[c.cardId] ?? null : null)}
              onMouseLeave={() => setHoverCard(null)}
            >
              「{c.name}」（{c.zone}）→ {modeLabel}
              {costNote}
            </button>
          ))}
          {prompt.altMode === 'charge' &&
            prompt.candidates.map((c) => (
              <button
                key={c.uid + '-alt'}
                onClick={() => onAction('chooseSearchDeploy', c.uid, true)}
                onMouseEnter={() => setHoverCard(c.cardId ? gs.cardsById[c.cardId] ?? null : null)}
                onMouseLeave={() => setHoverCard(null)}
              >
                「{c.name}」（{c.zone}）→ 作为充能
              </button>
            ))}
          <button className="danger" onClick={() => onAction('chooseSearchDeploy', null)}>
            放弃
          </button>
        </div>
        {Preview}
      </Modal>
    );
  }

  if (prompt.kind === 'effect-choice') {
    return (
      <Modal>
        <h3>✨ 效果选择</h3>
        <p>{prompt.title}</p>
        <div className="prompt-actions">
          {prompt.options.map((o) => (
            <WindowOptionBtn key={o.id} gs={gs} id={o.id} label={o.label} cardId={(o as any).cardId} onClick={() => onAction('chooseEffectOption', [o.id])} />
          ))}
          <button className="danger" onClick={() => onAction('cancelPrompt')}>
            取消
          </button>
        </div>
        <p className="prompt-note">（本面板支持 宣言/诱発 效果结算；含手动部分的效果会再弹出手动面板）</p>
      </Modal>
    );
  }

  if (prompt.kind === 'card-pick') {
    // 「最多 N 张」类选择允许选 0~N（手牌/下方合计破弃、破弃对方角色、充能、置き場放置等）
    const upTo = prompt.purpose === 'handUnder' || prompt.purpose === 'discardOppChar' || prompt.purpose === 'charge' || prompt.purpose === 'store' || prompt.purpose === 'storeUnder' || prompt.purpose === 'healDeck' || prompt.purpose === 'discardCharge';
    const ready = upTo ? pickSel.length <= prompt.max : pickSel.length === prompt.max;
    return (
      <Modal>
        <h3>🃏 选择卡片</h3>
        <p>{prompt.title}</p>
        <div className="adjust-hand">
          {prompt.candidates.map((c) => {
            const isSel = pickSel.includes(c.uid);
            return (
              <div
                key={c.uid}
                className={`adjust-card${isSel ? ' selected' : ''}`}
                onClick={() =>
                  setPickSel((s) => (isSel ? s.filter((u) => u !== c.uid) : s.length < prompt.max ? [...s, c.uid] : s))
                }
                onMouseEnter={() => setHoverCard(gs.cardsById[c.cardId] ?? null)}
                onMouseLeave={() => setHoverCard(null)}
              >
                <img src={cardImageUrl(c.cardId)} alt={c.name} draggable={false} />
                <span>{c.name}</span>
              </div>
            );
          })}
        </div>
        {Preview}
        <div className="prompt-actions">
          <button disabled={!ready} onClick={() => onAction('chooseCardPick', pickSel)}>
            确认（已选 {pickSel.length}/{prompt.max}）
          </button>
          <button className="danger" onClick={() => onAction('cancelPrompt')}>
            取消
          </button>
        </div>
      </Modal>
    );
  }

  if (prompt.kind === 'slot-pick') {
    // 登场位置（Bug ①）：与正常宣言登场一致，直接点击场上高亮空格，而非弹出按钮列表
    return (
      <div className="timing-panel">
        <div className="timing-panel-head">
          <span className="timing-panel-title">📍 选择登场位置</span>
          <button className="timing-panel-cancel" onClick={() => onAction('cancelPrompt')}>
            取消
          </button>
        </div>
        <div className="timing-panel-hint">{prompt.title}——点击场上高亮空格登场。</div>
      </div>
    );
  }

  if (prompt.kind === 'response') {
    // 对应窗口（Bug ⑤）：非遮挡浮动面板，可直接点击卡进行宣言；右上角取消对应
    const declTitle = prompt.title.split('：')[0] ?? prompt.title;
    return (
      <div className="timing-panel">
        <div className="timing-panel-head">
          <span className="timing-panel-title">🛡️ 对应宣言窗口</span>
          <button className="timing-panel-cancel" onClick={() => onAction('respond', 'pass')}>
            取消对应（放弃→倒序结算）
          </button>
        </div>
        <div className="response-declarer">
          {prompt.cardId ? (
            <img className="response-declarer-img" src={cardImageUrl(prompt.cardId)} alt="" draggable={false} />
          ) : (
            <div className="response-declarer-img empty">🃏</div>
          )}
          <div className="response-declarer-info">
            <div className="response-declarer-title">对方宣言</div>
            <div className="response-declarer-text">{declTitle}</div>
            {prompt.effectLabel && <div className="response-declarer-effect">效果：{prompt.effectLabel}</div>}
            <div className="response-declarer-hint">点击手牌/己方场上卡即可对应宣言；若无不行动，点右上角“取消对应”放弃。</div>
          </div>
        </div>
      </div>
    );
  }

  if (prompt.kind === 'battle-timing') {
    return (
      <div className="timing-panel">
        <div className="timing-panel-head">
          <span className="timing-panel-title">⚔️ バトル中宣言タイミング · 玩家 {prompt.owner + 1}</span>
          <button className="timing-panel-cancel" onClick={() => onAction('battleTimingAction', 'end')}>
            结束宣言时机（放弃）
          </button>
        </div>
        <div className="timing-panel-hint">
          点击己方手牌/场上卡进行支援、事件、手札宣言或场效果；点右上角“结束把宣言时机”放弃。
        </div>
      </div>
    );
  }

  if (prompt.kind === 'end-main') {
    // 主阶段结束确认：非全屏遮挡的小窗（同战斗时点样式）——可点己方手牌/场上卡直接使用宣言/事件
    const ownerP = prompt.owner;
    const canAgree = mode === 'local' || ownerP === selfPlayer;
    const canCancel = mode === 'local' || gs.turnPlayer === selfPlayer;
    return (
      <div className="timing-panel">
        <div className="timing-panel-head">
          <span className="timing-panel-title">⏹ 主阶段结束 · 玩家 {gs.turnPlayer + 1} 宣言结束</span>
          <span className="timing-panel-btns">
            {canCancel && (
              <button className="timing-panel-cancel" onClick={() => onAction('endMainCancel')}>
                ✖ 取消（继续主阶段）
              </button>
            )}
            {canAgree && (
              <button className="timing-panel-ok" onClick={() => onAction('endMainAction', 'end')}>
                ✅ 同意结束
              </button>
            )}
          </span>
        </div>
        <div className="timing-panel-hint">
          优先权在玩家 {ownerP + 1}：直接点击手牌 / 己方场上卡即可使用事件、手札宣言或场效果；点「同意结束」进入结束阶段。
          {canCancel && ' 回合玩家也可点「取消」返回主阶段继续操作。'}
        </div>
      </div>
    );
  }

  if (prompt.kind === 'mulligan') {
    // 起手换牌：非全屏遮挡面板，可悬停/点击下方手牌查看效果后再决定
    return (
      <div className="mulligan-panel">
        <h3>🔄 起手换牌</h3>
        <p>
          玩家 {prompt.owner + 1}：是否重抽起手？（先攻先决定）<br />
          <span className="mulligan-hint">💡 悬停或点击下方手牌可在右侧查看效果，再决定是否保留。</span>
        </p>
        <div className="prompt-actions">
          <button onClick={() => onAction('chooseMulligan', true)}>重抽 7 张</button>
          <button onClick={() => onAction('chooseMulligan', false)}>保留手牌</button>
        </div>
      </div>
    );
  }

  if (prompt.kind === 'support') {
    return (
      <Modal>
        <h3>🤝 战斗支援（{prompt.gain === 'AP' ? '攻击方' : '防御方'}）</h3>
        <p>
          选择与「{gs.cardsById[prompt.targetUid]?.name ?? prompt.attackerName}」相邻的未行动味方角色支援（SP 加入{prompt.gain === 'AP' ? '攻击力 AP' : '防御力 DP'}，仅本次战斗有效）？
        </p>
        <div className="prompt-actions">
          {prompt.candidates.map((c) => (
            <button key={c.uid} onClick={() => onAction('chooseSupport', c.uid)}>
              「{c.name}」支援（SP {c.sp}
              {c.cost ? `，费用 [${c.cost}]` : ''}）
            </button>
          ))}
          <button className="danger" onClick={() => onAction('chooseSupport', null)}>
            不支援
          </button>
        </div>
      </Modal>
    );
  }

  if (prompt.kind === 'manual-effect') {
    return (
      <div className="manual-panel">
        <div className="manual-title">🛠 {prompt.title}</div>
        <div className="manual-text">{formatAbilityText(prompt.text)}</div>
        <div className="manual-hint">该效果无法自动结算，请按效果文本手动操作：</div>
        <div className="manual-tools">
          <button onClick={() => onAction('manualDraw', 1)}>抽 1 张</button>
          <button onClick={() => onAction('manualDraw', 2)}>抽 2 张</button>
          <button onClick={() => onAction('manualDeckDiscard', 1)}>破弃牌堆顶 1 张</button>
          <span className="manual-sep">数值修正（点击后选目标角色）：</span>
          <button onClick={() => onPickStat('ap', 1)}>AP+1</button>
          <button onClick={() => onPickStat('ap', 2)}>AP+2</button>
          <button onClick={() => onPickStat('ap', -1)}>AP-1</button>
          <button onClick={() => onPickStat('dp', 1)}>DP+1</button>
          <button onClick={() => onPickStat('dp', -1)}>DP-1</button>
          <button onClick={() => onPickStat('sp', 1)}>SP+1</button>
          <button onClick={() => onPickStat('dmg', 1)}>DMG+1</button>
        </div>
        <div className="manual-actions">
          <button className="primary" onClick={() => onAction('manualDone')}>
            完成
          </button>
        </div>
      </div>
    );
  }

  if (prompt.kind === 'cost-pay') {
    return <CostPayModal gs={gs} prompt={prompt} onAction={onAction} />;
  }

  if (prompt.kind === 'gameover') {
    return (
      <Modal>
        <h3>🏆 对局结束</h3>
        <p className="winner-text">玩家 {prompt.winner + 1} 获胜！（对方牌堆归零）</p>
        <div className="prompt-actions">
          <button onClick={onNewGame}>再来一局</button>
        </div>
      </Modal>
    );
  }

  return null;
}

function Modal({ children }: { children: React.ReactNode }) {
  return (
    <div className="prompt-backdrop">
      <div className="prompt-modal">{children}</div>
    </div>
  );
}

/** 战斗状态条：实时显示双方参战角色的有效数值（bug 5） */
function BattleStatusBar({ gs }: { gs: GameState }) {
  if (!gs.battle) return null;
  const b = gs.battle;
  const statOf = (uid: string | null) => {
    if (!uid) return null;
    const s = engStats(gs, uid);
    const loc = findInstance(gs, uid);
    const inst = loc ? getInstAt(gs, loc) : undefined;
    const card = inst ? gs.cardsById[inst.cardId] : undefined;
    return { name: card?.name ?? '?', cardId: card?.id ?? inst?.cardId ?? '', ap: s.ap, dp: s.dp, sp: s.sp, dmg: s.dmg, tapped: !!inst?.tapped };
  };
  const atk = statOf(b.attackerUid);
  const def = statOf(b.defenderUid);
  const side = (p: { name: string; cardId: string; ap: number; dp: number; sp: number; dmg: number; tapped: boolean } | null, label: string) =>
    p ? (
      <div className="bs-side">
        <img className="bs-img" src={cardImageUrl(p.cardId)} alt="" draggable={false} />
        <div>
          <div className="bs-name">
            {label}「{p.name}」{p.tapped ? '（已行动）' : ''}
          </div>
          <div className="bs-stats">
            <em>AP {p.ap}</em> <em>DP {p.dp}</em> <em>SP {p.sp}</em> <em>DMG {p.dmg}</em>
          </div>
        </div>
      </div>
    ) : (
      <div className="bs-side">
        <div className="bs-name">{label}：无</div>
        <div className="bs-stats">（不防御 → 直接牌堆伤害）</div>
      </div>
    );
  return (
    <div className="battle-status-bar">
      {side(atk, '攻击方')}
      <div className="bs-vs">⚔</div>
      {side(def, '防御方')}
    </div>
  );
}

/** 费用支付选择弹窗：玩家手动选择要破弃的费用卡 */
function CostPayModal({
  gs,
  prompt,
  onAction,
}: {
  gs: GameState;
  prompt: Extract<NonNullable<GameState['prompt']>, { kind: 'cost-pay' }>;
  onAction: (action: string, ...args: unknown[]) => void;
}) {
  const [sel, setSel] = useState<string[]>([]);
  const selData = prompt.candidates.filter((c) => sel.includes(c.uid)).map((c) => ({ elements: c.elements, ex: c.ex }));
  const valid = rules.validateCostSelection(selData, prompt.cost);
  const coverage = rules.selectionCoverage(selData, prompt.cost);

  const toggle = (uid: string) => setSel((s) => (s.includes(uid) ? s.filter((u) => u !== uid) : [...s, uid]));

  // 付费时可用的 [コスト] 能力（Bug 8：选择费用时除了手牌还提供 cost 效果）
  const p = prompt.owner;
  const st = gs.players[p];
  const turn = gs.turn;
  const costAbilities: { uid: string; name: string; gen: string; note: string }[] = [];
  const pushCostAbility = (inst: CardInstance | null | undefined, card: Card | undefined) => {
    if (!inst || !card) return;
    const parsed = getParsed(card);
    const ab = parsed.costAbilities[0];
    if (!ab) return;
    if (ab.lose && inst.lost.includes('cost')) return;
    const key = `cost:${inst.uid}:${turn}`;
    if ((st.perTurn[key] ?? 0) >= ab.perTurn) return;
    if (ab.noDeployTurn && inst.deployedTurn === turn) return;
    if (ab.underCost > 0 && inst.under.length < ab.underCost) return;
    costAbilities.push({
      uid: inst.uid,
      name: card.name,
      gen: `[${ab.generate}]`,
      note: ab.tag === 'surprise_char' ? '（仅サプライズ登场）' : ab.tag === 'equip_only' ? '（仅装备）' : ab.tag === 'char3plus_or_supporter' ? '（仅3点以上/サポーター）' : '',
    });
  };
  for (let r = 0; r < 2; r++) {
    for (let a = 0; a < 3; a++) {
      const cell = st.field[r][a];
      if (cell) {
        pushCostAbility(cell, gs.cardsById[cell.cardId]);
        pushCostAbility(cell.equip, cell.equip ? gs.cardsById[cell.equip.cardId] : undefined);
      }
      const ar = st.fieldAreas[r][a];
      pushCostAbility(ar, ar ? gs.cardsById[ar.cardId] : undefined);
    }
  }

  return (
    <Modal>
      <h3>支付费用</h3>
      <p>
        <b>{prompt.actionLabel}</b>
        <br />
        费用要求：{coverage.length === 0 ? '无' : coverage.map((c) => `${c.elem}×${c.points}`).join('、')}
        {'　'}
        {coverage.map((c, i) => (
          <span key={i} className={c.ok ? 'cost-ok' : 'cost-bad'}>
            {c.elem} {c.got}/{c.points}点{!c.ok && ' ✗'}
          </span>
        ))}
      </p>
      <p className="cost-hint">点击手牌选择要破弃的费用卡（EX 点数累计 ≥ 费用点数，属性需匹配；無 可用任意属性）。</p>
      {costAbilities.length > 0 && (
        <div className="cost-abilities">
          <p className="cost-hint">可用 [コスト] 能力（生成费用自动抵扣）：</p>
          <div className="cost-ability-btns">
            {costAbilities.map((ca) => (
              <button key={ca.uid} onClick={() => onAction('useCostAbilityInPay', ca.uid)}>
                「{ca.name}」生成 {ca.gen}
                {ca.note}
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="cost-hand">
        {prompt.candidates.map((c) => {
          const isSel = sel.includes(c.uid);
          return (
            <div key={c.uid} className={`cost-card${isSel ? ' selected' : ''}`} onClick={() => toggle(c.uid)}>
              <img src={cardImageUrlByCardId(gs, c.uid)} alt={c.name} />
              <div className="cost-card-info">
                <span className="cost-card-name">{c.name}</span>
                <span className="cost-card-tags">
                  <em style={{ color: ELEMENT_COLORS[c.elements] ?? '#ccc' }}>{c.elements || '無'}</em> EX{c.ex}
                </span>
              </div>
            </div>
          );
        })}
      </div>
      <div className="prompt-actions">
        <button disabled={!valid} onClick={() => onAction('confirmCostPay', sel)}>
          确认支付并{prompt.pending.action === 'deploy' ? '登场' : prompt.pending.action === 'event' ? '使用' : prompt.pending.action === 'area' ? '配置' : '装备'}
        </button>
        <button className="danger" onClick={() => onAction('cancelCostPay')}>
          取消
        </button>
      </div>
    </Modal>
  );
}

/** 通过 uid 找卡牌数据并生成卡图地址（从手牌中查找） */
function cardImageUrlByCardId(gs: GameState, uid: string): string {
  for (const p of [0, 1] as PlayerIndex[]) {
    const c = gs.players[p].hand.find((x) => x.uid === uid);
    if (c) return cardImageUrl(c.cardId);
  }
  return '';
}

/* ================= 左栏置场 ================= */
function SideZones({
  gs,
  player,
  selected,
  self,
  onCardClick,
  onCardHover,
  onZoneClick,
  onDeckClick,
  onStorageClick,
}: {
  gs: GameState;
  player: PlayerIndex;
  selected: string | null;
  self?: boolean;
  onCardClick: (uid: string, rect: DOMRect) => void;
  onCardHover: (uid: string | null) => void;
  onZoneClick: (player: PlayerIndex, zone: ZoneName) => void;
  onDeckClick: (player: PlayerIndex) => void;
  onStorageClick: (player: PlayerIndex, name: string) => void;
}) {
  const st = gs.players[player];
  const zones: { zone: ZoneName; list: CardInstance[] }[] = [
    { zone: 'deck', list: st.deck },
    { zone: 'hand', list: st.hand },
    { zone: 'shield', list: st.shield },
    { zone: 'special', list: st.special },
    { zone: 'trash', list: st.trash },
    { zone: 'removed', list: st.removed },
  ];

  return (
    <div className={`side-zones ${self ? 'self' : 'opponent'}`}>
      <div className="side-player-label">
        玩家 {player + 1}
        {st.name ? ` · ${st.name}` : ''}
        {self ? '（自己）' : '（对手）'}
        {gs.turnPlayer === player && <em className="turn-mark">●</em>}
      </div>
      {zones.map(({ zone, list }) => (
        <div
          key={zone}
          className={`zone zone-${zone}`}
          onClick={() => (zone === 'deck' ? onDeckClick(player) : onZoneClick(player, zone))}
        >
          <div className="zone-label">{ZONE_NAMES[zone]}</div>
          <div className="zone-body">
            {list.length === 0 && <div className="zone-empty">—</div>}
            {zone === 'deck' && list.length > 0 && (
              <BoardCard
                inst={list[list.length - 1]}
                card={gs.cardsById[list[list.length - 1].cardId]}
                selected={false}
                onClick={() => onDeckClick(player)}
                onHover={() => onCardHover(list[list.length - 1].uid)}
                size="zone"
              />
            )}
            {zone !== 'deck' && !(self && zone === 'hand') && (
              <div className="zone-stack">
                {list.slice(0, 4).map((c) => (
                  <CardWrap
                    key={c.uid}
                    gs={gs}
                    inst={c}
                    selected={selected === c.uid}
                    hidden={!self && zone === 'hand'}
                    size="zone"
                    onCardClick={onCardClick}
                    onCardHover={onCardHover}
                  />
                ))}
                {list.length > 4 && <div className="zone-more">+{list.length - 4}</div>}
              </div>
            )}
            {list.length > 0 && <div className="zone-count">{list.length}</div>}
          </div>
        </div>
      ))}
      {/* 置き場（青春カウント / 野良天使 / Orohoraの箱 等）：场上卡引用到的即使为空也显示（Bug 11），可点击查看 */}
      {(() => {
        const known = new Set<string>(Object.keys(st.storage));
        const pushNames = (text: string | undefined) => {
          if (!text) return;
          const re = /「([^」]+)」置き場/g;
          let m: RegExpExecArray | null;
          while ((m = re.exec(text))) known.add(m[1]);
        };
        for (let r = 0; r < 2; r++) {
          for (let a = 0; a < 3; a++) {
            const cell = st.field[r][a];
            if (cell) {
              pushNames(gs.cardsById[cell.cardId]?.ability);
              pushNames(cell.equip ? gs.cardsById[cell.equip.cardId]?.ability : undefined);
            }
            const ar = st.fieldAreas[r][a];
            if (ar) pushNames(gs.cardsById[ar.cardId]?.ability);
          }
        }
        return [...known].sort().map((name) => {
          const list = st.storage[name] ?? [];
          return (
            <div key={'st-' + name} className="zone zone-storage" onClick={() => onStorageClick(player, name)}>
              <div className="zone-label">📂 {name}置き場</div>
              <div className="zone-body">
                {list.length === 0 && <div className="zone-empty">—</div>}
                {list.length > 0 && (
                  <div className="zone-stack">
                    {list.slice(0, 4).map((c) => (
                      <CardWrap
                        key={c.uid}
                        gs={gs}
                        inst={c}
                        selected={false}
                        size="zone"
                        onCardClick={onCardClick}
                        onCardHover={onCardHover}
                      />
                    ))}
                    {list.length > 4 && <div className="zone-more">+{list.length - 4}</div>}
                  </div>
                )}
                {list.length > 0 && <div className="zone-count">{list.length}</div>}
              </div>
            </div>
          );
        });
      })()}
    </div>
  );
}

/* ================= 中央场地 ================= */
function SideField({
  gs,
  player,
  selected,
  opponent,
  onCardClick,
  onCardHover,
  onSlotClick,
  moveTargets,
}: {
  gs: GameState;
  player: PlayerIndex;
  selected: string | null;
  opponent?: boolean;
  onCardClick: (uid: string, rect: DOMRect) => void;
  onCardHover: (uid: string | null) => void;
  onSlotClick: (player: PlayerIndex, row: RowName, area: AreaIndex) => void;
  moveTargets?: { row: RowName; area: AreaIndex }[];
}) {
  const st = gs.players[player];
  const rows: { row: RowName; label: string }[] = opponent
    ? [
        { row: 'DF', label: 'DF 后列' },
        { row: 'AF', label: 'AF 前列' },
      ]
    : [
        { row: 'AF', label: 'AF 前列' },
        { row: 'DF', label: 'DF 后列' },
      ];

  return (
    <div className={`side-field ${opponent ? 'opponent' : 'self'}`}>
      {rows.map(({ row, label }) => (
        <div key={row} className={`field-row row-${row}`}>
          <div className="row-label">{label}</div>
          <div className="field-slots">
            {[0, 1, 2].map((a) => {
              const r = row === 'AF' ? 0 : 1;
              const cell = st.field[r][a];
              const areaCard = st.fieldAreas[r][a];
              return (
                <div
                  key={a}
                  className={`field-slot${cell ? ' occupied' : ''}${moveTargets?.some((t) => t.row === row && t.area === a) ? ' move-target' : ''}`}
                  onClick={() => onSlotClick(player, row, a as AreaIndex)}
                >
                  <div className="slot-area">{AREA_NAMES[a]}</div>
                  {areaCard && (
                    <div
                      className={`field-area-badge${selected === areaCard.uid ? ' selected' : ''}`}
                      title={`エリア：${gs.cardsById[areaCard.cardId]?.name ?? ''}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        onCardClick(areaCard.uid, (e.currentTarget as HTMLElement).getBoundingClientRect());
                      }}
                    >
                      <img src={cardImageUrl(gs.cardsById[areaCard.cardId]?.id ?? areaCard.cardId)} alt="" draggable={false} />
                      <span className="field-area-tag">エリア</span>
                    </div>
                  )}
                  {cell ? (
                    <CardWrap
                      gs={gs}
                      inst={cell}
                      selected={selected === cell.uid}
                      onCardClick={onCardClick}
                      onCardHover={onCardHover}
                    />
                  ) : (
                    <div className="slot-empty">＋</div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

/* ================= 自己手牌 ================= */
function SelfHand({
  gs,
  selfPlayer,
  selected,
  onCardClick,
  onCardHover,
}: {
  gs: GameState;
  selfPlayer: PlayerIndex;
  selected: string | null;
  onCardClick: (uid: string, rect: DOMRect) => void;
  onCardHover: (uid: string | null) => void;
}) {
  const hand = gs.players[selfPlayer].hand;
  if (hand.length === 0) return <div className="self-hand empty">手札为空</div>;
  return (
    <div className="self-hand">
      <div className="self-hand-label">手札（{hand.length}）</div>
      <div className="hand-fan">
        {hand.map((c) => (
          <CardWrap
            key={c.uid}
            gs={gs}
            inst={c}
            selected={selected === c.uid}
            size="hand"
            onCardClick={onCardClick}
            onCardHover={onCardHover}
          />
        ))}
      </div>
    </div>
  );
}

/* ================= 右侧详情面板 ================= */
function CardInfoPanel({
  gs,
  uid,
  selfPlayer,
  onPeek,
}: {
  gs: GameState;
  uid: string | null;
  selfPlayer: PlayerIndex;
  onPeek?: (card: Card) => void;
}) {
  const loc = uid ? findInstance(gs, uid) : null;
  const inst = loc ? getInstAt(gs, loc) : undefined;
  const card = inst ? gs.cardsById[inst.cardId] : undefined;
  const effStats = card && inst ? effectiveStats(gs, inst.uid) : { ap: 0, dp: 0, sp: 0, dmg: 0 };

  if (!inst || !card || !loc) {
    return (
      <aside className="info-panel">
        <div className="info-placeholder">
          <div className="info-ph-icon">🃏</div>
          <div>点击或悬停一张卡</div>
          <div>查看详情与效果</div>
        </div>
      </aside>
    );
  }

  // 隐藏信息：牌堆背面 / 对方手牌 不显示详情（防止信息泄露）
  if (loc.zone === 'deck' || (loc.zone === 'hand' && loc.player !== selfPlayer)) {
    return (
      <aside className="info-panel">
        <div className="info-placeholder">
          <div className="info-ph-icon">🂠</div>
          <div>{loc.zone === 'deck' ? '牌堆（背面）' : '对方手牌'}</div>
          <div>不能查看内容</div>
        </div>
      </aside>
    );
  }

  const abilities = parseBasicAbilities(card.basicAbilities);
  const locLabel = locationLabel(loc);

  return (
    <aside className="info-panel">
      <div className="info-image">
        <img src={cardImageUrl(card.id)} alt={card.name} />
      </div>
      <div className="info-name">{card.name}</div>
      <div className="info-id">
        {card.id} · {locLabel}
        {inst.deployedTurn === gs.turn && card.type === 'character' && <span className="info-new">（本回合登场）</span>}
      </div>

      {card.type === 'character' &&
        (loc.zone === 'field' ? (
          <div className="info-stats">
            <span className="st-ap">AP {effStats.ap}</span>
            <span className="st-dp">DP {effStats.dp}</span>
            <span className="st-sp">SP {effStats.sp}</span>
            <span className="st-dmg">DMG {effStats.dmg}</span>
          </div>
        ) : (
          <div className="info-stats">
            <span className="st-ap">AP {card.ap}</span>
            <span className="st-dp">DP {card.dp}</span>
            <span className="st-sp">SP {card.sp}</span>
            <span className="st-dmg">DMG {card.dmg}</span>
          </div>
        ))}

      <div className="info-tags">
        <span className="tag">{card.typeRaw}</span>
        {card.elements && (
          <span className="tag" style={{ color: ELEMENT_COLORS[card.elements] ?? '#ccc' }}>
            {card.elements}
          </span>
        )}
        <span className="tag">EX {card.ex}</span>
        {card.cost && <span className="tag">费用 {card.cost}</span>}
        {card.type === 'character' && card.positionFlags.trim() !== '' && (
          <span className="tag">配置 {card.positionFlags}</span>
        )}
        {card.rarity && <span className="tag">稀有度 {card.rarity}</span>}
      </div>

      {abilities.length > 0 && (
        <div className="info-section">
          <div className="info-section-title">基本能力</div>
          <div className="ability-tags">
            {abilities.map((a, i) => {
              const info = ABILITY_GLOSSARY[a.tag];
              const tip = info ? `【${info.kind}】${info.desc}` : undefined;
              return (
                <span key={i} className="ability-tag" title={tip} style={tip ? { cursor: 'help' } : undefined}>
                  {a.tag}
                  {a.value && <em>{a.value}</em>}
                </span>
              );
            })}
          </div>
        </div>
      )}

      {card.abilityName && (
        <div className="info-section">
          <div className="info-section-title">効果名</div>
          <div className="info-ability-name">{card.abilityName}</div>
        </div>
      )}

      {inst.charge.length > 0 && (
        <div className="info-section">
          <div className="info-section-title">⚡ 充能（{inst.charge.length} 张）</div>
          <div className="info-under-list">
            {inst.charge.map((c) => {
              const cc = gs.cardsById[c.cardId];
              return (
                <div key={c.uid} className="info-under-item" title={cc?.name ?? c.cardId} onClick={() => cc && onPeek?.(cc)}>
                  <img src={cardImageUrl(cc?.id ?? c.cardId)} alt="" draggable={false} />
                  <span>{cc?.name ?? c.cardId}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {inst.under.length > 0 && (
        <div className="info-section">
          <div className="info-section-title">📥 下方卡（{inst.under.length} 张）</div>
          <div className="info-under-list">
            {inst.under.map((c) => {
              const cc = gs.cardsById[c.cardId];
              return (
                <div key={c.uid} className="info-under-item" title={cc?.name ?? c.cardId} onClick={() => cc && onPeek?.(cc)}>
                  <img src={cardImageUrl(cc?.id ?? c.cardId)} alt="" draggable={false} />
                  <span>{cc?.name ?? c.cardId}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {inst.equip && gs.cardsById[inst.equip.cardId] && (
        <div className="info-section">
          <div className="info-section-title">🎒 装备道具（常时效果已计入上方数值）</div>
          {(() => {
            const eqCard = gs.cardsById[inst.equip!.cardId];
            return (
              <div className="info-under-item" title={eqCard.name} onClick={() => onPeek?.(eqCard)}>
                <img src={cardImageUrl(eqCard.id)} alt="" draggable={false} />
                <span>{eqCard.name}</span>
              </div>
            );
          })()}
        </div>
      )}

      {card.ability && (
        <div className="info-section info-effect-sec">
          <div className="info-section-title">効果テキスト（效果文本，可滚动查看）</div>
          <pre className="info-ability">{formatAbilityText(card.ability)}</pre>
        </div>
      )}

      {(card.cardSet || card.brand) && (
        <div className="info-meta">
          {card.cardSet && <div>卡包：{card.cardSet}</div>}
          {card.brand && <div>作品：{card.brand}</div>}
        </div>
      )}
    </aside>
  );
}

function locationLabel(loc: { zone: ZoneName; row?: RowName; area?: AreaIndex; index: number }): string {
  if (loc.zone === 'field') return `${loc.row === 'AF' ? '前列' : '后列'}·${AREA_NAMES[loc.area ?? 0]}`;
  return ZONE_NAMES[loc.zone];
}

/* ===== 辅助函数 ===== */
function getInstAt(
  gs: GameState,
  loc: { player: PlayerIndex; zone: ZoneName; row?: RowName; area?: AreaIndex; index: number } | null,
): CardInstance | undefined {
  if (!loc) return undefined;
  const st = gs.players[loc.player];
  if (loc.zone === 'field') return st.field[loc.row === 'AF' ? 0 : 1][loc.area ?? 0] ?? undefined;
  if (loc.zone === 'area') return st.fieldAreas[loc.row === 'AF' ? 0 : 1][loc.area ?? 0] ?? undefined;
  if (loc.zone === 'equip') return st.field[loc.row === 'AF' ? 0 : 1][loc.area ?? 0]?.equip ?? undefined;
  const map: Record<string, CardInstance[]> = { deck: st.deck, hand: st.hand, trash: st.trash, shield: st.shield, special: st.special };
  const list = map[loc.zone];
  return list && loc.index >= 0 ? list[loc.index] : undefined;
}

function shuffleArr<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
