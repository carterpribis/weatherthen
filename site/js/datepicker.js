// A month / day / year picker: two menus and a typed year.
// Browser date pickers make you scroll month by month (or through every month of every
// year) to reach 1888; typing the year is faster.

import { FIRST_DATE, today } from './dates.js';

const pad = (n) => String(n).padStart(2, '0');
const daysIn = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate(); // m is 1-12

/**
 * root: an empty element. onChange(dateString) fires when the user picks a date.
 * Returns {set(date), get()} where dates are "YYYY-MM-DD".
 */
export function datePicker(root, { onChange, label = 'Date' } = {}) {
  root.classList.add('date-picker');
  root.setAttribute('role', 'group');
  root.setAttribute('aria-label', label);
  const monthNames = Array.from({ length: 12 }, (_, i) =>
    new Date(Date.UTC(2000, i, 15)).toLocaleDateString(undefined, { month: 'short', timeZone: 'UTC' }));
  root.innerHTML = `
    <select class="dp-month" aria-label="Month">${monthNames.map((n, i) => `<option value="${i + 1}">${n}</option>`).join('')}</select>
    <select class="dp-day" aria-label="Day"></select>
    <input class="dp-year" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="4" aria-label="Year" autocomplete="off">`;
  const month = root.querySelector('.dp-month');
  const day = root.querySelector('.dp-day');
  const year = root.querySelector('.dp-year');
  let current = null;

  const fillDays = (y, m, keep) => {
    const n = daysIn(y, m);
    if (day.options.length !== n) {
      day.innerHTML = Array.from({ length: n }, (_, i) => `<option value="${i + 1}">${i + 1}</option>`).join('');
    }
    day.value = String(Math.min(keep, n));
  };

  const set = (date) => {
    if (!date) return;
    current = date;
    const [y, m, d] = date.split('-').map(Number);
    month.value = String(m);
    fillDays(y, m, d);
    if (document.activeElement !== year) year.value = String(y);
  };

  // Read the three controls, clamp to the available range, and report it.
  const commit = () => {
    const y = parseInt(year.value, 10);
    if (!Number.isFinite(y) || year.value.length !== 4) return;
    const m = +month.value;
    fillDays(y, m, +day.value || 1);
    let date = `${y}-${pad(m)}-${pad(+day.value)}`;
    if (date < FIRST_DATE) date = FIRST_DATE;
    if (date > today()) date = today();
    set(date);
    if (document.activeElement === year) year.value = date.slice(0, 4);
    onChange?.(date);
  };

  month.addEventListener('change', commit);
  day.addEventListener('change', commit);
  // Year: commit once four digits are typed, or on Enter / leaving the box.
  year.addEventListener('input', () => {
    year.value = year.value.replace(/\D/g, '').slice(0, 4);
    if (year.value.length === 4) commit();
  });
  year.addEventListener('change', () => (year.value.length === 4 ? commit() : set(current)));
  year.addEventListener('blur', () => set(current));
  year.addEventListener('focus', () => year.select());
  year.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { commit(); year.blur(); }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const y = (parseInt(year.value, 10) || +current.slice(0, 4)) + (e.key === 'ArrowUp' ? 1 : -1);
      year.value = String(Math.min(Math.max(y, +FIRST_DATE.slice(0, 4)), +today().slice(0, 4)));
      commit();
    }
  });

  return { set, get: () => current };
}
