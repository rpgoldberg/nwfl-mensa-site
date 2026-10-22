// Dates written out ("Saturday, 21 November 2026") and money in dollars, as
// the design draft asks. Dates are calendar days, never shifted by time zone.

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export function formatDate(iso: string, { year = true }: { year?: boolean } = {}): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  const date = m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))) : undefined;
  if (!m || !date || date.getUTCMonth() !== Number(m[2]) - 1) throw new Error(`not a YYYY-MM-DD date: ${iso}`);
  const day = `${DAYS[date.getUTCDay()]}, ${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`;
  return year ? `${day} ${date.getUTCFullYear()}` : day;
}

const DOLLARS = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

/** Cents to "$1,234.56"; a debit gets a true minus sign. */
export function formatMoney(cents: number): string {
  const text = DOLLARS.format(Math.abs(cents) / 100);
  return cents < 0 ? `−${text}` : text;
}

export function monthOf(iso: string): string {
  return iso.slice(0, 7);
}
