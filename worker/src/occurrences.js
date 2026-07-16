// 重複行程展開邏輯(從 js/app.js 的 occurrencesInRange 移植過來,不含 DOM)

function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

function fmtYMD(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// 找出事件在 [rangeStart, rangeEnd] 內的所有「這一次」發生時間
export function occurrencesInRange(ev, rangeStart, rangeEnd) {
  const out = [];
  const evStart = new Date(ev.startAt);
  const evEnd = new Date(ev.endAt);
  const durMs = evEnd - evStart;
  const exdates = ev.exdates || [];

  if (!ev.repeat || ev.repeat === 'none') {
    if (evStart <= rangeEnd && evEnd >= rangeStart) out.push({ start: evStart, end: evEnd });
    return out;
  }

  let cur = new Date(evStart);
  for (let i = 0; i < 500 && cur <= rangeEnd; i++) {
    const occEnd = new Date(cur.getTime() + durMs);
    if (occEnd >= rangeStart && !exdates.includes(fmtYMD(cur))) {
      out.push({ start: new Date(cur), end: occEnd });
    }
    if (ev.repeat === 'daily') cur = addDays(cur, 1);
    else if (ev.repeat === 'weekly') cur = addDays(cur, 7);
    else if (ev.repeat === 'monthly') { cur = new Date(cur); cur.setMonth(cur.getMonth() + 1); }
    else if (ev.repeat === 'yearly') { cur = new Date(cur); cur.setFullYear(cur.getFullYear() + 1); }
    else break;
  }
  return out;
}
