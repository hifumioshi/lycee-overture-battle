#!/usr/bin/env node
/**
 * Lycee 卡牌数据下载工具
 *
 * 数据来源（官方站，已验证可用）：
 *   - 卡牌 CSV: https://lycee-tcg.com/card?output=csv&page=1&limit=N
 *   - 卡图:     https://lycee-tcg.com/card/image/{卡号}.png
 *
 * 用法：
 *   node tools/download-cards.mjs --from 6845 --to 6971   # 下载指定编号区间的卡（含卡图）
 *   node tools/download-cards.mjs --limit 20              # 下载前 20 张卡的 CSV
 *   node tools/download-cards.mjs --all                   # 下载全部卡的 CSV
 *   node tools/download-cards.mjs --images LO-0001 LO-0002 # 下载指定卡图
 *
 * 输出：
 *   data/cards/lycee.csv     原始 CSV（保留）
 *   data/cards/cards.json    解析后的全部卡牌数据
 *   data/cards/range.json    区间筛选后的卡牌数据（应用使用）
 *   data/images/{卡号}.png   卡图存档
 *   public/cards.json        应用可访问的区间卡数据（Vite public 目录）
 *   public/images/{卡号}.png 应用可访问的卡图
 */
import { writeFile, mkdir, readFile, rm, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const CARDS_DIR = path.join(DATA_DIR, 'cards');
const IMAGES_DIR = path.join(DATA_DIR, 'images');
const PUBLIC_DIR = path.join(ROOT, 'public');
const PUBLIC_IMAGES_DIR = path.join(PUBLIC_DIR, 'images');

const BASE_URL = 'https://lycee-tcg.com';
const CSV_URL = `${BASE_URL}/card?output=csv`;
const IMAGE_URL = `${BASE_URL}/card/image/{id}.png`;

// 官方 CSV 列定义（0 起）。来源：amcsi/lycee-overture 项目 CsvColumns.php
const COL = {
  ID: 0,
  ABILITY_NAME: 1, // 效果名（能力名）
  NAME: 2, // 卡名
  TYPE: 3, // 类型：キャラクター / イベント / アイテム
  RARITY: 4, // 稀有度
  ELEMENTS: 5, // 属性：花 月 宙 雪 日 無
  EX: 6, // EX 值
  COST: 7, // 费用
  POSITION_FLAGS: 8, // 配置位置
  AP: 9, // 攻击力
  DP: 10, // 防御力
  SP: 11, // 支援力
  DMG: 12, // 伤害值
  CHARACTER_TYPE: 13, // 角色类型
  TEAM: 14, // 队伍
  BASIC_ABILITIES: 15, // 基本能力（[タグ:値] 列表）
  ABILITY: 16, // 效果文本（日文原文）
  CARD_SET: 17, // 卡包 1
  CARD_SET_2: 18, // 卡包 2
  EXTRA: 19, // 附加信息（入手途径等）
  BRAND: 20, // 品牌 / 作品
};

const TYPE_MAP = {
  キャラクター: 'character',
  イベント: 'event',
  アイテム: 'item',
  エリア: 'area',
};

// 卡号 → 基础编号：LO-6971 / LO-6971-A → 6971
function cardBaseNumber(id) {
  const m = /^LO-(\d+)/i.exec(id);
  return m ? parseInt(m[1], 10) : NaN;
}

function parseArgs() {
  const args = process.argv.slice(2);
  const opt = { limit: null, all: false, images: false, ids: [], from: null, to: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--limit') opt.limit = Number(args[++i]);
    else if (args[i] === '--all') opt.all = true;
    else if (args[i] === '--images') opt.images = true;
    else if (args[i] === '--from') opt.from = Number(args[++i]);
    else if (args[i] === '--to') opt.to = Number(args[++i]);
    else opt.ids.push(args[i]);
  }
  return opt;
}

async function downloadCsv(limit) {
  const url = `${CSV_URL}&page=1&limit=${limit}`;
  console.log(`下载卡牌 CSV: ${url}`);
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 lycee-battle-tool' } });
  if (!res.ok) throw new Error(`CSV 下载失败: HTTP ${res.status}`);
  const text = await res.text();
  return text.replace(/^\uFEFF/, ''); // 去掉可能的 BOM
}

/**
 * 官方 CSV 解析。
 * 关键事实（已实测验证）：该 CSV 完全不用引号包裹字段，每张卡固定 21 个字段
 * （索引 0~20），效果文本（索引 16）内部可以包含换行，
 * 行尾的换行符会与下一行的第一个字段黏在一起（行尾逗号产生空字段）。
 * 因此按"每行 21 个字段"分组即可正确解析；字段开头的换行是行分隔符，需剥离。
 */
const ROW_FIELD_COUNT = 21;
const CARD_ID_PATTERN = /^LO-\d+(-[A-Z])?$/i;

function parseCsv(text) {
  const flat = text.replace(/\r/g, '').split(',');
  const rows = [];
  let row = [];
  for (let f of flat) {
    f = f.replace(/^\n+/, ''); // 行首换行（行分隔符）剥离
    row.push(f);
    if (row.length === ROW_FIELD_COUNT) {
      rows.push(row);
      row = [];
    }
  }
  if (row.some((f) => f.trim() !== '')) {
    console.warn(`警告：文件末尾有 ${row.length} 个未成行的字段，已丢弃（CSV 结构可能已变化）`);
  }
  // 结构自检：第一列应为卡号（LO-xxxx）
  let bad = 0;
  for (const r of rows) {
    if (!CARD_ID_PATTERN.test(r[0])) bad++;
  }
  if (bad > 0) {
    console.warn(`警告：有 ${bad}/${rows.length} 行第一列不是卡号，解析可能错位（CSV 结构可能已变化）`);
  }
  return rows;
}

function normalizeCard(row) {
  const num = (s) => {
    const n = parseInt(s, 10);
    return Number.isNaN(n) ? 0 : n;
  };
  return {
    id: row[COL.ID],
    abilityName: row[COL.ABILITY_NAME],
    name: row[COL.NAME],
    type: TYPE_MAP[row[COL.TYPE]] ?? row[COL.TYPE],
    typeRaw: row[COL.TYPE],
    rarity: row[COL.RARITY],
    elements: row[COL.ELEMENTS],
    ex: num(row[COL.EX]),
    cost: row[COL.COST],
    positionFlags: row[COL.POSITION_FLAGS],
    ap: num(row[COL.AP]),
    dp: num(row[COL.DP]),
    sp: num(row[COL.SP]),
    dmg: num(row[COL.DMG]),
    characterType: row[COL.CHARACTER_TYPE],
    team: row[COL.TEAM],
    basicAbilities: row[COL.BASIC_ABILITIES],
    ability: row[COL.ABILITY],
    cardSet: row[COL.CARD_SET],
    cardSet2: row[COL.CARD_SET_2],
    brand: row[COL.BRAND],
  };
}

async function downloadImages(ids) {
  await mkdir(IMAGES_DIR, { recursive: true });
  let ok = 0, fail = 0, skip = 0;
  const saved = [];
  for (const id of ids) {
    const dest = path.join(IMAGES_DIR, `${id}.png`);
    // 断点续传：已存在的卡图直接跳过
    try {
      await access(dest);
      skip++;
      saved.push(`${id}.png`);
      continue;
    } catch { /* 不存在，继续下载 */ }
    const url = IMAGE_URL.replace('{id}', id);
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 lycee-battle-tool' } });
      if (!res.ok) { console.log(`  ${id}: HTTP ${res.status}（无图）`); fail++; continue; }
      const buf = Buffer.from(await res.arrayBuffer());
      await writeFile(dest, buf);
      console.log(`  ${id}: ${(buf.length / 1024).toFixed(0)}KB ✓`);
      ok++;
      saved.push(`${id}.png`);
    } catch (e) {
      console.log(`  ${id}: 失败 ${e.message}`);
      fail++;
    }
  }
  console.log(`卡图完成：成功 ${ok}，跳过 ${skip}，失败 ${fail}`);
  return saved;
}

// 把区间数据 + 卡图复制到 public/（Vite 的 public 目录，开发/打包都能直接访问）
async function publishToPublic(cards, imageFiles) {
  await rm(path.join(PUBLIC_DIR, 'images'), { recursive: true, force: true });
  await mkdir(PUBLIC_IMAGES_DIR, { recursive: true });
  await writeFile(path.join(PUBLIC_DIR, 'cards.json'), JSON.stringify(cards), 'utf-8');
  for (const f of imageFiles) {
    await readFile(path.join(IMAGES_DIR, f)).then(
      (buf) => writeFile(path.join(PUBLIC_IMAGES_DIR, f), buf),
      () => {},
    );
  }
  console.log(`已发布到 public/：cards.json（${cards.length} 张）+ ${imageFiles.length} 张卡图`);
}

async function main() {
  const opt = parseArgs();
  await mkdir(CARDS_DIR, { recursive: true });
  await mkdir(IMAGES_DIR, { recursive: true });

  if (opt.ids.length > 0) {
    await downloadImages(opt.ids);
    return;
  }

  // 区间模式默认拉取 1000 行（一页足够覆盖 LO-6845~6971 完整区间）
  const isRange = opt.from != null || opt.to != null;
  const limit = opt.all ? 100000 : opt.limit ?? (isRange ? 1000 : 20);
  const csv = await downloadCsv(limit);
  await writeFile(path.join(CARDS_DIR, 'lycee.csv'), csv, 'utf-8');
  console.log(`CSV 已保存：data/cards/lycee.csv（${csv.length} 字符）`);

  const rows = parseCsv(csv);
  console.log(`解析到 ${rows.length} 张卡`);
  const cards = rows.map(normalizeCard);
  await writeFile(path.join(CARDS_DIR, 'cards.json'), JSON.stringify(cards, null, 2), 'utf-8');
  console.log(`cards.json 已保存（全部 ${cards.length} 张）`);

  // 区间模式：按编号筛选（含 -A/-B 变体），下载卡图，发布到 public
  if (opt.from != null || opt.to != null) {
    const from = opt.from ?? 0;
    const to = opt.to ?? Infinity;
    const filtered = cards.filter((c) => {
      const n = cardBaseNumber(c.id);
      return n >= from && n <= to;
    });
    console.log(`区间筛选 LO-${from} ~ LO-${to}：得到 ${filtered.length} 张卡`);
    await writeFile(path.join(CARDS_DIR, 'range.json'), JSON.stringify(filtered, null, 2), 'utf-8');
    console.log(`range.json 已保存（${filtered.length} 张）`);

    console.log('开始下载区间卡图…');
    const saved = await downloadImages(filtered.map((c) => c.id));
    await publishToPublic(filtered, saved);
    return;
  }

  // 非区间模式（历史行为）
  if (opt.images) {
    console.log('开始下载卡图…');
    const n = Math.min(opt.limit ?? 20, cards.length);
    const saved = await downloadImages(cards.slice(0, n).map((c) => c.id));
    await publishToPublic(cards.slice(0, n), saved);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
