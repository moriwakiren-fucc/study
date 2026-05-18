/**
 * 漢文暗記帳 — script.js
 *
 * ── 将来実装のための設計メモ ──
 * - auth.js       : Firebase Auth / Supabase Auth でアカウント管理
 * - sync.js       : チェック状態をクラウドDB（Firestore / Supabase）に同期
 * - sw.js         : Service Worker でオフラインキャッシュ（PWA化）
 * - manifest.json : PWAマニフェスト
 * AppState.checks は将来 localStorage + クラウド二段階保存に移行する前提で
 * 独立モジュール化してあります。
 */

'use strict';

/* ══════════════════════════════════════
   アプリケーション状態
══════════════════════════════════════ */
const AppState = {
  units: [],           // { name: string, file: string }
  currentUnit: null,   // 選択中の単元名
  rows: [],            // CSVから読み込んだ行データ [{...}]
  headers: [],         // 見出し行
  checks: {},          // { unitName: { rowIndex: bool } } — チェック状態
  colRevealed: {},     // { colIndex: bool } — 列の一括開閉状態
  fontScale: 100,      // %
  filter: 'all',       // 'all' | 'checked' | 'unchecked'
  verticalMode: false,
};

/* ══════════════════════════════════════
   設定の永続化（localStorage）
   将来: クラウド同期に差し替え
══════════════════════════════════════ */
const Store = {
  PREF_KEY: 'kanbun_prefs',
  CHECK_KEY: 'kanbun_checks',

  loadPrefs() {
    try {
      const raw = localStorage.getItem(this.PREF_KEY);
      if (!raw) return;
      const p = JSON.parse(raw);
      if (p.fontScale)     AppState.fontScale    = p.fontScale;
      if (p.filter)        AppState.filter        = p.filter;
      if (p.verticalMode !== undefined) AppState.verticalMode = p.verticalMode;
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
   CSV パーサー（RFC4180準拠・簡易版）
══════════════════════════════════════ */
function parseCSV(text) {
  // BOM除去
  text = text.replace(/^\uFEFF/, '');
  const rows = [];
  let row = [], cell = '', inQuote = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];

    if (inQuote) {
      if (ch === '"' && next === '"') { cell += '"'; i++; }
      else if (ch === '"') { inQuote = false; }
      else { cell += ch; }
    } else {
      if (ch === '"') { inQuote = true; }
      else if (ch === ',') { row.push(cell.trim()); cell = ''; }
      else if (ch === '\r' && next === '\n') { row.push(cell.trim()); rows.push(row); row = []; cell = ''; i++; }
      else if (ch === '\n' || ch === '\r') { row.push(cell.trim()); rows.push(row); row = []; cell = ''; }
      else { cell += ch; }
    }
  }
  if (cell !== '' || row.length > 0) { row.push(cell.trim()); rows.push(row); }
  return rows.filter(r => r.some(c => c !== ''));
}

/* ══════════════════════════════════════
   単元リスト読み込み
   units.csv を読む（A列: 表示名, B列: ファイル名）
   例:
     論語一（学而篇）,rongo1.csv
     孟子（梁恵王篇）,moshi1.csv
══════════════════════════════════════ */
async function loadUnitList() {
  try {
    const res = await fetch('units.csv');
    if (!res.ok) throw new Error('units.csv が見つかりません');
    const text = await res.text();
    const rows = parseCSV(text);
    AppState.units = rows
      .filter(r => r[0] && r[1])
      .map(r => ({ name: r[0], file: r[1] }));
    renderUnitSelect();
  } catch (e) {
    console.error('単元リスト読み込みエラー:', e);
    showError('units.csv の読み込みに失敗しました。ファイルを確認してください。');
  }
}

function renderUnitSelect() {
  const sel = document.getElementById('unitSelect');
  sel.innerHTML = '<option value="">── 単元を選択 ──</option>';
  AppState.units.forEach(u => {
    const opt = document.createElement('option');
    opt.value = u.file;
    opt.textContent = u.name;
    sel.appendChild(opt);
  });
}

/* ══════════════════════════════════════
   CSV（単元データ）読み込み
   行0: A1=単元名（すでにunits.csvで管理しているが念のため取得）
   行1: 見出し
   行2~: データ
══════════════════════════════════════ */
async function loadUnit(filename) {
  showLoading(true);
  try {
    const res = await fetch(filename);
    if (!res.ok) throw new Error(`${filename} が見つかりません`);
    const text = await res.text();
    const allRows = parseCSV(text);

    if (allRows.length < 2) {
      showError('データが不足しています（見出し行が必要です）。');
      return;
    }

    // A1行（行0）: 単元名
    AppState.currentUnit = allRows[0][0] || filename;
    // 行1 (index 1): 見出し
    AppState.headers = allRows[1];
    // 行2以降: データ
    AppState.rows = allRows.slice(2);
    // 列の開閉状態リセット
    AppState.colRevealed = {};

    renderTable();
  } catch (e) {
    console.error('単元データ読み込みエラー:', e);
    showError(`${filename} の読み込みに失敗しました。`);
  } finally {
    showLoading(false);
  }
}

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

  // ── ヘッダー ──
  thead.innerHTML = '';
  const tr = document.createElement('tr');

  // チェック列ヘッダー
  const thCheck = document.createElement('th');
  thCheck.className = 'col-check';
  thCheck.innerHTML = '<span style="opacity:0.5;font-size:0.75rem;">✓</span>';
  tr.appendChild(thCheck);

  AppState.headers.forEach((h, ci) => {
    const th = document.createElement('th');
    const span = document.createElement('span');
    span.className = 'th-content';
    span.dataset.col = ci;
    span.title = 'クリックで列を一括表示/非表示';
    span.innerHTML = `${escHtml(h)} <span class="th-toggle-icon">▼</span>`;
    span.addEventListener('click', () => toggleColumn(ci));
    th.appendChild(span);
    tr.appendChild(th);
  });
  thead.appendChild(tr);

  // ── ボディ ──
  tbody.innerHTML = '';
  AppState.rows.forEach((row, ri) => {
    tbody.appendChild(createRow(row, ri));
  });

  applyFilter();
}

function createRow(rowData, ri) {
  const unitKey = AppState.currentUnit;
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
  tr.appendChild(tdCheck);

  // データセル
  AppState.headers.forEach((_, ci) => {
    const td = document.createElement('td');
    td.dataset.col = ci;
    const cellInner = document.createElement('div');
    cellInner.className = 'cell-inner';

    const cellText = document.createElement('span');
    cellText.className = 'cell-text';
    cellText.textContent = rowData[ci] ?? '';
    cellInner.appendChild(cellText);

    const mask = document.createElement('div');
    mask.className = 'cell-mask';
    // 列が開いていれば最初から外す
    if (AppState.colRevealed[ci]) {
      mask.classList.add('peeled');
    }
    mask.addEventListener('click', () => toggleMask(mask));
    cellInner.appendChild(mask);

    td.appendChild(cellInner);
    tr.appendChild(td);
  });

  return tr;
}

/* ── セル単体のめくり ── */
function toggleMask(mask) {
  if (mask.classList.contains('peeled')) {
    // 元に戻す
    mask.classList.remove('peeled');
    mask.classList.add('restoring');
    mask.addEventListener('animationend', () => {
      mask.classList.remove('restoring');
    }, { once: true });
  } else {
    // めくる
    mask.classList.add('peeling');
    mask.addEventListener('animationend', () => {
      mask.classList.remove('peeling');
      mask.classList.add('peeled');
    }, { once: true });
  }
}

/* ── 列一括開閉 ── */
function toggleColumn(ci) {
  AppState.colRevealed[ci] = !AppState.colRevealed[ci];
  const revealed = AppState.colRevealed[ci];

  document.querySelectorAll(`#tableBody td[data-col="${ci}"] .cell-mask`).forEach(mask => {
    if (revealed) {
      if (!mask.classList.contains('peeled')) {
        mask.classList.add('peeling');
        mask.addEventListener('animationend', () => {
          mask.classList.remove('peeling');
          mask.classList.add('peeled');
        }, { once: true });
      }
    } else {
      if (mask.classList.contains('peeled')) {
        mask.classList.remove('peeled');
        mask.classList.add('restoring');
        mask.addEventListener('animationend', () => {
          mask.classList.remove('restoring');
        }, { once: true });
      }
    }
  });

  // アイコン更新
  const icon = document.querySelector(`.th-content[data-col="${ci}"] .th-toggle-icon`);
  if (icon) icon.textContent = revealed ? '▲' : '▼';
}

/* ── すべて表示/隠す ── */
function revealAll() {
  document.querySelectorAll('#tableBody .cell-mask').forEach(mask => {
    if (!mask.classList.contains('peeled')) {
      mask.classList.add('peeling');
      mask.addEventListener('animationend', () => {
        mask.classList.remove('peeling');
        mask.classList.add('peeled');
      }, { once: true });
    }
  });
  AppState.headers.forEach((_, ci) => {
    AppState.colRevealed[ci] = true;
    const icon = document.querySelector(`.th-content[data-col="${ci}"] .th-toggle-icon`);
    if (icon) icon.textContent = '▲';
  });
}

function hideAll() {
  document.querySelectorAll('#tableBody .cell-mask').forEach(mask => {
    if (mask.classList.contains('peeled')) {
      mask.classList.remove('peeled');
      mask.classList.add('restoring');
      mask.addEventListener('animationend', () => {
        mask.classList.remove('restoring');
      }, { once: true });
    }
  });
  AppState.headers.forEach((_, ci) => {
    AppState.colRevealed[ci] = false;
    const icon = document.querySelector(`.th-content[data-col="${ci}"] .th-toggle-icon`);
    if (icon) icon.textContent = '▼';
  });
}

/* ── チェック管理 ── */
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
  Store.syncToCloud(); // 将来のクラウド同期（現在はno-op）

  // フィルターが掛かっている場合は再適用
  if (AppState.filter !== 'all') applyFilter();
}

/* ── フィルター ── */
function applyFilter() {
  const unitKey = AppState.currentUnit;
  const checks  = AppState.checks[unitKey] || {};
  document.querySelectorAll('#tableBody tr').forEach(tr => {
    const ri = parseInt(tr.dataset.row, 10);
    const isChecked = !!checks[ri];
    if (AppState.filter === 'checked')   tr.classList.toggle('hidden-row', !isChecked);
    else if (AppState.filter === 'unchecked') tr.classList.toggle('hidden-row', isChecked);
    else tr.classList.remove('hidden-row');
  });
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
}

/* ══════════════════════════════════════
   ユーティリティ
══════════════════════════════════════ */
function escHtml(str) {
  return (str ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function showLoading(show) {
  // 簡易: ボタンの無効化
  document.getElementById('unitSelect').disabled = show;
}
function showError(msg) {
  const empty = document.getElementById('emptyState');
  empty.hidden = false;
  document.getElementById('tableWrap').hidden = true;
  empty.querySelector('p').textContent = '⚠ ' + msg;
}

/* ══════════════════════════════════════
   初期化
══════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', () => {
  Store.loadPrefs();
  Store.loadChecks();
  applyFontScale();
  applyVerticalMode();

  // フィルターボタンの初期状態
  document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.filter === AppState.filter);
  });

  // 単元リスト
  loadUnitList();

  // ── イベントリスナー ──

  // 単元選択
  document.getElementById('unitSelect').addEventListener('change', e => {
    const file = e.target.value;
    if (file) loadUnit(file);
    else {
      document.getElementById('tableWrap').hidden = true;
      document.getElementById('emptyState').hidden = false;
      document.getElementById('emptyState').querySelector('p').textContent = '単元を選択してください';
    }
  });

  // 設定ボタン
  document.getElementById('settingsBtn').addEventListener('click', openSettings);
  document.getElementById('settingsClose').addEventListener('click', closeSettings);
  document.getElementById('settingsOverlay').addEventListener('click', closeSettings);

  // 縦書き
  document.getElementById('verticalMode').addEventListener('change', e => {
    AppState.verticalMode = e.target.checked;
    applyVerticalMode();
    Store.savePrefs();
  });

  // フォントサイズ
  document.getElementById('fontIncrease').addEventListener('click', () => {
    if (AppState.fontScale >= 200) return;
    AppState.fontScale = Math.min(200, AppState.fontScale + 10);
    applyFontScale();
    Store.savePrefs();
  });
  document.getElementById('fontDecrease').addEventListener('click', () => {
    if (AppState.fontScale <= 60) return;
    AppState.fontScale = Math.max(60, AppState.fontScale - 10);
    applyFontScale();
    Store.savePrefs();
  });

  // フィルター
  document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      AppState.filter = btn.dataset.filter;
      document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      Store.savePrefs();
      applyFilter();
    });
  });

  // すべて表示/隠す
  document.getElementById('revealAllBtn').addEventListener('click', revealAll);
  document.getElementById('hideAllBtn').addEventListener('click', hideAll);

  // Escキーで設定を閉じる
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeSettings();
  });
});
