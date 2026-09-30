// 卡组存储工具：支持保存多个卡组、读取/删除/校验
import type { Card } from './cards';

const STORAGE_KEY = 'lycee-decks';

export interface SavedDeck {
  name: string;
  ids: string[];
  song?: string; // 绑定的“战歌”文件名（无 = 不播放）
  voice?: string; // 绑定的“语音包”名（无 = 不播放语音）
}

/** 卡号 → 基础编号（同编号最多 4 张，忽略尾部字母） */
export function baseNumber(id: string): string {
  const m = /^LO-(\d+)/i.exec(id);
  return m ? `LO-${m[1]}` : id;
}

/** 校验并规范化牌组：过滤不在卡池中的卡、限制每种最多 4 张、总张数上限 60 */
export function normalizeDeck(ids: string[], pool: Card[]): string[] {
  const poolIds = new Set(pool.map((c) => c.id));
  const counts = new Map<string, number>();
  const out: string[] = [];
  for (const id of ids) {
    if (!poolIds.has(id)) continue;
    const key = baseNumber(id);
    if ((counts.get(key) ?? 0) >= 4) continue;
    if (out.length >= 60) break;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    out.push(id);
  }
  return out;
}

/** 读取全部已保存的卡组（含旧版单卡组迁移） */
export function loadDecks(pool: Card[]): SavedDeck[] {
  let decks: SavedDeck[] = [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as SavedDeck[];
      if (Array.isArray(parsed)) decks = parsed;
    }
  } catch {
    /* 忽略 */
  }
  // 迁移旧版单卡组
  if (decks.length === 0) {
    try {
      const old = localStorage.getItem('lycee-deck');
      if (old) {
        const ids = JSON.parse(old) as string[];
        if (Array.isArray(ids) && ids.length > 0) {
          decks = [{ name: '我的卡组', ids }];
        }
      }
    } catch {
      /* 忽略 */
    }
  }
  return decks
    .map((d) => ({ name: d.name || '未命名卡组', ids: normalizeDeck(d.ids, pool), song: d.song, voice: d.voice }))
    .filter((d) => d.ids.length > 0);
}

/** 保存卡组（同名覆盖，新名新增），返回更新后的列表；song = 绑定的战歌，voice = 绑定的语音包 */
export function saveDeck(name: string, ids: string[], pool: Card[], song?: string, voice?: string): SavedDeck[] {
  const decks = loadDecks(pool);
  const norm = normalizeDeck(ids, pool);
  const finalName = name.trim() || `卡组 ${decks.length + 1}`;
  const idx = decks.findIndex((d) => d.name === finalName);
  const entry: SavedDeck = { name: finalName, ids: norm, song: song || undefined, voice: voice || undefined };
  if (idx >= 0) decks[idx] = { ...decks[idx], ...entry };
  else decks.push(entry);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(decks));
  } catch {
    /* 忽略 */
  }
  return decks;
}

/** 删除卡组 */
export function deleteDeck(name: string, pool: Card[]): SavedDeck[] {
  const decks = loadDecks(pool).filter((d) => d.name !== name);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(decks));
  } catch {
    /* 忽略 */
  }
  return decks;
}

/** 取指定卡组的卡（不存在返回 []） */
export function getDeckIds(name: string, pool: Card[]): string[] {
  const d = loadDecks(pool).find((x) => x.name === name);
  return d ? d.ids : [];
}

/** 卡组码 → 完整卡号列表（宽容解析：空格/逗号/换行/连续都行，支持带或不带 LO- 前缀） */
export function parseDeckCode(text: string): string[] {
  const out: string[] = [];
  const re = /(?:LO-)?(\d+(?:-[A-Za-z])?)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.push(`LO-${m[1].toUpperCase()}`);
  return out;
}

/** 完整卡号列表 → 卡组码（只保留编号，空格分隔，便于复制分享） */
export function formatDeckCode(ids: string[]): string {
  return ids.map((id) => id.replace(/^LO-/i, '')).join(' ');
}
