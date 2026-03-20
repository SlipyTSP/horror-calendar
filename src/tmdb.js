// Módulo para consultar la API de TMDB (discover/movie con género Horror)
// Usa fetch nativo de Node.js 18+ — sin dependencias externas

const BASE_URL = 'https://api.themoviedb.org/3';

// Género 27 = Horror en TMDB
const HORROR_GENRE_ID = 27;

// Tipos de estreno en TMDB (endpoint /movie/{id}/release_dates)
// 1 = Premiere, 2 = Theatrical (limited), 3 = Theatrical,
// 4 = Digital, 5 = Physical, 6 = TV
const RELEASE_TYPE = {
  PREMIERE: 1,
  THEATRICAL_LIMITED: 2,
  THEATRICAL: 3,
  DIGITAL: 4,
  PHYSICAL: 5,
  TV: 6,
};

// Agrupamos los tipos en categorías para mostrar en el calendario
// "theatrical" = se estrena en cines, "digital" = plataformas online/streaming
const THEATRICAL_TYPES = [RELEASE_TYPE.PREMIERE, RELEASE_TYPE.THEATRICAL_LIMITED, RELEASE_TYPE.THEATRICAL];
const DIGITAL_TYPES = [RELEASE_TYPE.DIGITAL, RELEASE_TYPE.TV];

// Incluimos todos los tipos en el filtro de discover/movie
const RELEASE_TYPES = '1|2|3|4|5|6';

/**
 * Construye la URL con query params para el endpoint dado
 * @param {string} path - Ruta del endpoint (ej: /discover/movie)
 * @param {Record<string, string>} params - Parámetros de consulta
 * @returns {string} URL completa
 */
function buildUrl(path, params) {
  const url = new URL(`${BASE_URL}${path}`);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

/**
 * Hace una petición GET a la API de TMDB y devuelve el JSON parseado
 * @param {string} path - Ruta del endpoint
 * @param {Record<string, string>} params - Parámetros adicionales
 * @returns {Promise<object>} Respuesta JSON
 */
async function tmdbGet(path, params = {}) {
  const apiKey = process.env.TMDB_API_KEY;
  if (!apiKey) {
    throw new Error('Falta la variable de entorno TMDB_API_KEY. Revisa tu archivo .env');
  }

  // Añadimos la API key a todos los requests
  const allParams = { api_key: apiKey, ...params };
  const url = buildUrl(path, allParams);

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Error de TMDB (${response.status}): ${response.statusText} — ${url}`);
  }

  return response.json();
}

/**
 * Calcula las fechas límite: desde hoy hasta dentro de 90 días
 * @returns {{ from: string, to: string }} Fechas en formato YYYY-MM-DD
 */
function getDateRange() {
  const today = new Date();
  const in90Days = new Date(today);
  in90Days.setDate(today.getDate() + 90);

  // Formateamos a YYYY-MM-DD
  const from = today.toISOString().split('T')[0];
  const to = in90Days.toISOString().split('T')[0];
  return { from, to };
}

/**
 * Obtiene los proveedores de streaming/alquiler/compra para una película
 * @param {number} movieId - ID de la película en TMDB
 * @param {string} region - Código de región (ES, US, MX, etc.)
 * @returns {Promise<string[]>} Lista de nombres de plataformas
 */
async function getWatchProviders(movieId, region) {
  try {
    const data = await tmdbGet(`/movie/${movieId}/watch/providers`);
    const regionData = data.results?.[region];

    if (!regionData) return [];

    // Recopilamos proveedores de todas las categorías disponibles:
    // flatrate (suscripción), rent (alquiler), buy (compra)
    const providers = new Set();
    for (const type of ['flatrate', 'rent', 'buy']) {
      if (regionData[type]) {
        for (const provider of regionData[type]) {
          providers.add(provider.provider_name);
        }
      }
    }

    return [...providers];
  } catch {
    // Si falla la consulta de proveedores, no bloqueamos el flujo principal
    return [];
  }
}

/**
 * Obtiene el tipo de estreno de una película para una región dada
 * Consulta /movie/{id}/release_dates y busca en orden: ES, GB, FR, DE, US
 * (Europa primero, US como último recurso para mayor cobertura)
 *
 * Devuelve una categoría simplificada:
 * - "theatrical" → estreno en cines (tipos 1, 2, 3)
 * - "digital"    → estreno digital/streaming (tipos 4, 6)
 * - "physical"   → estreno físico (tipo 5)
 * - null         → no se pudo determinar
 *
 * @param {number} movieId - ID de la película en TMDB
 * @param {string} region - Código de región principal (ES, MX, AR, etc.)
 * @returns {Promise<string|null>} Categoría de estreno
 */
async function getReleaseType(movieId, region) {
  try {
    const data = await tmdbGet(`/movie/${movieId}/release_dates`);
    const results = data.results || [];

    // Buscamos en orden: región principal, Europa occidental, US como último recurso
    const regionsToCheck = [region, 'GB', 'FR', 'DE', 'US'];
    for (const reg of regionsToCheck) {
      const entry = results.find((r) => r.iso_3166_1 === reg);
      if (!entry || !entry.release_dates?.length) continue;

      const types = entry.release_dates.map((rd) => rd.type);

      // Priorizamos: si hay estreno en cines, eso es lo principal
      if (types.some((t) => THEATRICAL_TYPES.includes(t))) return 'theatrical';
      // Si no, comprobamos digital/streaming
      if (types.some((t) => DIGITAL_TYPES.includes(t))) return 'digital';
      // Estreno solo en formato físico
      if (types.includes(RELEASE_TYPE.PHYSICAL)) return 'physical';
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Intenta obtener la sinopsis en inglés como fallback cuando no hay
 * descripción en el idioma principal
 * @param {number} movieId - ID de la película en TMDB
 * @returns {Promise<string>} Sinopsis en inglés o cadena vacía
 */
async function getEnglishOverview(movieId) {
  try {
    const data = await tmdbGet(`/movie/${movieId}`, { language: 'en-US' });
    return data.overview || '';
  } catch {
    return '';
  }
}

/**
 * Recorre todas las páginas de resultados de discover/movie
 * TMDB pagina los resultados (máx 20 por página)
 * @param {Record<string, string>} params - Parámetros de la consulta
 * @returns {Promise<object[]>} Array con todos los resultados combinados
 */
async function fetchAllPages(params) {
  const allResults = [];

  // Primera petición para saber cuántas páginas hay
  const firstPage = await tmdbGet('/discover/movie', { ...params, page: '1' });
  allResults.push(...firstPage.results);

  // Limitamos a 5 páginas (100 películas) para no abusar de la API
  const totalPages = Math.min(firstPage.total_pages, 5);

  for (let page = 2; page <= totalPages; page++) {
    const data = await tmdbGet('/discover/movie', { ...params, page: String(page) });
    allResults.push(...data.results);
  }

  return allResults;
}

/**
 * Función principal: obtiene los estrenos de películas de terror
 * en los próximos 90 días (cines + plataformas online)
 *
 * Para cada película obtiene:
 * - Proveedores de streaming (watch/providers)
 * - Tipo de estreno: theatrical, digital o physical (release_dates)
 * - Sinopsis en inglés como fallback si no hay en el idioma principal
 *
 * @returns {Promise<Array<{
 *   title: string,
 *   releaseDate: string,
 *   overview: string,
 *   providers: string[],
 *   releaseType: string|null,
 *   tmdbUrl: string
 * }>>} Array de películas con sus datos
 */
async function getHorrorReleases() {
  const language = process.env.TMDB_LANGUAGE || 'es-ES';
  const region = process.env.TMDB_REGION || 'ES';
  const { from, to } = getDateRange();

  // Parámetros para discover/movie:
  // - with_genres=27 → solo horror
  // - sort_by=primary_release_date.asc → ordenadas por fecha de estreno
  // - primary_release_date.gte/lte → ventana de 90 días
  // - with_release_type → todos los tipos (cine, digital, TV, etc.)
  // - region → para fechas de estreno locales
  const params = {
    language,
    region,
    with_genres: String(HORROR_GENRE_ID),
    sort_by: 'primary_release_date.asc',
    'primary_release_date.gte': from,
    'primary_release_date.lte': to,
    with_release_type: RELEASE_TYPES,
  };

  // Obtenemos todas las películas paginadas
  const movies = await fetchAllPages(params);

  // Para cada película consultamos proveedores, tipo de estreno y sinopsis fallback
  // Usamos Promise.all para paralelizar las peticiones por película
  const releases = await Promise.all(
    movies.map(async (movie) => {
      // Lanzamos las 3 consultas en paralelo para cada película
      const [providers, releaseType, englishOverview] = await Promise.all([
        getWatchProviders(movie.id, region),
        getReleaseType(movie.id, region),
        // Solo pedimos la sinopsis en inglés si no hay en el idioma principal
        movie.overview ? Promise.resolve('') : getEnglishOverview(movie.id),
      ]);

      // Usamos la sinopsis original, o la inglesa como fallback
      const overview = movie.overview || englishOverview;

      return {
        title: movie.title,
        releaseDate: movie.release_date,
        overview,
        providers,
        releaseType,
        tmdbUrl: `https://www.themoviedb.org/movie/${movie.id}`,
      };
    })
  );

  // Filtro suave: excluimos solo películas sin absolutamente ninguna información
  // - Incluir si tiene providers en ES (streaming confirmado)
  // - Incluir si tiene releaseType (estreno confirmado en ES/GB/FR/DE/US)
  // - Incluir si al menos tiene sinopsis (puede ser relevante para España)
  // - Excluir solo si no tiene nada: sin releaseType, sin providers y sin overview
  const filtered = releases.filter((r) =>
    r.releaseType !== null || r.providers.length > 0 || r.overview
  );

  return filtered;
}

module.exports = { getHorrorReleases };
