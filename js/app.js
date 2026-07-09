// 給他排下去 — 主程式
import { db } from './db.js';
import { sync } from './sync.js';
import { HOLIDAYS } from './holidays.js';

const $ = id => document.getElementById(id);
const HOUR_H = 48; // 時間軸每小時高度(px)
const PALETTE = ['#4A7CFA', '#F26B6B', '#F5A623', '#2FB380', '#9B59D0', '#E85D9E', '#17A2B8', '#8B6F47', '#607D8B', '#D4A017'];
const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

// ── 狀態 ──
let calendars = [];
let events = [];
let view = 'month';
let cursor = new Date();      // 目前檢視的月/週/日基準
let selectedDay = new Date(); // 月檢視選取的日期
let editingEvent = null;      // 編輯中的行程
let editingPhotos = [];       // 編輯中的照片 [{id, data}]
let editingCal = null;        // 編輯中的行事曆
let calFormColor = PALETTE[0];

// ── 日期工具 ──
const fmtYMD = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const fmtHM = d => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
const startOfDay = d => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
const endOfDay = d => { const x = new Date(d); x.setHours(23, 59, 59, 999); return x; };
const startOfWeek = d => { const x = startOfDay(d); x.setDate(x.getDate() - x.getDay()); return x; };
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };

function calById(id) { return calendars.find(c => c.id === id) || { name: '?', color: '#999' }; }

// ── 重複行程展開:回傳指定範圍內的「行程實例」 ──
function occurrencesInRange(rangeStart, rangeEnd) {
  const out = [];
  const visibleCals = new Set(calendars.filter(c => !c.hidden).map(c => c.id));
  for (const ev of events) {
    if (ev.deleted || !visibleCals.has(ev.calendarId)) continue;
    const evStart = new Date(ev.start);
    const evEnd = new Date(ev.end);
    const durMs = evEnd - evStart;
    if (!ev.repeat || ev.repeat === 'none') {
      if (evStart <= rangeEnd && evEnd >= rangeStart) out.push({ ev, start: evStart, end: evEnd });
      continue;
    }
    // 從行程開始日往後展開到範圍結束(上限 500 次防呆)
    let cur = new Date(evStart);
    for (let i = 0; i < 500 && cur <= rangeEnd; i++) {
      const occEnd = new Date(cur.getTime() + durMs);
      if (occEnd >= rangeStart) out.push({ ev, start: new Date(cur), end: occEnd });
      if (ev.repeat === 'daily') cur = addDays(cur, 1);
      else if (ev.repeat === 'weekly') cur = addDays(cur, 7);
      else if (ev.repeat === 'monthly') { cur = new Date(cur); cur.setMonth(cur.getMonth() + 1); }
      else if (ev.repeat === 'yearly') { cur = new Date(cur); cur.setFullYear(cur.getFullYear() + 1); }
      else break;
    }
  }
  out.sort((a, b) => (b.ev.allDay - a.ev.allDay) || (a.start - b.start));
  return out;
}

function occurrencesOnDay(day) {
  const s = startOfDay(day), e = endOfDay(day);
  return occurrencesInRange(s, e).filter(o => o.start <= e && o.end >= s);
}

// ── Toast ──
let toastTimer;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}

// ── 初始化 ──
async function init() {
  calendars = await db.getAll('calendars');
  if (calendars.filter(c => !c.deleted).length === 0) {
    const defaults = [
      { name: '家庭', color: '#F26B6B' },
      { name: '工作', color: '#4A7CFA' },
      { name: '個人', color: '#2FB380' },
    ];
    for (const d of defaults) {
      const cal = { id: db.uid(), ...d, hidden: false, deleted: false, updatedAt: Date.now() };
      await db.put('calendars', cal);
    }
    calendars = await db.getAll('calendars');
  }
  events = await db.getAll('events');

  bindUI();
  render();
  registerSW();
  startReminderLoop();
  startClock();
  sync.init({
    onRemoteChange: async () => {
      calendars = await db.getAll('calendars');
      events = await db.getAll('events');
      render();
      renderSettings();
    },
    toast,
  });
  renderSettings();
}

// ── 畫面渲染 ──
function render() {
  renderTitle();
  if (view === 'month') renderMonth();
  else if (view === 'week') renderWeek();
  else renderDay();
}

function renderTitle() {
  const y = cursor.getFullYear(), m = cursor.getMonth() + 1;
  if (view === 'day') $('titleText').textContent = `${y}年${m}月${cursor.getDate()}日 (${WEEKDAYS[cursor.getDay()]})`;
  else $('titleText').textContent = `${y}年${m}月`;
}

// ── 月檢視 ──
function renderMonth() {
  const wr = $('weekdayRow');
  wr.innerHTML = WEEKDAYS.map((w, i) =>
    `<span class="${i === 0 ? 'wd-sun' : i === 6 ? 'wd-sat' : ''}">${w}</span>`).join('');

  const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
  const gridStart = startOfWeek(first);
  const cells = [];
  const today = new Date();
  const rangeEnd = addDays(gridStart, 42);
  const occs = occurrencesInRange(gridStart, endOfDay(addDays(rangeEnd, -1)));

  for (let i = 0; i < 42; i++) {
    const d = addDays(gridStart, i);
    const dayOccs = occs.filter(o => o.start <= endOfDay(d) && o.end >= startOfDay(d));
    const isOther = d.getMonth() !== cursor.getMonth();
    const holiday = HOLIDAYS[fmtYMD(d)];
    const cls = ['mcell'];
    if (isOther) cls.push('other');
    if (sameDay(d, today)) cls.push('today');
    if (sameDay(d, selectedDay)) cls.push('selected');
    if (d.getDay() === 0) cls.push('sun');
    if (d.getDay() === 6) cls.push('sat');
    if (holiday) cls.push('hol');
    const holHtml = holiday ? `<div class="mcell-holname">${holiday}</div>` : '';
    const maxChips = holiday ? 2 : 3;
    let chips = dayOccs.slice(0, maxChips).map(o =>
      `<div class="chip" style="background:${calById(o.ev.calendarId).color}">${esc(o.ev.title)}</div>`).join('');
    if (dayOccs.length > maxChips) chips += `<div class="chip more">+${dayOccs.length - maxChips}</div>`;
    cells.push(`<div class="${cls.join(' ')}" data-date="${fmtYMD(d)}"><div class="mcell-num">${d.getDate()}</div>${holHtml}${chips}</div>`);
  }
  $('monthGrid').innerHTML = cells.join('');
  $('monthGrid').querySelectorAll('.mcell').forEach(c => {
    c.onclick = () => {
      const [y, m, dd] = c.dataset.date.split('-').map(Number);
      const clicked = new Date(y, m - 1, dd);
      if (sameDay(clicked, selectedDay)) {
        // 再點一次已選取的日期 → 直接新增當天行程
        openEventForm(null, { date: clicked });
        return;
      }
      selectedDay = clicked;
      if (selectedDay.getMonth() !== cursor.getMonth()) cursor = new Date(selectedDay);
      renderMonth();
    };
  });
  renderDayPanel();
}

function renderDayPanel() {
  const d = selectedDay;
  $('dayEventsHeader').textContent = `${d.getMonth() + 1}月${d.getDate()}日 (${WEEKDAYS[d.getDay()]})`;
  const occs = occurrencesOnDay(d);
  if (!occs.length) {
    $('dayEventsList').innerHTML = `<div class="empty-hint">沒有行程,按「＋」新增</div>`;
    return;
  }
  $('dayEventsList').innerHTML = occs.map(o => {
    const cal = calById(o.ev.calendarId);
    const time = o.ev.allDay ? '全天' : `${fmtHM(o.start)} - ${fmtHM(o.end)}`;
    const icons = [(o.ev.photos && o.ev.photos.length) ? '📷' : '', o.ev.notes ? '📝' : '', (o.ev.repeat && o.ev.repeat !== 'none') ? '🔁' : ''].join('');
    return `<div class="ev-row" data-id="${o.ev.id}">
      <div class="ev-row-bar" style="background:${cal.color}"></div>
      <div class="ev-row-main">
        <div class="ev-row-title">${esc(o.ev.title)}</div>
        <div class="ev-row-time">${time} · ${esc(cal.name)}</div>
      </div>
      <div class="ev-row-icons">${icons}</div>
    </div>`;
  }).join('');
  $('dayEventsList').querySelectorAll('.ev-row').forEach(r => {
    r.onclick = () => showDetail(r.dataset.id);
  });
}

// ── 重疊行程並排:回傳每筆的 {col, total}(同時段的行程分欄顯示) ──
function layoutTimed(items) {
  // items: [{s, e, ...}] 依開始時間排序後,重疊的分到不同欄
  items.sort((a, b) => a.s - b.s || b.e - a.e);
  const colEnds = [];   // 每欄目前的結束時間
  let cluster = [];     // 目前重疊群
  let clusterEnd = -Infinity;
  const finalize = () => {
    for (const it of cluster) it.total = colEnds.length;
    cluster = [];
    colEnds.length = 0;
  };
  for (const it of items) {
    if (cluster.length && it.s >= clusterEnd) finalize();
    let col = colEnds.findIndex(end => end <= it.s);
    if (col === -1) { col = colEnds.length; colEnds.push(0); }
    colEnds[col] = it.e;
    it.col = col;
    cluster.push(it);
    clusterEnd = Math.max(clusterEnd, it.e);
  }
  finalize();
  return items;
}

// 產生一天的時間軸行程 HTML(含並排)
function timedEventsHtml(occs, d) {
  const items = occs.map(o => {
    const s = o.start < startOfDay(d) ? startOfDay(d) : o.start;
    const e = o.end > endOfDay(d) ? endOfDay(d) : o.end;
    return { o, s: s.getTime(), e: Math.max(e.getTime(), s.getTime() + 20 * 60000) };
  });
  layoutTimed(items);
  let html = '';
  for (const it of items) {
    const s = new Date(it.s);
    const top = (s.getHours() + s.getMinutes() / 60) * HOUR_H;
    const height = Math.max(20, ((it.e - it.s) / 3600000) * HOUR_H - 2);
    const w = 100 / it.total;
    const timeLabel = sameDay(it.o.start, it.o.end)
      ? `${fmtHM(it.o.start)}${it.total > 2 ? '' : ' - ' + fmtHM(it.o.end)}`
      : fmtHM(it.o.start);
    html += `<div class="tl-event" data-id="${it.o.ev.id}" style="top:${top}px;height:${height}px;left:calc(${it.col * w}% + 2px);width:calc(${w}% - 5px);background:${calById(it.o.ev.calendarId).color}"><b>${esc(it.o.ev.title)}</b>${timeLabel}</div>`;
  }
  return html;
}

// ── 週檢視(垂直時間軸) ──
function renderWeek() {
  const weekStart = startOfWeek(cursor);
  const today = new Date();
  const occs = occurrencesInRange(weekStart, endOfDay(addDays(weekStart, 6)));

  // 全天行程列
  const alldayOccs = occs.filter(o => o.ev.allDay);
  $('weekAllday').innerHTML = alldayOccs.length
    ? `<span class="allday-label">全天</span>` + alldayOccs.map(o =>
        `<span class="allday-chip" data-id="${o.ev.id}" style="background:${calById(o.ev.calendarId).color}">${o.start.getMonth() + 1}/${o.start.getDate()} ${esc(o.ev.title)}</span>`).join('')
    : '';

  // 時間欄
  let gutter = '<div class="time-gutter"><div style="height:52px"></div><div style="position:relative;height:' + (24 * HOUR_H) + 'px">';
  for (let h = 1; h < 24; h++) gutter += `<span class="time-label" style="top:${h * HOUR_H}px">${h}:00</span>`;
  gutter += '</div></div>';

  let cols = '';
  for (let i = 0; i < 7; i++) {
    const d = addDays(weekStart, i);
    const isToday = sameDay(d, today);
    let lines = '';
    for (let h = 1; h < 24; h++) lines += `<div class="hour-line" style="top:${h * HOUR_H}px"></div>`;

    const dayOccs = occs.filter(o => !o.ev.allDay && o.start <= endOfDay(d) && o.end >= startOfDay(d));
    const evHtml = timedEventsHtml(dayOccs, d);

    let nowLine = '';
    if (isToday) {
      const top = (today.getHours() + today.getMinutes() / 60) * HOUR_H;
      nowLine = `<div class="now-line" style="top:${top}px"></div>`;
    }

    cols += `<div class="wcol ${isToday ? 'today-col' : ''}">
      <div class="wcol-head ${isToday ? 'today' : ''}" data-date="${fmtYMD(d)}">${WEEKDAYS[d.getDay()]}<b>${d.getDate()}</b></div>
      <div class="tl-body" data-date="${fmtYMD(d)}" style="position:relative;height:${24 * HOUR_H}px">${lines}${evHtml}${nowLine}</div>
    </div>`;
  }
  $('weekGrid').innerHTML = gutter + cols;

  $('weekGrid').querySelectorAll('.tl-event, .allday-chip').forEach(el => {
    el.onclick = () => showDetail(el.dataset.id);
  });
  $('weekAllday').querySelectorAll('.allday-chip').forEach(el => {
    el.onclick = () => showDetail(el.dataset.id);
  });
  $('weekGrid').querySelectorAll('.wcol-head').forEach(el => {
    el.onclick = () => {
      const [y, m, dd] = el.dataset.date.split('-').map(Number);
      cursor = new Date(y, m - 1, dd);
      selectedDay = new Date(cursor);
      setView('day');
    };
  });
  bindEmptySlotTap($('weekGrid'));

  // 捲到早上 7 點,並水平捲到目前檢視的日子
  requestAnimationFrame(() => {
    const sc = $('weekScroll');
    sc.scrollTop = 7 * HOUR_H;
    const focusIdx = Math.round((startOfDay(cursor) - weekStart) / 86400000);
    const col = sc.querySelectorAll('.wcol')[focusIdx];
    if (col && col.offsetLeft + col.offsetWidth > sc.clientWidth + sc.scrollLeft) {
      sc.scrollLeft = col.offsetLeft - 44;
    }
  });
}

// ── 日檢視 ──
function renderDay() {
  const d = cursor;
  const today = new Date();
  const occs = occurrencesOnDay(d);

  const alldayOccs = occs.filter(o => o.ev.allDay);
  $('dayAllday').innerHTML = alldayOccs.length
    ? `<span class="allday-label">全天</span>` + alldayOccs.map(o =>
        `<span class="allday-chip" data-id="${o.ev.id}" style="background:${calById(o.ev.calendarId).color}">${esc(o.ev.title)}</span>`).join('')
    : '';

  let lines = '';
  for (let h = 1; h < 24; h++) {
    lines += `<div class="hour-line" style="top:${h * HOUR_H}px"></div><span class="time-label" style="top:${h * HOUR_H}px;left:2px;right:auto">${h}:00</span>`;
  }

  const evHtml = timedEventsHtml(occs.filter(o => !o.ev.allDay), d);

  let nowLine = '';
  if (sameDay(d, today)) {
    const top = (today.getHours() + today.getMinutes() / 60) * HOUR_H;
    nowLine = `<div class="now-line" style="top:${top}px;left:44px"></div>`;
  }

  $('dayGrid').innerHTML = `<div style="position:relative;height:${24 * HOUR_H}px;margin-right:8px">${lines}
    <div class="tl-body" data-date="${fmtYMD(d)}" style="position:absolute;left:52px;right:0;top:0;height:100%">${evHtml}</div>${nowLine}</div>`;
  $('dayGrid').querySelectorAll('.tl-event').forEach(el => { el.onclick = () => showDetail(el.dataset.id); });
  $('dayAllday').querySelectorAll('.allday-chip').forEach(el => { el.onclick = () => showDetail(el.dataset.id); });
  bindEmptySlotTap($('dayGrid'));
  requestAnimationFrame(() => { $('dayScroll').scrollTop = 7 * HOUR_H; });
}

// 點時間軸空白處 → 新增該時段行程
function bindEmptySlotTap(root) {
  root.querySelectorAll('.tl-body').forEach(body => {
    body.onclick = (e) => {
      if (e.target !== body && !e.target.classList.contains('hour-line')) return;
      const rect = body.getBoundingClientRect();
      const hour = Math.min(23, Math.max(0, Math.floor((e.clientY - rect.top) / HOUR_H)));
      const [y, m, dd] = body.dataset.date.split('-').map(Number);
      openEventForm(null, { date: new Date(y, m - 1, dd), hour });
    };
  });
}

// ── 檢視切換 ──
function setView(v) {
  view = v;
  document.querySelectorAll('.view-tab').forEach(t => t.classList.toggle('active', t.dataset.view === v));
  document.querySelectorAll('.view').forEach(s => s.classList.remove('active'));
  $('view' + v[0].toUpperCase() + v.slice(1)).classList.add('active');
  render();
}

function navigate(dir) {
  if (view === 'month') { cursor = new Date(cursor.getFullYear(), cursor.getMonth() + dir, 1); }
  else if (view === 'week') { cursor = addDays(cursor, dir * 7); }
  else { cursor = addDays(cursor, dir); selectedDay = new Date(cursor); }
  render();
}

// ── 行程詳情 ──
async function showDetail(id) {
  const ev = events.find(e => e.id === id);
  if (!ev) return;
  const cal = calById(ev.calendarId);
  const s = new Date(ev.start), e = new Date(ev.end);
  const timeStr = ev.allDay
    ? `${s.getMonth() + 1}月${s.getDate()}日` + (sameDay(s, e) ? '' : ` - ${e.getMonth() + 1}月${e.getDate()}日`) + ' · 全天'
    : `${s.getMonth() + 1}月${s.getDate()}日 ${fmtHM(s)} - ` + (sameDay(s, e) ? '' : `${e.getMonth() + 1}月${e.getDate()}日 `) + fmtHM(e);
  const repeatStr = { daily: '每天重複', weekly: '每週重複', monthly: '每月重複', yearly: '每年重複' }[ev.repeat] || '';

  let photosHtml = '';
  if (ev.photos && ev.photos.length) {
    const imgs = [];
    for (const pid of ev.photos) {
      const p = await db.get('photos', pid);
      if (p) imgs.push(`<img src="${p.data}" alt="照片">`);
    }
    if (imgs.length) photosHtml = `<div class="detail-photos">${imgs.join('')}</div>`;
  }

  $('detailBody').innerHTML = `
    <div class="detail-title">${esc(ev.title)}<span class="detail-cal" style="background:${cal.color}">${esc(cal.name)}</span></div>
    <div class="detail-time">${timeStr}${repeatStr ? ' · 🔁 ' + repeatStr : ''}${ev.reminder !== null && ev.reminder !== undefined && ev.reminder !== '' ? ' · 🔔' : ''}</div>
    ${ev.notes ? `<div class="detail-notes">${esc(ev.notes)}</div>` : ''}
    ${photosHtml}
    <div class="detail-actions">
      <button class="detail-close" id="btnDetailClose">關閉</button>
      <button class="detail-edit" id="btnDetailEdit">編輯</button>
    </div>`;
  $('detailBackdrop').classList.add('open');
  $('btnDetailClose').onclick = () => $('detailBackdrop').classList.remove('open');
  $('btnDetailEdit').onclick = () => {
    $('detailBackdrop').classList.remove('open');
    openEventForm(ev);
  };
}

// ── 行程表單 ──
async function openEventForm(ev = null, preset = null) {
  editingEvent = ev;
  editingPhotos = [];
  $('eventSheetTitle').textContent = ev ? '編輯行程' : '新增行程';
  $('btnEventDelete').hidden = !ev;

  const activeCals = calendars.filter(c => !c.deleted);
  const base = ev || {};
  const defCalId = base.calendarId || (activeCals[0] && activeCals[0].id);

  $('calPicker').innerHTML = activeCals.map(c =>
    `<span class="cal-opt ${c.id === defCalId ? 'sel' : ''}" data-id="${c.id}"><span class="cal-dot" style="background:${c.color}"></span>${esc(c.name)}</span>`).join('');
  $('calPicker').querySelectorAll('.cal-opt').forEach(o => {
    o.onclick = () => {
      $('calPicker').querySelectorAll('.cal-opt').forEach(x => x.classList.remove('sel'));
      o.classList.add('sel');
    };
  });

  $('evTitle').value = base.title || '';
  $('evAllDay').checked = !!base.allDay;

  let s, e;
  if (ev) { s = new Date(ev.start); e = new Date(ev.end); }
  else {
    s = new Date((preset && preset.date) || selectedDay);
    if (preset && preset.hour !== undefined) s.setHours(preset.hour, 0, 0, 0);
    else { const now = new Date(); s.setHours(now.getHours() + 1, 0, 0, 0); }
    e = new Date(s.getTime() + 3600000);
  }
  $('evStartDate').value = fmtYMD(s);
  $('evStartTime').value = fmtHM(s);
  $('evEndDate').value = fmtYMD(e);
  $('evEndTime').value = fmtHM(e);
  toggleTimeInputs();

  $('evRepeat').value = base.repeat || 'none';
  $('evReminder').value = (base.reminder === null || base.reminder === undefined) ? '' : String(base.reminder);
  $('evNotes').value = base.notes || '';

  if (ev && ev.photos) {
    for (const pid of ev.photos) {
      const p = await db.get('photos', pid);
      if (p) editingPhotos.push(p);
    }
  }
  renderPhotoStrip();

  $('eventSheetBackdrop').classList.add('open');
  if (!ev) setTimeout(() => $('evTitle').focus(), 250);
}

function toggleTimeInputs() {
  const allDay = $('evAllDay').checked;
  $('evStartTime').style.display = allDay ? 'none' : '';
  $('evEndTime').style.display = allDay ? 'none' : '';
}

function renderPhotoStrip() {
  const strip = $('photoStrip');
  strip.querySelectorAll('.photo-wrap').forEach(x => x.remove());
  const addBtn = strip.querySelector('.photo-add');
  for (const p of editingPhotos) {
    const wrap = document.createElement('div');
    wrap.className = 'photo-wrap';
    wrap.innerHTML = `<img class="photo-thumb" src="${p.data}"><button class="photo-del">✕</button>`;
    wrap.querySelector('.photo-del').onclick = () => {
      editingPhotos = editingPhotos.filter(x => x.id !== p.id);
      renderPhotoStrip();
    };
    strip.insertBefore(wrap, addBtn);
  }
}

// 照片壓縮:縮到長邊 1280px 的 JPEG
function compressImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const MAX = 1280;
      let { width: w, height: h } = img;
      if (Math.max(w, h) > MAX) { const r = MAX / Math.max(w, h); w = Math.round(w * r); h = Math.round(h * r); }
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL('image/jpeg', 0.8));
    };
    img.onerror = reject;
    img.src = url;
  });
}

async function saveEvent() {
  const title = $('evTitle').value.trim();
  if (!title) { toast('請輸入標題'); return; }
  const selCal = $('calPicker').querySelector('.cal-opt.sel');
  const calendarId = selCal ? selCal.dataset.id : calendars[0].id;
  const allDay = $('evAllDay').checked;

  const s = new Date(`${$('evStartDate').value}T${allDay ? '00:00' : $('evStartTime').value || '00:00'}`);
  let e = new Date(`${$('evEndDate').value}T${allDay ? '23:59' : $('evEndTime').value || '00:00'}`);
  if (isNaN(s) || isNaN(e)) { toast('日期格式不正確'); return; }
  if (e < s) { e = allDay ? endOfDay(s) : new Date(s.getTime() + 3600000); }

  // 儲存照片
  const photoIds = [];
  for (const p of editingPhotos) {
    await db.put('photos', p);
    photoIds.push(p.id);
  }
  // 移除被刪掉的舊照片
  if (editingEvent && editingEvent.photos) {
    for (const pid of editingEvent.photos) {
      if (!photoIds.includes(pid)) await db.del('photos', pid);
    }
  }

  const reminderVal = $('evReminder').value;
  const ev = {
    id: editingEvent ? editingEvent.id : db.uid(),
    calendarId,
    title,
    allDay,
    start: s.toISOString(),
    end: e.toISOString(),
    repeat: $('evRepeat').value,
    reminder: reminderVal === '' ? null : Number(reminderVal),
    notes: $('evNotes').value.trim(),
    photos: photoIds,
    deleted: false,
    updatedAt: Date.now(),
  };
  await db.put('events', ev);
  events = await db.getAll('events');
  sync.pushEvent(ev);
  closeEventForm();
  render();
  toast(editingEvent ? '已更新' : '已新增行程 ✅');
}

async function deleteEvent() {
  if (!editingEvent) return;
  if (!confirm('確定刪除這個行程?')) return;
  const ev = { ...editingEvent, deleted: true, updatedAt: Date.now() };
  await db.put('events', ev);
  if (ev.photos) for (const pid of ev.photos) await db.del('photos', pid);
  events = await db.getAll('events');
  sync.pushEvent(ev);
  closeEventForm();
  render();
  toast('已刪除');
}

function closeEventForm() {
  $('eventSheetBackdrop').classList.remove('open');
  editingEvent = null;
  editingPhotos = [];
}

// ── 設定頁 ──
function renderSettings() {
  const list = $('calList');
  const activeCals = calendars.filter(c => !c.deleted);
  list.innerHTML = activeCals.map(c => {
    const count = events.filter(e => !e.deleted && e.calendarId === c.id).length;
    return `<div class="cal-item" data-id="${c.id}">
      <span class="cal-item-dot" style="background:${c.color};opacity:${c.hidden ? .3 : 1}"></span>
      <span class="cal-item-name" style="${c.hidden ? 'text-decoration:line-through;opacity:.5' : ''}">${esc(c.name)}</span>
      <span class="cal-item-count">${count} 個行程</span>
      <button class="icon-btn cal-toggle" data-id="${c.id}">${c.hidden ? '顯示' : '隱藏'}</button>
    </div>`;
  }).join('');
  list.querySelectorAll('.cal-item').forEach(item => {
    item.onclick = (e) => {
      if (e.target.classList.contains('cal-toggle')) return;
      openCalForm(calendars.find(c => c.id === item.dataset.id));
    };
  });
  list.querySelectorAll('.cal-toggle').forEach(btn => {
    btn.onclick = async () => {
      const cal = calendars.find(c => c.id === btn.dataset.id);
      cal.hidden = !cal.hidden;
      cal.updatedAt = Date.now();
      await db.put('calendars', cal);
      renderSettings();
      render();
    };
  });

  // 通知狀態
  if ('Notification' in window && Notification.permission === 'granted') {
    $('btnNotifyPerm').textContent = '✅ 通知已開啟';
  }
  sync.renderStatus();
}

function openCalForm(cal = null) {
  editingCal = cal;
  calFormColor = cal ? cal.color : PALETTE[Math.floor(Math.random() * PALETTE.length)];
  $('calSheetTitle').textContent = cal ? '編輯行事曆' : '新增行事曆';
  $('calName').value = cal ? cal.name : '';
  $('btnCalDelete').hidden = !cal || calendars.filter(c => !c.deleted).length <= 1;
  $('colorPalette').innerHTML = PALETTE.map(c =>
    `<span class="color-swatch ${c === calFormColor ? 'sel' : ''}" data-color="${c}" style="background:${c}"></span>`).join('');
  $('colorPalette').querySelectorAll('.color-swatch').forEach(s => {
    s.onclick = () => {
      calFormColor = s.dataset.color;
      $('colorPalette').querySelectorAll('.color-swatch').forEach(x => x.classList.remove('sel'));
      s.classList.add('sel');
    };
  });
  $('calSheetBackdrop').classList.add('open');
}

async function saveCal() {
  const name = $('calName').value.trim();
  if (!name) { toast('請輸入名稱'); return; }
  const cal = editingCal
    ? { ...editingCal, name, color: calFormColor, updatedAt: Date.now() }
    : { id: db.uid(), name, color: calFormColor, hidden: false, deleted: false, updatedAt: Date.now() };
  await db.put('calendars', cal);
  calendars = await db.getAll('calendars');
  sync.pushCalendar(cal);
  $('calSheetBackdrop').classList.remove('open');
  renderSettings();
  render();
}

async function deleteCal() {
  if (!editingCal) return;
  if (!confirm(`刪除「${editingCal.name}」?裡面的行程會一併刪除。`)) return;
  const cal = { ...editingCal, deleted: true, updatedAt: Date.now() };
  await db.put('calendars', cal);
  for (const ev of events.filter(e => e.calendarId === cal.id && !e.deleted)) {
    const dead = { ...ev, deleted: true, updatedAt: Date.now() };
    await db.put('events', dead);
    sync.pushEvent(dead);
  }
  calendars = await db.getAll('calendars');
  events = await db.getAll('events');
  sync.pushCalendar(cal);
  $('calSheetBackdrop').classList.remove('open');
  renderSettings();
  render();
}

// ── 時鐘:每分鐘更新「現在時間」紅線;切回 App 時重新整理 ──
function startClock() {
  setInterval(() => {
    const now = new Date();
    const top = (now.getHours() + now.getMinutes() / 60) * HOUR_H;
    document.querySelectorAll('.now-line').forEach(el => { el.style.top = top + 'px'; });
  }, 60000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) render(); });
}

// ── 提醒(App 開啟時的本地通知) ──
const notified = new Set();
function startReminderLoop() {
  setInterval(checkReminders, 30000);
  checkReminders();
}
function checkReminders() {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const now = Date.now();
  const soon = occurrencesInRange(new Date(now - 60000), new Date(now + 26 * 3600000));
  for (const o of soon) {
    if (o.ev.reminder === null || o.ev.reminder === undefined) continue;
    const fireAt = o.start.getTime() - o.ev.reminder * 60000;
    const key = o.ev.id + '|' + o.start.getTime();
    if (fireAt <= now && fireAt > now - 90000 && !notified.has(key)) {
      notified.add(key);
      const timeStr = o.ev.allDay ? '今天' : fmtHM(o.start);
      try {
        if (navigator.serviceWorker && navigator.serviceWorker.ready) {
          navigator.serviceWorker.ready.then(reg =>
            reg.showNotification('📅 ' + o.ev.title, { body: `${timeStr} · ${calById(o.ev.calendarId).name}`, tag: key }));
        } else {
          new Notification('📅 ' + o.ev.title, { body: `${timeStr} · ${calById(o.ev.calendarId).name}` });
        }
      } catch (e) { /* 通知失敗不影響主流程 */ }
    }
  }
}

// ── 匯出 / 匯入 ──
async function exportData() {
  const photos = await db.getAll('photos');
  const data = { app: 'paixiaqu', version: 1, exportedAt: new Date().toISOString(), calendars, events, photos };
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `排下去備份-${fmtYMD(new Date())}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast('備份已下載');
}

async function importData(file) {
  try {
    const data = JSON.parse(await file.text());
    if (data.app !== 'paixiaqu') { toast('這不是排下去的備份檔'); return; }
    if (!confirm(`匯入 ${data.calendars.length} 本行事曆、${data.events.length} 個行程?(與現有資料合併)`)) return;
    for (const c of data.calendars) await db.put('calendars', c);
    for (const e of data.events) await db.put('events', e);
    for (const p of (data.photos || [])) await db.put('photos', p);
    calendars = await db.getAll('calendars');
    events = await db.getAll('events');
    render();
    renderSettings();
    toast('匯入完成 ✅');
  } catch (e) {
    toast('匯入失敗:' + e.message);
  }
}

// ── Service Worker ──
function registerSW() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

// ── 工具 ──
function esc(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ── 事件綁定 ──
function bindUI() {
  document.querySelectorAll('.view-tab').forEach(t => t.onclick = () => setView(t.dataset.view));
  $('btnPrev').onclick = () => navigate(-1);
  $('btnNext').onclick = () => navigate(1);
  $('btnToday').onclick = () => { cursor = new Date(); selectedDay = new Date(); render(); };
  $('btnAdd').onclick = () => {
    if (view !== 'month') selectedDay = new Date(cursor);
    openEventForm();
  };

  $('btnEventCancel').onclick = closeEventForm;
  $('btnEventSave').onclick = saveEvent;
  $('btnEventDelete').onclick = deleteEvent;
  $('evAllDay').onchange = toggleTimeInputs;
  $('evStartDate').onchange = () => {
    // 開始日期改變時,結束日期跟著調整
    if ($('evEndDate').value < $('evStartDate').value) $('evEndDate').value = $('evStartDate').value;
  };
  $('evPhotoInput').onchange = async (e) => {
    for (const f of e.target.files) {
      try {
        const data = await compressImage(f);
        editingPhotos.push({ id: db.uid(), data, updatedAt: Date.now() });
      } catch { toast('照片讀取失敗'); }
    }
    e.target.value = '';
    renderPhotoStrip();
  };

  $('btnSettings').onclick = () => { renderSettings(); $('settingsPage').classList.add('open'); };
  $('btnSettingsBack').onclick = () => $('settingsPage').classList.remove('open');
  $('btnAddCal').onclick = () => openCalForm();
  $('btnCalCancel').onclick = () => $('calSheetBackdrop').classList.remove('open');
  $('btnCalSave').onclick = saveCal;
  $('btnCalDelete').onclick = deleteCal;

  $('btnNotifyPerm').onclick = async () => {
    if (!('Notification' in window)) { toast('此瀏覽器不支援通知'); return; }
    const perm = await Notification.requestPermission();
    if (perm === 'granted') { toast('通知已開啟 🔔'); renderSettings(); }
    else toast('通知未開啟');
  };

  $('btnExport').onclick = exportData;
  $('importInput').onchange = (e) => { if (e.target.files[0]) importData(e.target.files[0]); e.target.value = ''; };

  // 點背景關閉 sheet(開啟後 300ms 內忽略,避免點擊穿透)
  for (const id of ['eventSheetBackdrop', 'detailBackdrop', 'calSheetBackdrop']) {
    const el = $(id);
    let openedAt = 0;
    new MutationObserver(() => { if (el.classList.contains('open')) openedAt = Date.now(); })
      .observe(el, { attributes: true, attributeFilter: ['class'] });
    el.addEventListener('click', (e) => {
      if (e.target === el && Date.now() - openedAt > 300) el.classList.remove('open');
    });
  }

  // 左右滑動換月/週/日
  let touchX = null, touchY = null;
  document.addEventListener('touchstart', (e) => {
    if (e.target.closest('.sheet, .page, .week-scroll')) { touchX = null; return; }
    touchX = e.touches[0].clientX; touchY = e.touches[0].clientY;
  }, { passive: true });
  document.addEventListener('touchend', (e) => {
    if (touchX === null) return;
    const dx = e.changedTouches[0].clientX - touchX;
    const dy = e.changedTouches[0].clientY - touchY;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) navigate(dx < 0 ? 1 : -1);
    touchX = null;
  }, { passive: true });
}

init();
