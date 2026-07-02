import { HOME } from "./scraping.js";

// Household-local calendar date, not UTC — a UTC-based "today" rolls over to
// tomorrow during evening hours in US timezones, silently dropping a sale from
// Discover during the evening of its own final day.
export function todayIsoDate(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: HOME.timezone }).format(new Date());
}
