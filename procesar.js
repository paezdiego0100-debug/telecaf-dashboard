// procesar.js — Procesador de CSV + Google Sheets uploader
// Lee el CSV exportado, normaliza los datos y los sube al Sheet

const fs = require('fs');
const path = require('path');
const csv = require('csv-parse/sync');
const { google } = require('googleapis');

// ─── CONFIGURACIÓN GOOGLE SHEETS ─────────────────────────────────────────────
const SHEET_ID = process.env.GOOGLE_SHEET_ID || 'TU_SHEET_ID_AQUI';
// El ID está en la URL: docs.google.com/spreadsheets/d/ESTE_ID/edit
const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];
// ─────────────────────────────────────────────────────────────────────────────

// Detectar separador del CSV (el sistema a veces exporta con , y a veces con ;)
function detectarSeparador(contenido) {
  const primeraLinea = contenido.split('\n')[0];
  const comas = (primeraLinea.match(/,/g) || []).length;
  const puntoyComa = (primeraLinea.match(/;/g) || []).length;
  return puntoyComa > comas ? ';' : ',';
}

// Normalizar nombres de columnas (el sistema a veces los cambia levemente)
function normalizarFila(row) {
  const get = (posibles) => {
    for (const k of posibles) {
      if (row[k] !== undefined && row[k] !== null) return (row[k] || '').toString().trim();
    }
    return '';
  };
  return {
    nroTicket:    get(['NroTicket', 'Nro Ticket', 'nroTicket']),
    nombreTarea:  get(['Nombre Tarea', 'NombreTarea', '']),
    nodo:         get(['Nodo', 'nodo']),
    subZona:      get(['SubZona', 'Sub Zona', 'subZona']),
    prioridad:    get(['Prioridad', 'prioridad']),
    afectacion:   get(['Afectacion', 'Afectación']),
    estado:       get(['Estado', 'estado']),
    ticketEvento: get(['Ticket Evento', 'TicketEvento', 'Ticket evento']),
    tipoDeTarea:  get(['Tipo de Tarea', 'TipoDeTarea']),
    tipoNegocio:  get(['Tipo De Negocio', 'Tipo de Negocio', 'TipoDeNegocio']),
    metodoPago:   get(['Método Pago', 'Metodo Pago', 'MétodoPago']),
    tipificacion: get(['Detalle de Tipificación', 'Detalle de Tipificacion', 'Tipificacion']),
    fechaEstado:  get(['Fecha Estado', 'FechaEstado']),
  };
}

async function procesarCSV(rutaCSV, fecha, totalWeb) {
  // ── Leer y parsear CSV ────────────────────────────────────────────────────
  const contenido = fs.readFileSync(rutaCSV, 'utf-8');
  const sep = detectarSeparador(contenido);
  
  let filas;
  try {
    filas = csv.parse(contenido, {
      delimiter: sep,
      columns: true,
      skip_empty_lines: true,
      trim: true,
      bom: true,
    });
  } catch (e) {
    console.error('Error parseando CSV:', e.message);
    throw e;
  }

  const tickets = filas.map(normalizarFila).filter(t => t.nroTicket);
  console.log(`   📄 Filas procesadas: ${tickets.length}`);

  // ── Calcular métricas ─────────────────────────────────────────────────────
  const porEstado = {};
  const porTipificacion = {};
  const porSubZona = {};
  const porPrioridad = {};
  const porNegocio = {};

  for (const t of tickets) {
    porEstado[t.estado]           = (porEstado[t.estado] || 0) + 1;
    porTipificacion[t.tipificacion] = (porTipificacion[t.tipificacion] || 0) + 1;
    porSubZona[t.subZona]         = (porSubZona[t.subZona] || 0) + 1;
    porPrioridad[t.prioridad]     = (porPrioridad[t.prioridad] || 0) + 1;
    porNegocio[t.tipoNegocio]     = (porNegocio[t.tipoNegocio] || 0) + 1;
  }

  const resultado = {
    fecha,
    total: tickets.length,
    totalWeb: totalWeb || tickets.length,
    porEstado,
    porTipificacion,
    porSubZona,
    porPrioridad,
    porNegocio,
    tickets, // todos los registros individuales
  };

  // ── Guardar JSON local (para el dashboard) ────────────────────────────────
  const jsonPath = path.join('./datos', `snapshot_${fecha}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(resultado, null, 2));
  
  // Actualizar siempre el "último snapshot" para que el dashboard lo lea
  fs.writeFileSync('./datos/ultimo.json', JSON.stringify(resultado, null, 2));
  
  // Acumular historial
  const historialPath = './datos/historial.json';
  let historial = [];
  if (fs.existsSync(historialPath)) {
    historial = JSON.parse(fs.readFileSync(historialPath, 'utf-8'));
  }
  // Reemplazar entrada del mismo día si ya existe
  const idx = historial.findIndex(h => h.fecha === fecha);
  const resumen = {
    fecha,
    total: resultado.total,
    agendada:  porEstado['AGENDADA']  || 0,
    asignada:  porEstado['ASIGNADA']  || 0,
    iniciada:  porEstado['INICIADA']  || 0,
    suspendida: porEstado['SUSPENDIDA'] || 0,
    pendienteAgendamiento: porEstado['PENDIENTE AGENDAMIENTO'] || 0,
    pendienteAsignacion:   porEstado['PENDIENTE ASIGNACION']   || 0,
    noRealizada: porEstado['NO REALIZADA'] || 0,
    imp:  porSubZona['IMP NORTE-SUB01'] || 0,
    red:  porSubZona['RED NORTE-SUB01'] || 0,
  };
  if (idx >= 0) historial[idx] = resumen;
  else historial.push(resumen);
  historial.sort((a, b) => a.fecha.localeCompare(b.fecha));
  fs.writeFileSync(historialPath, JSON.stringify(historial, null, 2));
  console.log('   ✅ JSON local guardado');
await subirAGitHub();
  // ── Subir a Google Sheets ─────────────────────────────────────────────────
  try {
    await subirASheets(resultado, historial);
    console.log('   ✅ Google Sheets actualizado');
  } catch (e) {
    console.error('   ⚠️  Error Google Sheets (datos locales sí guardados):', e.message);
  }

  return resultado;
}

async function subirASheets(datos, historial) {
  // Autenticación con Service Account (JSON guardado como secret en GitHub)
  const credenciales = JSON.parse(
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON || fs.readFileSync('./google-credentials.json', 'utf-8')
  );

  const auth = new google.auth.GoogleAuth({
    credentials: credenciales,
    scopes: SCOPES,
  });
  const sheets = google.sheets({ version: 'v4', auth });
  const sid = SHEET_ID;

  // ── Hoja 1: HISTORIAL ─────────────────────────────────────────────────────
  const filaHistorial = [
    datos.fecha,
    datos.total,
    datos.porEstado['AGENDADA']  || 0,
    datos.porEstado['ASIGNADA']  || 0,
    datos.porEstado['INICIADA']  || 0,
    datos.porEstado['SUSPENDIDA'] || 0,
    datos.porEstado['PENDIENTE AGENDAMIENTO'] || 0,
    datos.porEstado['PENDIENTE ASIGNACION'] || 0,
    datos.porEstado['NO REALIZADA'] || 0,
    datos.porSubZona['IMP NORTE-SUB01'] || 0,
    datos.porSubZona['RED NORTE-SUB01'] || 0,
  ];

  // Verificar si ya existe la fila de hoy
  const respHistorial = await sheets.spreadsheets.values.get({
    spreadsheetId: sid,
    range: 'HISTORIAL!A:A',
  });
  const fechasExistentes = (respHistorial.data.values || []).flat();
  const filaExiste = fechasExistentes.findIndex(f => f === datos.fecha);

  if (filaExiste > 0) {
    // Actualizar fila existente
    await sheets.spreadsheets.values.update({
      spreadsheetId: sid,
      range: `HISTORIAL!A${filaExiste + 1}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [filaHistorial] },
    });
  } else {
    // Agregar nueva fila
    await sheets.spreadsheets.values.append({
      spreadsheetId: sid,
      range: 'HISTORIAL!A:K',
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [filaHistorial] },
    });
  }

  // ── Hoja 2: TICKETS_HOY (reemplazar todo) ─────────────────────────────────
  const headers = ['NroTicket', 'Nodo', 'SubZona', 'Prioridad', 'Afectacion',
                   'Estado', 'TicketEvento', 'TipoNegocio', 'Tipificacion', 'FechaEstado'];
  const filasTkts = datos.tickets.map(t => [
    t.nroTicket, t.nodo, t.subZona, t.prioridad, t.afectacion,
    t.estado, t.ticketEvento, t.tipoNegocio, t.tipificacion, t.fechaEstado
  ]);

  await sheets.spreadsheets.values.clear({
    spreadsheetId: sid,
    range: 'TICKETS_HOY!A:Z',
  });
  await sheets.spreadsheets.values.update({
    spreadsheetId: sid,
    range: 'TICKETS_HOY!A1',
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [headers, ...filasTkts] },
  });

  // ── Hoja 3: RESUMEN_TIPIFICACIONES ────────────────────────────────────────
  const tipifRows = Object.entries(datos.porTipificacion)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => [k, v]);

  await sheets.spreadsheets.values.clear({
    spreadsheetId: sid, range: 'RESUMEN_TIPIF!A:B',
  });
  await sheets.spreadsheets.values.update({
    spreadsheetId: sid, range: 'RESUMEN_TIPIF!A1',
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [['Tipificacion', 'Cantidad'], ...tipifRows] },
  });
}
async function subirAGitHub() {
  const { execSync } = require('child_process');
  try {
    execSync('git add docs/data/ultimo.json docs/data/historial.json', { cwd: __dirname });
    execSync('git commit -m "Actualizar datos ' + new Date().toISOString().slice(0,10) + '"', { cwd: __dirname });
    execSync('git push origin main', { cwd: __dirname });
    console.log('   ✅ GitHub Pages actualizado');
  } catch(e) {
    console.log('   ℹ️  Sin cambios para subir a GitHub');
  }
}
module.exports = { procesarCSV };
