// Platform configuration and calendar membership (docs/data-model.md §3 and §5).
// Single place to add or remove platforms: slugs are file-name safe and stable,
// providerNames are the aliases matched against TMDB provider names and release notes.

const PLATFORMS = [
  { slug: 'netflix',       name: 'Netflix',        providerNames: ['Netflix', 'Netflix basic with Ads'] },
  { slug: 'prime-video',   name: 'Prime Video',    providerNames: ['Amazon Prime Video', 'Amazon Prime Video with Ads', 'Prime Video'] },
  { slug: 'hbo-max',       name: 'HBO Max',        providerNames: ['HBO Max', 'Max'] },
  { slug: 'movistar-plus', name: 'Movistar Plus+', providerNames: ['Movistar Plus+', 'Movistar Plus'] },
  { slug: 'filmin',        name: 'Filmin',         providerNames: ['Filmin'] },
  { slug: 'disney-plus',   name: 'Disney+',        providerNames: ['Disney Plus', 'Disney+'] },
  { slug: 'skyshowtime',   name: 'SkyShowtime',    providerNames: ['SkyShowtime'] },
  { slug: 'apple-tv-plus', name: 'Apple TV+',      providerNames: ['Apple TV Plus', 'Apple TV+'] },
];

const normalize = (name) => (typeof name === 'string' ? name.trim().toLowerCase() : '');

/**
 * Maps a provider name or release note to a platform slug.
 * Exact match against the aliases, case-insensitive, after trimming.
 * @param {string|null|undefined} name
 * @returns {string|null} Platform slug or null when nothing matches
 */
function matchPlatform(name) {
  const key = normalize(name);
  if (!key) return null;
  const platform = PLATFORMS.find((p) => p.providerNames.some((alias) => normalize(alias) === key));
  return platform ? platform.slug : null;
}

/**
 * Returns a copy of the release with `calendars` set (§3):
 * - theatrical: ["cines"];
 * - tmdb digital: ["digital", ...platformSlugs], the union of the release note, the
 *   flatrate providers and the curated `platforms` (TMDB-wins rule of §2);
 * - manual digital: ["digital", ...platforms] (curated slug only, no note/flatrate union);
 * - arrival: [arrivalPlatform].
 * Platform slugs without duplicates and in config order.
 * @param {object} release - Release object from src/tmdb.js, src/manual.js or src/arrivals.js
 * @param {{ platforms?: string[] }} [options] - Curated platform slugs to add
 * @returns {object}
 */
function assignCalendars(release, options) {
  if (release?.type === 'theatrical') return withCalendars(release, ['cines']);
  if (release?.type === 'arrival') {
    const slug = PLATFORMS.some((p) => p.slug === release.arrivalPlatform) ? release.arrivalPlatform : null;
    return withCalendars(release, slug ? [slug] : []);
  }

  const curated = Array.isArray(options?.platforms) ? options.platforms : [];
  const matched = new Set(curated);
  if (release?.source !== 'manual') {
    const flatrate = Array.isArray(release?.providers?.flatrate) ? release.providers.flatrate : [];
    for (const slug of [release?.releaseNote, ...flatrate].map(matchPlatform)) if (slug) matched.add(slug);
  }
  const slugs = PLATFORMS.map((p) => p.slug).filter((slug) => matched.has(slug));
  return withCalendars(release, ['digital', ...slugs]);
}

// Copy with `calendars` right after `source` (or after `type` when there is no source),
// the field order of data-model §2
function withCalendars(release, calendars) {
  const entries = Object.entries(release ?? {}).filter(([key]) => key !== 'calendars');
  const anchor = entries.some(([key]) => key === 'source') ? 'source' : 'type';
  const copy = {};
  for (const [key, value] of entries) {
    copy[key] = value;
    if (key === anchor) copy.calendars = calendars;
  }
  if (!('calendars' in copy)) copy.calendars = calendars;
  return copy;
}

/** Display name of a platform slug, or null. */
function platformName(slug) {
  return PLATFORMS.find((p) => p.slug === slug)?.name ?? null;
}

/**
 * Canonical ordered list of calendars: cines, platforms in config order, digital, all.
 * @returns {Array<{ slug: string, file: string, name: string, kind: string }>}
 */
function calendarDefinitions() {
  return [
    { slug: 'cines', file: 'horror-cines.ics', name: 'Cines', kind: 'cinema' },
    ...PLATFORMS.map((p) => ({ slug: p.slug, file: `horror-${p.slug}.ics`, name: p.name, kind: 'platform' })),
    { slug: 'digital', file: 'horror-digital.ics', name: 'Digital', kind: 'aggregate' },
    { slug: 'all', file: 'horror.ics', name: 'Todo', kind: 'legacy' },
  ];
}

// Mixes (single subscription link, §3): one file per combination of two or more
// selectable calendars, capped so the number of files stays bounded
const SELECTABLE_KINDS = ['cinema', 'platform', 'aggregate'];
const MIX_DIR = 'mix';
const MAX_MIX_CALENDARS = 12;
const MIX_SLUG = /^[a-z0-9-]+$/;
const MIX_NAMED_UP_TO = 3;
const MIX_FALLBACK_NAME = 'Mi selección';

/** Mix file of slugs already in canonical order: "mix/cines_netflix.ics". */
function mixFile(slugs) {
  return `${MIX_DIR}/${slugs.join('_')}.ics`;
}

/** Mix display name (without the "Terror — " prefix): up to three names, else "Mi selección". */
function mixName(names) {
  return names.length <= MIX_NAMED_UP_TO ? names.join(', ') : MIX_FALLBACK_NAME;
}

/**
 * Every combination of two or more selectable calendars (§3), 2^n − n − 1 of them, each
 * with its slugs and display names in canonical order.
 * @param {Array<{ slug: string, name: string, kind: string }>} [definitions] - Canonical calendars
 * @returns {Array<{ slugs: string[], file: string, name: string }>}
 * @throws when there are more than MAX_MIX_CALENDARS selectable calendars or a slug is
 *   not file-name safe (the scheme must then be redesigned, §3)
 */
function mixDefinitions(definitions = calendarDefinitions()) {
  const selectable = definitions.filter((d) => SELECTABLE_KINDS.includes(d.kind));
  if (selectable.length > MAX_MIX_CALENDARS) {
    throw new Error(`${selectable.length} selectable calendars: mixes are capped at ${MAX_MIX_CALENDARS} `
      + '(docs/data-model.md §3), the single-link scheme must be redesigned.');
  }
  for (const { slug } of selectable) {
    if (typeof slug !== 'string' || !MIX_SLUG.test(slug)) throw new Error(`Calendar slug "${slug}" cannot be used in a mix file name.`);
  }
  const mixes = [];
  for (let mask = 1; mask < 2 ** selectable.length; mask += 1) {
    const chosen = selectable.filter((_, i) => mask & (1 << i));
    if (chosen.length < 2) continue;
    const slugs = chosen.map((d) => d.slug);
    mixes.push({ slugs, file: mixFile(slugs), name: mixName(chosen.map((d) => d.name)) });
  }
  return mixes;
}

module.exports = {
  PLATFORMS,
  MIX_DIR,
  MAX_MIX_CALENDARS,
  matchPlatform,
  assignCalendars,
  calendarDefinitions,
  platformName,
  mixDefinitions,
  mixFile,
  mixName,
};
