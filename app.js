'use strict';
/* 単語ドリル — 毎日少しずつテストして覚える単語アプリ（データはすべてスマホ内に保存） */

// ================= 保存（IndexedDB） =================
const DB_NAME = 'vocab-drill';
let dbPromise = null;
function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains('words')) db.createObjectStore('words', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('audio')) db.createObjectStore('audio', { keyPath: 'name' });
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  return dbPromise;
}
const reqP = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
async function dbGetAll(store) { const db = await openDB(); return reqP(db.transaction(store).objectStore(store).getAll()); }
async function dbGet(store, key) { const db = await openDB(); return reqP(db.transaction(store).objectStore(store).get(key)); }
async function dbGetKeys(store) { const db = await openDB(); return reqP(db.transaction(store).objectStore(store).getAllKeys()); }
async function dbPutMany(store, items) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const t = db.transaction(store, 'readwrite');
    const s = t.objectStore(store);
    items.forEach(i => s.put(i));
    t.oncomplete = () => res();
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error);
  });
}
const dbPut = (store, item) => dbPutMany(store, [item]);
async function dbDelete(store, key) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const t = db.transaction(store, 'readwrite');
    t.objectStore(store).delete(key);
    t.oncomplete = () => res(); t.onerror = () => rej(t.error);
  });
}

// ================= 状態 =================
const DEFAULT_SETTINGS = {
  newPerDay: 5,          // 1日の新しい単語数
  maxReviews: 50,        // 1日の復習の上限
  mode: 'recall',        // recall（英単語を見て思い出す） | listen（音声だけを聞いて思い出す）
  autoplay: true,        // 英単語の音声を自動再生
  introNew: true,        // 新しい単語は先にカードで確認してからテスト
  myFirst: true,         // 自分で追加した単語を優先
  decks: { toefl: true, my: true },
};
const DECK_NAMES = { toefl: 'TOEFL', my: 'My単語' };
const state = { words: [], settings: { ...DEFAULT_SETTINGS }, log: {}, audioNames: new Set(), tab: 'home', session: null };

function today(d = new Date()) { return Math.floor((d.getTime() - d.getTimezoneOffset() * 60000) / 86400000); }
function dayToStr(n) { return new Date(n * 86400000).toISOString().slice(0, 10); }
function dayLog(n = today()) { return state.log[n] || (state.log[n] = { new: 0, reviews: 0, correct: 0 }); }
async function saveMeta() {
  await dbPutMany('meta', [{ key: 'settings', value: state.settings }, { key: 'log', value: state.log }]);
}
function newSrs() { return { state: 'new', due: null, interval: 0, ease: 2.5, reps: 0, lapses: 0, last: null }; }

// ================= 間隔反復（SRS） =================
// result: 'again'（忘れた） | 'hard'（あいまい） | 'good'（覚えてた） | 'easy'
// 次に出す間隔の目安: 覚えてた 1日→3日→約8日→約20日… ／ あいまい 1日→2日→少しずつ伸びる ／ 忘れた 翌日からやり直し
function schedule(w, result) {
  const s = w.srs, t = today();
  if (result === 'again') {
    s.lapses++; s.reps = 0; s.ease = Math.max(1.3, s.ease - 0.2); s.interval = 1;
  } else if (result === 'hard') {
    s.reps++;
    s.interval = s.reps === 1 ? 1 : s.reps === 2 ? 2 : Math.round(s.interval * 1.2);
    s.ease = Math.max(1.3, s.ease - 0.15);
  } else {
    s.reps++;
    if (s.reps === 1) s.interval = result === 'easy' ? 3 : 1;
    else if (s.reps === 2) s.interval = result === 'easy' ? 7 : 3;
    else s.interval = Math.round(s.interval * s.ease * (result === 'easy' ? 1.3 : 1));
    if (result === 'easy') s.ease = Math.min(3.0, s.ease + 0.15);
  }
  s.interval = Math.max(1, Math.min(365, s.interval));
  s.state = 'review'; s.due = t + s.interval; s.last = t;
}
function status(w) {
  if (w.srs.state === 'new') return { label: '未学習', cls: '' };
  if (w.srs.interval >= 21) return { label: '定着', cls: 'done' };
  return { label: '学習中', cls: 'learn' };
}

// ================= 小道具 =================
function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return el;
}
let toastTimer;
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), 2200);
}
function shuffle(a) { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
const norm = s => (s || '').trim().toLowerCase();
function download(name, text, type = 'application/json') {
  const a = h('a', { href: URL.createObjectURL(new Blob([text], { type })), download: name });
  document.body.append(a); a.click(); a.remove();
}

// ================= 音声 =================
const player = new Audio();
let stopTimer = null;
const urlCache = {};
function stopAudio() { clearInterval(stopTimer); stopTimer = null; player.pause(); if (window.speechSynthesis) speechSynthesis.cancel(); }
// PCとスマホでファイル名が違っても、先頭のトラック番号（"01 xxx.mp3" の 01）が同じなら同じ音声とみなす
const trackNo = n => { const m = String(n).match(/(\d+)/); return m ? parseInt(m[1], 10) : null; };
function resolveAudioName(name) {
  if (state.audioNames.has(name)) return name;
  const t = trackNo(name);
  if (t == null) return null;
  const hits = [...state.audioNames].filter(n => trackNo(n) === t);
  return hits.length === 1 ? hits[0] : null;
}
async function audioUrl(file) {
  const name = resolveAudioName(file);
  if (!name) return null;
  if (urlCache[name]) return urlCache[name];
  const rec = await dbGet('audio', name);
  return rec ? (urlCache[name] = URL.createObjectURL(rec.blob)) : null;
}
function seek(el, t) {
  return new Promise(res => {
    const go = () => { el.currentTime = t; res(); };
    if (el.readyState >= 1) go(); else el.addEventListener('loadedmetadata', go, { once: true });
  });
}
// part: 'word' | 'meaning' | 'example'
async function play(w, part) {
  stopAudio();
  const a = w.audio, seg = a && a[part];
  if (a && a.file && seg && seg[1] > seg[0]) {
    const url = await audioUrl(a.file);
    if (url) {
      if (player.src !== url) player.src = url;
      await seek(player, Math.max(0, seg[0] - 0.05));
      try { await player.play(); } catch (e) { return; }
      stopTimer = setInterval(() => { if (player.currentTime >= seg[1] + 0.05) stopAudio(); }, 30);
      return;
    }
  }
  // 音声がない単語（自分で追加した単語など）は端末の読み上げで代用
  const text = part === 'word' ? w.word : part === 'example' ? w.example : w.meaning;
  if (!text || !window.speechSynthesis) return;
  const u = new SpeechSynthesisUtterance(text);
  u.lang = part === 'meaning' ? 'ja-JP' : 'en-US';
  u.rate = part === 'word' ? 0.85 : 0.95;
  speechSynthesis.speak(u);
}
const speakBtn = (w, part, label) => h('button', { class: 'speak', onclick: e => { e.stopPropagation(); play(w, part); } }, '🔊 ' + label);

// ================= 画面切り替え =================
const view = () => document.getElementById('view');
function setTitle(t) { document.getElementById('title').textContent = t; }
function go(tab, arg) {
  stopAudio();
  state.tab = tab;
  document.body.classList.toggle('in-session', tab === 'session');
  document.querySelectorAll('#tabbar button').forEach(b => b.classList.toggle('active', b.dataset.tab === tab || (tab === 'edit' && b.dataset.tab === 'list')));
  view().replaceChildren();
  window.scrollTo(0, 0);
  ({ home: renderHome, list: renderList, add: () => renderEdit(null), edit: () => renderEdit(arg), settings: renderSettings, session: renderSession })[tab]();
}

// ================= ホーム =================
function eligible() { return state.words.filter(w => state.settings.decks[w.deck] !== false && w.word && w.meaning); }
function newOrder(a, b) {
  if (state.settings.myFirst && a.deck !== b.deck) return a.deck === 'my' ? -1 : 1;
  if (a.deck === 'toefl' && b.deck === 'toefl') return (a.no || 0) - (b.no || 0);
  return (a.createdAt || 0) - (b.createdAt || 0);
}
function todaysWork() {
  const t = today(), pool = eligible(), log = dayLog(t);
  const due = pool.filter(w => w.srs.state !== 'new' && w.srs.due <= t).sort((a, b) => a.srs.due - b.srs.due).slice(0, state.settings.maxReviews);
  const remain = Math.max(0, state.settings.newPerDay - log.new);
  const news = pool.filter(w => w.srs.state === 'new').sort(newOrder).slice(0, remain);
  return { due, news };
}
function streak() {
  let n = 0, d = today();
  if (!state.log[d] || !(state.log[d].reviews + state.log[d].new)) d--; // 今日まだなら昨日から数える
  while (state.log[d] && state.log[d].reviews + state.log[d].new > 0) { n++; d--; }
  return n;
}
function renderHome() {
  setTitle('単語ドリル');
  const { due, news } = todaysWork();
  const all = state.words, learned = all.filter(w => w.srs.state !== 'new');
  const mastered = all.filter(w => status(w).cls === 'done');
  const log = dayLog();
  const total = due.length + news.length;
  view().append(
    h('div', { class: 'card' },
      h('h2', {}, '今日のテスト'),
      h('div', { class: 'stats' },
        h('div', { class: 'stat' }, h('div', { class: 'num' }, due.length), h('div', { class: 'lbl' }, '復習')),
        h('div', { class: 'stat' }, h('div', { class: 'num' }, news.length), h('div', { class: 'lbl' }, '新しい単語')),
        h('div', { class: 'stat' }, h('div', { class: 'num' }, streak()), h('div', { class: 'lbl' }, '連続日数'))),
      h('div', { style: 'margin-top:14px' },
        total
          ? h('button', { class: 'btn primary big', onclick: () => startSession(due, news) }, `スタート（${total}問）`)
          : h('div', { class: 'muted', style: 'text-align:center' },
              all.length ? '今日の分は終わりました 🎉' : 'まだ単語がありません。「追加」か「設定 → TOEFLデータ取り込み」から登録してください。')),
      (log.new + log.reviews) ? h('p', { class: 'small muted', style: 'margin:10px 0 0' }, `今日の成績：${log.new + log.reviews}語中 ${log.correct}語 思い出せた`) : null,
      (!total && all.length && eligible().some(w => w.srs.state === 'new'))
        ? h('div', { style: 'margin-top:10px' }, h('button', { class: 'btn big', onclick: () => { const more = eligible().filter(w => w.srs.state === 'new').sort(newOrder).slice(0, state.settings.newPerDay); startSession([], more); } }, `もう${state.settings.newPerDay}語やる`))
        : null),
    h('div', { class: 'card' },
      h('h2', {}, '全体の進み具合'),
      h('div', { class: 'stats' },
        h('div', { class: 'stat' }, h('div', { class: 'num' }, all.length), h('div', { class: 'lbl' }, '登録')),
        h('div', { class: 'stat' }, h('div', { class: 'num' }, learned.length), h('div', { class: 'lbl' }, '学習済み')),
        h('div', { class: 'stat' }, h('div', { class: 'num' }, mastered.length), h('div', { class: 'lbl' }, '定着(21日+)'))),
      h('p', { class: 'small muted', style: 'margin:10px 0 0' }, 'TOEFL ' + all.filter(w => w.deck === 'toefl').length + '語 ／ My単語 ' + all.filter(w => w.deck === 'my').length + '語')),
  );
}

// ================= テスト =================
function startSession(due, news) {
  const items = [];
  const quiz = shuffle([...due, ...news]).map(w => ({ type: 'quiz', w }));
  if (state.settings.introNew) news.forEach(w => items.push({ type: 'intro', w }));
  items.push(...quiz);
  state.session = { items, pos: 0, done: new Set(), firstResult: {}, correct: 0, answered: 0, total: due.length + news.length };
  go('session');
}
function renderSession() {
  const s = state.session;
  if (!s) return go('home');
  if (s.pos >= s.items.length) return renderSessionEnd();
  const item = s.items[s.pos], w = item.w;
  const intros = s.items.filter(i => i.type === 'intro');
  setTitle(item.type === 'intro'
    ? `📖 学習 ${intros.indexOf(item) + 1} / ${intros.length}`
    : `✏️ テスト ${Math.min(s.done.size + 1, s.total)} / ${s.total}`);
  const v = view();
  v.append(
    h('div', { class: 'progress' }, h('div', { style: `width:${(s.done.size / Math.max(1, s.total)) * 100}%` })),
  );
  if (item.type === 'intro') {
    v.append(
      h('div', { class: 'card study' },
        h('div', { class: 'mode-banner study' }, '📖 学習 — テストの前に覚えましょう'),
        h('div', { class: 'prompt' }, h('div', { class: 'word' }, w.word)),
        detailBlock(w, false),
        h('div', { class: 'grade one' }, h('button', { class: 'btn primary big', onclick: next }, '覚えた → 次へ'))),
      quitButton());
    if (state.settings.autoplay) play(w, 'word');
    return;
  }

  // テスト：答え（意味）を隠したまま出題し、思い出してから「答えを見る」で確認する
  const listen = state.settings.mode === 'listen';
  const first = !s.done.has(w.id) && !(w.id in s.firstResult);
  const answerBox = h('div');
  const prompt = h('div', { class: 'prompt' },
    h('div', { class: 'tag' }, listen ? '聞いて、意味を思い出してください' : '意味を思い出してください'),
    listen
      ? h('button', { class: 'listen-btn', onclick: () => play(w, 'word') }, '🔊', h('div', { class: 'small' }, 'もう一度聞く'))
      : h('div', {}, h('div', { class: 'word' }, w.word), h('div', { style: 'margin-top:8px' }, speakBtn(w, 'word', '発音'))));
  const reveal = h('button', { class: 'btn primary big', onclick: () => {
    reveal.remove();
    answerBox.append(detailBlock(w, true), gradeButtons(w, first));
    answerBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } }, '答えを見る');
  v.append(
    h('div', { class: 'card' }, h('div', { class: 'mode-banner test' }, '✏️ テスト'), prompt, reveal, answerBox),
    quitButton());
  if (listen || state.settings.autoplay) play(w, 'word');
}
function detailBlock(w, showWord) {
  return h('div', { class: 'detail card', style: 'margin:12px 0 0;background:var(--bg)' },
    showWord ? h('div', { class: 'w' }, w.word, w.field ? h('span', { class: 'badge', style: 'margin-left:8px;vertical-align:middle' }, w.field) : null) : null,
    h('div', { class: 'm' }, w.pos ? h('span', { class: 'pos' }, w.pos) : null, w.meaning),
    w.more ? h('div', { class: 'small', style: 'margin:-4px 0 8px' }, w.more) : null,
    w.example ? h('div', { class: 'ex' }, w.example) : null,
    w.related ? h('div', { class: 'small muted', style: 'margin-top:6px' }, w.related.split('／').map(x => h('div', {}, '・' + x))) : null,
    w.note ? h('div', { class: 'small muted', style: 'margin-top:6px' }, '📝 ' + w.note) : null,
    h('div', { class: 'row', style: 'margin-top:10px' }, speakBtn(w, 'word', '単語'), w.example || (w.audio && w.audio.example) ? speakBtn(w, 'example', '例文') : null));
}
function gradeButtons(w, first) {
  const s = state.session;
  const finish = async result => {
    if (first) {
      const wasNew = w.srs.state === 'new';
      s.firstResult[w.id] = result;
      schedule(w, result);
      const log = dayLog();
      if (wasNew) log.new++; else log.reviews++;
      if (result !== 'again') log.correct++;
      s.answered++; if (result !== 'again') s.correct++;
      await Promise.all([dbPut('words', w), saveMeta()]);
    }
    if (result === 'again') {
      // 間違えた単語は少し後にもう一度出す
      s.items.splice(Math.min(s.items.length, s.pos + 4), 0, { type: 'quiz', w });
    } else {
      s.done.add(w.id);
    }
    next();
  };
  return h('div', {},
    h('div', { class: 'small muted', style: 'text-align:center;margin-top:12px' }, '思い出せましたか？'),
    h('div', { class: 'grade', style: 'margin-top:6px' },
      h('button', { class: 'btn grade-ng', onclick: () => finish('again') }, '忘れた'),
      h('button', { class: 'btn grade-mid', onclick: () => finish('hard') }, 'あいまい'),
      h('button', { class: 'btn primary', onclick: () => finish('good') }, '覚えてた')));
}
function next() { state.session.pos++; go('session'); }
function quitButton() {
  return h('button', { class: 'btn big', style: 'margin-top:4px', onclick: () => { state.session = null; go('home'); } }, '中断してホームへ');
}
function renderSessionEnd() {
  const s = state.session;
  setTitle('おつかれさま');
  const missed = s.items.filter(i => i.type === 'quiz' && s.firstResult[i.w.id] === 'again').map(i => i.w);
  const uniq = [...new Map(missed.map(w => [w.id, w])).values()];
  view().append(h('div', { class: 'card', style: 'text-align:center' },
    h('div', { style: 'font-size:44px' }, '🎉'),
    h('h2', {}, `${s.answered}語中 ${s.correct}語 思い出せた`),
    uniq.length ? h('div', { style: 'text-align:left;margin-top:10px' },
      h('div', { class: 'small muted' }, '忘れていた単語（明日もう一度出ます）'),
      h('ul', { class: 'list' }, uniq.map(w => h('li', {}, h('div', {}, h('div', { class: 'lw' }, w.word), h('div', { class: 'lm' }, w.meaning)), speakBtn(w, 'word', ''))))) : null,
    h('button', { class: 'btn primary big', style: 'margin-top:14px', onclick: () => { state.session = null; go('home'); } }, 'ホームへ')));
}

// ================= 単語帳 =================
const listState = { q: '', deck: 'all', filter: 'all', limit: 100 };
function renderList() {
  setTitle('単語帳');
  const ul = h('ul', { class: 'list' });
  const info = h('div', { class: 'small muted', style: 'margin:6px 0' });
  const more = h('div');
  const draw = () => {
    const q = norm(listState.q);
    let items = state.words.filter(w =>
      (listState.deck === 'all' || w.deck === listState.deck) &&
      (listState.filter === 'all' || (listState.filter === 'due' ? (w.srs.state !== 'new' && w.srs.due <= today()) : status(w).cls === listState.filter || (listState.filter === 'new' && w.srs.state === 'new'))) &&
      (!q || norm(w.word).includes(q) || norm(w.meaning).includes(q)));
    items.sort((a, b) => a.deck !== b.deck ? (a.deck === 'my' ? -1 : 1) : a.deck === 'toefl' ? (a.no || 0) - (b.no || 0) : (b.createdAt || 0) - (a.createdAt || 0));
    info.textContent = `${items.length}語`;
    ul.replaceChildren(...items.slice(0, listState.limit).map(w => {
      const st = status(w);
      return h('li', { onclick: () => go('edit', w.id) },
        h('div', { style: 'min-width:0' },
          h('div', { class: 'lw' }, (w.no ? `${w.no}. ` : '') + w.word),
          h('div', { class: 'lm' }, w.meaning)),
        h('span', { class: 'badge ' + st.cls }, st.label + (w.srs.state !== 'new' ? ` ・${dayToStr(w.srs.due).slice(5)}` : '')));
    }));
    more.replaceChildren(items.length > listState.limit ? h('button', { class: 'btn big', onclick: () => { listState.limit += 200; draw(); } }, 'もっと表示') : '');
  };
  view().append(
    h('div', { class: 'card' },
      h('input', { type: 'search', placeholder: '英単語・意味で検索', value: listState.q, oninput: e => { listState.q = e.target.value; listState.limit = 100; draw(); } }),
      h('div', { class: 'row', style: 'margin-top:8px' },
        h('select', { onchange: e => { listState.deck = e.target.value; draw(); } },
          [['all', 'すべての単語帳'], ['toefl', 'TOEFL'], ['my', 'My単語']].map(([v, l]) => h('option', { value: v, selected: listState.deck === v }, l))),
        h('select', { onchange: e => { listState.filter = e.target.value; draw(); } },
          [['all', 'すべての状態'], ['new', '未学習'], ['learn', '学習中'], ['done', '定着'], ['due', '今日の復習']].map(([v, l]) => h('option', { value: v, selected: listState.filter === v }, l)))),
      info, ul, more));
  draw();
}

// ================= 追加・編集 =================
function renderEdit(id) {
  const w = id ? state.words.find(x => x.id === id) : null;
  setTitle(w ? '単語を編集' : '単語を追加');
  const f = {
    word: h('input', { type: 'text', value: w ? w.word : '', autocapitalize: 'off', autocomplete: 'off', spellcheck: 'false', placeholder: '例: ubiquitous' }),
    meaning: h('input', { type: 'text', value: w ? w.meaning : '', placeholder: '例: どこにでもある' }),
    example: h('textarea', { placeholder: '例文（任意）' }),
    note: h('textarea', { placeholder: 'メモ：どこで出会ったか、覚え方など（任意）' }),
  };
  f.example.value = w ? w.example || '' : '';
  f.note.value = w ? w.note || '' : '';
  const dup = h('div', { class: 'small', style: 'color:var(--ng);margin:-6px 0 10px' });
  f.word.addEventListener('input', () => {
    const ex = state.words.find(x => x.id !== id && norm(x.word) === norm(f.word.value));
    dup.textContent = ex ? `「${ex.word}」は${DECK_NAMES[ex.deck]}に登録済みです（${ex.meaning}）` : '';
  });
  const save = async () => {
    const word = f.word.value.trim(), meaning = f.meaning.value.trim();
    if (!word || !meaning) return toast('英単語と意味は必須です');
    const rec = w || { id: 'my-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), deck: 'my', createdAt: Date.now(), srs: newSrs(), audio: null };
    Object.assign(rec, { word, meaning, example: f.example.value.trim(), note: f.note.value.trim() });
    await dbPut('words', rec);
    if (!w) { state.words.push(rec); toast(`「${word}」を追加しました`); go('add'); }
    else { toast('保存しました'); go('list'); }
  };
  view().append(h('div', { class: 'card' },
    h('label', { class: 'field' }, '英単語 *', f.word), dup,
    h('label', { class: 'field' }, '意味 *', f.meaning),
    h('label', { class: 'field' }, '例文', f.example),
    h('label', { class: 'field' }, 'メモ', f.note),
    h('div', { class: 'row' },
      h('button', { class: 'btn', onclick: () => play({ word: f.word.value, example: f.example.value, audio: w && w.audio }, 'word') }, '🔊 発音'),
      h('button', { class: 'btn primary', onclick: save }, w ? '保存' : '追加'))));
  if (w) {
    const st = status(w);
    view().append(h('div', { class: 'card' },
      h('div', { class: 'small muted' }, `${DECK_NAMES[w.deck]}${w.no ? ' No.' + w.no : ''} ／ ${st.label}` +
        (w.srs.state !== 'new' ? ` ／ 次回 ${dayToStr(w.srs.due)}（間隔${w.srs.interval}日・間違い${w.srs.lapses}回）` : '')),
      h('div', { class: 'row', style: 'margin-top:10px' },
        h('button', { class: 'btn', onclick: async () => { if (!confirm('この単語の学習記録をリセットしますか？')) return; w.srs = newSrs(); await dbPut('words', w); toast('リセットしました'); go('edit', w.id); } }, '記録をリセット'),
        h('button', { class: 'btn danger', onclick: async () => { if (!confirm(`「${w.word}」を削除しますか？`)) return; await dbDelete('words', w.id); state.words = state.words.filter(x => x !== w); toast('削除しました'); go('list'); } }, '削除'))));
  } else {
    view().append(h('p', { class: 'small muted' }, '授業・ニュース・問題集などで分からなかった単語をここに追加すると、「My単語」として毎日のテストに出てきます。'));
    setTimeout(() => f.word.focus(), 50);
  }
}

// ================= 設定・取り込み =================
function parseCSV(text) {
  text = text.replace(/^﻿/, '');
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const head = (rows.shift() || []).map(s => s.trim());
  return rows.filter(r => r.some(c => c.trim())).map(r => Object.fromEntries(head.map((k, i) => [k, (r[i] || '').trim()])));
}
async function importWordList(file) {
  const text = await file.text();
  let rows;
  if (/\.json$/i.test(file.name)) { const j = JSON.parse(text); rows = Array.isArray(j) ? j : j.words; }
  else rows = parseCSV(text);
  const num = v => (v === '' || v == null || isNaN(+v)) ? null : +v;
  const byId = new Map(state.words.map(w => [w.id, w]));
  const changed = []; let added = 0, updated = 0;
  rows.forEach((r, i) => {
    if (!r.word || !r.meaning) return;
    const no = num(r.no) || i + 1;
    const id = 'toefl-' + String(no).padStart(4, '0');
    const seg = (a, b) => (num(r[a]) != null && num(r[b]) != null) ? [num(r[a]), num(r[b])] : null;
    const audio = r.audio || (r.file ? { file: r.file, word: seg('word_start', 'word_end'), meaning: seg('meaning_start', 'meaning_end'), example: seg('example_start', 'example_end') } : null);
    const old = byId.get(id);
    const rec = old || { id, deck: 'toefl', createdAt: Date.now(), srs: newSrs() };
    Object.assign(rec, { no, word: r.word, meaning: r.meaning, example: r.example || '', audio,
      pos: r.pos || '', field: r.field || '', more: r.more || '', related: r.related || '' });
    if (r.note != null && !old) rec.note = r.note;
    if (old) updated++; else { added++; state.words.push(rec); }
    changed.push(rec);
  });
  await dbPutMany('words', changed);
  return { added, updated };
}
async function importAudio(files) {
  let n = 0;
  for (const f of files) {
    await dbPut('audio', { name: f.name, blob: f });
    delete urlCache[f.name];
    state.audioNames.add(f.name); n++;
  }
  return n;
}
function renderSettings() {
  setTitle('設定');
  const st = state.settings;
  const set = async (k, v) => { st[k] = v; await saveMeta(); };
  const numInput = (k, min, max) => h('input', { type: 'number', min, max, value: st[k], onchange: e => set(k, Math.max(min, Math.min(max, parseInt(e.target.value) || min))) });
  const check = (label, k) => h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: st[k], onchange: e => set(k, e.target.checked) }), label);
  const deckCheck = d => h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: st.decks[d] !== false, onchange: e => { st.decks[d] = e.target.checked; saveMeta(); } }), DECK_NAMES[d] + 'を出題');

  const neededFiles = [...new Set(state.words.filter(w => w.audio && w.audio.file).map(w => w.audio.file))];
  const missing = neededFiles.filter(n => !resolveAudioName(n));
  const audioInfo = h('div', { class: 'small muted' },
    neededFiles.length ? `音声ファイル：${neededFiles.length - missing.length} / ${neededFiles.length} 取り込み済み` + (missing.length ? `（未取り込み例：${missing.slice(0, 3).join('、')}）` : '') : `取り込み済み音声ファイル：${state.audioNames.size}件`);
  const storageInfo = h('div', { class: 'small muted', style: 'margin-top:8px' });
  if (navigator.storage && navigator.storage.estimate) navigator.storage.estimate().then(e => { storageInfo.textContent = `使用容量：約${Math.round(e.usage / 1048576)}MB`; });

  const wordFile = h('input', { type: 'file', accept: '.csv,.json,text/csv,application/json', hidden: true, onchange: async e => {
    const f = e.target.files[0]; if (!f) return;
    try { const r = await importWordList(f); toast(`単語 ${r.added}語追加・${r.updated}語更新`); go('settings'); }
    catch (err) { alert('読み込みに失敗しました：' + err.message); }
  } });
  const audioFile = h('input', { type: 'file', accept: 'audio/*,.mp3', multiple: true, hidden: true, onchange: async e => {
    const files = [...e.target.files]; if (!files.length) return;
    toast('音声を取り込み中…');
    try { const n = await importAudio(files); toast(`音声 ${n}ファイルを取り込みました`); go('settings'); }
    catch (err) { alert('音声の取り込みに失敗しました（容量不足の可能性）：' + err.message); }
  } });
  const backupFile = h('input', { type: 'file', accept: '.json,application/json', hidden: true, onchange: async e => {
    const f = e.target.files[0]; if (!f) return;
    try {
      const j = JSON.parse(await f.text());
      if (j.app !== 'vocab-drill' || !Array.isArray(j.words)) throw new Error('このアプリのバックアップではありません');
      if (!confirm(`${j.words.length}語の記録を復元します。同じ単語の記録は上書きされます。よろしいですか？`)) return;
      await dbPutMany('words', j.words);
      state.settings = { ...DEFAULT_SETTINGS, ...j.settings }; state.log = j.log || {};
      await saveMeta(); await loadAll(); toast('復元しました'); go('settings');
    } catch (err) { alert('復元に失敗しました：' + err.message); }
  } });

  view().append(
    h('div', { class: 'card' },
      h('h2', {}, 'テストの設定'),
      h('label', { class: 'field' }, '1日の新しい単語数', numInput('newPerDay', 0, 100)),
      h('label', { class: 'field' }, '1日の復習の上限', numInput('maxReviews', 5, 500)),
      h('label', { class: 'field' }, '出題方法',
        h('select', { onchange: e => set('mode', e.target.value) },
          [['recall', '思い出し（英単語と発音を見て意味を思い出す）'], ['listen', '聞き取り（音声だけで意味を思い出す）']].map(([v, l]) => h('option', { value: v, selected: st.mode === v }, l)))),
      check('英単語の音声を自動再生', 'autoplay'),
      check('新しい単語はテストの前に学習カードで覚える', 'introNew'),
      check('My単語を優先して出す', 'myFirst'),
      deckCheck('toefl'), deckCheck('my')),
    h('div', { class: 'card' },
      h('h2', {}, 'TOEFLデータ取り込み'),
      h('p', { class: 'small muted', style: 'margin-top:0' }, 'PCで作った単語リスト（words.csv）と、スマホに入っているCDのMP3（フォルダを開いて全部選択）を選んでください。ファイル名がPCと違っても、先頭のトラック番号が同じなら対応づけます。何度取り込んでも学習記録は消えません。'),
      h('div', { class: 'row' },
        h('button', { class: 'btn', onclick: () => wordFile.click() }, '① 単語リスト'),
        h('button', { class: 'btn', onclick: () => audioFile.click() }, '② 音声MP3')),
      h('div', { style: 'margin-top:8px' }, audioInfo), storageInfo, wordFile, audioFile),
    h('div', { class: 'card' },
      h('h2', {}, 'バックアップ'),
      h('p', { class: 'small muted', style: 'margin-top:0' }, '学習記録とMy単語をファイルに保存します（音声は含みません）。機種変更やブラウザのデータ削除に備えて、ときどき保存してください。'),
      h('div', { class: 'row' },
        h('button', { class: 'btn', onclick: () => download(`vocab-backup-${dayToStr(today())}.json`, JSON.stringify({ app: 'vocab-drill', version: 1, exportedAt: new Date().toISOString(), words: state.words, settings: state.settings, log: state.log })) }, '保存する'),
        h('button', { class: 'btn', onclick: () => backupFile.click() }, '復元する')),
      h('button', { class: 'btn', style: 'margin-top:8px;width:100%', onclick: () => download(`my-words-${dayToStr(today())}.csv`,
        '﻿word,meaning,example,note\n' + state.words.filter(w => w.deck === 'my').map(w => [w.word, w.meaning, w.example, w.note].map(v => '"' + String(v || '').replace(/"/g, '""') + '"').join(',')).join('\n'), 'text/csv') }, 'My単語をCSVで書き出す'),
      backupFile),
  );
}

// ================= 起動 =================
async function loadAll() {
  state.words = (await dbGetAll('words')).map(w => ({ ...w, srs: w.srs || newSrs() }));
  const meta = Object.fromEntries((await dbGetAll('meta')).map(m => [m.key, m.value]));
  state.settings = { ...DEFAULT_SETTINGS, ...(meta.settings || {}), decks: { ...DEFAULT_SETTINGS.decks, ...((meta.settings || {}).decks || {}) } };
  state.log = meta.log || {};
  state.audioNames = new Set(await dbGetKeys('audio'));
}
async function init() {
  document.querySelectorAll('#tabbar button').forEach(b => b.addEventListener('click', () => go(b.dataset.tab)));
  await loadAll();
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('sw.js').catch(() => {});
  go('home');
}
init().catch(err => { document.getElementById('view').textContent = '起動に失敗しました：' + err.message; });
