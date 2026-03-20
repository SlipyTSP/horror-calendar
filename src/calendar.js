// Módulo para generar archivos .ics (RFC 5545) a partir de datos de películas
// Sin dependencias externas — construimos el formato manualmente

const crypto = require('crypto');

// Nombre del calendario que se muestra en iOS/Google Calendar
const CALENDAR_NAME = '🎬 Estrenos de Terror';

// Emojis para cada tipo de estreno — se usan en SUMMARY y DESCRIPTION
const RELEASE_EMOJI = {
  theatrical: '🎬',
  digital: '📺',
  physical: '💿',
};

/**
 * Escapa caracteres especiales según RFC 5545 (sección 3.3.11)
 * Los valores de texto deben escapar: backslash, punto y coma, coma y saltos de línea
 * @param {string} text - Texto a escapar
 * @returns {string} Texto escapado para .ics
 */
function escapeText(text) {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

/**
 * Convierte una fecha YYYY-MM-DD a formato VALUE=DATE de iCalendar (YYYYMMDD)
 * Se usa para eventos de día completo (sin hora)
 * @param {string} dateStr - Fecha en formato YYYY-MM-DD
 * @returns {string} Fecha en formato YYYYMMDD
 */
function formatDateValue(dateStr) {
  return dateStr.replace(/-/g, '');
}

/**
 * Genera un UID único para cada evento basado en el contenido
 * Usamos un hash SHA-256 del título + fecha para que el UID sea
 * determinista: si se regenera el calendario, los mismos eventos
 * mantienen el mismo UID y iOS no los duplica
 * @param {string} title - Título de la película
 * @param {string} date - Fecha de estreno
 * @returns {string} UID único en formato estándar
 */
function generateUID(title, date) {
  const hash = crypto.createHash('sha256')
    .update(`${title}-${date}`)
    .digest('hex')
    .substring(0, 16);
  return `${hash}@horror-calendar`;
}

/**
 * Genera el timestamp actual en formato UTC para DTSTAMP
 * RFC 5545 requiere que cada VEVENT tenga un DTSTAMP con la fecha de creación
 * @returns {string} Timestamp en formato YYYYMMDDTHHMMSSZ
 */
function nowUTC() {
  return new Date().toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
}

/**
 * Genera la línea de "dónde se estrena" según el tipo y los proveedores
 * - Theatrical → "🎬 En cines"
 * - Digital con proveedores → "📺 Streaming: Netflix, HBO Max..."
 * - Digital sin proveedores → "📺 Estreno digital"
 * - Physical → "💿 Formato físico"
 * - Sin tipo pero con proveedores → "📺 Streaming: ..."
 * - Sin nada → null (se omite)
 *
 * @param {string|null} releaseType - Tipo de estreno (theatrical, digital, physical)
 * @param {string[]} providers - Lista de plataformas
 * @returns {string|null} Línea descriptiva o null
 */
function buildWhereLine(releaseType, providers) {
  const hasProviders = providers && providers.length > 0;

  if (releaseType === 'theatrical') {
    // Estreno en cines — si además tiene proveedores, los mencionamos
    if (hasProviders) {
      return `🎬 En cines | 📺 También en: ${providers.join(', ')}`;
    }
    return '🎬 En cines';
  }

  if (releaseType === 'digital') {
    if (hasProviders) {
      return `📺 Streaming: ${providers.join(', ')}`;
    }
    return '📺 Estreno digital';
  }

  if (releaseType === 'physical') {
    return '💿 Formato físico';
  }

  // Sin tipo conocido pero con proveedores de streaming
  if (hasProviders) {
    return `📺 Streaming: ${providers.join(', ')}`;
  }

  // No tenemos información de dónde se estrena
  return null;
}

/**
 * Construye el bloque DESCRIPTION para un evento
 * Incluye: sinopsis, línea de dónde se estrena y enlace a TMDB
 * @param {object} release - Datos de la película
 * @returns {string} Texto escapado para el campo DESCRIPTION
 */
function buildDescription(release) {
  const parts = [];

  // Sinopsis (ya validada en shouldInclude, pero protegemos por si acaso)
  if (release.overview) {
    parts.push(release.overview);
  }

  // Línea de dónde se estrena (cines, streaming, digital, etc.)
  const whereLine = buildWhereLine(release.releaseType, release.providers);
  if (whereLine) {
    parts.push(whereLine);
  }

  // Enlace directo a la ficha en TMDB
  parts.push(`Más info: ${release.tmdbUrl}`);

  return escapeText(parts.join('\n\n'));
}

/**
 * Genera el SUMMARY del evento con el emoji del tipo de estreno
 * Ejemplo: "Baby Bird 🎬" o "The Ring 📺"
 * @param {string} title - Título de la película
 * @param {string|null} releaseType - Tipo de estreno
 * @returns {string} Título con emoji
 */
function buildSummary(title, releaseType) {
  const emoji = RELEASE_EMOJI[releaseType] || '';
  return emoji ? `${title} ${emoji}` : title;
}

/**
 * Determina si una película debe incluirse en el calendario
 * Se excluyen películas que no tienen ni descripción ni plataformas conocidas
 * @param {object} release - Datos de la película
 * @returns {boolean} true si debe incluirse
 */
function shouldInclude(release) {
  const hasOverview = Boolean(release.overview);
  const hasProviders = release.providers && release.providers.length > 0;
  const hasReleaseType = Boolean(release.releaseType);

  // Excluimos si no tiene descripción Y tampoco sabemos dónde se estrena
  return hasOverview || hasProviders || hasReleaseType;
}

/**
 * Pliega líneas largas según RFC 5545 (sección 3.1)
 * Las líneas de contenido no deben superar 75 octetos.
 * Las continuaciones se marcan con un espacio al inicio de la línea siguiente.
 * @param {string} line - Línea a plegar
 * @returns {string} Línea plegada
 */
function foldLine(line) {
  const MAX_OCTETS = 75;
  const encoder = new TextEncoder();
  const bytes = encoder.encode(line);

  // Si cabe en una línea, no hay que plegar
  if (bytes.length <= MAX_OCTETS) return line;

  const lines = [];
  let start = 0;

  while (start < bytes.length) {
    // La primera línea permite 75 octetos; las siguientes 74 (por el espacio de continuación)
    const limit = start === 0 ? MAX_OCTETS : MAX_OCTETS - 1;
    let end = start + limit;

    // No cortar en medio de un carácter multi-byte UTF-8
    // Los bytes de continuación UTF-8 empiezan con 10xxxxxx (0x80-0xBF)
    if (end < bytes.length) {
      while (end > start && (bytes[end] & 0xC0) === 0x80) {
        end--;
      }
    } else {
      end = bytes.length;
    }

    const chunk = new TextDecoder().decode(bytes.slice(start, end));
    lines.push(start === 0 ? chunk : ` ${chunk}`);
    start = end;
  }

  return lines.join('\r\n');
}

/**
 * Genera un bloque VEVENT para una película
 * @param {object} release - Datos de la película (de getHorrorReleases)
 * @returns {string} Bloque VEVENT completo
 */
function buildEvent(release) {
  const dtstamp = nowUTC();
  const uid = generateUID(release.title, release.releaseDate);
  const dtstart = formatDateValue(release.releaseDate);
  const summary = escapeText(buildSummary(release.title, release.releaseType));
  const description = buildDescription(release);
  const url = release.tmdbUrl;

  // Cada propiedad se pliega individualmente para respetar el límite de 75 octetos
  const lines = [
    'BEGIN:VEVENT',
    foldLine(`UID:${uid}`),
    foldLine(`DTSTAMP:${dtstamp}`),
    foldLine(`DTSTART;VALUE=DATE:${dtstart}`),       // Evento de día completo (sin hora)
    foldLine(`SUMMARY:${summary}`),
    foldLine(`DESCRIPTION:${description}`),
    foldLine(`URL:${url}`),
    'TRANSP:TRANSPARENT',                             // No bloquea el horario del usuario
    'END:VEVENT',
  ];

  return lines.join('\r\n');
}

/**
 * Función principal: genera el contenido .ics completo
 *
 * Filtra las películas que no tienen información útil (sin descripción
 * ni plataformas conocidas) antes de generar los eventos.
 *
 * Cabeceras del calendario:
 * - VERSION:2.0 → versión de iCalendar (RFC 5545)
 * - PRODID → identificador del producto que genera el calendario
 * - CALSCALE:GREGORIAN → escala de calendario (estándar)
 * - METHOD:PUBLISH → indica que es un calendario de solo lectura/suscripción
 * - X-WR-CALNAME → nombre visible del calendario en iOS/macOS
 * - REFRESH-INTERVAL / X-PUBLISHED-TTL → le dice a iOS que refresque
 *   el calendario cada 24 horas (P1D = Period 1 Day)
 *
 * @param {Array<{title: string, releaseDate: string, overview: string, providers: string[], releaseType: string|null, tmdbUrl: string}>} releases
 * @returns {{ ics: string, total: number, excluded: number }} Contenido .ics y estadísticas
 */
function generateICS(releases) {
  // Filtramos películas sin información útil
  const included = releases.filter(shouldInclude);
  const excluded = releases.length - included.length;

  const header = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Horror Calendar//horror-calendar//ES',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    foldLine(`X-WR-CALNAME:${CALENDAR_NAME}`),
    // Intervalo de refresco estándar (RFC 7986) — cada 24 horas
    'REFRESH-INTERVAL;VALUE=DURATION:P1D',
    // Versión legacy del refresh para clientes que no soporten RFC 7986
    'X-PUBLISHED-TTL:P1D',
  ];

  const footer = ['END:VCALENDAR'];

  // Generamos un VEVENT por cada película incluida
  const events = included.map(buildEvent);

  // RFC 5545 exige terminaciones de línea CRLF (\r\n)
  const parts = [...header, ...events, ...footer];
  const ics = parts.join('\r\n') + '\r\n';

  return { ics, total: included.length, excluded };
}

module.exports = { generateICS };
