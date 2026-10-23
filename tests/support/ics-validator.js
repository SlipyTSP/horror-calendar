// Structural validator for the generated iCalendar documents (RFC 5545 subset used by
// this project). Returns a list of problems; an empty list means the document is valid.

const strictDecoder = new TextDecoder('utf-8', { fatal: true });

const CALENDAR_REQUIRED = ['VERSION', 'PRODID', 'CALSCALE', 'METHOD', 'X-WR-CALNAME', 'REFRESH-INTERVAL', 'X-PUBLISHED-TTL'];
const EVENT_REQUIRED = ['UID', 'DTSTAMP', 'DTSTART', 'SUMMARY', 'DESCRIPTION', 'URL', 'TRANSP'];
const CONTENT_LINE = /^([A-Za-z0-9-]+)((?:;[A-Za-z0-9-]+=[^;:]*)*):(.*)$/;

/**
 * @param {string} ics
 * @returns {string[]} Problems found
 */
function validateICS(ics) {
  const errors = [];
  if (typeof ics !== 'string' || ics.length === 0) return ['document is empty'];
  if (!ics.endsWith('\r\n')) errors.push('document does not end with CRLF');
  if (/[\r\n]/.test(ics.replace(/\r\n/g, ''))) errors.push('bare CR or LF found');

  const physical = ics.split('\r\n').slice(0, -1);
  for (const [i, line] of physical.entries()) {
    const bytes = Buffer.from(line, 'utf-8');
    if (bytes.length > 75) errors.push(`line ${i + 1} has ${bytes.length} octets`);
    try {
      strictDecoder.decode(bytes);
    } catch {
      errors.push(`line ${i + 1} is not valid UTF-8`);
    }
    if (line.includes('�')) errors.push(`line ${i + 1} contains U+FFFD (split sequence)`);
    if (line.startsWith(' ') && i === 0) errors.push('document starts with a continuation line');
    if (line.startsWith('\t')) errors.push(`line ${i + 1} uses a tab continuation`);
    if (line === '') errors.push(`line ${i + 1} is empty`);
  }

  const logical = ics.replace(/\r\n /g, '').split('\r\n').slice(0, -1);
  const stack = [];
  let calendars = 0;
  let current = null;
  const uids = new Set();
  const calendarProps = new Map();

  for (const line of logical) {
    const match = CONTENT_LINE.exec(line);
    if (!match) {
      errors.push(`malformed content line: ${line}`);
      continue;
    }
    const [, rawName, params, value] = match;
    const name = rawName.toUpperCase();
    if (name === 'BEGIN') {
      if (stack.length === 0 && value !== 'VCALENDAR') errors.push(`top-level component ${value}`);
      if (value === 'VCALENDAR') calendars += 1;
      if (value === 'VEVENT') current = new Map();
      stack.push(value);
      continue;
    }
    if (name === 'END') {
      const open = stack.pop();
      if (open !== value) errors.push(`END:${value} closes ${open ?? 'nothing'}`);
      if (value === 'VEVENT' && current) {
        for (const req of EVENT_REQUIRED) {
          if ((current.get(req) ?? []).length !== 1) errors.push(`VEVENT needs exactly one ${req}`);
        }
        const uid = current.get('UID')?.[0]?.value;
        if (uid) {
          if (uids.has(uid)) errors.push(`duplicate UID ${uid}`);
          uids.add(uid);
        }
        const dtstart = current.get('DTSTART')?.[0];
        if (dtstart && (dtstart.params !== ';VALUE=DATE' || !/^\d{8}$/.test(dtstart.value))) {
          errors.push(`DTSTART is not an all-day date: DTSTART${dtstart.params}:${dtstart.value}`);
        }
        const dtstamp = current.get('DTSTAMP')?.[0]?.value;
        if (dtstamp && !/^\d{8}T\d{6}Z$/.test(dtstamp)) errors.push(`DTSTAMP is not UTC: ${dtstamp}`);
        current = null;
      }
      continue;
    }
    const target = stack.at(-1) === 'VEVENT' ? current : stack.at(-1) === 'VCALENDAR' ? calendarProps : null;
    if (!target) {
      errors.push(`property ${name} outside a component`);
      continue;
    }
    if (!target.has(name)) target.set(name, []);
    target.get(name).push({ params, value });
  }

  if (stack.length > 0) errors.push(`unclosed components: ${stack.join(', ')}`);
  if (calendars !== 1) errors.push(`expected one VCALENDAR, found ${calendars}`);
  for (const req of CALENDAR_REQUIRED) {
    if ((calendarProps.get(req) ?? []).length !== 1) errors.push(`VCALENDAR needs exactly one ${req}`);
  }
  if (calendarProps.get('VERSION')?.[0]?.value !== '2.0') errors.push('VERSION must be 2.0');
  if (calendarProps.get('METHOD')?.[0]?.value !== 'PUBLISH') errors.push('METHOD must be PUBLISH');
  return errors;
}

/** Throws with every problem when the document is not valid. */
function assertValidICS(ics, label = 'calendar') {
  const errors = validateICS(ics);
  if (errors.length > 0) throw new Error(`${label} is not valid iCalendar:\n  ${errors.join('\n  ')}`);
}

/** Logical (unfolded) lines of a document, without the trailing empty string. */
function unfoldedLines(ics) {
  return ics.replace(/\r\n /g, '').split('\r\n').slice(0, -1);
}

module.exports = { validateICS, assertValidICS, unfoldedLines };
