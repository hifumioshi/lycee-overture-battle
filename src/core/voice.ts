// 语音（角色台词）：与「战歌」同套路 —— 跟着卡组绑定，对局中做某个行为时播放对应台词。
//
// 素材目录约定（放在程序目录下，和 songs 平级）：
//   data/voices/<语音包名>/<行为文件夹>/<台词文件>.m4a
// 例：data/voices/风千 伪/回合开始/わたしのターン.m4a
//
// 扩展方式：以后加新种类，只要在 ACTION_FOLDERS 里加一行（行为 → 文件夹名/别名），
// 再到对应对局事件处发一次语音信号即可；不认识的文件夹会被忽略，不会报错。

/** 行为 key → 素材文件夹名（含别名，兼容不同写法） */
export const VOICE_ACTIONS: { key: string; label: string; folders: string[] }[] = [
  { key: 'turnStart', label: '回合开始', folders: ['回合开始', 'ターン開始', '我的回合'] },
  { key: 'draw', label: '抽卡', folders: ['抽卡', '抽牌', 'ドロー'] },
  { key: 'trump', label: '切札', folders: ['切扎', '切札', '切り札'] },
  { key: 'deploy', label: '角色登场', folders: ['角色登场', '登场', '登場'] },
  { key: 'equip', label: '道具装备', folders: ['道具装备', '装备', '装備'] },
  { key: 'area', label: '地板配置', folders: ['地板配置', '场地配置', 'エリア配置'] },
  { key: 'declare', label: '宣言', folders: ['宣言', '效果发动', '効果発動'] },
  { key: 'respond', label: '对应宣言', folders: ['对应宣言', '対応宣言'] },
  { key: 'support', label: '支援', folders: ['支援', 'サポート'] },
  { key: 'attack', label: '攻击宣言', folders: ['攻击宣言', 'アタック', '攻撃宣言'] },
  { key: 'defense', label: '防御', folders: ['防御', 'ガード'] },
  { key: 'damage', label: '受伤', folders: ['受伤', '伤害', 'ダメージ'] },
  { key: 'moveStep', label: '移动', folders: ['移动', 'ステップ'] },
  { key: 'moveSide', label: '横移', folders: ['横移', 'サイドステップ'] },
  { key: 'moveOrder', label: '竖移', folders: ['竖移', 'オーダーステップ'] },
  { key: 'jump', label: '跳跃', folders: ['跳跃', 'ジャンプ'] },
];

/** 某个行为可用的文件夹名列表 */
export function foldersOf(actionKey: string): string[] {
  return VOICE_ACTIONS.find((a) => a.key === actionKey)?.folders ?? [];
}

/** 由行为 key 反查中文标签（界面提示用） */
export function labelOf(actionKey: string): string {
  return VOICE_ACTIONS.find((a) => a.key === actionKey)?.label ?? actionKey;
}

/** 字符串散列（FNV-1a）：两端用同一个种子算出同一个下标 → 两台电脑播同一句 */
export function hashSeed(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

/**
 * 多个版本里挑一个：由种子决定（两端一致），且尽量不和上一次重复。
 * @param files 该行为的台词文件列表
 * @param seed  同步来的种子（如 `玩家0:回合3:回合开始:信号12`）
 * @param lastIndex 上一次播的下标（-1 = 没有）
 */
export function pickVariant(files: string[], seed: string, lastIndex = -1): number {
  if (files.length === 0) return -1;
  let idx = hashSeed(seed) % files.length;
  if (files.length > 1 && idx === lastIndex) idx = (idx + 1) % files.length;
  return idx;
}
