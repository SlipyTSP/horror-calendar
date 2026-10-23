// --- Traducciones ---
const i18n = {
  es: {
    title: 'Estrenos de Terror',
    subtitle: 'Calendario de pr\u00f3ximos estrenos de pel\u00edculas de terror. Actualizado semanalmente.',
    subscribe_title: 'Suscr\u00edbete al calendario',
    subscribe_btn: 'Suscribirse con un clic',
    ios_instructions: 'Pulsa el bot\u00f3n de arriba o ve a Ajustes \u2192 Calendario \u2192 Cuentas \u2192 A\u00f1adir cuenta \u2192 Otro \u2192 A\u00f1adir calendario suscrito y pega la URL de abajo.',
    android_instructions: 'Descarga una app compatible con calendarios .ics (como ICSx5 o Calendrier ICS) y a\u00f1ade la URL del calendario como suscripci\u00f3n.',
    gcal_instructions: 'Abre Google Calendar \u2192 Otros calendarios (+) \u2192 Desde URL \u2192 pega la URL y pulsa "A\u00f1adir calendario".',
    movies_title: 'Pr\u00f3ximos estrenos',
    loading: 'Cargando estrenos...',
    no_movies: 'No hay estrenos pr\u00f3ximos disponibles.',
    error: 'Error al cargar los estrenos.',
    stats: '<strong>{total}</strong> estrenos en los pr\u00f3ximos 90 d\u00edas',
    footer_data: 'Datos de',
    footer_source: 'C\u00f3digo en',
    badge_theatrical: 'En cines',
    badge_digital: 'Streaming',
    badge_physical: 'F\u00edsico',
    badge_unknown: 'Por confirmar',
    providers_label: 'Disponible en:',
    date_locale: 'es-ES',
  },
  en: {
    title: 'Horror Releases',
    subtitle: 'Upcoming horror movie releases calendar. Updated weekly.',
    subscribe_title: 'Subscribe to the calendar',
    subscribe_btn: 'Subscribe with one click',
    ios_instructions: 'Tap the button above or go to Settings \u2192 Calendar \u2192 Accounts \u2192 Add Account \u2192 Other \u2192 Add Subscribed Calendar and paste the URL below.',
    android_instructions: 'Download an app that supports .ics calendars (like ICSx5 or Calendrier ICS) and add the calendar URL as a subscription.',
    gcal_instructions: 'Open Google Calendar \u2192 Other calendars (+) \u2192 From URL \u2192 paste the URL and click "Add calendar".',
    movies_title: 'Upcoming releases',
    loading: 'Loading releases...',
    no_movies: 'No upcoming releases available.',
    error: 'Error loading releases.',
    stats: '<strong>{total}</strong> releases in the next 90 days',
    footer_data: 'Data from',
    footer_source: 'Source on',
    badge_theatrical: 'Theatrical',
    badge_digital: 'Streaming',
    badge_physical: 'Physical',
    badge_unknown: 'TBC',
    providers_label: 'Available on:',
    date_locale: 'en-US',
  }
};

let currentLang = 'es';
let releasesData = null;

// --- Inicializar URLs ---
const baseUrl = window.location.href.replace(/\/?(index\.html)?$/, '');
const icsUrl = baseUrl + '/horror.ics';
const webcalUrl = icsUrl.replace(/^https?:/, 'webcal:');

document.getElementById('cal-url').textContent = icsUrl;
document.getElementById('webcal-btn').href = webcalUrl;

// --- i18n ---
function applyLang(lang) {
  currentLang = lang;
  const strings = i18n[lang];

  // Actualizar textos de la interfaz
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    if (strings[key]) el.textContent = strings[key];
  });

  // Actualizar botones de idioma
  document.querySelectorAll('.lang-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.lang === lang);
  });

  // Re-renderizar stats y películas si tenemos datos
  if (releasesData) {
    renderStats(releasesData);
    renderMovies(releasesData);
  }
}

document.querySelectorAll('.lang-btn').forEach(btn => {
  btn.addEventListener('click', () => applyLang(btn.dataset.lang));
});

// --- Stats ---
function renderStats(data) {
  const t = i18n[currentLang];
  document.getElementById('stats').innerHTML = t.stats.replace('{total}', data.total);
}

// --- Renderizar películas ---
function formatDate(dateStr) {
  const locale = i18n[currentLang].date_locale;
  const date = new Date(dateStr + 'T00:00:00');
  return date.toLocaleDateString(locale, {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });
}

function getBadge(releaseType) {
  const t = i18n[currentLang];
  const config = {
    theatrical: { emoji: '\uD83C\uDFAC', label: t.badge_theatrical, cls: 'badge-theatrical' },
    digital:    { emoji: '\uD83D\uDCFA', label: t.badge_digital,    cls: 'badge-digital' },
    physical:   { emoji: '\uD83D\uDCBF', label: t.badge_physical,   cls: 'badge-physical' },
  };
  const c = config[releaseType] || { emoji: '\u2753', label: t.badge_unknown, cls: 'badge-unknown' };
  return '<span class="movie-badge ' + c.cls + '">' + c.emoji + ' ' + c.label + '</span>';
}

function renderMovies(data) {
  const container = document.getElementById('movie-list');
  const t = i18n[currentLang];

  if (!data.releases || data.releases.length === 0) {
    container.innerHTML = '<div class="loading"><p>' + t.no_movies + '</p></div>';
    return;
  }

  // Ordenar por fecha
  const sorted = [...data.releases].sort((a, b) => a.releaseDate.localeCompare(b.releaseDate));

  let html = '<div class="movie-list">';
  for (const movie of sorted) {
    const providers = movie.providers && movie.providers.length > 0
      ? '<p class="movie-providers">' + t.providers_label + ' ' + movie.providers.join(', ') + '</p>'
      : '';

    const overview = movie.overview
      ? '<p class="movie-overview">' + escapeHtml(movie.overview) + '</p>'
      : '';

    html += '<article class="movie-card">'
      + '<div class="movie-header">'
        + '<div class="movie-title"><a href="' + escapeHtml(movie.tmdbUrl) + '" target="_blank" rel="noopener">' + escapeHtml(movie.title) + '</a></div>'
        + getBadge(movie.releaseType)
      + '</div>'
      + '<div class="movie-date">' + formatDate(movie.releaseDate) + '</div>'
      + overview
      + providers
    + '</article>';
  }
  html += '</div>';

  container.innerHTML = html;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// --- Cargar datos ---
fetch('releases.json')
  .then(res => {
    if (!res.ok) throw new Error(res.status);
    return res.json();
  })
  .then(data => {
    releasesData = data;
    renderStats(data);
    renderMovies(data);
  })
  .catch(() => {
    const t = i18n[currentLang];
    document.getElementById('movie-list').innerHTML =
      '<div class="loading"><p>' + t.error + '</p></div>';
  });
