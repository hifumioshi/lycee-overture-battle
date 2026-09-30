// 卡牌数据核心模块：类型定义、加载、筛选

/** 与 tools/download-cards.mjs 中 normalizeCard 的输出一致 */
export interface Card {
  id: string; // 卡号，如 LO-6971 / LO-6971-A
  abilityName: string; // 效果名（能力名）
  name: string; // 卡名
  type: string; // character | event | item
  typeRaw: string; // 原始类型（日文）
  rarity: string; // 稀有度
  elements: string; // 属性：花 月 宙 雪 日 無
  ex: number; // EX 值
  cost: string; // 费用
  positionFlags: string; // 配置位置原始串
  ap: number; // 攻击力
  dp: number; // 防御力
  sp: number; // 支援力
  dmg: number; // 伤害值
  characterType: string; // 角色类型
  team: string; // 队伍
  basicAbilities: string; // 基本能力（[タグ:値] 列表）
  ability: string; // 效果文本（日文原文）
  cardSet: string; // 卡包 1
  cardSet2: string; // 卡包 2
  brand: string; // 品牌 / 作品
}

export const TYPE_LABELS: Record<string, string> = {
  character: '角色卡',
  event: '事件卡',
  item: '道具卡',
  area: '场地卡',
};

export const ELEMENT_LABELS: Record<string, string> = {
  花: '花',
  月: '月',
  宙: '宙',
  雪: '雪',
  日: '日',
  無: '無',
};

/** 属性配色（Lycee 常用色系） */
export const ELEMENT_COLORS: Record<string, string> = {
  花: '#e88ab0',
  月: '#6fa8dc',
  宙: '#9d7fe0',
  雪: '#a8d4e8',
  日: '#e8c35a',
  無: '#9aa4b0',
};

export const RARITY_COLORS: Record<string, string> = {
  P: '#e8b84a', // 金
  R: '#e06060', // 红
  U: '#a080e0', // 紫
  C: '#6fa8dc', // 蓝
  K: '#e88ab0', // 粉（特典？）
  S: '#7ad0a0', // 绿（签名？）
};

/** 卡图地址（public 目录；用相对路径以兼容 file:// 与 http:// 两种加载方式） */
export function cardImageUrl(id: string): string {
  return `./images/${id}.png`;
}

/** 从 public/cards.json 加载卡牌数据（相对路径兼容 file:// 与 dev server） */
export async function loadCards(): Promise<Card[]> {
  const res = await fetch('./cards.json');
  if (!res.ok) throw new Error(`卡牌数据加载失败: HTTP ${res.status}`);
  return (await res.json()) as Card[];
}

/**
 * Lycee Overture 19 种基本能力官方说明（来源：lycee-tcg.com/rule/index_8.html，中文翻译）
 * 数据中的基本能力格式：[能力名] 或 [能力名:值]，值可以是数字或效果文本，且值内部可能再套括号
 */
export interface BasicAbilityInfo {
  cn: string; // 中文名
  kind: string; // 类型：使用型 / 诱发型 / 常时型 / 特殊型 / 费用型
  desc: string; // 中文说明（官方内容翻译）
}

export const ABILITY_GLOSSARY: Record<string, BasicAbilityInfo> = {
  ステップ: {
    cn: '步进',
    kind: '使用型',
    desc: '非战斗中的自己回合、此角色未行动时：移动到前后左右相邻的己方场地。',
  },
  オーダーステップ: {
    cn: '指令步进',
    kind: '使用型',
    desc: '非战斗中的自己回合、此角色未行动时：移动到前后相邻的己方场地。',
  },
  サイドステップ: {
    cn: '侧步',
    kind: '使用型',
    desc: '非战斗中的自己回合、此角色未行动时：移动到左右相邻的己方场地。',
  },
  ジャンプ: {
    cn: '跳跃',
    kind: '使用型',
    desc: '非战斗中的自己回合、此角色未行动时：移动到别的己方场地（无论是否相邻）。',
  },
  オーダーチェンジ: {
    cn: '指令交换',
    kind: '使用型',
    desc: '非战斗中的自己回合、此角色未行动时：与此角色前后相邻的己方角色交换位置（对方已行动也可交换）。',
  },
  コンバート: {
    cn: '转换',
    kind: '使用型',
    desc: '非战斗中的自己回合（非响应时机）：支付指定费用或破弃角色，从牌库或弃牌区找出「→」右侧记载的角色并无偿登场。对方不能对此宣言响应。',
  },
  サポーター: {
    cn: '支援者',
    kind: '费用型',
    desc: '战斗时：支付记载的费用（代替使此角色行动），以此角色进行支援。',
  },
  チャージ: {
    cn: '充能',
    kind: '诱发型',
    desc: '此角色登场时：可将最多记载数量的自己弃牌区的卡放到此角色下方；不足时可破弃自己牌库来补充。下方的卡称为「充能」，可用于支付[C]费用。',
  },
  アグレッシブ: {
    cn: '攻击性',
    kind: '常时型',
    desc: '此角色失去登场回合限制：登场回合即可支付[T]费用、指定为攻击角色。',
  },
  リカバリー: {
    cn: '回复',
    kind: '诱发型',
    desc: '此角色登场时：若己方角色数少于对方角色数，处理记载的效果。',
  },
  ターンリカバリー: {
    cn: '回合回复',
    kind: '诱发型',
    desc: '此角色在自己后攻第 1 回合登场时，且本回合尚未处理过回复/回合回复：处理记载的效果；直到回合结束无法再获得回复效果。',
  },
  ペナルティ: {
    cn: '惩罚',
    kind: '诱发型',
    desc: '此角色离场时：处理记载的效果。',
  },
  ボーナス: {
    cn: '奖励',
    kind: '诱发型',
    desc: '此角色的对战角色被击破的战斗结束时：处理记载的效果。',
  },
  ガッツ: {
    cn: '毅力',
    kind: '诱发型',
    desc: '此角色被击破时：支付指定费用，可将弃牌区中的此角色无偿登场。',
  },
  エンゲージ: {
    cn: '交战',
    kind: '特殊型',
    desc: '此角色可以破弃场上已有的 1 个角色、登场到该位置；如此登场时处理记载的效果。',
  },
  アシスト: {
    cn: '辅助',
    kind: '特殊型',
    desc: '支付费用时，若使用卡的卡种与此角色相同，则此角色可当作全部属性的费用。',
  },
  リーダー: {
    cn: '领队',
    kind: '特殊型',
    desc: '游戏准备时将此卡从牌库中拿出（不展示）放在一旁；初始手牌变为 6 张（而非 7 张），换牌后、游戏开始前展示给对方再加入手牌。牌库中此卡最多 1 张。',
  },
  プリンシパル: {
    cn: '主角',
    kind: '特殊型',
    desc: '此角色的登场宣言即使因对方效果失败，也可无偿登场；此时视同从手牌登场。',
  },
  サプライズ: {
    cn: '惊喜',
    kind: '特殊型',
    desc: '此角色的登场宣言如同事件卡：可在战斗中、对方回合、响应时机宣言。',
  },
};

/** 效果文本格式化：官方数据中部分卡用 <br /> 表示换行、可能带 <b> 等标签，统一转换 */
export function formatAbilityText(text: string): string {
  if (!text) return '';
  return text.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '');
}

/** 解析基本能力串：[サイドステップ:[0]][チャージ:１] → [{tag, value}]（支持值内嵌套括号） */
export function parseBasicAbilities(raw: string): { tag: string; value: string }[] {
  if (!raw) return [];
  const out: { tag: string; value: string }[] = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '[') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === ']') {
      depth--;
      if (depth === 0 && start >= 0) {
        const token = raw.slice(start + 1, i); // 去掉最外层括号
        const colon = token.indexOf(':');
        const tag = (colon >= 0 ? token.slice(0, colon) : token).trim();
        let value = (colon >= 0 ? token.slice(colon + 1) : '').trim();
        // 若值恰好是单个 [..] 组（如 [0]、[花花]、[破棄キャラを回復する。]），去掉外层括号
        if (value.startsWith('[') && value.endsWith(']')) {
          let d = 0;
          let balanced = true;
          for (let j = 0; j < value.length; j++) {
            if (value[j] === '[') d++;
            else if (value[j] === ']') {
              d--;
              if (d < 0) { balanced = false; break; }
            }
          }
          if (balanced && d === 0) value = value.slice(1, -1).trim();
        }
        out.push({ tag, value });
        start = -1;
      }
    }
  }
  return out;
}
