// iCalendar (RFC 5545) generation: one VCALENDAR per calendar of docs/data-model.md §3,
// with the rules of §6. No dependencies — the format is built by hand.

const {
  PLATFORMS, assignCalendars, calendarDefinitions, platformName,
} = require('./platforms');

const PRODID = '-//Horror Calendar//horror-calendar//ES';
const CALENDAR_NAME_PREFIX = 'Terror — ';

// Type marker appended to SUMMARY
const RELEASE_EMOJI = {
  theatrical: '🎬',
  digital: '📺',
  arrival: '🆕',
};

// Types that belong to the legacy horror.ics (cines + digital, never arrivals)
const LEGACY_TYPES = new Set(['theatrical', 'digital']);

/**
 * Escapes text values (RFC 5545 §3.3.11): backslash, semicolon, comma and newlines
 * (CRLF, lone CR and LF all become an escaped "\n"). Other control characters, which
 * RFC 5545 forbids in TEXT values, are removed.
 * @param {string} text
 * @returns {string}
 */
function escapeText(text) {
  return String(text ?? '')
    .replace(/\r\n|\r|\n/g, '\n')
    .replace(/[\x00-\x08\x0B-\x1F\x7F]/g, '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n');
}

/** YYYY-MM-DD → YYYYMMDD (VALUE=DATE). */
function formatDateValue(dateStr) {
  return dateStr.replace(/-/g, '');
}

/** Date → YYYYMMDDTHHMMSSZ (UTC). */
function formatTimestamp(date) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/**
 * Stable UID from the TMDB id and the release type (plus the platform for arrivals): a
 * date or title change in TMDB updates the event instead of duplicating it. A manual
 * release shares the `digital` UID with its future TMDB counterpart.
 * @param {{ id: number, type: string, arrivalPlatform?: string|null }} release
 * @returns {string} e.g. "tmdb-900004-digital@horror-calendar",
 *   "tmdb-900010-arrival-movistar-plus@horror-calendar"
 */
function generateUID(release) {
  if (release.type === 'arrival') return `tmdb-${release.id}-arrival-${release.arrivalPlatform}@horror-calendar`;
  return `tmdb-${release.id}-${release.type}@horror-calendar`;
}

/**
 * "Where" line of the description (§6), first rule that applies.
 * @param {object} release - Release with calendars
 * @returns {string}
 */
function buildWhereLine(release) {
  if (release.type === 'theatrical') return 'En cines';
  if (release.type === 'arrival') return `Ya disponible en: ${platformName(release.arrivalPlatform) ?? release.arrivalPlatform}`;

  const flatrate = Array.isArray(release.providers?.flatrate) ? release.providers.flatrate : [];
  if (flatrate.length > 0) return `Incluido en: ${flatrate.join(', ')}`;

  const calendars = Array.isArray(release.calendars) ? release.calendars : assignCalendars(release).calendars;
  const platforms = PLATFORMS.filter((p) => calendars.includes(p.slug)).map((p) => p.name);
  if (platforms.length > 0) return `Estreno en: ${platforms.join(', ')}`;

  const rentBuy = Array.isArray(release.providers?.rentBuy) ? release.providers.rentBuy : [];
  if (rentBuy.length > 0) return `Alquiler o compra: ${rentBuy.join(', ')}`;

  return 'Estreno digital';
}

/**
 * DESCRIPTION value, escaped: synopsis (if any), where line, press source (manual
 * releases) and TMDB link, separated by blank lines.
 * @param {object} release
 * @returns {string}
 */
function buildDescription(release) {
  const parts = [];
  if (release.overview) parts.push(release.overview);
  parts.push(buildWhereLine(release));
  if (release.source === 'manual' && release.sourceUrl) parts.push(`Fuente: ${release.sourceUrl}`);
  parts.push(`Más info: ${release.tmdbUrl}`);
  return escapeText(parts.join('\n\n'));
}

/** SUMMARY: title plus the type marker. */
function buildSummary(release) {
  const emoji = RELEASE_EMOJI[release.type];
  return emoji ? `${release.title} ${emoji}` : release.title;
}

/**
 * Folds a content line at 75 octets (RFC 5545 §3.1) without splitting UTF-8
 * sequences; continuation lines start with a single space.
 * @param {string} line
 * @returns {string}
 */
function foldLine(line) {
  const MAX_OCTETS = 75;
  const bytes = new TextEncoder().encode(line);
  if (bytes.length <= MAX_OCTETS) return line;

  const lines = [];
  let start = 0;
  while (start < bytes.length) {
    // 75 octets on the first line, 74 on continuations (plus the leading space)
    const limit = start === 0 ? MAX_OCTETS : MAX_OCTETS - 1;
    let end = start + limit;
    if (end < bytes.length) {
      // UTF-8 continuation bytes are 10xxxxxx: back off to the start of the character
      while (end > start && (bytes[end] & 0xC0) === 0x80) end -= 1;
    } else {
      end = bytes.length;
    }
    const chunk = new TextDecoder().decode(bytes.slice(start, end));
    lines.push(start === 0 ? chunk : ` ${chunk}`);
    start = end;
  }
  return lines.join('\r\n');
}

/** One all-day VEVENT. */
function buildEvent(release, dtstamp) {
  return [
    'BEGIN:VEVENT',
    foldLine(`UID:${generateUID(release)}`),
    `DTSTAMP:${dtstamp}`,
    `DTSTART;VALUE=DATE:${formatDateValue(release.releaseDate)}`,
    foldLine(`SUMMARY:${escapeText(buildSummary(release))}`),
    foldLine(`DESCRIPTION:${buildDescription(release)}`),
    foldLine(`URL:${release.tmdbUrl}`),
    'TRANSP:TRANSPARENT',
    'END:VEVENT',
  ].join('\r\n');
}

/**
 * A complete VCALENDAR document; with no releases it is still valid (no VEVENT).
 * @param {object[]} releases - Releases of this calendar, already ordered
 * @param {object} options
 * @param {string} options.name - Display name, without the "Terror — " prefix
 * @param {Date} [options.now] - Build time, used for DTSTAMP
 * @returns {string} Document with CRLF line endings and a trailing CRLF
 */
function generateICS(releases, { name, now = new Date() }) {
  const dtstamp = formatTimestamp(now);
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:${PRODID}`,
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    foldLine(`X-WR-CALNAME:${escapeText(`${CALENDAR_NAME_PREFIX}${name}`)}`),
    // RFC 7986 refresh interval, plus the legacy property for older clients
    'REFRESH-INTERVAL;VALUE=DURATION:P1D',
    'X-PUBLISHED-TTL:P1D',
    ...releases.map((release) => buildEvent(release, dtstamp)),
    'END:VCALENDAR',
  ];
  return `${lines.join('\r\n')}\r\n`;
}

/**
 * Every calendar of §3, in canonical order, always generated (possibly empty).
 * `all` (horror.ics) holds every theatrical and digital release (cines + digital);
 * arrivals only belong to their platform calendar.
 * @param {object[]} releases - Releases with `calendars` (see src/platforms.js)
 * @param {object} [options]
 * @param {Date} [options.now] - Build time
 * @returns {Array<{ slug: string, file: string, name: string, kind: string, count: number, ics: string }>}
 */
function generateCalendars(releases, { now = new Date() } = {}) {
  return calendarDefinitions().map((def) => {
    const members = def.slug === 'all'
      ? releases.filter((r) => LEGACY_TYPES.has(r.type))
      : releases.filter((r) => Array.isArray(r.calendars) && r.calendars.includes(def.slug));
    return { ...def, count: members.length, ics: generateICS(members, { name: def.name, now }) };
  });
}

module.exports = {
  generateCalendars,
  generateICS,
  escapeText,
  foldLine,
  generateUID,
  buildDescription,
  buildWhereLine,
};
