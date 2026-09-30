import { useEffect, useMemo, useState } from 'react';
import { Card, cardImageUrl, TYPE_LABELS, ELEMENT_LABELS, ELEMENT_COLORS, RARITY_COLORS, formatAbilityText, parseBasicAbilities } from '../core/cards';
import { loadDecks, saveDeck, deleteDeck, SavedDeck, baseNumber, normalizeDeck, parseDeckCode, formatDeckCode } from '../core/deckStorage';

/** 卡组制作：参考 YGO 组卡界面 —— 左=选中卡详情 / 中=按类型分组的卡组 / 右=可搜索筛选的卡池 */
export default function DeckBuilder({
  cards,
  deck,
  onSave,
  onBack,
}: {
  cards: Card[];
  deck: string[];
  onSave: (deck: string[]) => void;
  onBack: () => void;
}) {
  const [decks, setDecks] = useState<SavedDeck[]>(() => loadDecks(cards));
  const [sel, setSel] = useState<string[]>(deck);
  const [selName, setSelName] = useState('');
  const [query, setQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState('all');
  const [elementFilter, setElementFilter] = useState('all');
  const [detail, setDetail] = useState<Card | null>(null); // 左栏展示的卡
  const [codeModal, setCodeModal] = useState<string | null>(null); // 导出的卡组码弹窗
  const [copied, setCopied] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importName, setImportName] = useState('');
  const [importCode, setImportCode] = useState('');
  const [importReport, setImportReport] = useState<string | null>(null);
  // 战歌：列出 data/songs 中的音频，文件名即选项名
  const [songList, setSongList] = useState<{ file: string; name: string }[]>([]);
  const [selSong, setSelSong] = useState('');
  // 语音：列出 data/voices 中的语音包（文件夹名即选项名），与卡组绑定
  const [voiceList, setVoiceList] = useState<string[]>([]);
  const [selVoice, setSelVoice] = useState('');
  useEffect(() => {
    let dead = false;
    const load = async () => {
      try {
        const s = await (window as { lyceeSongs?: { list(): Promise<{ file: string; name: string; url: string }[]> } }).lyceeSongs?.list();
        if (s && !dead) setSongList(s.map((x) => ({ file: x.file, name: x.name })));
      } catch {
        /* 无战歌能力 */
      }
      try {
        const v = await (
          window as { lyceeVoices?: { list(): Promise<{ name: string; actions: { folder: string; files: { file: string; url: string }[] }[] }[]> } }
        ).lyceeVoices?.list();
        if (v && !dead) setVoiceList(v.map((x) => x.name));
      } catch {
        /* 无语音能力 */
      }
    };
    void load();
    return () => {
      dead = true;
    };
  }, []);

  const countById = useMemo(() => {
    const m = new Map<string, { total: number }>();
    for (const id of sel) {
      const b = baseNumber(id);
      m.set(b, { total: (m.get(b)?.total ?? 0) + 1 });
    }
    return m;
  }, [sel]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return cards
      .filter((c) => (typeFilter === 'all' ? true : c.type === typeFilter))
      .filter((c) => (elementFilter === 'all' ? true : c.elements.includes(elementFilter)))
      .filter((c) => (q === '' ? true : c.id.toLowerCase().includes(q) || c.name.toLowerCase().includes(q) || c.ability.toLowerCase().includes(q)));
  }, [cards, query, typeFilter, elementFilter]);

  // 当前牌组（带在 sel 中的下标，便于精确移除）
  const deckItems = useMemo(
    () => sel.map((id, idx) => ({ id, idx, card: cards.find((x) => x.id === id) })).filter((x) => x.card),
    [sel, cards],
  );

  const TYPE_ORDER = ['character', 'item', 'area', 'event'] as const;

  const addCard = (id: string) => {
    const used = countById.get(baseNumber(id))?.total ?? 0;
    if (used >= 4 || sel.length >= 60) return;
    setSel((s) => [...s, id]);
  };

  const removeCard = (index: number) => setSel((s) => s.filter((_, i) => i !== index));

  const isFull = sel.length >= 60;

  const handleSave = () => {
    const name = selName.trim() || `卡组 ${decks.length + 1}`;
    const updated = saveDeck(name, sel, cards, selSong || undefined, selVoice || undefined);
    setDecks(updated);
    setSelName(name);
    onSave(saveDeck(name, sel, cards, selSong || undefined, selVoice || undefined).find((d) => d.name === name)?.ids ?? sel);
  };

  const handleLoad = (d: SavedDeck) => {
    setSel(d.ids);
    setSelName(d.name);
    setSelSong(d.song ?? '');
    setSelVoice(d.voice ?? '');
  };

  const handleDelete = () => {
    if (!selName) return;
    setDecks(deleteDeck(selName, cards));
    setSel([]);
    setSelName('');
    setSelSong('');
    setSelVoice('');
    onSave([]);
  };

  const handleNew = () => {
    setSel([]);
    setSelName('');
    setSelSong('');
    setSelVoice('');
  };

  /** 导出：生成卡组码并弹窗 */
  const handleExport = () => {
    if (sel.length === 0) return;
    setCodeModal(formatDeckCode(sel));
    setCopied(false);
  };

  /** 一键复制卡组码（clipboard API + 降级方案） */
  const copyCode = async () => {
    if (!codeModal) return;
    let ok = false;
    try {
      await navigator.clipboard.writeText(codeModal);
      ok = true;
    } catch {
      const ta = document.createElement('textarea');
      ta.value = codeModal;
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy');
        ok = true;
      } catch {
        /* 忽略 */
      }
      document.body.removeChild(ta);
    }
    if (ok) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    }
  };

  /** 导入：解析卡组码 → 规范化 → 存为卡组并载入 */
  const handleImport = () => {
    const name0 = importName.trim();
    if (!name0) {
      setImportReport('请先输入卡组名。');
      return;
    }
    const raw = parseDeckCode(importCode);
    const ids = normalizeDeck(raw, cards);
    if (ids.length === 0) {
      setImportReport('没有识别到有效卡号，请检查粘贴的内容。');
      return;
    }
    // 重名自动加后缀（不覆盖已有卡组）
    const existing = new Set(decks.map((d) => d.name));
    let finalName = name0;
    let n = 2;
    while (existing.has(finalName)) finalName = `${name0} (${n++})`;
    const updated = saveDeck(finalName, ids, cards);
    setDecks(updated);
    setSel(ids);
    setSelName(finalName);
    const skipped = raw.length - ids.length;
    setImportReport(
      `导入成功：${ids.length} 张` +
        (skipped > 0 ? `，跳过 ${skipped} 张无效/超限` : '') +
        (finalName !== name0 ? `（已重命名为「${finalName}」）` : ''),
    );
    setImportCode('');
  };

  return (
    <div className="deck-builder">
      <header className="deck-header">
        <h1>🃏 卡组制作</h1>
        <div className="deck-count">
          <span className={sel.length === 60 ? 'full' : ''}>已选 {sel.length} / 60</span>
          <span className="deck-req">同编号最多 4 张</span>
        </div>
        <div className="deck-actions">
          <input className="deck-name-input" value={selName} onChange={(e) => setSelName(e.target.value)} placeholder="卡组名称" />
          <select
            className="deck-song-select"
            value={selSong}
            onChange={(e) => setSelSong(e.target.value)}
            title="绑定的战歌：发动切札时自动播放（把 mp3/wav 放进 data\\songs 文件夹，重启后出现在这里；文件名即选项名）"
          >
            <option value="">♪ 无战歌</option>
            {songList.map((s) => (
              <option key={s.file} value={s.file}>
                {s.name}
              </option>
            ))}
          </select>
          <select
            className="deck-voice-select"
            value={selVoice}
            onChange={(e) => setSelVoice(e.target.value)}
            title="绑定的语音包：对局中做对应行为时播放台词（把语音包文件夹放进 data\\voices，结构为 voices\\包名\\行为\\台词.m4a；包名即选项名）"
          >
            <option value="">🎤 无语音</option>
            {voiceList.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
          <button className="primary" onClick={handleSave}>
            保存卡组
          </button>
          <button onClick={handleExport} disabled={sel.length === 0} title="生成卡组码发给朋友">
            📤 导出
          </button>
          <button onClick={() => { setImportOpen(true); setImportReport(null); }} title="粘贴卡组码还原卡组">
            📥 导入
          </button>
          <button onClick={handleNew}>清空</button>
          {selName && decks.some((d) => d.name === selName) && (
            <button className="danger" onClick={handleDelete}>
              删除当前
            </button>
          )}
          <button onClick={onBack}>返回主菜单</button>
        </div>
      </header>

      {/* 已保存卡组 */}
      <div className="deck-saved">
        <span className="deck-saved-label">已保存：</span>
        {decks.length === 0 && <span className="deck-saved-empty">（无）</span>}
        {decks.map((d) => (
          <span
            key={d.name}
            className={`deck-chip${selName === d.name ? ' active' : ''}`}
            onClick={() => handleLoad(d)}
            title={`${d.ids.length} 张`}
          >
            {d.name}（{d.ids.length}）
          </span>
        ))}
        <span className="deck-chip new" onClick={handleNew}>
          ＋ 新建
        </span>
      </div>

      {/* 三栏主体 */}
      <div className="deck-body">
        {/* 左：选中卡详情 + 效果面板 */}
        <aside className="deck-detail">
          <CardDetail card={detail} countById={countById} />
        </aside>

        {/* 中：当前卡组（按类型分组） */}
        <section className="deck-current">
          <div className="deck-current-title">当前牌组（{sel.length}）</div>
          {sel.length === 0 && <div className="deck-empty">点击右侧卡牌加入牌组</div>}
          {TYPE_ORDER.map((t) => {
            const items = deckItems.filter((x) => x.card!.type === t);
            if (items.length === 0) return null;
            return (
              <div key={t} className="deck-group">
                <div className="deck-group-title">
                  {TYPE_LABELS[t]}〈{items.length}〉
                </div>
                <div className="deck-row">
                  {items.map((x) => {
                    const total = countById.get(baseNumber(x.id))?.total ?? 1;
                    return (
                      <div
                        key={x.idx}
                        className="deck-cell"
                        onClick={() => removeCard(x.idx)}
                        onMouseEnter={() => setDetail(x.card!)}
                        title={`${x.card!.name}（点击移除）`}
                      >
                        <img src={cardImageUrl(x.id)} alt={x.card!.name} loading="lazy" />
                        {total > 1 && <span className="deck-cell-count">{total}</span>}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </section>

        {/* 右：卡池浏览（可搜索筛选） */}
        <aside className="deck-pool">
          <div className="pool-toolbar">
            <input
              className="search"
              placeholder="搜索卡号 / 卡名 / 效果…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <div className="pool-filter-row">
              {[{ id: 'all', label: '全部' }, { id: 'character', label: '角色' }, { id: 'item', label: '道具' }, { id: 'area', label: '场地' }, { id: 'event', label: '事件' }].map((t) => (
                <button
                  key={t.id}
                  className={`filter-btn${typeFilter === t.id ? ' active' : ''}`}
                  onClick={() => setTypeFilter(t.id)}
                >
                  {t.label}
                </button>
              ))}
            </div>
            <div className="pool-filter-row">
              {['all', '花', '月', '宙', '雪', '日', '無'].map((el) => (
                <button
                  key={el}
                  className={`filter-btn elem${el !== 'all' ? '-e' : ''}${elementFilter === el ? ' active' : ''}`}
                  style={el !== 'all' ? { ['--el' as string]: ELEMENT_COLORS[el] ?? '#9aa4b0' } : undefined}
                  onClick={() => setElementFilter(el)}
                >
                  {el === 'all' ? '全部' : ELEMENT_LABELS[el]}
                </button>
              ))}
            </div>
          </div>
          <div className="pool-results">{filtered.length} 张</div>
          <div className="deck-grid">
            {filtered.map((c) => {
              const used = countById.get(baseNumber(c.id))?.total ?? 0;
              const disabled = used >= 4 || isFull;
              return (
                <div
                  key={c.id}
                  className={`deck-pool-card${disabled ? ' disabled' : ''}${used > 0 ? ' added' : ''} type-${c.type}`}
                  onClick={() => !disabled && addCard(c.id)}
                  onMouseEnter={() => setDetail(c)}
                  onMouseLeave={() => setDetail((d) => (d?.id === c.id ? null : d))}
                >
                  <span className="pool-card-type">{TYPE_LABELS[c.type] ?? c.typeRaw}</span>
                  <div className="deck-pool-thumb">
                    <img src={cardImageUrl(c.id)} alt={c.name} loading="lazy" />
                    <span className="pool-elem" style={{ background: ELEMENT_COLORS[c.elements[0]] ?? '#556' }} />
                    {used > 0 && <span className="deck-copy-badge">{used}/4</span>}
                  </div>
                  <div className="deck-pool-info">
                    <span className="deck-pool-name">{c.name}</span>
                    <span className="deck-pool-id">{c.id} · {ELEMENT_LABELS[c.elements[0]] ?? ''}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </aside>
      </div>

      {/* 导出卡组码弹窗 */}
      {codeModal !== null && (
        <div className="prompt-backdrop" onClick={() => setCodeModal(null)}>
          <div className="prompt-modal" onClick={(e) => e.stopPropagation()}>
            <h3>📤 卡组码（共 {sel.length} 张）</h3>
            <p className="prompt-note">把这串卡号复制给朋友，对方在「导入」里粘贴即可还原卡组：</p>
            <textarea className="deck-code-text" readOnly value={codeModal} rows={4} onClick={(e) => (e.target as HTMLTextAreaElement).select()} />
            <div className="prompt-actions">
              <button className="primary" onClick={copyCode}>
                {copied ? '✓ 已复制' : '一键复制'}
              </button>
              <button onClick={() => setCodeModal(null)}>关闭</button>
            </div>
          </div>
        </div>
      )}

      {/* 导入卡组码弹窗 */}
      {importOpen && (
        <div className="prompt-backdrop" onClick={() => setImportOpen(false)}>
          <div className="prompt-modal" onClick={(e) => e.stopPropagation()}>
            <h3>📥 导入卡组码</h3>
            <p className="prompt-note">粘贴卡号串（空格 / 逗号 / 换行都行），再给卡组起个名字，点导入即可还原：</p>
            <input
              className="deck-name-input deck-import-name"
              value={importName}
              onChange={(e) => setImportName(e.target.value)}
              placeholder="卡组名（重名会自动加后缀）"
            />
            <textarea
              className="deck-code-text"
              placeholder="例：6845 6851 6971-A …"
              rows={5}
              value={importCode}
              onChange={(e) => setImportCode(e.target.value)}
            />
            {importReport && <p className="deck-import-report">{importReport}</p>}
            <div className="prompt-actions">
              <button className="primary" onClick={handleImport} disabled={!importCode.trim()}>
                导入
              </button>
              <button onClick={() => setImportOpen(false)}>关闭</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** 左栏详情：选中卡卡图 + 数值 + 效果文本 */
function CardDetail({ card, countById }: { card: Card | null; countById: Map<string, { total: number }> }) {
  if (!card) {
    return (
      <div className="deck-detail-empty">
        <div className="deck-detail-ph-icon">🃏</div>
        <div>点击或悬停卡牌查看详情</div>
      </div>
    );
  }
  const isChar = card.type === 'character';
  const bas = parseBasicAbilities(card.basicAbilities ?? '');
  return (
    <div className="card-detail">
      <div className="card-detail-img">
        <img src={cardImageUrl(card.id)} alt={card.name} />
        <span className="card-detail-rarity" style={{ background: RARITY_COLORS[card.rarity] ?? '#557' }}>
          {card.rarity}
        </span>
      </div>
      <div className="card-detail-title">
        <span className="card-detail-name">{card.name}</span>
        {card.abilityName && <span className="card-detail-ability-name">「{card.abilityName}」</span>}
      </div>
      <div className="card-detail-meta">
        <span className="card-detail-id">{card.id}</span>
        <span className="card-detail-type">{TYPE_LABELS[card.type] ?? card.typeRaw}</span>
        <span className="card-detail-elem" style={{ color: ELEMENT_COLORS[card.elements[0]] ?? '#ccc' }}>
          {ELEMENT_LABELS[card.elements[0]] ?? ''}
        </span>
        <span className="card-detail-ex">EX{card.ex}</span>
        {card.cost && <span className="card-detail-cost">费用 {card.cost}</span>}
        {countById.get(baseNumber(card.id)) && <span className="card-detail-used">已选 {countById.get(baseNumber(card.id))!.total}/4</span>}
      </div>
      {isChar && (
        <div className="card-detail-stats">
          <span className="stat">AP {card.ap}</span>
          <span className="stat">DP {card.dp}</span>
          <span className="stat stat-sp">SP {card.sp}</span>
          <span className="stat">DMG {card.dmg}</span>
        </div>
      )}
      {bas.length > 0 && (
        <div className="card-detail-basic">
          {bas.map((b, i) => (
            <span key={i} className="basic-chip">
              [{b.tag}
              {b.value ? `:${b.value}` : ''}]
            </span>
          ))}
        </div>
      )}
      {card.ability && (
        <div className="card-detail-effect">
          <div className="card-detail-effect-title">效果</div>
          <div className="card-detail-effect-text">{formatAbilityText(card.ability)}</div>
        </div>
      )}
    </div>
  );
}
