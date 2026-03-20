# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Proyecto

**horror-calendar** — Script Node.js que consulta la API de TMDB semanalmente para obtener estrenos de películas de terror (cines y plataformas online) y genera un archivo `.ics` que se publica en GitHub Pages para suscripción desde iOS.

## Comandos

```bash
npm start          # Ejecuta src/index.js — consulta TMDB y genera output/horror-calendar.ics
npm test           # Ejecuta tests con el test runner nativo de Node.js (--test)
```

## Arquitectura

```
src/
  index.js       — Entry point: orquesta la consulta a TMDB y la generación del .ics
  tmdb.js        — Cliente de la API de TMDB (discover/movie filtrado por género 27=Horror)
  calendar.js    — Generador de archivos .ics a partir de datos de películas
scripts/
  generate.js    — Script para GitHub Actions: genera el .ics y lo deja en output/
output/          — Directorio donde se escribe el .ics generado (ignorado en git)
.github/workflows/ — CI: workflow semanal (cron) que ejecuta generate.js y publica en GitHub Pages
```

## API de TMDB

- Se usa la API v3 de TMDB con API key (no bearer token).
- Endpoint principal: `GET /discover/movie` con `with_genres=27` (Horror).
- Las fechas de estreno se filtran por región (`TMDB_REGION`) para obtener estrenos locales.
- Idioma de los resultados controlado por `TMDB_LANGUAGE`.
- La API key se configura en `.env` (ver `.env.example`).

## Formato .ics

- El archivo generado debe ser un calendario iCalendar válido (RFC 5545).
- Cada película es un evento `VEVENT` de día completo con la fecha de estreno.
- El calendario se sirve desde GitHub Pages como archivo estático para que iOS pueda suscribirse vía URL.

## Convenciones

- Node.js >= 18 (para usar fetch nativo y el test runner nativo).
- Sin framework: scripts simples con módulos ES o CommonJS según convenga.
- Variables de entorno cargadas desde `.env` (usar dotenv o similar).
- No commitear credenciales; las API keys van en `.env` (excluido en `.gitignore`).
