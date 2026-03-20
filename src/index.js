// Punto de entrada principal: consulta TMDB y genera el archivo .ics

// Cargamos las variables de entorno desde .env antes de cualquier otra cosa
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { getHorrorReleases } = require('./tmdb');
const { generateICS } = require('./calendar');

// Ruta donde se guarda el archivo .ics generado
const OUTPUT_DIR = path.join(__dirname, '..', 'output');
const OUTPUT_FILE = path.join(OUTPUT_DIR, 'horror.ics');

async function main() {
  console.log('🎬 Horror Calendar — Generador de calendario de estrenos de terror\n');

  // Paso 1: Consultar TMDB para obtener los próximos estrenos de terror
  console.log('Consultando TMDB...');
  const releases = await getHorrorReleases();

  if (releases.length === 0) {
    console.log('No se encontraron estrenos de terror en los próximos 90 días.');
    return;
  }

  console.log(`Se encontraron ${releases.length} películas de terror.\n`);

  // Mostramos un resumen de las primeras películas encontradas
  const preview = releases.slice(0, 5);
  for (const movie of preview) {
    const providers = movie.providers.length > 0
      ? ` (${movie.providers.join(', ')})`
      : '';
    console.log(`  📅 ${movie.releaseDate} — ${movie.title}${providers}`);
  }
  if (releases.length > 5) {
    console.log(`  ... y ${releases.length - 5} más.\n`);
  } else {
    console.log();
  }

  // Paso 2: Generar el contenido del archivo .ics
  console.log('Generando archivo .ics...');
  const icsContent = generateICS(releases);

  // Paso 3: Asegurarnos de que el directorio output/ existe y guardar el archivo
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(OUTPUT_FILE, icsContent, 'utf-8');

  console.log(`Archivo guardado en: ${OUTPUT_FILE}`);
  console.log(`\n✅ Calendario generado con ${releases.length} eventos.`);
}

// Ejecutamos y capturamos cualquier error para mostrar un mensaje claro
main().catch((error) => {
  console.error('\n❌ Error al generar el calendario:\n');

  // Errores conocidos con mensajes útiles
  if (error.message.includes('TMDB_API_KEY')) {
    console.error('  No se encontró la API key de TMDB.');
    console.error('  Copia .env.example a .env y añade tu clave.');
  } else if (error.message.includes('Error de TMDB')) {
    console.error('  La API de TMDB respondió con un error:');
    console.error(`  ${error.message}`);
  } else if (error.code === 'ENOENT') {
    console.error('  No se pudo escribir el archivo de salida.');
    console.error(`  Verifica que tengas permisos en: ${OUTPUT_DIR}`);
  } else {
    console.error(`  ${error.message}`);
  }

  // Salimos con código de error para que CI/scripts detecten el fallo
  process.exit(1);
});
