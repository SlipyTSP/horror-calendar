# CLAUDE.md

Guía para Claude Code (local o en la nube) al trabajar en este repositorio. Léela entera
antes de tocar nada. Los documentos de `docs/` son parte de esta guía.

## Proyecto

**horror-calendar** — Script Node.js que consulta la API de TMDB semanalmente y genera
calendarios `.ics` con los estrenos de películas de terror en España (cines y plataformas
de streaming), publicados en GitHub Pages junto a una web de suscripción. El usuario se
suscribe desde iOS solo a los calendarios que le interesan.

Problema de fondo corregido en F1: la versión original mezclaba `primary_release_date`
con `region` en `discover/movie` (TMDB ignora la región en ese caso) y aceptaba casi
cualquier película, así que el calendario traía estrenos de todo el mundo. El plan está
en `docs/phases.md`; el modelo de datos, en `docs/data-model.md`.

## Comandos

```bash
npm ci                              # Instalar dependencias (usa el lockfile)
npm start                           # Ejecuta src/index.js — consulta TMDB y escribe output/
                                    # (11 .ics + 1013 mixes en output/mix/ + releases.json
                                    # + providers-snapshot.json);
                                    # exit 1 solo en los casos de §7 (nunca por altas
                                    # manuales ni llegadas)
npm test                            # Test runner nativo (node --test): tests/unit/*.test.js
node scripts/summary.js [archivo]   # Tablas Markdown de output/releases.json (o del archivo dado):
                                    # títulos y llegadas por calendario, número de mixes;
                                    # source y duración por release
node scripts/capture-fixtures.js    # Captura respuestas reales de TMDB en tests/fixtures/tmdb/
                                    # (necesita key; lo ejecuta el propietario, nunca CI)
```

La API key se lee de `.env` (ver `.env.example`, con todas las variables de §7). En CI va
por `secrets.TMDB_API_KEY`; ambos workflows pasan `SNAPSHOT_URL` con la copia publicada de
`providers-snapshot.json`. En local, sin `SNAPSHOT_URL`, las llegadas van en modo semilla.

Vista previa local de la web: `cp tests/fixtures/releases.sample.json site/releases.json`
y cualquier servidor estático sobre `site/` (las copias locales están en `.gitignore`).
Para seguir los enlaces de suscripción, servir una carpeta temporal con `site/`,
`output/*.ics` y `output/mix/` (`site/mix/` no está en `.gitignore`).

## Arquitectura

```
src/
  index.js       — Entry point. main({ fetchImpl, now, env, outDir, rootDir, … }) devuelve
                   el exit code; solo se ejecuta si require.main === module (carga dotenv
                   ahí). resolveSettings → fetchHorrorReleases → altas manuales →
                   assignCalendars → llegadas → generateCalendars + generateMixes;
                   escribe los 11 .ics, vacía y rellena output/mix/ (log: número y tamaño
                   total, sin listarlos), releases.json (schema 2, §4) y
                   providers-snapshot.json (§11, siempre),
                   log de la regla de duración, preview por release y ::warning:: por
                   cada releaseNote sin alias. Manual y llegadas van en try/catch
  tmdb.js        — Cliente TMDB: resolveSettings (todas las variables de §7),
                   createContext (GET con reintentos 429/5xx y Retry-After, caché de
                   detalle por id compartida por las tres fuentes, contadores por
                   categoría), getHorrorReleases / fetchHorrorReleases (dos discover
                   regionales, un GET /movie/{id}?append_to_response=release_dates,
                   watch/providers por id, regla de duración, sinopsis EN de respaldo,
                   pool de 5, umbral del 20 % solo sobre releases tmdb), parseDetail,
                   passesRuntimeRule, compareReleases. fetch, now, env y sleep inyectables
  manual.js      — Altas manuales (§10): loadManualEntries (validación, nunca lanza),
                   buildManualReleases (ventana, detalle, regla de duración, TMDB gana
                   con ::warning:: si difieren las fechas y plataforma curada sumada)
  arrivals.js    — Llegadas (§11): readSnapshot (solo https, sin redirecciones, 5 MB
                   leídos por trozos, JSON inválido → semilla), fetchProviderIds,
                   fetchCatalogue, diffPlatform (guardas), computeArrivals (arrastre,
                   ventana ARRIVAL_DAYS, descarte del estreno anunciado, regla de
                   duración), carryForwardArrivals (si computeArrivals falla: foto
                   anterior arrastrada, vacía solo sin foto válida) y buildSnapshot.
                   Best effort
  platforms.js   — PLATFORMS (§5), matchPlatform, platformName, assignCalendars (unión
                   nota + flatrate + plataformas curadas para tmdb; solo la curada para
                   manual; arrivalPlatform para llegadas), calendarDefinitions y
                   mixDefinitions (combinaciones de 2+ seleccionables, §3: mixFile,
                   mixName; lanza con más de MAX_MIX_CALENDARS = 12)
  calendar.js    — generateCalendars(releases, { now }) → un VCALENDAR por calendario
                   (RFC 5545: folding a 75 octetos, escape, CRLF); horror.ics = cines +
                   digital, sin llegadas. generateMixes → un VCALENDAR por mix (unión,
                   cada UID una vez, orden de releases). Exporta también generateICS,
                   escapeText, foldLine, generateUID, buildDescription, buildWhereLine y
                   buildSummary (plataforma en SUMMARY, §6)
data/
  manual-releases.json — Altas manuales del propietario (§10). Los tests no lo leen
scripts/
  summary.js     — Tablas Markdown de releases.json: contadores por calendario, una
                   línea con el número de mixes (2^n − n − 1, sin listarlos) y una
                   fila por release con calendarios y nota (tolera el formato antiguo);
                   CI la vuelca en el resumen del job
  capture-fixtures.js — Captura única de respuestas TMDB (§7) a tests/fixtures/tmdb/
                   (discover, watch/providers, release_dates, detalle EN) con
                   manifest.json; sin reintentos, nunca escribe la key; imprime
                   provider_name y notas tipo 4 vistas en la región
site/
  index.html     — Web pública: marcado, meta OG/Twitter e i18n ES/EN vía data-i18n;
                   pie con créditos de TMDB y JustWatch. El deploy copia site/ entero
                   a GitHub Pages
  styles.css     — Estilos de la página (Creepster local, resto fuentes del sistema)
  selector.js    — Selector de calendarios (ES2020, sin build): lee releases.json
                   (schema 2) con URL relativa, persiste la selección en localStorage y
                   pinta un único enlace de suscripción (subscriptionFile: su archivo con
                   uno, mix/<slugs>.ics con dos o más) y la lista filtrada en el orden de
                   releases (posters, meses, insignia de llegada). La lógica pura se exporta para
                   node --test (guarda module.exports); el DOM solo si existe document
  assets/        — favicon.svg, apple-touch-icon.png (180x180) y og-image.png (1200x630)
  fonts/         — creepster-latin-400-normal.woff2 y su licencia OFL.txt
output/          — Generado por npm start: horror-cines.ics, horror-<plataforma>.ics,
                   horror-digital.ics, horror.ics, mix/<slugs>.ics (1013), releases.json
                   y providers-snapshot.json; ignorado por git
docs/
  data-model.md  — Contrato de datos entre la capa Node y la web (solo lectura)
  phases.md      — Plan de fases, reparto de ficheros y criterios de aceptación
  prototype-selector.html — Maqueta de referencia del selector de calendarios (F2)
tests/
  unit/*.test.js — Tests (node --test), sin red. site-*.test.js prueban la web sin
                   DOM importando site/selector.js en Node; site-build.test.js comprueba
                   que el archivo que ofrece el selector existe en la salida del build
  support/       — Helpers, no son tests: mock-fetch.js (fetch falso que mapea URL
                   sin api_key → fixture, graba llamadas, respuestas en cola),
                   fixture-name.js (nombre determinista de fixture por petición),
                   fixture-fetch.js (mock-fetch sobre capturadas + synthetic/, sin
                   colisiones) e ics-validator.js (validador estructural de .ics)
  fixtures/releases.sample.json — Ejemplo completo y válido de releases.json (contrato)
  fixtures/tmdb/ — Respuestas TMDB capturadas + manifest.json (solo las recaptura el
                   propietario)
  fixtures/tmdb/synthetic/ — Fixtures escritas a mano para lo que la captura no cubre
                   (detalle combinado de F4 por release capturada, lista de proveedores
                   y catálogos de llegadas, sinopsis EN, casos límite; ver su README)
.github/workflows/
  ci.yml         — PR, push a main y manual: job test (npm test) y job dry-run
                   (npm start real con SNAPSHOT_URL publicada, solo lectura; tabla en
                   el resumen, artefacto output/ 14 días)
  update-calendar.yml — Cron lunes 06:00 UTC: npm test, npm start con SNAPSHOT_URL,
                   copia site/ + output/*.ics + output/mix/ + output/releases.json +
                   output/providers-snapshot.json y deploy a GitHub Pages;
                   job keepalive que rehabilita el workflow vía API (sin commits)
```

Cada fase que cambie la estructura actualiza esta sección en el mismo PR.

## API de TMDB

- API v3 con API key como query param (`api_key`), nunca bearer token.
- Filtrado regional correcto: `discover/movie` con `region=ES` + `with_release_type` +
  `release_date.gte/lte`. **Nunca** combinar `primary_release_date.*` con `region`.
- Con región y tipo, el `release_date` devuelto es la fecha de ese tipo en esa región:
  esa es la fecha del evento.
- Solo `flatrate` de `watch/providers` (región ES) cuenta como "incluido en suscripción"
  (los tiers `ads`/`free` solo si son alias de una plataforma configurada); `rent` y `buy`
  se fusionan en `rentBuy`, se etiquetan como alquiler/compra y nunca crean pertenencia.
- Un solo detalle por película y build: `GET /movie/{id}` con `language` y
  `append_to_response=release_dates,watch/providers` (da `runtime`, `imdb_id` y, para
  digitales, providers y nota). La caché por id la comparten tmdb, manual y llegadas.
  Un detalle fallido conserva la release tmdb; el umbral del 20 % cuenta solo los
  detalles (y sinopsis EN) de releases tmdb.
- De `release_dates` solo se usa la región: `releaseNote` (nota tipo 4 cuyo día coincide
  con `releaseDate`; si ninguna, la primera tipo 4 con nota) y, en llegadas, las fechas
  tipo 4 para descartar el estreno anunciado. Nunca para inferir el tipo ni para buscar
  en otras regiones.
- Regla de duración en las tres fuentes: entra con `runtime >= MIN_RUNTIME` (40) o sin
  duración (0 = null) pero con `imdb_id`; `MIN_RUNTIME=0` la desactiva. El log lista las
  eliminadas (líneas normales).
- Altas manuales (`data/manual-releases.json`, §10): validación por entrada con
  `::warning::`; si TMDB ya fecha el estreno digital, gana TMDB y la plataforma curada se
  suma. Nunca cambian el exit code.
- Llegadas (§11): `/watch/providers/movie` → ids por alias; una discover por plataforma con
  `watch_region`, `with_watch_providers`, `flatrate`, `with_genres=27`,
  `primary_release_date.gte` (sin `region`: aquí solo acota la antigüedad) y
  `sort_by=primary_release_date.desc`; diff contra la foto de `SNAPSHOT_URL` con modo
  semilla y guardas. Best effort: todo fallo es `::warning::`.
- Pertenencia a calendarios de plataforma de una release tmdb = unión de
  `matchPlatform(releaseNote)`, `matchPlatform` de cada `flatrate` (alias en
  `src/platforms.js`) y la plataforma curada si hay alta manual del mismo id. Las altas
  manuales van solo a su plataforma curada y las llegadas solo a `arrivalPlatform`. Una
  nota sin alias se avisa con `::warning::` al final de `npm start`.
- La ventana empieza hoy (UTC), sin look-back: `WINDOW_DAYS` (1-366, def. 90) y
  `MAX_PAGES` (1-20, def. 5); un corte de paginación siempre emite `::warning::`. Las
  llegadas son el único look-back (`ARRIVAL_DAYS`, def. 30).
- Detalles exactos de queries, reintentos y límites: `docs/data-model.md` §7.

## Formato .ics

- iCalendar válido (RFC 5545): CRLF, folding a 75 octetos sin partir secuencias UTF-8,
  eventos de día completo, `METHOD:PUBLISH`, refresco de 24 h.
- UID: `tmdb-<id>-<type>@horror-calendar` (estable ante cambios de fecha o título; una
  alta manual comparte el UID `digital` con su futuro equivalente de TMDB); llegadas:
  `tmdb-<id>-arrival-<plataforma>@horror-calendar`. No volver a UIDs derivados de título
  o fecha.
- SUMMARY: título + `🎬` (cines), `📺` (digital) o `🆕` (llegada) y, en digitales y
  llegadas, la plataforma: nombres de sus calendarios de plataforma en orden de config
  unidos por ` / ` (`Título 📺 Netflix / Prime Video`; sin plataforma, `Título 📺`) o el
  de `arrivalPlatform` (`Título 🆕 HBO Max`). El mismo SUMMARY en todos los calendarios.
- Un `.ics` por calendario (`cines`, plataformas, `digital`, `all`), todos en cada build,
  vacíos incluidos; `X-WR-CALNAME` = `Terror — <nombre>` (`horror.ics`: `Terror — Todo`).
- Mixes (enlace único, §3): `mix/<slugs>.ics` para cada combinación de 2+ calendarios
  seleccionables (slugs en orden canónico unidos por `_`; 1013 con 10); unión de sus
  calendarios, cada UID una vez, en el orden de `releases`; `X-WR-CALNAME` =
  `Terror — A, B, C` hasta tres, `Terror — Mi selección` si más. No van en
  `releases.json`: la web deriva el nombre. Tope de 12 seleccionables (error claro).
- DESCRIPTION: sinopsis; línea "dónde" (`En cines` / `Ya disponible en:` para llegadas /
  `Incluido en:` / `Estreno en:` para plataformas conocidas solo por la nota o el alta
  manual / `Alquiler o compra:` / `Estreno digital`); `Fuente:` en altas manuales;
  `Más info:`. El filtrado vive solo en la capa de datos.
- `horror.ics` es un contrato con los suscriptores existentes: no se renombra ni se
  elimina y contiene cines + digital; las llegadas nunca entran en `horror.ics` ni en
  `digital`. Detalles: `docs/data-model.md` §3 y §6.

## Convenciones

- Node.js >= 20 (fetch y `node:test` nativos; CI usa Node 24). CommonJS. Sin framework.
- `dotenv` es la única dependencia de producción. No añadir dependencias de producción.
  Una devDependency solo si es imprescindible y se justifica en el PR.
- Tests con el runner nativo (`node --test`), en `tests/unit/*.test.js`. Los tests no
  hacen red: toda petición pasa por un `fetch` inyectable y fixtures en `tests/fixtures/`.
- Toda entrada numérica (variables de entorno, campos de la API) se parsea con valor por
  defecto; los campos de TMDB se tratan como opcionales.
- Line endings LF en el repo (`.gitattributes`); los `.ics` generados usan CRLF por
  exigencia del RFC y no se normalizan.
- Secretos: `.env` está en `.gitignore`. La key no aparece nunca en código, fixtures,
  logs, nombres de archivo ni descripciones de PR. No abrir `.env` en pantalla.
- Español en la narrativa y en los documentos de planificación; inglés en código,
  comentarios de código, commits, nombres de archivo y ramas. `docs/` está en inglés.

## Sesiones cloud

Las fases de `docs/phases.md` las ejecutan sesiones autónomas de Claude Code en la nube.
Reglas de cada sesión:

1. **Rama.** Trabajar en la rama que indica el prompt, creada desde `main` actualizado.
   Nunca commitear en `main`. Al terminar, abrir un pull request contra `main`.
2. **Identidad git**, antes del primer commit:
   `git config user.name SlipyTSP && git config user.email 269801722+SlipyTSP@users.noreply.github.com`
3. **Commits.** Conventional Commits en inglés, una sola línea, con scope
   (`feat(tmdb): …`, `test(calendar): …`, `ci: …`, `docs: …`, `chore: …`), atómicos.
   Sin trailers de ningún tipo (`Co-Authored-By`, `Claude-Session`, `Generated with`,
   `Signed-off-by`). Si el servicio añade un pie al PR, borrarlo.
4. **Alcance.** Solo se tocan los ficheros que la fase posee según `docs/phases.md` y el
   prompt. Si un cambio fuera de ese conjunto parece necesario, no se hace: se documenta
   en la descripción del PR. Las excepciones autorizadas van listadas en el prompt.
5. **Contrato.** `docs/data-model.md` y `tests/fixtures/releases.sample.json` son de solo
   lectura. Si la implementación no puede cumplirlos, se para y se explica en el PR.
6. **Verde antes del PR.** `npm test` completo en verde en la rama antes de abrir el PR.
   Un test de un módulo prohibido que dependa de que la fase "aún no existe" puede
   ajustarse con el cambio mínimo, y se señala en el PR.
7. **Descripción del PR**, en inglés, con estas secciones: Summary; Acceptance criteria
   (cada criterio de la fase con su evidencia: test, comando, captura de salida); Files
   touched; Deviations and open questions; How to verify (pasos para el revisor).
8. **Documentación sincronizada.** Si la fase cambia estructura, comandos o
   convenciones, actualiza este `CLAUDE.md` y los docs afectados en el mismo PR, y marca
   su fila de estado en `docs/phases.md`.
9. **Nada de red real en tests.** La sesión no tiene API key: valida con fixtures. La
   ejecución real la hace el job `dry-run` de CI sobre el PR y la revisa el propietario.
10. **Sin destrucción.** No reescribir historia, no forzar push, no borrar ramas ajenas,
    no tocar `.env`, no modificar workflows fuera del alcance de la fase.

## Decisiones vigentes

- Cadencia semanal (lunes 06:00 UTC) confirmada como suficiente.
- Un `.ics` por plataforma más `cines`, `digital` y el alias `horror.ics`; todos se
  generan siempre. Altas y bajas de plataformas se resuelven suscribiéndose o no en el
  dispositivo, no en el build.
- La sinopsis no es criterio de inclusión. Sin fecha de estreno en España no se entra: la
  fecha española sale de TMDB o, para altas manuales, de una fuente de prensa española
  (`data/manual-releases.json`). Nunca se usan fechas de otros países.
- Regla de duración (2026-10-26): solo entran películas de 40 min o más, o sin duración
  en TMDB pero con `imdb_id` (la medición del 25-oct mostró que la mitad de lo publicado
  en sep-oct eran cortos).
- Altas manuales (2026-10-26): `data/manual-releases.json` es del propietario; si TMDB ya
  fecha el estreno, gana TMDB. Se rellena desde la prensa a mano o mediante PRs que revisa
  el propietario.
- Llegadas a plataformas (2026-10-26): diff semanal del catálogo `flatrate` en ES de
  películas de terror de los últimos 3 años; solo en el calendario de su plataforma
  (nunca en `digital` ni en `horror.ics`), 30 días; la foto anterior se lee de la copia
  publicada en Pages, sin commits desde Actions.
- UID basado en ID de TMDB + tipo (las llegadas añaden la plataforma).
- La web usa solo URLs relativas (en el futuro puede servirse bajo una subruta).
- Atribución obligatoria en la web: TMDB y JustWatch (datos de disponibilidad).
