// 卡牌能力检测：识别手札宣言 / 宣言 / 移动类基本能力
import type { Card } from './cards';
import { formatAbilityText, parseBasicAbilities } from './cards';

/** 效果文本中是否含某标签（如 [手札宣言] / [宣言] / [常時] / [誘発]） */
export function hasTag(card: Card, tag: string): boolean {
  const a = formatAbilityText(card.ability || '');
  return a.includes(`[${tag}]`);
}

/** 是否有手札宣言能力 */
export function hasHandDeclare(card: Card): boolean {
  return hasTag(card, '手札宣言');
}

/** 是否有宣言（效果）能力（与手札宣言可共存） */
export function hasDeclare(card: Card): boolean {
  return hasTag(card, '宣言');
}

/** 提取某标签后的使用费用（[宣言] [0]: → "0"；[宣言] [T]: → "T"） */
export function abilityCost(card: Card, tag: string): string {
  const a = formatAbilityText(card.ability || '');
  const re = new RegExp(`\\[${tag}\\]\\s*\\[([^\\]]+)\\]`);
  const m = re.exec(a);
  return m ? m[1] : '';
}

/** 移动/交换类基本能力（使用型）：只有步进/跳等可移动；サポーター・エンゲージ等不是移动（Bug：サポーター角色被当可移动） */
const MOVE_TAGS = ['ステップ', 'サイドステップ', 'オーダーステップ', 'ジャンプ', 'オーダーチェンジ'];

/** 该卡具有的移动/交换类基本能力标签列表 */
export function moveAbilityTags(card: Card): string[] {
  return parseBasicAbilities(card.basicAbilities || '')
    .map((a) => a.tag)
    .filter((t) => MOVE_TAGS.includes(t));
}

/** 是否有移动类基本能力 */
export function hasMoveAbility(card: Card): boolean {
  return moveAbilityTags(card).length > 0;
}

/** 是否有エンゲージ基本能力（登场时可破弃己方场上角色） */
export function hasEngage(card: Card): boolean {
  return (card.basicAbilities ?? '').includes('[エンゲージ');
}

/** 效果标签都识别出来（用于界面展示"可用操作"） */
export function isDeployable(card: Card): boolean {
  return card.type === 'character';
}
