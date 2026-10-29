const date = new Intl.DateTimeFormat('pl', { dateStyle: 'medium' });
const utcDay = new Intl.DateTimeFormat('pl', { dateStyle: 'medium', timeZone: 'UTC' });
const dateTime = new Intl.DateTimeFormat('pl', { dateStyle: 'medium', timeStyle: 'short' });

/** `29 paź 2026` for an ISO timestamp from the server (in the user's time zone). */
export function formatDate(iso: string): string {
  return date.format(new Date(iso));
}

/** `29 paź 2026` for a calendar day `YYYY-MM-DD` the server stores in UTC (e.g. "last active"). */
export function formatDay(day: string): string {
  return utcDay.format(new Date(`${day}T00:00:00Z`));
}

/** `29 paź 2026, 14:05` for an ISO timestamp from the server (in the user's time zone). */
export function formatDateTime(iso: string): string {
  return dateTime.format(new Date(iso));
}
