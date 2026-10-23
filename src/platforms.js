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
 * Returns a copy of the release with `calendars` set:
 * ["cines"] for theatrical; ["digital", ...platformSlugs] for digital, where the
 * platform slugs are the union of the release note and the flatrate providers,
 * without duplicates and in config order.
 * @param {object} release - Release object from src/tmdb.js
 * @returns {object}
 */
function assignCalendars(release) {
  if (release?.type === 'theatrical') return { ...release, calendars: ['cines'] };

  const flatrate = Array.isArray(release?.providers?.flatrate) ? release.providers.flatrate : [];
  const matched = new Set([release?.releaseNote, ...flatrate].map(matchPlatform).filter(Boolean));
  const slugs = PLATFORMS.map((p) => p.slug).filter((slug) => matched.has(slug));
  return { ...release, calendars: ['digital', ...slugs] };
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

module.exports = { PLATFORMS, matchPlatform, assignCalendars, calendarDefinitions };
