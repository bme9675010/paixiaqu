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
let editingOccStart = null;   // 編輯中的重複行程「這一次」的開始時間 (ms)
let editingPhotos = [];       // 編輯中的照片 [{id, data}]
let editingCal = null;        // 編輯中的行事曆
let calFormColor = PALETTE[0];
let todos = [];
let unsubDetailComments = null; // 行程詳情開啟中的留言即時監聽

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
    // 從行程開始日往後展開到範圍結束(上限 500 次防呆;跳過已排除的單次)
    const exdates = ev.exdates || [];
    let cur = new Date(evStart);
    for (let i = 0; i < 500 && cur <= rangeEnd; i++) {
      const occEnd = new Date(cur.getTime() + durMs);
      if (occEnd >= rangeStart && !exdates.includes(fmtYMD(cur))) out.push({ ev, start: new Date(cur), end: occEnd });
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
  todos = await db.getAll('todos');

  bindUI();
  render();
  registerSW();
  startReminderLoop();
  startClock();
  sync.init({
    onRemoteChange: async () => {
      calendars = await db.getAll('calendars');
      events = await db.getAll('events');
      todos = await db.getAll('todos');
      render();
      renderSettings();
      renderTodoList();
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
    const lunar = holiday ? '' : lunarDayLabel(d);
    const holHtml = holiday
      ? `<div class="mcell-holname">${holiday}</div>`
      : (lunar ? `<div class="mcell-lunar">${lunar}</div>` : '');
    const maxChips = holHtml ? 2 : 3;
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
  const lunar = lunarFullLabel(d);
  const hol = HOLIDAYS[fmtYMD(d)];
  $('dayEventsHeader').textContent = `${d.getMonth() + 1}月${d.getDate()}日 (${WEEKDAYS[d.getDay()]})`
    + (lunar ? ` · ${lunar}` : '') + (hol ? ` · ${hol} 🎉` : '');
  const occs = occurrencesOnDay(d);
  if (!occs.length) {
    $('dayEventsList').innerHTML = `<div class="empty-hint">沒有行程,按「＋」新增</div>`;
    return;
  }
  $('dayEventsList').innerHTML = occs.map(o => {
    const cal = calById(o.ev.calendarId);
    const time = o.ev.allDay ? '全天' : `${fmtHM(o.start)} - ${fmtHM(o.end)}`;
    const icons = [(o.ev.photos && o.ev.photos.length) ? '📎' : '', o.ev.url ? '🔗' : '', o.ev.notes ? '📝' : '', (o.ev.repeat && o.ev.repeat !== 'none') ? '🔁' : ''].join('');
    return `<div class="ev-row" data-id="${o.ev.id}" data-occ="${o.start.getTime()}">
      <div class="ev-row-bar" style="background:${cal.color}"></div>
      <div class="ev-row-main">
        <div class="ev-row-title">${esc(o.ev.title)}</div>
        <div class="ev-row-time">${time} · ${esc(cal.name)}</div>
      </div>
      <div class="ev-row-icons">${icons}</div>
    </div>`;
  }).join('');
  $('dayEventsList').querySelectorAll('.ev-row').forEach(r => {
    r.onclick = () => showDetail(r.dataset.id, +r.dataset.occ);
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
    html += `<div class="tl-event" data-id="${it.o.ev.id}" data-occ="${it.o.start.getTime()}" style="top:${top}px;height:${height}px;left:calc(${it.col * w}% + 2px);width:calc(${w}% - 5px);background:${calById(it.o.ev.calendarId).color}"><b>${esc(it.o.ev.title)}</b><span class="tl-time">${timeLabel}</span></div>`;
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
        `<span class="allday-chip" data-id="${o.ev.id}" data-occ="${o.start.getTime()}" style="background:${calById(o.ev.calendarId).color}">${o.start.getMonth() + 1}/${o.start.getDate()} ${esc(o.ev.title)}</span>`).join('')
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

    const wkCls = d.getDay() === 0 ? 'sun-col' : d.getDay() === 6 ? 'sat-col' : '';
    cols += `<div class="wcol ${isToday ? 'today-col' : wkCls}">
      <div class="wcol-head ${isToday ? 'today' : ''}" data-date="${fmtYMD(d)}">${WEEKDAYS[d.getDay()]}<b>${d.getDate()}</b></div>
      <div class="tl-body" data-date="${fmtYMD(d)}" style="position:relative;height:${24 * HOUR_H}px">${lines}${evHtml}${nowLine}</div>
    </div>`;
  }
  $('weekGrid').innerHTML = gutter + cols;

  $('weekGrid').querySelectorAll('.tl-event, .allday-chip').forEach(el => {
    el.onclick = () => showDetail(el.dataset.id, +el.dataset.occ);
  });
  $('weekAllday').querySelectorAll('.allday-chip').forEach(el => {
    el.onclick = () => showDetail(el.dataset.id, +el.dataset.occ);
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
  bindDragReschedule($('weekGrid'));

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
        `<span class="allday-chip" data-id="${o.ev.id}" data-occ="${o.start.getTime()}" style="background:${calById(o.ev.calendarId).color}">${esc(o.ev.title)}</span>`).join('')
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
  $('dayGrid').querySelectorAll('.tl-event').forEach(el => { el.onclick = () => showDetail(el.dataset.id, +el.dataset.occ); });
  $('dayAllday').querySelectorAll('.allday-chip').forEach(el => { el.onclick = () => showDetail(el.dataset.id, +el.dataset.occ); });
  bindEmptySlotTap($('dayGrid'));
  bindDragReschedule($('dayGrid'));
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

// 長按拖曳行程改變時間(週/日檢視,同一天內垂直拖動,15 分鐘為單位)
function bindDragReschedule(root) {
  const LONG_PRESS_MS = 350;
  const MOVE_CANCEL_PX = 8;
  const SNAP_PX = HOUR_H / 4; // 15 分鐘

  root.querySelectorAll('.tl-event').forEach(el => {
    const body = el.closest('.tl-body');
    if (!body) return;
    let timer = null, dragging = false, startY = 0, startTop = 0, moved = false, justDragged = false;

    const endDrag = () => {
      clearTimeout(timer);
      timer = null;
      if (dragging) {
        el.classList.remove('dragging');
        const badge = document.getElementById('dragTimeBadge');
        if (badge) badge.remove();
      }
      dragging = false;
    };

    el.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1) return;
      startY = e.touches[0].clientY;
      startTop = parseFloat(el.style.top) || 0;
      moved = false;
      timer = setTimeout(() => {
        dragging = true;
        el.classList.add('dragging');
        if (navigator.vibrate) navigator.vibrate(15);
      }, LONG_PRESS_MS);
    }, { passive: true });

    el.addEventListener('touchmove', (e) => {
      const dy = e.touches[0].clientY - startY;
      if (!dragging) {
        if (Math.abs(dy) > MOVE_CANCEL_PX) { clearTimeout(timer); timer = null; }
        return;
      }
      e.preventDefault();
      moved = true;
      let newTop = startTop + dy;
      newTop = Math.round(newTop / SNAP_PX) * SNAP_PX;
      newTop = Math.max(0, Math.min(body.offsetHeight - el.offsetHeight, newTop));
      el.style.top = newTop + 'px';
      const mins = Math.round(newTop / HOUR_H * 60);
      let badge = document.getElementById('dragTimeBadge');
      if (!badge) {
        badge = document.createElement('div');
        badge.id = 'dragTimeBadge';
        badge.className = 'drag-time-badge';
        document.body.appendChild(badge);
      }
      badge.textContent = `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
      const rect = el.getBoundingClientRect();
      badge.style.left = Math.min(window.innerWidth - 60, rect.right + 8) + 'px';
      badge.style.top = rect.top + 'px';
    }, { passive: false });

    el.addEventListener('touchend', async () => {
      const wasDragging = dragging, wasMoved = moved;
      justDragged = wasDragging && wasMoved;
      endDrag();
      if (!wasDragging || !wasMoved) return;
      const newTop = parseFloat(el.style.top);
      const newMinutesOfDay = Math.round(newTop / HOUR_H * 60);
      await rescheduleEvent(el.dataset.id, +el.dataset.occ, newMinutesOfDay);
    });
    el.addEventListener('touchcancel', endDrag);

    // 拖曳結束後緊接著的那次 click 要吃掉,避免誤開詳情頁
    el.addEventListener('click', (e) => {
      if (justDragged) { e.preventDefault(); e.stopImmediatePropagation(); justDragged = false; }
    }, true);
  });
}

async function rescheduleEvent(id, occMs, newMinutesOfDay) {
  const ev = events.find(e => e.id === id);
  if (!ev) { render(); return; }
  const durMs = new Date(ev.end) - new Date(ev.start);
  const oldStart = new Date(occMs);
  const newStart = new Date(oldStart);
  newStart.setHours(Math.floor(newMinutesOfDay / 60), newMinutesOfDay % 60, 0, 0);
  if (newStart.getTime() === oldStart.getTime()) { render(); return; }
  const newEnd = new Date(newStart.getTime() + durMs);

  const isRepeating = ev.repeat && ev.repeat !== 'none';
  if (isRepeating) {
    const scope = await choose('這是重複行程', ['只改這一次', '改變所有重複的時間']);
    if (!scope) { render(); return; }
    if (scope === '只改這一次') {
      const orig = { ...ev, exdates: [...(ev.exdates || []), fmtYMD(oldStart)], updatedAt: Date.now() };
      const single = {
        id: db.uid(), calendarId: ev.calendarId, title: ev.title, allDay: false,
        start: newStart.toISOString(), end: newEnd.toISOString(),
        repeat: 'none', exdates: [], reminder: ev.reminder, reminder2: ev.reminder2 ?? null,
        url: ev.url || '', notes: ev.notes || '', photos: ev.photos || [],
        createdBy: ev.createdBy || sync.getUid(), attendees: ev.attendees || [],
        deleted: false, updatedAt: Date.now(),
      };
      await db.put('events', orig);
      await db.put('events', single);
      events = await db.getAll('events');
      sync.pushEvent(orig);
      sync.pushEvent(single);
      toast('已調整這一次的時間 ✅');
    } else {
      const origStart = new Date(ev.start);
      origStart.setHours(newStart.getHours(), newStart.getMinutes(), 0, 0);
      const origEnd = new Date(origStart.getTime() + durMs);
      const updated = { ...ev, start: origStart.toISOString(), end: origEnd.toISOString(), updatedAt: Date.now() };
      await db.put('events', updated);
      events = await db.getAll('events');
      sync.pushEvent(updated);
      toast('已調整所有重複的時間 ✅');
    }
  } else {
    const updated = { ...ev, start: newStart.toISOString(), end: newEnd.toISOString(), updatedAt: Date.now() };
    await db.put('events', updated);
    events = await db.getAll('events');
    sync.pushEvent(updated);
    toast('時間已更新 ✅');
  }
  render();
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

// ── 通用選項對話框 ──
function choose(title, options) {
  return new Promise(resolve => {
    const bd = document.createElement('div');
    bd.className = 'sheet-backdrop open';
    bd.style.zIndex = '150';
    bd.innerHTML = `<div class="sheet sheet-auto"><div class="sheet-handle"></div><div class="sheet-body">
      <div style="text-align:center;font-weight:700;margin-bottom:12px">${esc(title)}</div>
      ${options.map((o, i) => `<button class="outline-btn" data-i="${i}">${esc(o)}</button>`).join('')}
    </div></div>`;
    document.body.appendChild(bd);
    bd.querySelectorAll('.outline-btn').forEach(b => b.onclick = () => { bd.remove(); resolve(options[+b.dataset.i]); });
    bd.addEventListener('click', e => { if (e.target === bd) { bd.remove(); resolve(null); } });
  });
}

// ── 行程詳情 ──
function closeDetail() {
  if (unsubDetailComments) { unsubDetailComments(); unsubDetailComments = null; }
  $('detailBackdrop').classList.remove('open');
}

function renderComments(comments) {
  const list = $('commentsList');
  if (!list) return; // 詳情可能已經關閉
  const myUid = sync.getUid();
  list.innerHTML = comments.length ? comments.map(c => `
    <div class="comment-row">
      <div class="comment-avatar">${esc((c.name || '?').slice(0, 1))}</div>
      <div class="comment-body">
        <div class="comment-name">${esc(c.name || '家人')}</div>
        <div class="comment-text">${esc(c.text)}</div>
      </div>
      ${c.uid === myUid ? `<button class="comment-del" data-id="${c.id}">✕</button>` : ''}
    </div>`).join('') : '<div class="empty-hint" style="padding:6px 0">還沒有留言,說句話吧</div>';
}

async function showDetail(id, occMs) {
  const ev = events.find(e => e.id === id);
  if (!ev) return;
  closeDetail();
  const cal = calById(ev.calendarId);
  const durMs = new Date(ev.end) - new Date(ev.start);
  const s = occMs ? new Date(occMs) : new Date(ev.start);
  const e = occMs ? new Date(occMs + durMs) : new Date(ev.end);
  const timeStr = ev.allDay
    ? `${s.getMonth() + 1}月${s.getDate()}日` + (sameDay(s, e) ? '' : ` - ${e.getMonth() + 1}月${e.getDate()}日`) + ' · 全天'
    : `${s.getMonth() + 1}月${s.getDate()}日 ${fmtHM(s)} - ` + (sameDay(s, e) ? '' : `${e.getMonth() + 1}月${e.getDate()}日 `) + fmtHM(e);
  const repeatStr = { daily: '每天重複', weekly: '每週重複', monthly: '每月重複', yearly: '每年重複' }[ev.repeat] || '';

  let photosHtml = '';
  if (ev.photos && ev.photos.length) {
    const items = [];
    for (const pid of ev.photos) {
      const p = await db.get('photos', pid);
      if (!p) continue;
      if (isImageAttachment(p)) items.push(`<img src="${p.data}" alt="照片">`);
      else items.push(`<a class="link-row" href="${p.data}" target="_blank" rel="noopener">📄 <span>${esc(p.name || '檔案')}</span></a>`);
    }
    if (items.length) photosHtml = `<div class="detail-photos">${items.join('')}</div>`;
  }
  const urlHtml = ev.url ? `<a class="link-row" href="${esc(ev.url)}" target="_blank" rel="noopener">🔗 <span>${esc(ev.url)}</span></a>` : '';

  const cloudOn = sync.cloudActive();
  const myUid = sync.getUid();
  const attendees = ev.attendees || [];
  const iAmIn = myUid && attendees.includes(myUid);
  const creatorHtml = (cloudOn && ev.createdBy) ? `<div class="detail-meta">由 ${esc(sync.getMemberName(ev.createdBy))} 建立</div>` : '';
  const attendeeHtml = cloudOn ? `
    <div class="attendee-chips">
      ${attendees.map(uid => `<span class="attendee-chip">${esc(sync.getMemberName(uid))}</span>`).join('')}
      <button class="attendee-toggle ${iAmIn ? 'joined' : ''}" id="btnToggleAttend">${iAmIn ? '✓ 我會參加' : '＋ 我要參加'}</button>
    </div>` : '';
  const commentsHtml = cloudOn ? `
    <div class="comments-section">
      <div class="comments-title">💬 留言</div>
      <div id="commentsList"></div>
      <div class="comment-input-row">
        <input type="text" id="commentInput" placeholder="寫留言…">
        <button class="comment-send" id="btnCommentSend">➤</button>
      </div>
    </div>` : '';

  $('detailBody').innerHTML = `
    <div class="detail-title">${esc(ev.title)}<span class="detail-cal" style="background:${cal.color}">${esc(cal.name)}</span></div>
    <div class="detail-time">${timeStr}${repeatStr ? ' · 🔁 ' + repeatStr : ''}${ev.reminder !== null && ev.reminder !== undefined && ev.reminder !== '' ? ' · 🔔' : ''}</div>
    ${creatorHtml}
    ${urlHtml}
    ${ev.notes ? `<div class="detail-notes">${esc(ev.notes)}</div>` : ''}
    ${photosHtml}
    ${attendeeHtml}
    <div class="detail-actions">
      <button class="detail-close" id="btnDetailClose">關閉</button>
      <button class="detail-edit" id="btnDetailEdit">編輯</button>
    </div>
    ${commentsHtml}`;
  $('detailBackdrop').classList.add('open');
  $('btnDetailClose').onclick = closeDetail;
  $('btnDetailEdit').onclick = () => {
    closeDetail();
    openEventForm(ev, null, occMs);
  };

  if (cloudOn) {
    $('btnToggleAttend').onclick = async () => {
      const idx = attendees.indexOf(myUid);
      if (idx === -1) attendees.push(myUid); else attendees.splice(idx, 1);
      const updated = { ...ev, attendees: [...attendees], updatedAt: Date.now() };
      await db.put('events', updated);
      events = await db.getAll('events');
      sync.pushEvent(updated);
      showDetail(id, occMs);
    };
    unsubDetailComments = sync.listenComments(ev.id, renderComments);
    const sendComment = () => {
      const text = $('commentInput').value.trim();
      if (!text) return;
      sync.postComment(ev.id, text);
      $('commentInput').value = '';
    };
    $('btnCommentSend').onclick = sendComment;
    $('commentInput').onkeydown = (e2) => { if (e2.key === 'Enter') sendComment(); };
    $('commentsList').addEventListener('click', (e2) => {
      const btn = e2.target.closest('.comment-del');
      if (btn) sync.deleteComment(ev.id, btn.dataset.id);
    });
  }
}

// ── 行程表單 ──
async function openEventForm(ev = null, preset = null, occMs = null) {
  editingEvent = ev;
  editingOccStart = occMs;
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
  if (ev && occMs && ev.repeat && ev.repeat !== 'none') {
    // 編輯重複行程的其中一次:表單顯示該次的日期
    const durMs = new Date(ev.end) - new Date(ev.start);
    s = new Date(occMs); e = new Date(occMs + durMs);
  } else if (ev) { s = new Date(ev.start); e = new Date(ev.end); }
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
  const hasReminder2 = base.reminder2 !== null && base.reminder2 !== undefined;
  $('evReminder2').value = hasReminder2 ? String(base.reminder2) : '';
  $('reminder2Row').hidden = !hasReminder2;
  $('btnAddReminder2').hidden = hasReminder2;
  $('evUrl').value = base.url || '';
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

function isImageAttachment(p) {
  return p.type ? p.type.startsWith('image/') : p.data.startsWith('data:image');
}
function fileIcon(name) {
  const ext = (name || '').split('.').pop().toLowerCase();
  if (ext === 'pdf') return '📕';
  if (['doc', 'docx'].includes(ext)) return '📘';
  if (['xls', 'xlsx'].includes(ext)) return '📗';
  if (['zip', 'rar', '7z'].includes(ext)) return '🗜️';
  return '📄';
}

function renderPhotoStrip() {
  const strip = $('photoStrip');
  strip.querySelectorAll('.photo-wrap').forEach(x => x.remove());
  const addBtn = strip.querySelector('.photo-add');
  for (const p of editingPhotos) {
    const wrap = document.createElement('div');
    wrap.className = 'photo-wrap';
    const inner = isImageAttachment(p)
      ? `<img class="photo-thumb" src="${p.data}">`
      : `<div class="file-thumb">${fileIcon(p.name)}<span>${esc(p.name || '檔案')}</span></div>`;
    wrap.innerHTML = `${inner}<button class="photo-del">✕</button>`;
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

// 非圖片檔案直接讀成 data URL(不壓縮)
function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
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
  const reminder2Val = $('reminder2Row').hidden ? '' : $('evReminder2').value;
  let url = $('evUrl').value.trim();
  if (url && !/^https?:\/\//i.test(url)) url = 'https://' + url;
  const formVals = {
    calendarId,
    title,
    allDay,
    repeat: $('evRepeat').value,
    reminder: reminderVal === '' ? null : Number(reminderVal),
    reminder2: reminder2Val === '' ? null : Number(reminder2Val),
    url,
    notes: $('evNotes').value.trim(),
    photos: photoIds,
  };

  // 編輯重複行程的某一次 → 問要改一次還是全部
  const isRepeating = editingEvent && editingEvent.repeat && editingEvent.repeat !== 'none';
  if (isRepeating && editingOccStart) {
    const scope = await choose('這是重複行程', ['只修改這一次', '修改所有重複']);
    if (!scope) return;
    if (scope === '只修改這一次') {
      // 原系列排除這一天,另建一筆獨立行程
      const orig = {
        ...editingEvent,
        exdates: [...(editingEvent.exdates || []), fmtYMD(new Date(editingOccStart))],
        updatedAt: Date.now(),
      };
      const single = {
        id: db.uid(), ...formVals, repeat: 'none',
        start: s.toISOString(), end: e.toISOString(),
        createdBy: editingEvent.createdBy || sync.getUid(), attendees: editingEvent.attendees || [],
        deleted: false, updatedAt: Date.now(),
      };
      await db.put('events', orig);
      await db.put('events', single);
      events = await db.getAll('events');
      sync.pushEvent(orig);
      sync.pushEvent(single);
      closeEventForm();
      render();
      toast('已修改這一次 ✅');
      return;
    }
    // 修改所有重複:保留系列原本的開始「日期」,套用表單的新時間與長度
    const origStart = new Date(editingEvent.start);
    if (!allDay) origStart.setHours(s.getHours(), s.getMinutes(), 0, 0);
    const origEnd = new Date(origStart.getTime() + (e - s));
    const ev = {
      ...editingEvent, ...formVals,
      start: origStart.toISOString(), end: origEnd.toISOString(),
      updatedAt: Date.now(),
    };
    await db.put('events', ev);
    events = await db.getAll('events');
    sync.pushEvent(ev);
    closeEventForm();
    render();
    toast('已更新所有重複 ✅');
    return;
  }

  const ev = {
    id: editingEvent ? editingEvent.id : db.uid(),
    ...formVals,
    start: s.toISOString(),
    end: e.toISOString(),
    exdates: (editingEvent && editingEvent.exdates) || [],
    createdBy: (editingEvent && editingEvent.createdBy) || sync.getUid(),
    attendees: (editingEvent && editingEvent.attendees) || [],
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
  const isRepeating = editingEvent.repeat && editingEvent.repeat !== 'none';
  if (isRepeating && editingOccStart) {
    const scope = await choose('刪除重複行程', ['只刪除這一次', '刪除整個重複行程']);
    if (!scope) return;
    if (scope === '只刪除這一次') {
      const ev = {
        ...editingEvent,
        exdates: [...(editingEvent.exdates || []), fmtYMD(new Date(editingOccStart))],
        updatedAt: Date.now(),
      };
      await db.put('events', ev);
      events = await db.getAll('events');
      sync.pushEvent(ev);
      closeEventForm();
      render();
      toast('已刪除這一次');
      return;
    }
  } else if (!confirm('確定刪除這個行程?')) return;
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
  editingOccStart = null;
  editingPhotos = [];
}

// ── 待辦清單 ──
function renderTodoList() {
  const list = $('todoList');
  if (!list) return;
  const live = todos.filter(t => !t.deleted).sort((a, b) => (a.done - b.done) || (b.updatedAt - a.updatedAt));
  list.innerHTML = live.length ? live.map(t => `
    <div class="todo-item" data-id="${t.id}">
      <span class="todo-check ${t.done ? 'done' : ''}">${t.done ? '✓' : ''}</span>
      <span class="todo-text ${t.done ? 'done' : ''}">${esc(t.text)}</span>
      <button class="todo-del">✕</button>
    </div>`).join('') : '<div class="empty-hint">目前沒有待辦事項</div>';
  list.querySelectorAll('.todo-item').forEach(row => {
    const id = row.dataset.id;
    row.querySelector('.todo-check').onclick = () => toggleTodo(id);
    row.querySelector('.todo-del').onclick = () => deleteTodo(id);
  });
}

async function addTodo() {
  const text = $('todoInput').value.trim();
  if (!text) return;
  const t = { id: db.uid(), text, done: false, deleted: false, updatedAt: Date.now() };
  await db.put('todos', t);
  todos = await db.getAll('todos');
  sync.pushTodo(t);
  $('todoInput').value = '';
  renderTodoList();
}

async function toggleTodo(id) {
  const t = todos.find(x => x.id === id);
  if (!t) return;
  const updated = { ...t, done: !t.done, updatedAt: Date.now() };
  await db.put('todos', updated);
  todos = await db.getAll('todos');
  sync.pushTodo(updated);
  renderTodoList();
}

async function deleteTodo(id) {
  const t = todos.find(x => x.id === id);
  if (!t) return;
  const updated = { ...t, deleted: true, updatedAt: Date.now() };
  await db.put('todos', updated);
  todos = await db.getAll('todos');
  sync.pushTodo(updated);
  renderTodoList();
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
  if (sync.cloudPushActive()) return; // 雲端推播已經接管,避免本機再跳一次重複通知
  const now = Date.now();
  const soon = occurrencesInRange(new Date(now - 60000), new Date(now + 26 * 3600000));
  for (const o of soon) {
    for (const slot of ['reminder', 'reminder2']) {
      const mins = o.ev[slot];
      if (mins === null || mins === undefined) continue;
      const fireAt = o.start.getTime() - mins * 60000;
      const key = o.ev.id + '|' + o.start.getTime() + '|' + slot;
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
}

// ── 匯入 .ics(iPhone / TimeTree 行事曆) ──
function parseIcsDate(val) {
  let m = val.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) return { date: new Date(+m[1], +m[2] - 1, +m[3]), allDay: true };
  m = val.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  if (m) {
    const date = m[7]
      ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]))
      : new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
    return { date, allDay: false };
  }
  return null;
}

function unescapeIcs(s) {
  return s.replace(/\\n/gi, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\');
}

async function importICS(file) {
  try {
    const text = await file.text();
    // 展開折行(ics 規範:續行以空白開頭)
    const lines = text.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '').split('\n');
    const vevents = [];
    let cur = null;
    for (const line of lines) {
      if (line === 'BEGIN:VEVENT') { cur = {}; continue; }
      if (line === 'END:VEVENT') { if (cur) vevents.push(cur); cur = null; continue; }
      if (!cur) continue;
      const idx = line.indexOf(':');
      if (idx < 0) continue;
      const name = line.slice(0, idx).split(';')[0];
      cur[name] = line.slice(idx + 1);
    }
    if (!vevents.length) { toast('檔案裡沒有行程'); return; }

    // 匯入的行程統一放進「匯入」行事曆
    let cal = calendars.find(c => !c.deleted && c.name === '匯入');
    if (!cal) {
      cal = { id: db.uid(), name: '匯入', color: '#607D8B', hidden: false, deleted: false, updatedAt: Date.now() };
      await db.put('calendars', cal);
      sync.pushCalendar(cal);
    }

    let count = 0;
    for (const v of vevents) {
      if (!v.SUMMARY || !v.DTSTART) continue;
      const ds = parseIcsDate(v.DTSTART);
      if (!ds) continue;
      const de = v.DTEND ? parseIcsDate(v.DTEND) : null;
      const start = ds.date;
      let end = de ? de.date : new Date(start.getTime() + (ds.allDay ? 0 : 3600000));
      if (ds.allDay) {
        if (de) end = new Date(end.getTime() - 86400000); // ics 全天結束日不含當天
        end = endOfDay(end < start ? start : end);
      }
      const rr = (v.RRULE || '').match(/FREQ=(DAILY|WEEKLY|MONTHLY|YEARLY)/);
      const ev = {
        id: db.uid(), calendarId: cal.id,
        title: unescapeIcs(v.SUMMARY), allDay: ds.allDay,
        start: start.toISOString(), end: end.toISOString(),
        repeat: rr ? rr[1].toLowerCase() : 'none',
        exdates: [], reminder: null,
        notes: v.DESCRIPTION ? unescapeIcs(v.DESCRIPTION) : '',
        photos: [], deleted: false, updatedAt: Date.now(),
      };
      await db.put('events', ev);
      sync.pushEvent(ev);
      count++;
    }
    calendars = await db.getAll('calendars');
    events = await db.getAll('events');
    render();
    renderSettings();
    toast(`匯入 ${count} 個行程 ✅`);
  } catch (e) { toast('匯入失敗:' + e.message); }
}

// ── 搜尋 ──
function openSearch() {
  $('searchBackdrop').classList.add('open');
  $('searchInput').value = '';
  $('searchResults').innerHTML = '<div class="empty-hint">輸入標題或備註關鍵字</div>';
  setTimeout(() => $('searchInput').focus(), 250);
}

function runSearch() {
  const q = $('searchInput').value.trim().toLowerCase();
  const box = $('searchResults');
  if (!q) { box.innerHTML = '<div class="empty-hint">輸入標題或備註關鍵字</div>'; return; }
  const hits = events
    .filter(ev => !ev.deleted && ((ev.title || '').toLowerCase().includes(q) || (ev.notes || '').toLowerCase().includes(q)))
    .sort((a, b) => new Date(b.start) - new Date(a.start))
    .slice(0, 50);
  if (!hits.length) { box.innerHTML = '<div class="empty-hint">找不到符合的行程</div>'; return; }
  box.innerHTML = hits.map(ev => {
    const cal = calById(ev.calendarId);
    const s = new Date(ev.start);
    const dateStr = `${s.getFullYear()}/${s.getMonth() + 1}/${s.getDate()}`
      + (ev.allDay ? ' 全天' : ' ' + fmtHM(s))
      + ((ev.repeat && ev.repeat !== 'none') ? ' 🔁' : '');
    return `<div class="ev-row" data-id="${ev.id}" data-start="${ev.start}">
      <div class="ev-row-bar" style="background:${cal.color}"></div>
      <div class="ev-row-main">
        <div class="ev-row-title">${esc(ev.title)}</div>
        <div class="ev-row-time">${dateStr} · ${esc(cal.name)}</div>
      </div></div>`;
  }).join('');
  box.querySelectorAll('.ev-row').forEach(r => {
    r.onclick = () => {
      $('searchBackdrop').classList.remove('open');
      cursor = new Date(r.dataset.start);
      selectedDay = new Date(cursor);
      setView('day');
    };
  });
}

// ── 農曆(用瀏覽器內建中國曆,不用資料表) ──
const LUNAR_DAYS = ['初一', '初二', '初三', '初四', '初五', '初六', '初七', '初八', '初九', '初十',
  '十一', '十二', '十三', '十四', '十五', '十六', '十七', '十八', '十九', '二十',
  '廿一', '廿二', '廿三', '廿四', '廿五', '廿六', '廿七', '廿八', '廿九', '三十'];
let lunarDayFmt = null, lunarMonthFmt = null;
try {
  lunarDayFmt = new Intl.DateTimeFormat('zh-Hant-u-ca-chinese', { day: 'numeric' });
  lunarMonthFmt = new Intl.DateTimeFormat('zh-Hant-u-ca-chinese', { month: 'long' });
} catch { /* 舊瀏覽器不支援就不顯示農曆 */ }

function lunarDayNum(d) {
  if (!lunarDayFmt) return 0;
  return parseInt(lunarDayFmt.format(d).replace(/\D/g, ''), 10) || 0;
}
function lunarDayLabel(d) {
  const day = lunarDayNum(d);
  if (!day) return '';
  if (day === 1) return lunarMonthFmt.format(d); // 初一顯示月份,例如「六月」
  return LUNAR_DAYS[day - 1] || '';
}
function lunarFullLabel(d) {
  const day = lunarDayNum(d);
  if (!day) return '';
  return '農曆' + lunarMonthFmt.format(d) + (LUNAR_DAYS[day - 1] || '');
}

// ── 匯出 / 匯入 ──
async function exportData() {
  const photos = await db.getAll('photos');
  const todosData = await db.getAll('todos');
  const data = { app: 'paixiaqu', version: 1, exportedAt: new Date().toISOString(), calendars, events, photos, todos: todosData };
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
    for (const t of (data.todos || [])) await db.put('todos', t);
    calendars = await db.getAll('calendars');
    events = await db.getAll('events');
    todos = await db.getAll('todos');
    render();
    renderSettings();
    renderTodoList();
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
  $('btnDayAdd').onclick = () => openEventForm(null, { date: selectedDay });

  $('btnEventCancel').onclick = closeEventForm;
  $('btnEventSave').onclick = saveEvent;
  $('btnEventDelete').onclick = deleteEvent;
  $('evAllDay').onchange = toggleTimeInputs;
  $('btnAddReminder2').onclick = () => {
    $('reminder2Row').hidden = false;
    $('btnAddReminder2').hidden = true;
  };
  $('evStartDate').onchange = () => {
    // 開始日期改變時,結束日期跟著調整
    if ($('evEndDate').value < $('evStartDate').value) $('evEndDate').value = $('evStartDate').value;
  };
  $('evPhotoInput').onchange = async (e) => {
    for (const f of e.target.files) {
      if (f.size > 10 * 1024 * 1024) { toast(`「${f.name}」超過 10MB,略過`); continue; }
      try {
        if (f.type.startsWith('image/')) {
          const data = await compressImage(f);
          editingPhotos.push({ id: db.uid(), data, name: f.name, type: 'image/jpeg', updatedAt: Date.now() });
        } else {
          const data = await readFileAsDataURL(f);
          editingPhotos.push({ id: db.uid(), data, name: f.name, type: f.type || 'application/octet-stream', updatedAt: Date.now() });
        }
      } catch { toast(`「${f.name}」讀取失敗`); }
    }
    e.target.value = '';
    renderPhotoStrip();
  };

  $('btnSettings').onclick = () => { renderSettings(); $('settingsPage').classList.add('open'); };
  $('btnSettingsBack').onclick = () => $('settingsPage').classList.remove('open');
  $('btnTodo').onclick = () => { renderTodoList(); $('todoPage').classList.add('open'); };
  $('btnTodoBack').onclick = () => $('todoPage').classList.remove('open');
  $('btnTodoAdd').onclick = addTodo;
  $('todoInput').onkeydown = (e) => { if (e.key === 'Enter') addTodo(); };
  $('btnAddCal').onclick = () => openCalForm();
  $('btnCalCancel').onclick = () => $('calSheetBackdrop').classList.remove('open');
  $('btnCalSave').onclick = saveCal;
  $('btnCalDelete').onclick = deleteCal;

  $('btnNotifyPerm').onclick = async () => {
    if (!('Notification' in window)) { toast('此瀏覽器不支援通知'); return; }
    const perm = await Notification.requestPermission();
    if (perm === 'granted') {
      await sync.subscribePush(true); // 有雲端同步 + 已加入群組時,順便訂閱「App 沒開也通知」;verbose 顯示失敗原因
      renderSettings();
    } else toast('通知未開啟');
  };

  $('btnExport').onclick = exportData;
  $('importInput').onchange = (e) => { if (e.target.files[0]) importData(e.target.files[0]); e.target.value = ''; };
  $('icsInput').onchange = (e) => { if (e.target.files[0]) importICS(e.target.files[0]); e.target.value = ''; };

  $('btnSearch').onclick = openSearch;
  $('btnSearchClose').onclick = () => $('searchBackdrop').classList.remove('open');
  $('searchInput').oninput = runSearch;

  // 點背景關閉 sheet(開啟後 300ms 內忽略,避免點擊穿透)
  for (const id of ['eventSheetBackdrop', 'detailBackdrop', 'calSheetBackdrop', 'searchBackdrop']) {
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
