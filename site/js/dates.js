// Calendar dates as "YYYY-MM-DD" strings, handled in UTC so no time zone shifts them.

export const FIRST_DATE = '1836-01-01';

export function today() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function addDays(date, n) {
  const t = new Date(date + 'T00:00:00Z');
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}

export function daysBetween(a, b) {
  return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 864e5);
}

export function clampDate(date) {
  const last = today();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return null;
  return date < FIRST_DATE ? FIRST_DATE : date > last ? last : date;
}

export function longDate(date) {
  return new Date(date + 'T12:00:00Z').toLocaleDateString(undefined, {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC',
  });
}

export function shortDate(date) {
  return new Date(date + 'T12:00:00Z').toLocaleDateString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC',
  });
}

const pad = (n) => String(n).padStart(2, '0');
