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
                                    # (11 .ics + releases.json); exit 1 en los casos de §7
npm test                            # Test runner nativo (node --test): tests/unit/*.test.js
node scripts/summary.js [archivo]   # Tablas Markdown de output/releases.json (o del archivo dado)
node scripts/capture-fixtures.js    # Captura respuestas reales de TMDB en tests/fixtures/tmdb/
                                    # (necesita key; lo ejecuta el propietario, nunca CI)
```

La API key se lee de `.env` (ver `.env.example`). En CI va por `secrets.TMDB_API_KEY`.

Vista previa local de la web: `cp tests/fixtures/releases.sample.json site/releases.json`
y cualquier servidor estático sobre `site/` (las copias locales están en `.gitignore`).

## Arquitectura

```
src/
  index.js       — Entry point. main({ fetchImpl, now, env, outDir, … }) devuelve el
                   exit code; solo se ejecuta si require.main === module (carga dotenv
                   ahí). getHorrorReleases → assignCalendars → generateCalendars; escribe
                   los 11 .ics y releases.json (§4), preview por release y ::warning::
                   por cada releaseNote sin alias
  tmdb.js        — Cliente TMDB: getHorrorReleases / fetchHorrorReleases (este último
                   añade region, window y contadores). Dos discover regionales,
                   watch/providers + release_dates solo para digitales, sinopsis EN de
                   respaldo, pool de 5, reintentos 429/5xx con Retry-After, umbral de
                   fallos de detalle del 20 %. fetch, now, env y sleep inyectables
  platforms.js   — PLATFORMS (§5), matchPlatform, assignCalendars (unión nota +
                   flatrate) y calendarDefinitions (orden canónico)
  calendar.js    — generateCalendars(releases, { now }) → un VCALENDAR por calendario
                   (RFC 5545: folding a 75 octetos, escape, CRLF). Exporta también
                   generateICS, escapeText, foldLine, generateUID, buildDescription y
                   buildWhereLine
scripts/
  summary.js     — Tablas Markdown de releases.json: contadores por calendario y una
                   fila por release con calendarios y nota (tolera el formato antiguo);
                   CI la vuelca en el resumen del job
  capture-fixtures.js — Captura única de respuestas TMDB (§7) a tests/fixtures/tmdb/
                   (discover, watch/providers, release_dates, detalle EN) con
                   manifest.json; sin reintentos, nunca escribe la key; imprime
                   provider_name y notas tipo 4 vistas en la región
site/
  index.html     — Web pública: marcado e i18n ES/EN vía data-i18n. El deploy copia
                   site/ entero a GitHub Pages
  styles.css     — Estilos de la página
  selector.js    — Selector de calendarios (ES2020, sin build): lee releases.json con
                   URL relativa, persiste la selección en localStorage y pinta
                   suscripciones y lista filtrada. La lógica pura se exporta para
                   node --test (guarda module.exports); el DOM solo si existe document
output/          — Generado por npm start: horror-cines.ics, horror-<plataforma>.ics,
                   horror-digital.ics, horror.ics y releases.json; ignorado por git
docs/
  data-model.md  — Contrato de datos entre la capa Node y la web (solo lectura)
  phases.md      — Plan de fases, reparto de ficheros y criterios de aceptación
  prototype-selector.html — Maqueta de referencia del selector de calendarios (F2)
tests/
  unit/*.test.js — Tests (node --test), sin red. site-*.test.js prueban la web sin
                   DOM importando site/selector.js en Node
  support/       — Helpers, no son tests: mock-fetch.js (fetch falso que mapea URL
                   sin api_key → fixture, graba llamadas, respuestas en cola),
                   fixture-name.js (nombre determinista de fixture por petición),
                   fixture-fetch.js (mock-fetch sobre capturadas + synthetic/, sin
                   colisiones) e ics-validator.js (validador estructural de .ics)
  fixtures/releases.sample.json — Ejemplo completo y válido de releases.json (contrato)
  fixtures/tmdb/ — Respuestas TMDB capturadas + manifest.json (solo las recaptura el
                   propietario)
  fixtures/tmdb/synthetic/ — Fixtures escritas a mano para lo que la captura no cubre
                   (release_dates observados el 2026-10-23, sinopsis EN, casos límite)
.github/workflows/
  ci.yml         — PR, push a main y manual: job test (npm test) y job dry-run
                   (npm start real, tabla en el resumen, artefacto output/ 14 días)
  update-calendar.yml — Cron lunes 06:00 UTC: npm test, npm start, copia site/ +
                   output/*.ics + output/releases.json y deploy a GitHub Pages;
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
- `release_dates` se pide solo para releases digitales y solo para obtener `releaseNote`
  (nota tipo 4 de la región cuyo día coincide con `releaseDate`; si ninguna coincide, la
  primera tipo 4 con nota). Nunca para inferir el tipo ni para buscar en otras regiones.
- Pertenencia a calendarios de plataforma = unión de `matchPlatform(releaseNote)` y
  `matchPlatform` de cada `flatrate` (alias en `src/platforms.js`). Una nota sin alias se
  avisa con `::warning::` al final de `npm start`.
- La ventana empieza hoy (UTC), sin look-back: `WINDOW_DAYS` (1-366, def. 90) y
  `MAX_PAGES` (1-20, def. 5); un corte de paginación siempre emite `::warning::`.
- Detalles exactos de queries, reintentos y límites: `docs/data-model.md` §7.

## Formato .ics

- iCalendar válido (RFC 5545): CRLF, folding a 75 octetos sin partir secuencias UTF-8,
  eventos de día completo, `METHOD:PUBLISH`, refresco de 24 h.
- UID: `tmdb-<id>-<type>@horror-calendar` (estable ante cambios de fecha o título).
  No volver a UIDs derivados de título o fecha.
- Un `.ics` por calendario (`cines`, plataformas, `digital`, `all`), todos en cada build,
  vacíos incluidos; `X-WR-CALNAME` = `Terror — <nombre>` (`horror.ics`: `Terror — Todo`).
- DESCRIPTION: sinopsis; línea "dónde" (`En cines` / `Incluido en:` / `Estreno en:`
  para plataformas conocidas solo por la nota / `Alquiler o compra:` / `Estreno
  digital`); `Más info:`. El filtrado vive solo en la capa de datos.
- `horror.ics` es un contrato con los suscriptores existentes: no se renombra ni se
  elimina y contiene cines + digital. Detalles: `docs/data-model.md` §3 y §6.

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
- La sinopsis no es criterio de inclusión; sin fecha de estreno en España no se entra.
- UID basado en ID de TMDB + tipo.
- La web usa solo URLs relativas (en el futuro puede servirse bajo una subruta).
