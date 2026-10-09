// Calendar-day helpers on 'YYYY-MM-DD' strings. Days are the business's
// local days; the server converts to and from UTC, so no timezone maths here.

export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function weekday(date: string): number {
  return new Date(`${date}T12:00:00Z`).getUTCDay();
}

/** Monday of the week containing `date`. */
export function startOfWeek(date: string): string {
  return addDays(date, -((weekday(date) + 6) % 7));
}

/** Today in a given IANA timezone. */
export function todayIn(timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

export function nowMinutesIn(timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date());
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
  const m = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
  return (h % 24) * 60 + m;
}

export function minutesOf(localDateTime: string): number {
  const [h, m] = localDateTime.slice(11, 16).split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

export function locale(lang: string): string {
  return lang === 'el' ? 'el-GR' : 'en-GB';
}

export function formatDay(date: string, lang: string, opts: Intl.DateTimeFormatOptions = { weekday: 'long', day: 'numeric', month: 'long' }): string {
  return new Intl.DateTimeFormat(locale(lang), { ...opts, timeZone: 'UTC' }).format(new Date(`${date}T12:00:00Z`));
}

export function weekdayName(dow: number, lang: string, style: 'long' | 'short' = 'long'): string {
  // 2023-01-01 was a Sunday.
  return new Intl.DateTimeFormat(locale(lang), { weekday: style, timeZone: 'UTC' }).format(new Date(Date.UTC(2023, 0, 1 + dow, 12)));
}

export function formatInstant(iso: string, timeZone: string, lang: string, opts: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat(locale(lang), { ...opts, timeZone }).format(new Date(iso));
}

export function formatMoney(cents: number, currency: string, lang: string): string {
  return new Intl.NumberFormat(locale(lang), { style: 'currency', currency, minimumFractionDigits: cents % 100 ? 2 : 0 }).format(cents / 100);
}

export function formatDuration(min: number, lang: string): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  const hu = lang === 'el' ? 'ώ' : 'h';
  const mu = lang === 'el' ? 'λ' : 'min';
  return h ? (m ? `${h}${hu} ${m}${mu}` : `${h}${hu}`) : `${m} ${mu}`;
}

/** 'HH:MM' → minutes after midnight. */
export function hm(time: string): number {
  const [h, m] = time.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}
