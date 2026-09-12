/** Curated timezone list for the chart/import selectors (IANA ids, DST-aware). */

export interface TzOption {
  id: string;
  label: string;
  short: string;
  group: 'reference' | 'sessions' | 'major';
}

export const COMMON_TIMEZONES: TzOption[] = [
  { id: 'UTC', label: 'UTC (reference)', short: 'UTC', group: 'reference' },
  { id: 'Etc/GMT+3', label: 'GMT-3', short: 'GMT-3', group: 'reference' },
  { id: 'Etc/GMT+2', label: 'GMT-2', short: 'GMT-2', group: 'reference' },
  { id: 'Etc/GMT+1', label: 'GMT-1', short: 'GMT-1', group: 'reference' },
  { id: 'Etc/GMT', label: 'GMT+0', short: 'GMT+0', group: 'reference' },
  { id: 'Etc/GMT-1', label: 'GMT+1', short: 'GMT+1', group: 'reference' },
  { id: 'Etc/GMT-2', label: 'GMT+2', short: 'GMT+2', group: 'reference' },
  { id: 'Etc/GMT-3', label: 'GMT+3', short: 'GMT+3', group: 'reference' },
  { id: 'Etc/GMT-5', label: 'GMT+5', short: 'GMT+5', group: 'reference' },
  { id: 'Etc/GMT-8', label: 'GMT+8', short: 'GMT+8', group: 'reference' },
  { id: 'Etc/GMT-9', label: 'GMT+9', short: 'GMT+9', group: 'reference' },
  { id: 'Etc/GMT-10', label: 'GMT+10', short: 'GMT+10', group: 'reference' },
  { id: 'America/New_York', label: 'New York (Eastern)', short: 'NY', group: 'sessions' },
  { id: 'America/Chicago', label: 'Chicago (Central)', short: 'CHI', group: 'sessions' },
  { id: 'America/Los_Angeles', label: 'Los Angeles (Pacific)', short: 'LA', group: 'sessions' },
  { id: 'Europe/London', label: 'London', short: 'LDN', group: 'sessions' },
  { id: 'Europe/Berlin', label: 'Berlin', short: 'BER', group: 'sessions' },
  { id: 'Europe/Zurich', label: 'Zurich', short: 'ZRH', group: 'sessions' },
  { id: 'Asia/Tokyo', label: 'Tokyo', short: 'TYO', group: 'sessions' },
  { id: 'Asia/Singapore', label: 'Singapore', short: 'SG', group: 'sessions' },
  { id: 'Australia/Sydney', label: 'Sydney', short: 'SYD', group: 'sessions' },
  { id: 'Asia/Dubai', label: 'Dubai', short: 'DXB', group: 'major' },
  { id: 'Asia/Shanghai', label: 'Shanghai', short: 'SH', group: 'major' },
  { id: 'Asia/Kolkata', label: 'Kolkata', short: 'CAL', group: 'major' },
];

export const TIMEZONE_OPTIONS: { value: string; label: string }[] = COMMON_TIMEZONES.map((z) => ({
  value: z.id,
  label: z.group === 'reference' ? z.label : `${z.label}  ·  ${z.short}`,
}));

/** Best-effort detection of the operator's own timezone. */
export function localTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}
