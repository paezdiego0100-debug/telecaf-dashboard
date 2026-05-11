// scraper.js — Extractor automático de tickets pendientes
// Sistema Contratistas Telecentro → Google Sheets + Dashboard
// Requiere: npm install playwright google-auth-library googleapis

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { procesarCSV } = require('./procesar');

// ─── CONFIGURACIÓN ────────────────────────────────────────────────────────────
const CONFIG = {
  url_login:   'https://sc.telecentro.net.ar/webs/logIn.php',
  url_tareas:  'https://sc.telecentro.net.ar/webs/tasks.php',
  usuario:     process.env.SC_USUARIO     || 'user_ext_pamarilla',
  password:    process.env.SC_PASSWORD    || '42824854',
  empresa:     '[Red] TELECAF S.A.',
  // Estados que queremos capturar (todos los pendientes)
  estados_pendientes: [
    'AGENDADA',
    'ASIGNADA',
    'INICIADA',
    'NO REALIZADA',
    'PENDIENTE AGENDAMIENTO',
    'PENDIENTE ASIGNACION',
    'SUSPENDIDA'
  ],
  carpeta_datos: './datos',
  headless: process.env.HEADLESS !== 'false', // true en servidor, false local
};
// ─────────────────────────────────────────────────────────────────────────────

async function extraerTickets() {
  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║   TELECAF Dashboard — Extractor v2.0    ║');
  console.log('╚══════════════════════════════════════════╝\n');

  if (!fs.existsSync(CONFIG.carpeta_datos)) {
    fs.mkdirSync(CONFIG.carpeta_datos, { recursive: true });
  }

  const browser = await chromium.launch({
    headless: CONFIG.headless,
    args: ['--no-sandbox', '--disable-setuid-sandbox'] // necesario en servidores Linux
  });

  const context = await browser.newContext({
    acceptDownloads: true // habilitar descarga automática
  });
  const page = await context.newPage();

  try {
    // ── 1. LOGIN ──────────────────────────────────────────────────────────────
    console.log('1. Iniciando sesión...');
    await page.goto(CONFIG.url_login, { waitUntil: 'networkidle' });
    await page.fill('input[name="usuario"]', CONFIG.usuario);
    await page.fill('input[name="password"]', CONFIG.password);
    await page.selectOption('select[name="validador"]', {
      label: 'Active Directory Externo - Sistemas'
    });
    await page.click('input[type="submit"]');
    await page.waitForSelector('.navbar-custom', { visible: true, timeout: 15000 });
    console.log('   ✅ Login exitoso');

    // ── 2. NAVEGAR A TAREAS ───────────────────────────────────────────────────
    console.log('2. Navegando a Tareas...');
    await page.goto(CONFIG.url_tareas, { waitUntil: 'networkidle' });
    await page.waitForSelector('#HOME-SELECT-EMPRESA', { visible: true });
    await page.selectOption('#HOME-SELECT-EMPRESA', { label: CONFIG.empresa });
    await page.waitForTimeout(2500);

    // ── 3. ABRIR FILTRO AVANZADO ──────────────────────────────────────────────
    console.log('3. Abriendo filtro avanzado...');
    // El panel puede estar colapsado — intentar expandirlo
    try {
      const panelHeading = page.locator('#SC-DIV-FILTRO .panel-heading, .panel-heading:has-text("FILTRO")').first();
      const isCollapsed = await page.locator('#SC-DIV-FILTRO .panel-collapse:not(.in)').count();
      if (isCollapsed > 0) {
        await panelHeading.click();
        await page.waitForTimeout(1000);
      }
    } catch (e) {
      console.log('   ℹ️  Panel ya estaba abierto');
    }

    // ── 4. SELECCIONAR TODOS LOS ESTADOS PENDIENTES ───────────────────────────
    console.log('4. Seleccionando estados pendientes...');
    
    // El select de Estado puede ser un listbox múltiple
    // Primero deseleccionar todo, luego seleccionar los pendientes
    const selectEstado = page.locator('select[name*="estado"], select[name*="Estado"], #estado, select.form-control').first();
    
    // Desmarcar todo primero
    await selectEstado.evaluate(el => {
      for (let opt of el.options) opt.selected = false;
    });

    // Seleccionar cada estado pendiente
    for (const estado of CONFIG.estados_pendientes) {
      try {
        await selectEstado.evaluate((el, val) => {
          for (let opt of el.options) {
            if (opt.text.trim().toUpperCase() === val.toUpperCase()) {
              opt.selected = true;
            }
          }
        }, estado);
        console.log(`   ✅ ${estado}`);
      } catch (e) {
        console.log(`   ⚠️  No encontrado: ${estado}`);
      }
    }

    // Scroll para ver si hay más opciones en el listbox y marcarlas
    await selectEstado.evaluate(el => {
      el.scrollTop = el.scrollHeight;
    });
    await page.waitForTimeout(500);

    // ── 5. FILTRAR ────────────────────────────────────────────────────────────
    console.log('5. Aplicando filtro...');
    await page.click('button.btn-primary:has-text("FILTRAR"), button:has-text("FILTRAR")');
    await page.waitForTimeout(4000);
    
    // Leer total de resultados
    let totalTickets = 0;
    try {
      const textoTotal = await page.locator('.ui-pager-right, #pager_right, [id*="records"]').first().innerText();
      const match = textoTotal.match(/de\s+(\d+)/i);
      if (match) totalTickets = parseInt(match[1]);
    } catch (e) {}
    
    if (totalTickets === 0) {
      // Intentar leer del texto de paginación
      try {
        const pagerText = await page.locator('text=/\\d+-\\d+ de \\d+/').first().innerText();
        const match = pagerText.match(/de\s+(\d+)/i);
        if (match) totalTickets = parseInt(match[1]);
      } catch (e) {}
    }
    console.log(`   📊 Total tickets encontrados: ${totalTickets || '(leyendo...)'}`);

    // ── 6. EXPORTAR CSV ───────────────────────────────────────────────────────
    console.log('6. Exportando CSV...');
    
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 30000 }),
      page.click('button:has-text("Exportar"), a:has-text("Exportar"), .btn:has-text("Exportar CSV"), button:has-text("CSV")')
    ]);

    const fecha = new Date().toISOString().slice(0, 10);
    const hora  = new Date().toTimeString().slice(0, 5).replace(':', '');
    const nombreArchivo = `tareas_${fecha}_${hora}.csv`;
    const rutaDestino = path.join(CONFIG.carpeta_datos, nombreArchivo);
    
    await download.saveAs(rutaDestino);
    console.log(`   ✅ CSV guardado: ${nombreArchivo}`);

    // ── 7. PROCESAR Y SUBIR ───────────────────────────────────────────────────
    console.log('7. Procesando datos...');
    const resultado = await procesarCSV(rutaDestino, fecha, totalTickets);
    
    console.log('\n╔══════════════════════════════════════════╗');
    console.log(`║  ✅ PROCESO COMPLETADO                   ║`);
    console.log(`║  📊 Pendientes: ${String(resultado.total).padEnd(24)}║`);
    console.log(`║  📅 Fecha: ${fecha.padEnd(30)}║`);
    console.log('╚══════════════════════════════════════════╝\n');

    return resultado;

  } catch (error) {
    console.error('\n❌ Error crítico:', error.message);
    // Captura de pantalla para debug
    const screenshotPath = path.join(CONFIG.carpeta_datos, `error_${Date.now()}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: true });
    console.error(`   Screenshot guardado: ${screenshotPath}`);
    throw error;
  } finally {
    await browser.close();
  }
}

// Ejecutar si se llama directamente
if (require.main === module) {
  extraerTickets().catch(err => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { extraerTickets };
