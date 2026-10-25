/*
 * Horror calendar selector — plain ES2020, no build step, no dependencies.
 *
 * Reads releases.json (docs/data-model.md §4) with a relative URL, lets the user pick
 * calendars (cinemas, platforms, digital aggregate), offers a webcal:// button and a
 * copyable https URL per selected calendar, and filters the release list.
 *
 * Local preview (both copies are ignored by git):
 *   cp tests/fixtures/releases.sample.json site/releases.json
 *   npx --yes serve site      # or: python3 -m http.server -d site 8000
 *
 * The pure logic is exported for node --test (tests/unit/site-selector.test.js); the
 * code that touches the DOM only runs when `document` exists.
 */
(function () {
  'use strict';

  const SCHEMA_VERSION = 1;
  const STORAGE_KEY = 'horror-calendar:selection';
  const DEFAULT_SELECTION = ['cines'];
  const SELECTABLE_KINDS = ['cinema', 'platform', 'aggregate'];
  const LEGACY_FILE = 'horror.ics';
  const POSTER_BASE = 'https://image.tmdb.org/t/p/w342';

  // --- Translations ---
  const I18N = {
    es: {
      title: 'Estrenos de Terror',
      subtitle: 'Estrenos de películas de terror en España, en cines y plataformas. Elige qué quieres seguir: cada opción es un calendario independiente.',
      stats_one: '{total} estreno de terror en los próximos meses',
      stats_other: '{total} estrenos de terror en los próximos meses',
      generated: 'Actualizado el {date}',
      picker_title: '1 · Elige tus calendarios',
      picker_hint: 'Marca los cines y las plataformas que tienes. «Digital» incluye todos los estrenos digitales, también los de alquiler o compra.',
      picker_unavailable: 'No se ha podido cargar la lista de calendarios.',
      count_one: '{count} estreno',
      count_other: '{count} estrenos',
      subscribe_title: '2 · Suscríbete a lo elegido',
      subscribe_empty: 'Marca arriba al menos un calendario.',
      subscribe_btn: 'Suscribirse',
      copy_btn: 'Copiar URL',
      copied: 'Copiada',
      copy_manual: 'URL seleccionada: cópiala',
      ios_instructions: 'Pulsa «Suscribirse» en cada calendario o ve a Ajustes → Calendario → Cuentas → Añadir cuenta → Otro → Añadir calendario suscrito y pega su URL.',
      android_instructions: 'Descarga una app compatible con calendarios .ics (como ICSx5 o Calendrier ICS) y añade la URL de cada calendario como suscripción.',
      gcal_instructions: 'Abre Google Calendar → Otros calendarios (+) → Desde URL → pega la URL y pulsa «Añadir calendario».',
      classic_text: '¿Ya estabas suscrito? El calendario clásico con todos los estrenos (cines y digital) sigue funcionando.',
      classic_link: 'Calendario clásico completo',
      movies_title: 'Próximos estrenos de tu selección',
      loading: 'Cargando estrenos...',
      no_selection: 'Marca al menos un calendario para ver sus estrenos.',
      no_movies: 'No hay estrenos próximos en los calendarios elegidos.',
      error: 'No se han podido cargar los estrenos. Inténtalo más tarde.',
      error_schema: 'Los datos publicados tienen un formato que esta página no reconoce. Inténtalo más tarde.',
      badge_rentbuy: 'Alquiler/compra',
      footer_data: 'Datos de',
      footer_source: 'Código en',
      date_locale: 'es-ES',
    },
    en: {
      title: 'Horror Releases',
      subtitle: 'Horror movie releases in Spain, in cinemas and on streaming platforms. Pick what you want to follow: each option is a separate calendar.',
      stats_one: '{total} horror release in the coming months',
      stats_other: '{total} horror releases in the coming months',
      generated: 'Updated {date}',
      picker_title: '1 · Pick your calendars',
      picker_hint: 'Tick the cinemas and the platforms you have. “Digital” includes every digital release, rentals and purchases too.',
      picker_unavailable: 'The list of calendars could not be loaded.',
      count_one: '{count} release',
      count_other: '{count} releases',
      subscribe_title: '2 · Subscribe to your picks',
      subscribe_empty: 'Tick at least one calendar above.',
      subscribe_btn: 'Subscribe',
      copy_btn: 'Copy URL',
      copied: 'Copied',
      copy_manual: 'URL selected: copy it',
      ios_instructions: 'Tap “Subscribe” on each calendar or go to Settings → Calendar → Accounts → Add Account → Other → Add Subscribed Calendar and paste its URL.',
      android_instructions: 'Download an app that supports .ics calendars (like ICSx5 or Calendrier ICS) and add each calendar URL as a subscription.',
      gcal_instructions: 'Open Google Calendar → Other calendars (+) → From URL → paste the URL and click “Add calendar”.',
      classic_text: 'Already subscribed? The classic calendar with every release (cinemas and digital) keeps working.',
      classic_link: 'Classic full calendar',
      movies_title: 'Upcoming releases in your selection',
      loading: 'Loading releases...',
      no_selection: 'Tick at least one calendar to see its releases.',
      no_movies: 'No upcoming releases in the selected calendars.',
      error: 'Releases could not be loaded. Please try again later.',
      error_schema: 'The published data has a format this page does not recognise. Please try again later.',
      badge_rentbuy: 'Rent/buy',
      footer_data: 'Data from',
      footer_source: 'Source on',
      date_locale: 'en-US',
    },
  };

  const LANGS = Object.keys(I18N);

  function translate(lang, key, vars) {
    const table = I18N[lang] || I18N.es;
    let text = Object.prototype.hasOwnProperty.call(table, key) ? table[key]
      : Object.prototype.hasOwnProperty.call(I18N.es, key) ? I18N.es[key] : key;
    if (vars) {
      text = text.replace(/\{(\w+)\}/g, (match, name) =>
        Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match);
    }
    return text;
  }

  function plural(lang, baseKey, n, vars) {
    return translate(lang, baseKey + (n === 1 ? '_one' : '_other'), vars);
  }

  // --- Data validation ---
  function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  // Only plain relative paths: no scheme, no leading slash, no "..".
  function isRelativeFile(file) {
    return typeof file === 'string' && /^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)*$/.test(file)
      && !file.split('/').some((part) => part === '..' || part === '.');
  }

  function validateData(data) {
    if (!isObject(data)) return { ok: false, reason: 'shape' };
    if (data.schema !== SCHEMA_VERSION) return { ok: false, reason: 'schema' };
    return { ok: true };
  }

  function listCalendars(data) {
    const list = isObject(data) && Array.isArray(data.calendars) ? data.calendars : [];
    return list.filter((c) => isObject(c) && typeof c.slug === 'string' && c.slug !== ''
      && isRelativeFile(c.file));
  }

  function selectableCalendars(data) {
    return listCalendars(data).filter((c) => SELECTABLE_KINDS.includes(c.kind));
  }

  function legacyFile(data) {
    const legacy = listCalendars(data).find((c) => c.kind === 'legacy');
    return legacy ? legacy.file : LEGACY_FILE;
  }

  function listReleases(data) {
    const list = isObject(data) && Array.isArray(data.releases) ? data.releases : [];
    return list.filter(isObject);
  }

  function countOf(calendar) {
    const n = Number(calendar && calendar.count);
    return Number.isInteger(n) && n >= 0 ? n : 0;
  }

  // --- Selection state ---
  // `knownSlugs` (optional) drops slugs that are not offered; without it (data not
  // loaded) every string slug is kept so a failed load never erases the stored choice.
  function sanitizeSelection(slugs, knownSlugs) {
    if (!Array.isArray(slugs)) return null;
    const known = Array.isArray(knownSlugs) ? new Set(knownSlugs) : null;
    const out = [];
    for (const slug of slugs) {
      if (typeof slug !== 'string' || out.includes(slug)) continue;
      if (known && !known.has(slug)) continue;
      out.push(slug);
    }
    return out;
  }

  function loadSelection(storage, knownSlugs) {
    let raw = null;
    try {
      raw = storage ? storage.getItem(STORAGE_KEY) : null;
    } catch (err) {
      raw = null;
    }
    let parsed = null;
    if (typeof raw === 'string') {
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        parsed = null;
      }
    }
    return sanitizeSelection(parsed, knownSlugs) || sanitizeSelection(DEFAULT_SELECTION, knownSlugs);
  }

  function saveSelection(storage, slugs) {
    try {
      if (!storage) return false;
      storage.setItem(STORAGE_KEY, JSON.stringify(slugs));
      return true;
    } catch (err) {
      return false;
    }
  }

  // Returns a new selection in the canonical order of `orderSlugs`; slugs outside that
  // order (data not loaded yet) are kept at the end.
  function toggleSelection(selection, slug, checked, orderSlugs) {
    const set = new Set(selection);
    if (checked) set.add(slug); else set.delete(slug);
    const order = Array.isArray(orderSlugs) ? orderSlugs : [];
    return order.filter((s) => set.has(s)).concat([...set].filter((s) => !order.includes(s)));
  }

  // --- Filtering and badges ---
  function compareReleases(a, b) {
    const da = typeof a.releaseDate === 'string' ? a.releaseDate : '';
    const db = typeof b.releaseDate === 'string' ? b.releaseDate : '';
    if (da !== db) return da < db ? -1 : 1;
    const ta = typeof a.title === 'string' ? a.title : '';
    const tb = typeof b.title === 'string' ? b.title : '';
    return ta.localeCompare(tb);
  }

  function filterReleases(releases, selection) {
    const selected = new Set(Array.isArray(selection) ? selection : []);
    return (Array.isArray(releases) ? releases : [])
      .filter((r) => isObject(r) && Array.isArray(r.calendars)
        && r.calendars.some((slug) => selected.has(slug)))
      .sort(compareReleases);
  }

  function hasRentBuyOnly(release, calendars) {
    const rentBuy = isObject(release.providers) && Array.isArray(release.providers.rentBuy)
      ? release.providers.rentBuy : [];
    if (rentBuy.length === 0) return false;
    const platforms = new Set((calendars || []).filter((c) => c.kind === 'platform').map((c) => c.slug));
    const slugs = Array.isArray(release.calendars) ? release.calendars : [];
    return !slugs.some((slug) => platforms.has(slug));
  }

  // Badges in canonical calendar order; slugs missing from `calendars` are skipped.
  function releaseBadges(release, calendars) {
    const slugs = new Set(Array.isArray(release.calendars) ? release.calendars : []);
    const badges = (calendars || [])
      .filter((c) => slugs.has(c.slug) && c.kind !== 'legacy')
      .map((c) => ({ kind: c.kind, slug: c.slug, label: typeof c.name === 'string' && c.name ? c.name : c.slug }));
    if (hasRentBuyOnly(release, calendars)) badges.push({ kind: 'rentbuy', slug: null, label: null });
    return badges;
  }

  // --- URLs ---
  function buildCalendarUrls(file, base) {
    if (!isRelativeFile(file)) return null;
    let url;
    try {
      url = new URL(file, base);
    } catch (err) {
      return null;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    const https = url.href;
    return { https, webcal: https.replace(/^https?:/, 'webcal:') };
  }

  function safeExternalUrl(value) {
    if (typeof value !== 'string') return null;
    try {
      const url = new URL(value);
      return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
    } catch (err) {
      return null;
    }
  }

  // --- Posters ---
  // Only a single TMDB-style file name ("/abc_D-1.jpg") is accepted: no extra slashes,
  // no "..", no scheme, so the result can only ever point at image.tmdb.org.
  function posterUrl(posterPath) {
    if (typeof posterPath !== 'string') return null;
    if (!/^\/[A-Za-z0-9_-]+\.(jpg|jpeg|png|webp)$/.test(posterPath)) return null;
    return POSTER_BASE + posterPath;
  }

  // --- Dates ---
  // YYYY-MM-DD parsed as a local date: new Date('YYYY-MM-DD') would be UTC midnight and
  // show the previous day west of Greenwich.
  function parseLocalDate(value) {
    const m = typeof value === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(value) : null;
    if (!m) return null;
    const date = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return date.getMonth() === Number(m[2]) - 1 ? date : null;
  }

  function formatReleaseDate(value, locale) {
    const date = parseLocalDate(value);
    if (!date) return typeof value === 'string' ? value : '';
    return date.toLocaleDateString(locale, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  }

  function formatGenerated(value, locale) {
    if (typeof value !== 'string') return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleString(locale, { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  const api = {
    SCHEMA_VERSION,
    STORAGE_KEY,
    DEFAULT_SELECTION,
    I18N,
    LANGS,
    translate,
    plural,
    isRelativeFile,
    validateData,
    selectableCalendars,
    legacyFile,
    listReleases,
    countOf,
    sanitizeSelection,
    loadSelection,
    saveSelection,
    toggleSelection,
    filterReleases,
    hasRentBuyOnly,
    releaseBadges,
    buildCalendarUrls,
    safeExternalUrl,
    parseLocalDate,
    formatReleaseDate,
    formatGenerated,
    posterUrl,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof document !== 'undefined') initPage();

  // --- DOM ---
  function initPage() {
    const state = {
      lang: 'es',
      status: 'loading', // loading | ready | error
      errorReason: null,
      data: null,
      selection: [],
    };

    const storage = (() => {
      try {
        return window.localStorage;
      } catch (err) {
        return null;
      }
    })();

    const $ = (id) => document.getElementById(id);
    const t = (key, vars) => translate(state.lang, key, vars);

    function el(tag, props, children) {
      const node = document.createElement(tag);
      if (props) {
        for (const [key, value] of Object.entries(props)) {
          if (value === null || value === undefined || value === false) continue;
          if (key === 'className') node.className = value;
          else if (key === 'text') node.textContent = value;
          else node.setAttribute(key, value === true ? '' : value);
        }
      }
      for (const child of children || []) {
        if (child) node.appendChild(child);
      }
      return node;
    }

    function message(text, extraClass) {
      return el('p', { className: 'message' + (extraClass ? ' ' + extraClass : ''), text });
    }

    function calendars() {
      return state.status === 'ready' ? selectableCalendars(state.data) : [];
    }

    // Copies `url`; falls back to selecting the text of `target` when the clipboard API
    // is missing (http preview, old browsers) or refuses.
    function copyUrl(url, target, feedback) {
      const show = (key) => {
        feedback.textContent = t(key);
        clearTimeout(feedback._timer);
        feedback._timer = setTimeout(() => { feedback.textContent = ''; }, 2500);
      };
      const selectText = () => {
        try {
          const range = document.createRange();
          range.selectNodeContents(target);
          const sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
        } catch (err) {
          // Nothing else to do: the URL stays visible for manual copy.
        }
        show('copy_manual');
      };
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        navigator.clipboard.writeText(url).then(() => show('copied'), selectText);
      } else {
        selectText();
      }
    }

    function subscriptionRow(name, file, extraClass) {
      const urls = buildCalendarUrls(file, location.href);
      if (!urls) return null;
      const code = el('code', { className: 'cal-url', text: urls.https });
      const feedback = el('span', { className: 'copy-feedback', 'aria-live': 'polite' });
      const copy = el('button', { type: 'button', className: 'copy-btn', text: t('copy_btn') });
      copy.addEventListener('click', () => copyUrl(urls.https, code, feedback));
      return el('div', { className: 'sub-card' + (extraClass ? ' ' + extraClass : '') }, [
        el('div', { className: 'sub-head' }, [
          el('span', { className: 'sub-name', text: name }),
          el('a', { className: 'webcal-btn', href: urls.webcal, text: '📅 ' + t('subscribe_btn') }),
        ]),
        code,
        el('div', { className: 'sub-actions' }, [copy, feedback]),
      ]);
    }

    function renderStatic() {
      document.documentElement.lang = state.lang;
      document.querySelectorAll('[data-i18n]').forEach((node) => {
        node.textContent = t(node.getAttribute('data-i18n'));
      });
      document.querySelectorAll('.lang-btn').forEach((btn) => {
        const active = btn.dataset.lang === state.lang;
        btn.classList.toggle('active', active);
        btn.setAttribute('aria-pressed', String(active));
      });
    }

    function renderStats() {
      const stats = $('stats');
      const generated = $('generated');
      if (state.status !== 'ready') {
        stats.textContent = '';
        generated.textContent = '';
        return;
      }
      const total = listReleases(state.data).length;
      stats.textContent = plural(state.lang, 'stats', total, { total });
      const date = formatGenerated(state.data.generated, t('date_locale'));
      generated.textContent = date ? t('generated', { date }) : '';
    }

    function renderSelector() {
      const box = $('selector');
      box.replaceChildren();
      if (state.status === 'loading') return;
      const list = calendars();
      if (list.length === 0) {
        box.appendChild(message(t('picker_unavailable')));
        return;
      }
      const order = list.map((c) => c.slug);
      for (const cal of list) {
        const count = countOf(cal);
        const input = el('input', { type: 'checkbox', value: cal.slug, checked: state.selection.includes(cal.slug) });
        input.addEventListener('change', () => {
          state.selection = toggleSelection(state.selection, cal.slug, input.checked, order);
          saveSelection(storage, state.selection);
          renderSubscriptions();
          renderMovies();
        });
        box.appendChild(el('label', { className: 'sel sel-' + cal.kind + (count === 0 ? ' is-empty' : '') }, [
          input,
          el('span', { className: 'sel-name', text: typeof cal.name === 'string' && cal.name ? cal.name : cal.slug }),
          el('span', { className: 'sel-count', text: plural(state.lang, 'count', count, { count }) }),
        ]));
      }
    }

    function renderSubscriptions() {
      const box = $('subs');
      box.replaceChildren();
      if (state.status === 'loading') return;
      const chosen = calendars().filter((c) => state.selection.includes(c.slug));
      if (chosen.length === 0) {
        if (state.status === 'ready') box.appendChild(message(t('subscribe_empty')));
        return;
      }
      for (const cal of chosen) {
        const row = subscriptionRow(typeof cal.name === 'string' && cal.name ? cal.name : cal.slug, cal.file);
        if (row) box.appendChild(row);
      }
    }

    function renderClassic() {
      const box = $('classic');
      box.replaceChildren();
      const file = state.status === 'ready' ? legacyFile(state.data) : LEGACY_FILE;
      const row = subscriptionRow(t('classic_link'), file, 'sub-classic');
      if (row) box.appendChild(row);
    }

    function badgeNode(badge) {
      if (badge.kind === 'rentbuy') return el('span', { className: 'movie-badge badge-rentbuy', text: t('badge_rentbuy') });
      return el('span', { className: 'movie-badge badge-' + badge.kind, text: badge.label });
    }

    function movieCard(release, allCalendars) {
      const title = typeof release.title === 'string' && release.title ? release.title : String(release.id || '');
      const href = safeExternalUrl(release.tmdbUrl);
      const titleNode = href
        ? el('a', { href, target: '_blank', rel: 'noopener', text: title })
        : el('span', { text: title });
      const badges = releaseBadges(release, allCalendars).map(badgeNode);
      const overview = typeof release.overview === 'string' && release.overview
        ? el('p', { className: 'movie-overview', text: release.overview }) : null;
      return el('article', { className: 'movie-card' }, [
        el('div', { className: 'movie-header' }, [
          el('h3', { className: 'movie-title' }, [titleNode]),
          el('div', { className: 'movie-badges' }, badges),
        ]),
        el('div', { className: 'movie-date', text: formatReleaseDate(release.releaseDate, t('date_locale')) }),
        overview,
      ]);
    }

    function renderMovies() {
      const box = $('movie-list');
      box.replaceChildren();
      if (state.status === 'loading') {
        box.appendChild(el('div', { className: 'loading' }, [
          el('div', { className: 'spinner' }),
          el('p', { text: t('loading') }),
        ]));
        return;
      }
      if (state.status === 'error') {
        box.appendChild(message(t(state.errorReason === 'schema' ? 'error_schema' : 'error'), 'message-error'));
        return;
      }
      if (state.selection.length === 0) {
        box.appendChild(message(t('no_selection')));
        return;
      }
      const all = isObject(state.data) && Array.isArray(state.data.calendars)
        ? state.data.calendars.filter((c) => isObject(c) && typeof c.slug === 'string') : [];
      const list = filterReleases(listReleases(state.data), state.selection);
      if (list.length === 0) {
        box.appendChild(message(t('no_movies')));
        return;
      }
      box.appendChild(el('div', { className: 'movie-list' }, list.map((r) => movieCard(r, all))));
    }

    function renderAll() {
      renderStatic();
      renderStats();
      renderSelector();
      renderSubscriptions();
      renderClassic();
      renderMovies();
    }

    document.querySelectorAll('.lang-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (!LANGS.includes(btn.dataset.lang)) return;
        state.lang = btn.dataset.lang;
        renderAll();
      });
    });

    state.selection = loadSelection(storage);
    renderAll();

    fetch('releases.json', { cache: 'no-cache' })
      .then((res) => {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then((data) => {
        const check = validateData(data);
        if (!check.ok) {
          state.status = 'error';
          state.errorReason = check.reason;
          return;
        }
        state.data = data;
        state.status = 'ready';
        state.selection = loadSelection(storage, selectableCalendars(data).map((c) => c.slug));
      })
      .catch(() => {
        state.status = 'error';
        state.errorReason = 'fetch';
      })
      .then(renderAll);
  }
})();
