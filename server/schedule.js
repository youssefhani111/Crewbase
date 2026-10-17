// Works out when a scheduled agent should run next, in the owner's time zone.
//   manual   → never runs by itself
//   interval → every N hours            schedule_value = "6"
//   daily    → at a time on chosen days schedule_value = {"time":"09:00","days":[0,1,2,3,4]}  (0 = Sunday)
import { config } from './config.js';

function partsIn(tz, ts) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short',
  });
  const p = Object.fromEntries(f.formatToParts(new Date(ts)).map(x => [x.type, x.value]));
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday);
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, min: +p.minute, s: +p.second, wd };
}

function offsetMs(tz, ts) {
  const p = partsIn(tz, ts);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s) - Math.floor(ts / 1000) * 1000;
}

// Wall-clock time in `tz` → UTC timestamp.
function zonedToUtc(tz, y, m, d, h, min) {
  const guess = Date.UTC(y, m - 1, d, h, min);
  let ts = guess - offsetMs(tz, guess);
  ts = guess - offsetMs(tz, ts); // second pass handles DST edges
  return ts;
}

export function validTimezone(tz) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

export function parseSchedule(type, value) {
  if (type === 'interval') {
    const hours = Math.max(config.minScheduleMinutes / 60, Number(value) || 24);
    return { hours };
  }
  if (type === 'daily') {
    let v = value;
    if (typeof v === 'string') { try { v = JSON.parse(v); } catch { v = {}; } }
    const time = /^\d{2}:\d{2}$/.test(v?.time || '') ? v.time : '09:00';
    const days = Array.isArray(v?.days) && v.days.length ? v.days.map(Number).filter(n => n >= 0 && n <= 6) : [0, 1, 2, 3, 4, 5, 6];
    return { time, days };
  }
  return null;
}

export function nextRunAt(type, value, tz, from = Date.now()) {
  const s = parseSchedule(type, value);
  if (!s) return null;
  if (type === 'interval') return from + s.hours * 3600_000;
  const [hh, mm] = s.time.split(':').map(Number);
  for (let add = 0; add <= 8; add++) {
    const p = partsIn(tz, from + add * 86400_000);
    if (!s.days.includes(p.wd)) continue;
    const ts = zonedToUtc(tz, p.y, p.m, p.d, hh, mm);
    if (ts > from + 30_000) return ts;
  }
  return null;
}

export function describeSchedule(type, value) {
  const s = parseSchedule(type, value);
  if (!s) return 'Runs when you ask';
  if (type === 'interval') return `Every ${s.hours} hour${s.hours === 1 ? '' : 's'}`;
  const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const days = s.days.length === 7 ? 'Every day' : s.days.map(d => names[d]).join(', ');
  return `${days} at ${s.time}`;
}
