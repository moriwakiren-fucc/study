/**
 * 漢文暗記帳 — script.js
 *
 * ── 将来実装のための設計メモ ──
 * - auth.js       : Firebase Auth / Supabase Auth でアカウント管理
 * - sync.js       : チェック状態をクラウドDB（Firestore / Supabase）に同期
 * - sw.js         : Service Worker でオフラインキャッシュ（PWA化）
 * - manifest.json : PWAマニフェスト
 * AppState.checks は将来 localStorage + クラウド二段階保存に移行する前提。
 * AppState.uploadedUnits はブラウザセッション内のみ保持（PWA化後はIndexedDBへ）。
 */

'use strict';

/* ══════════════════════════════════════
   アプリケーション状態
══════════════════════════════════════ */
const AppState = {
  units: [],              // { name, file } — サーバー上のCSV
  uploadedUnits: [],      // { name, file, csvText } — アップロードされたCSV（メモリ保持）
  currentUnit: null,      // 選択中の単元キー
  currentFile: null,      // 現在のファイル名
  headers: [],            // 見出し行
  rows: [],               // データ行（2次元配列）
  checks: {},             // { unitKey: { rowIndex: bool } }
  colRevealed: {},        // { colIndex: bool }
  fontScale: 100,
  filter: 'all',
  verticalMode: false,
  editMode: false,
  // 編集履歴（Undo/Redo）
  editHistory: [],        // スナップショット配列（各要素は rows のディープコピー）
  editHistoryCursor: -1,  // 現在位置
};

/* ══════════════════════════════════════
   永続化（localStorage）
   将来: クラウド同期に差し替え
══════════════════════════════════════ */
const Store = {
  PREF_KEY:  'kanbun_prefs',
  CHECK_KEY: 'kanbun_checks',

  loadPrefs() {
    try {
      const raw = localStorage.getItem(this.PREF_KEY);
      if (!raw) return;
      const p = JSON.parse(raw);
      if (p.fontScale)                    AppState.fontScale    = p.fontScale;
      if (p.filter)                       AppState.filter       = p.filter;
      if (p.verticalMode !== undefined)   AppState.verticalMode = p.verticalMode;
    } catch (e) { console.warn('設定の読み込みに失敗:', e); }
  },

  savePrefs() {
    try {
      localStorage.setItem(this.PREF_KEY, JSON.stringify({
        fontScale:    AppState.fontScale,
        filter:       AppState.filter,
        verticalMode: AppState.verticalMode,
      }));
    } catch (e) { console.warn('設定の保存に失敗:', e); }
  },

  loadChecks() {
    try {
      const raw = localStorage.getItem(this.CHECK_KEY);
      if (raw) AppState.checks = JSON.parse(raw);
    } catch (e) { console.warn('チェック状態の読み込みに失敗:', e); }
  },

  saveChecks() {
    try {
      localStorage.setItem(this.CHECK_KEY, JSON.stringify(AppState.checks));
    } catch (e) { console.warn('チェック状態の保存に失敗:', e); }
  },

  /* 将来: クラウドへのアップロードを担うスタブ */
  async syncToCloud() {
    // TODO: auth.currentUser があればサーバーへ POST
  },
};

/* ══════════════════════════════════════
   CSV パーサー（RFC4180準拠）
══════════════════════════════════════ */
function parseCSV(text) {
  text = text.replace(/^\uFEFF/, ''); // BOM除去
  const rows = [];
  let row = [], cell = '', inQuote = false;

  for (let i = 0; i < text.length; i++) {
    const ch   = text[i];
    const next = text[i + 1];
    if (inQuote) {
      if (ch === '"' && next === '"') { cell += '"'; i++; }
      else if (ch === '"') { inQuote = false; }
      else { cell += ch; }
    } else {
      if      (ch === '"')                    { inQuote = true; }
      else if (ch === ',')                    { row.push(cell); cell = ''; }
      else if (ch === '\r' && next === '\n')  { row.push(cell); rows.push(row); row = []; cell = ''; i++; }
      else if (ch === '\n' || ch === '\r')    { row.push(cell); rows.push(row); row = []; cell = ''; }
      else                                    { cell += ch; }
    }
  }
  if (cell !== '' || row.length > 0) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(c => c !== ''));
}

/* ══════════════════════════════════════
   CSV シリアライザー（ダウンロード用）
══════════════════════════════════════ */
function serializeCSV(unitName, headers, rows) {
  const escCell = v => {
    const s = String(v ?? '');
    return (s.includes(',') || s.includes('"') || s.includes('\n'))
      ? `"${s.replace(/"/g, '""')}"`
      : s;
  };
  const lines = [];
  lines.push(escCell(unitName));                    // A1: 単元名
  lines.push(headers.map(escCell).join(','));        // 見出し行
  rows.forEach(row => lines.push(row.map(escCell).join(',')));
  return lines.join('\r\n');
}

/* ══════════════════════════════════════
   単元リスト読み込み（units.csv）
══════════════════════════════════════ */
async function loadUnitList() {
  try {
    const res = await fetch('units.csv');
    if (!res.ok) throw new Error('units.csv が見つかりません');
    const text = await res.text();
    const csvRows = parseCSV(text);
    AppState.units = csvRows
      .filter(r => r[0] && r[1])
      .map(r => ({ name: r[0].trim(), file: r[1].trim() }));
    rebuildUnitSelect();
  } catch (e) {
    console.warn('units.csv の読み込みに失敗（省略可）:', e);
    // units.csv がなくてもアップロード機能で使えるので警告のみ
    rebuildUnitSelect();
  }
}

/* ── プルダウン再構築（サーバー単元 + アップロード単元） ── */
function rebuildUnitSelect() {
  const sel = document.getElementById('unitSelect');
  const prevVal = sel.value;
  sel.innerHTML = '<option value="">── 単元を選択 ──</option>';

  // サーバー上の単元
  if (AppState.units.length > 0) {
    const grp = document.createElement('optgroup');
    grp.label = '── 収録単元 ──';
    AppState.units.forEach(u => {
      const opt = document.createElement('option');
      opt.value = 'server:' + u.file;
      opt.textContent = u.name;
      grp.appendChild(opt);
    });
    sel.appendChild(grp);
  }

  // アップロードされた単元
  if (AppState.uploadedUnits.length > 0) {
    const grp = document.createElement('optgroup');
    grp.label = '── アップロード ──';
    AppState.uploadedUnits.forEach((u, idx) => {
      const opt = document.createElement('option');
      opt.value = 'upload:' + idx;
      opt.textContent = u.name;
      grp.appendChild(opt);
    });
    sel.appendChild(grp);
  }

  // 選択状態を復元
  if (prevVal) sel.value = prevVal;
}

/* ══════════════════════════════════════
   単元データ読み込み
══════════════════════════════════════ */
async function loadUnitByValue(value) {
  if (!value) return;
  showLoading(true);
  try {
    let csvText;
    if (value.startsWith('server:')) {
      const filename = value.slice(7);
      const res = await fetch(filename);
      if (!res.ok) throw new Error(`${filename} が見つかりません`);
      csvText = await res.text();
      AppState.currentFile = filename;
    } else if (value.startsWith('upload:')) {
      const idx = parseInt(value.slice(7), 10);
      const u = AppState.uploadedUnits[idx];
      if (!u) throw new Error('アップロードデータが見つかりません');
      csvText = u.csvText;
      AppState.currentFile = u.name + '.csv';
    } else {
      throw new Error('不明な単元指定: ' + value);
    }
    parseCsvIntoState(csvText, value);
    renderTable();
    document.getElementById('editBtn').hidden = false;
  } catch (e) {
    console.error('単元データ読み込みエラー:', e);
    showError(e.message);
  } finally {
    showLoading(false);
  }
}

function parseCsvIntoState(csvText, unitKey) {
  const allRows = parseCSV(csvText);
  if (allRows.length < 2) {
    showError('データが不足しています（見出し行が必要です）。');
    return;
  }
  AppState.currentUnit = unitKey;
  // 行0: 単元名（A1）
  // 行1: 見出し
  // 行2〜: データ
  AppState.headers = allRows[1];
  AppState.rows = allRows.slice(2).map(r => {
    // 列数をheadersに揃える
    const padded = [...r];
    while (padded.length < AppState.headers.length) padded.push('');
    return padded;
  });
  AppState.colRevealed = {};
  // 編集履歴リセット
  AppState.editHistory = [];
  AppState.editHistoryCursor = -1;
}

/* ══════════════════════════════════════
   アップロード処理
══════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('uploadInput').addEventListener('change', async (e) => {
    const files = Array.from(e.target.files);
    if (files.length === 0) return;

    for (const file of files) {
      const csvText = await file.text();
      const allRows = parseCSV(csvText);
      // A1セルを単元名として使用、なければファイル名
      const name = (allRows[0] && allRows[0][0] && allRows[0][0].trim())
        ? allRows[0][0].trim()
        : file.name.replace(/\.csv$/i, '');

      // 同名が既にあれば上書き
      const existing = AppState.uploadedUnits.findIndex(u => u.name === name);
      if (existing >= 0) {
        AppState.uploadedUnits[existing].csvText = csvText;
      } else {
        AppState.uploadedUnits.push({ name, file: file.name, csvText });
      }
    }

    rebuildUnitSelect();

    // 最後にアップロードしたものを自動選択
    const lastIdx = AppState.uploadedUnits.length - 1;
    const sel = document.getElementById('unitSelect');
    sel.value = 'upload:' + lastIdx;
    loadUnitByValue(sel.value);

    // inputをリセット（同じファイルを再度選べるように）
    e.target.value = '';
  });
});

/* ══════════════════════════════════════
   テーブル描画
══════════════════════════════════════ */
function renderTable() {
  const tableWrap  = document.getElementById('tableWrap');
  const emptyState = document.getElementById('emptyState');
  const thead      = document.getElementById('tableHead');
  const tbody      = document.getElementById('tableBody');

  emptyState.hidden = true;
  tableWrap.hidden  = false;

  const isVert    = AppState.verticalMode;
  const colCount  = AppState.headers.length;
  // 縦書き時は列インデックスを逆順にする（右→左）
  const colOrder  = isVert
    ? Array.from({ length: colCount }, (_, i) => colCount - 1 - i)
    : Array.from({ length: colCount }, (_, i) => i);

  // ── ヘッダー ──
  thead.innerHTML = '';
  const tr = document.createElement('tr');

  // 縦書き時: チェック列は末尾（=DOM的には右端=表示上は左端）
  // 横書き時: チェック列は先頭
  const thCheck = document.createElement('th');
  thCheck.className = 'col-check';
  thCheck.innerHTML = '<span style="opacity:0.4;font-size:0.75rem;">✓</span>';

  if (!isVert) tr.appendChild(thCheck);

  colOrder.forEach(ci => {
    const h    = AppState.headers[ci];
    const th   = document.createElement('th');
    const span = document.createElement('span');
    span.className   = 'th-content';
    span.dataset.col = ci;
    span.title       = 'クリックで列を一括表示/非表示';
    span.innerHTML   = `${escHtml(h)} <span class="th-toggle-icon">▼</span>`;
    span.addEventListener('click', () => toggleColumn(ci));
    th.appendChild(span);
    tr.appendChild(th);
  });

  if (isVert) tr.appendChild(thCheck);
  thead.appendChild(tr);

  // ── ボディ ──
  tbody.innerHTML = '';
  AppState.rows.forEach((row, ri) => {
    tbody.appendChild(createRow(row, ri, colOrder, isVert));
  });

  applyFilter();
}

/* ── 1行生成 ── */
function createRow(rowData, ri, colOrder, isVert) {
  colOrder = colOrder ?? Array.from({ length: AppState.headers.length }, (_, i) => i);
  isVert   = isVert   ?? AppState.verticalMode;

  const unitKey   = AppState.currentUnit;
  if (!AppState.checks[unitKey]) AppState.checks[unitKey] = {};
  const isChecked = !!AppState.checks[unitKey][ri];

  const tr = document.createElement('tr');
  tr.dataset.row = ri;
  if (isChecked) tr.classList.add('checked-row');

  // チェックボタン
  const tdCheck = document.createElement('td');
  tdCheck.className = 'td-check col-check';
  const btn = document.createElement('button');
  btn.className = 'check-btn' + (isChecked ? ' checked' : '');
  btn.textContent = '✓';
  btn.title = isChecked ? 'チェック済み（クリックで解除）' : 'クリックでチェック';
  btn.setAttribute('aria-pressed', isChecked);
  btn.addEventListener('click', () => toggleCheck(ri, tr, btn));
  tdCheck.appendChild(btn);

  // 縦書き: チェック列は末尾（表示上は左端）、横書き: 先頭
  if (!isVert) tr.appendChild(tdCheck);

  // データセル（colOrderに従って並べる）
  colOrder.forEach(ci => {
    tr.appendChild(createDataCell(rowData[ci] ?? '', ri, ci));
  });

  if (isVert) tr.appendChild(tdCheck);

  return tr;
}

/* ── データセル生成 ── */
function createDataCell(value, ri, ci) {
  const td = document.createElement('td');
  td.dataset.col = ci;

  const cellInner = document.createElement('div');
  cellInner.className = 'cell-inner';
  // めくり状態を data-revealed で管理
  // 列が既に開かれていれば初めから revealed
  cellInner.dataset.revealed = AppState.colRevealed[ci] ? 'true' : 'false';

  const cellText = document.createElement('span');
  cellText.className   = 'cell-text';
  cellText.textContent = value;
  cellInner.appendChild(cellText);

  const mask = document.createElement('div');
  mask.className = 'cell-mask';
  cellInner.appendChild(mask);

  // ★修正: cell-inner 自体をクリックしてトグル
  cellInner.addEventListener('click', () => {
    if (AppState.editMode) return; // 編集モード中は無効
    toggleCellRevealed(cellInner);
  });

  td.appendChild(cellInner);
  return td;
}

/* ── セル単体のめくりトグル（★バグ修正版） ── */
function toggleCellRevealed(cellInner) {
  const current = cellInner.dataset.revealed === 'true';
  cellInner.dataset.revealed = current ? 'false' : 'true';
}

/* ── 列一括開閉 ── */
function toggleColumn(ci) {
  if (AppState.editMode) return;
  AppState.colRevealed[ci] = !AppState.colRevealed[ci];
  const revealed = AppState.colRevealed[ci];

  document.querySelectorAll(`#tableBody td[data-col="${ci}"] .cell-inner`).forEach(inner => {
    inner.dataset.revealed = revealed ? 'true' : 'false';
  });

  const icon = document.querySelector(`.th-content[data-col="${ci}"] .th-toggle-icon`);
  if (icon) icon.textContent = revealed ? '▲' : '▼';
}

/* ── すべて表示 ── */
function revealAll() {
  document.querySelectorAll('#tableBody .cell-inner').forEach(inner => {
    inner.dataset.revealed = 'true';
  });
  AppState.headers.forEach((_, ci) => {
    AppState.colRevealed[ci] = true;
    const icon = document.querySelector(`.th-content[data-col="${ci}"] .th-toggle-icon`);
    if (icon) icon.textContent = '▲';
  });
}

/* ── すべて隠す ── */
function hideAll() {
  document.querySelectorAll('#tableBody .cell-inner').forEach(inner => {
    inner.dataset.revealed = 'false';
  });
  AppState.headers.forEach((_, ci) => {
    AppState.colRevealed[ci] = false;
    const icon = document.querySelector(`.th-content[data-col="${ci}"] .th-toggle-icon`);
    if (icon) icon.textContent = '▼';
  });
}

/* ══════════════════════════════════════
   チェック管理
══════════════════════════════════════ */
function toggleCheck(ri, tr, btn) {
  const unitKey = AppState.currentUnit;
  if (!AppState.checks[unitKey]) AppState.checks[unitKey] = {};
  const current = !!AppState.checks[unitKey][ri];
  AppState.checks[unitKey][ri] = !current;

  btn.classList.toggle('checked', !current);
  btn.setAttribute('aria-pressed', !current);
  btn.title = !current ? 'チェック済み（クリックで解除）' : 'クリックでチェック';
  tr.classList.toggle('checked-row', !current);

  Store.saveChecks();
  Store.syncToCloud();

  if (AppState.filter !== 'all') applyFilter();
}

/* ══════════════════════════════════════
   フィルター
══════════════════════════════════════ */
function applyFilter() {
  const unitKey = AppState.currentUnit;
  const checks  = AppState.checks[unitKey] || {};
  document.querySelectorAll('#tableBody tr').forEach(tr => {
    const ri        = parseInt(tr.dataset.row, 10);
    const isChecked = !!checks[ri];
    if      (AppState.filter === 'checked')   tr.classList.toggle('hidden-row', !isChecked);
    else if (AppState.filter === 'unchecked') tr.classList.toggle('hidden-row',  isChecked);
    else                                       tr.classList.remove('hidden-row');
  });
}

/* ══════════════════════════════════════
   編集モード
══════════════════════════════════════ */
function enterEditMode() {
  // ★バグ修正: 既に編集モード中なら何もしない
  if (AppState.editMode) return;

  AppState.editMode = true;
  document.body.classList.add('edit-mode');
  document.getElementById('editToolbar').hidden = false;
  document.getElementById('editBtn').hidden = true;

  // 全セルをtextareaに変換
  document.querySelectorAll('#tableBody tr').forEach(tr => {
    const ri = parseInt(tr.dataset.row, 10);
    tr.querySelectorAll('td[data-col]').forEach(td => {
      const ci        = parseInt(td.dataset.col, 10);
      const cellInner = td.querySelector('.cell-inner');

      // ★バグ修正: 既にtextareaが存在する場合はスキップ
      if (td.querySelector('.cell-edit-input')) return;

      const value = AppState.rows[ri]?.[ci] ?? '';

      const textarea = document.createElement('textarea');
      textarea.className  = 'cell-edit-input';
      textarea.value      = value;
      textarea.rows       = Math.max(2, (value.match(/\n/g) || []).length + 2);
      textarea.dataset.ri = ri;
      textarea.dataset.ci = ci;

      textarea.addEventListener('change', () => {
        pushEditHistory();
        AppState.rows[ri][ci] = textarea.value;
      });

      cellInner.hidden = true;
      td.appendChild(textarea);
    });
  });

  // 最初のスナップショットを記録
  AppState.editHistory = [];
  AppState.editHistoryCursor = -1;
  pushEditHistory();
  updateUndoRedoBtns();
}

function exitEditMode() {
  if (!AppState.editMode) return;
  AppState.editMode = false;

  // textareaの最終値をAppStateに反映
  document.querySelectorAll('.cell-edit-input').forEach(ta => {
    const ri = parseInt(ta.dataset.ri, 10);
    const ci = parseInt(ta.dataset.ci, 10);
    if (AppState.rows[ri]) AppState.rows[ri][ci] = ta.value;
  });

  document.body.classList.remove('edit-mode');
  document.getElementById('editToolbar').hidden = true;
  document.getElementById('editBtn').hidden = false;

  // テーブルを再描画（縦書き/横書き状態・列順を正しく反映）
  renderTable();
}

/* ── 履歴管理（Undo/Redo） ── */
function snapshotRows() {
  return AppState.rows.map(r => [...r]);
}

function pushEditHistory() {
  // カーソルより未来の履歴を捨てる
  AppState.editHistory = AppState.editHistory.slice(0, AppState.editHistoryCursor + 1);
  AppState.editHistory.push(snapshotRows());
  AppState.editHistoryCursor = AppState.editHistory.length - 1;
  updateUndoRedoBtns();
}

function applyHistorySnapshot(snapshot) {
  AppState.rows = snapshot.map(r => [...r]);
  // textareaの値を更新
  document.querySelectorAll('.cell-edit-input').forEach(ta => {
    const ri = parseInt(ta.dataset.ri, 10);
    const ci = parseInt(ta.dataset.ci, 10);
    ta.value = AppState.rows[ri]?.[ci] ?? '';
  });
}

function undo() {
  if (AppState.editHistoryCursor <= 0) return;
  AppState.editHistoryCursor--;
  applyHistorySnapshot(AppState.editHistory[AppState.editHistoryCursor]);
  updateUndoRedoBtns();
}

function redo() {
  if (AppState.editHistoryCursor >= AppState.editHistory.length - 1) return;
  AppState.editHistoryCursor++;
  applyHistorySnapshot(AppState.editHistory[AppState.editHistoryCursor]);
  updateUndoRedoBtns();
}

function updateUndoRedoBtns() {
  document.getElementById('undoBtn').disabled = AppState.editHistoryCursor <= 0;
  document.getElementById('redoBtn').disabled = AppState.editHistoryCursor >= AppState.editHistory.length - 1;
}

/* ── CSV ダウンロード ── */
function downloadCSV() {
  // 編集中のtextareaの最新値をAppStateに反映
  document.querySelectorAll('.cell-edit-input').forEach(ta => {
    const ri = parseInt(ta.dataset.ri, 10);
    const ci = parseInt(ta.dataset.ci, 10);
    if (AppState.rows[ri]) AppState.rows[ri][ci] = ta.value;
  });

  const unitName = (() => {
    // 単元名を特定
    const val = document.getElementById('unitSelect').value;
    if (val.startsWith('upload:')) {
      const idx = parseInt(val.slice(7), 10);
      return AppState.uploadedUnits[idx]?.name ?? '編集済み';
    }
    const found = AppState.units.find(u => 'server:' + u.file === val);
    return found?.name ?? '編集済み';
  })();

  const csvStr  = serializeCSV(unitName, AppState.headers, AppState.rows);
  const blob    = new Blob(['\uFEFF' + csvStr], { type: 'text/csv;charset=utf-8;' });
  const url     = URL.createObjectURL(blob);
  const a       = document.createElement('a');
  a.href        = url;
  a.download    = AppState.currentFile || (unitName + '.csv');
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ══════════════════════════════════════
   設定パネル
══════════════════════════════════════ */
function openSettings() {
  document.getElementById('settingsPanel').classList.add('open');
  document.getElementById('settingsOverlay').classList.add('open');
  document.getElementById('settingsPanel').removeAttribute('aria-hidden');
}
function closeSettings() {
  document.getElementById('settingsPanel').classList.remove('open');
  document.getElementById('settingsOverlay').classList.remove('open');
  document.getElementById('settingsPanel').setAttribute('aria-hidden', 'true');
}

function applyFontScale() {
  document.documentElement.style.setProperty('--font-scale', AppState.fontScale / 100);
  document.getElementById('fontSizeDisplay').textContent = AppState.fontScale + '%';
}

function applyVerticalMode() {
  document.body.classList.toggle('vertical-mode', AppState.verticalMode);
  document.getElementById('verticalMode').checked = AppState.verticalMode;
  // テーブルが表示中なら列順を再構築（縦書きは右→左の逆順）
  if (!document.getElementById('tableWrap').hidden) {
    renderTable();
  }
}

/* ══════════════════════════════════════
   ユーティリティ
══════════════════════════════════════ */
function escHtml(str) {
  return (str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
function showLoading(show) {
  document.getElementById('unitSelect').disabled = show;
}
function showError(msg) {
  const empty = document.getElementById('emptyState');
  empty.hidden = false;
  document.getElementById('tableWrap').hidden = true;
  empty.querySelector('p').textContent = '⚠ ' + msg;
  document.getElementById('editBtn').hidden = true;
}

/* ══════════════════════════════════════
   初期化
══════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', () => {
  Store.loadPrefs();
  Store.loadChecks();
  applyFontScale();
  applyVerticalMode();

  document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.filter === AppState.filter);
  });

  loadUnitList();

  /* ── 単元選択 ── */
  document.getElementById('unitSelect').addEventListener('change', e => {
    if (AppState.editMode) exitEditMode();
    const val = e.target.value;
    if (val) {
      loadUnitByValue(val);
    } else {
      document.getElementById('tableWrap').hidden = true;
      document.getElementById('emptyState').hidden = false;
      document.getElementById('emptyState').querySelector('p').textContent =
        '単元を選択するか、CSVをアップロードしてください';
      document.getElementById('editBtn').hidden = true;
    }
  });

  /* ── 設定パネル ── */
  document.getElementById('settingsBtn').addEventListener('click', openSettings);
  document.getElementById('settingsClose').addEventListener('click', closeSettings);
  document.getElementById('settingsOverlay').addEventListener('click', closeSettings);

  /* ── 縦書き ── */
  document.getElementById('verticalMode').addEventListener('change', e => {
    AppState.verticalMode = e.target.checked;
    applyVerticalMode();
    Store.savePrefs();
  });

  /* ── フォントサイズ ── */
  document.getElementById('fontIncrease').addEventListener('click', () => {
    AppState.fontScale = Math.min(200, AppState.fontScale + 10);
    applyFontScale();
    Store.savePrefs();
  });
  document.getElementById('fontDecrease').addEventListener('click', () => {
    AppState.fontScale = Math.max(60, AppState.fontScale - 10);
    applyFontScale();
    Store.savePrefs();
  });

  /* ── フィルター ── */
  document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      AppState.filter = btn.dataset.filter;
      document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      Store.savePrefs();
      applyFilter();
    });
  });

  /* ── すべて表示/隠す ── */
  document.getElementById('revealAllBtn').addEventListener('click', revealAll);
  document.getElementById('hideAllBtn').addEventListener('click', hideAll);

  /* ── 編集モード ── */
  document.getElementById('editBtn').addEventListener('click', enterEditMode);
  document.getElementById('exitEditBtn').addEventListener('click', exitEditMode);
  document.getElementById('undoBtn').addEventListener('click', undo);
  document.getElementById('redoBtn').addEventListener('click', redo);
  document.getElementById('downloadBtn').addEventListener('click', downloadCSV);

  /* ── Escキー ── */
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeSettings();
    // Ctrl+Z / Ctrl+Shift+Z で Undo/Redo
    if (AppState.editMode) {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key === 'z') { e.preventDefault(); undo(); }
      if ((e.ctrlKey || e.metaKey) &&  e.shiftKey && e.key === 'z') { e.preventDefault(); redo(); }
      if ((e.ctrlKey || e.metaKey) && e.key === 'y') { e.preventDefault(); redo(); }
    }
  });
});
