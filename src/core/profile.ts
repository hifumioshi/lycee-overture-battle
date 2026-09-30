// 玩家 ID（昵称）：存在本机，主菜单右上角可改；建房/加入房间/座位显示都用它
const KEY = 'lycee-player-name';

/** 读取我的 ID（默认「玩家」） */
export function getPlayerName(): string {
  try {
    const v = localStorage.getItem(KEY);
    return v && v.trim() ? v.trim() : '玩家';
  } catch {
    return '玩家';
  }
}

/** 保存我的 ID（最多 12 个字，去掉首尾空格） */
export function setPlayerName(name: string): string {
  const v = (name ?? '').trim().slice(0, 12) || '玩家';
  try {
    localStorage.setItem(KEY, v);
  } catch {
    /* 忽略 */
  }
  return v;
}
