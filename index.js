// ===================== CARGA DE VARIABLES DE ENTORNO =====================
require('dotenv').config();

const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const FormData = require('form-data');
const https = require('https');
const nodemailer = require('nodemailer');
const puppeteer = require('puppeteer');
const { Resend } = require('resend');

// ===================== CONFIGURACIÓN =====================
const KOBO_SUBMISSION_URL = 'https://kc-eu.kobotoolbox.org/submission';
const KOBO_TOKEN = process.env.KOBO_TOKEN;

const SESSION_FILE = path.join(__dirname, process.env.SESSION_FILE || 'sessions.json');
const PHOTO_DIR = path.join(__dirname, process.env.PHOTO_DIR || 'photos');
const LOG_FILE = path.join(__dirname, 'bot.log');
const REPORTES_FILE = path.join(__dirname, 'reportes.json');

// Configuración de correo (Fase 3)
const SMTP_HOST = process.env.SMTP_HOST || 'smtp.gmail.com';
const SMTP_PORT = parseInt(process.env.SMTP_PORT || '587');
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const EMAIL_DESTINO = process.env.EMAIL_DESTINO;
const EMAIL_CC = process.env.EMAIL_CC || '';
const LOGO_PATH = path.join(__dirname, process.env.LOGO_PATH || 'assets/logo.png');
const INSTITUCION_NOMBRE = process.env.INSTITUCION_NOMBRE || 'Dirección Municipal de Protección Civil y Administración de Desastres Uribante';
const INSTITUCION_LEMA = process.env.INSTITUCION_LEMA || 'Periculum administratur, non tantum partitur';

const ALLOWED_USERS = new Set(
    (process.env.ALLOWED_USERS || '')
        .split(',')
        .map(u => u.trim())
        .filter(u => u.length > 0)
);

const ADMIN_USERS = new Set(
    (process.env.ADMIN_USERS || '')
        .split(',')
        .map(u => u.trim())
        .filter(u => u.length > 0)
);

if (!KOBO_TOKEN) {
    console.error('❌ ERROR: Falta KOBO_TOKEN en el archivo .env');
    process.exit(1);
}

if (!fs.existsSync(PHOTO_DIR)) {
    fs.mkdirSync(PHOTO_DIR, { recursive: true });
}

// ===================== SISTEMA DE LOGS =====================
function log(mensaje) {
    const marca = new Date().toLocaleString('es-VE', { timeZone: 'America/Caracas' });
    const linea = `[${marca}] ${mensaje}`;
    console.log(linea);
    try {
        fs.appendFileSync(LOG_FILE, linea + '\n', 'utf8');
    } catch (err) {
        console.error('Error escribiendo log:', err.message);
    }
}

// ===================== PERSISTENCIA SESIONES =====================
function loadSessions() {
    try {
        if (fs.existsSync(SESSION_FILE)) {
            return JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
        }
    } catch (err) {
        console.error('Error cargando sesiones:', err);
    }
    return {};
}

function saveSessions(sessions) {
    try {
        fs.writeFileSync(SESSION_FILE, JSON.stringify(sessions, null, 2), 'utf8');
    } catch (err) {
        console.error('Error guardando sesiones:', err);
    }
}

let sessions = loadSessions();

// ===================== PERSISTENCIA REPORTES =====================
function loadReportes() {
    try {
        if (fs.existsSync(REPORTES_FILE)) {
            return JSON.parse(fs.readFileSync(REPORTES_FILE, 'utf8'));
        }
    } catch (err) {
        console.error('Error cargando reportes:', err);
    }
    return [];
}

function saveReportes(reportes) {
    try {
        fs.writeFileSync(REPORTES_FILE, JSON.stringify(reportes, null, 2), 'utf8');
    } catch (err) {
        console.error('Error guardando reportes:', err);
    }
}

function registrarReporte(from, data, enviadoKobo) {
    const reportes = loadReportes();
    reportes.push({
        id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        from: from,
        personal: data.Personal_Asignado || '',
        tipo: data.Tipo_de_Procedimiento || '',
        unidad: data.Unidad_Asignada || '',
        fecha: data.Fecha || '',
        hora_inicio: data.Hora_de_Inicio || '',
        hora_fin: data.Hora_de_Finalizacion || '',
        enviado_kobo: enviadoKobo,
        tiene_foto: !!(data.Foto_Evidencia && data.Foto_Evidencia !== 'Sin foto' && !data.Foto_Evidencia.startsWith('No')),
        observaciones: data.Observaciones_Procedimientos || ''
    });
    saveReportes(reportes);
    log(`📝 Reporte registrado en historial local (${reportes.length} total)`);
}

// ===================== DESTINATARIOS =====================
function recolectarDestinatarios() {
    const numeros = new Set();
    const reportes = loadReportes();
    reportes.forEach(r => {
        if (r.from && typeof r.from === 'string') numeros.add(r.from);
    });
    Object.keys(sessions).forEach(f => {
        if (f && typeof f === 'string') numeros.add(f);
    });
    ADMIN_USERS.forEach(a => {
        if (a && typeof a === 'string') numeros.add(a);
    });
    return Array.from(numeros);
}

// ===================== EXPORTAR A CSV =====================
function escaparCSV(valor) {
    const s = String(valor === undefined || valor === null ? '' : valor);
    if (s.includes(',') || s.includes('"') || s.includes('\n')) {
        return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
}

function generarCSV(reportes) {
    const headers = [
        'ID', 'Timestamp', 'Fecha', 'Hora Inicio', 'Hora Fin',
        'Operador', 'Tipo', 'Unidad', 'Enviado Kobo', 'Tiene Foto', 'Observaciones'
    ];
    let csv = headers.join(',') + '\n';

    reportes.forEach(r => {
        const fila = [
            (r.id || '').substring(0, 8),
            escaparCSV(r.timestamp),
            escaparCSV(r.fecha),
            escaparCSV(r.hora_inicio),
            escaparCSV(r.hora_fin),
            escaparCSV(r.personal),
            escaparCSV(r.tipo),
            escaparCSV(r.unidad),
            r.enviado_kobo ? 'SI' : 'NO',
            r.tiene_foto ? 'SI' : 'NO',
            escaparCSV(r.observaciones)
        ];
        csv += fila.join(',') + '\n';
    });

    return csv;
}

// ===================== GENERAR PDF (FASE 3.1) =====================
async function generarPDF(reportes, periodo) {
    const templatePath = path.join(__dirname, 'templates', 'reporte.html');

    if (!fs.existsSync(templatePath)) {
        throw new Error(`No se encontró la plantilla HTML en ${templatePath}`);
    }

    let html = fs.readFileSync(templatePath, 'utf8');

    // Construir filas de la tabla
    let filas = '';
    reportes.forEach(r => {
        filas += `<tr>
            <td>${r.fecha || ''}</td>
            <td>${r.tipo || ''}</td>
            <td>${r.unidad || ''}</td>
            <td>${r.personal || ''}</td>
            <td>${r.hora_inicio || ''}</td>
            <td>${r.hora_fin || ''}</td>
        </tr>`;
    });

    // Fecha de emisión
    const fechaEmision = new Date().toLocaleString('es-VE', { timeZone: 'America/Caracas' });

    // ===================== Embeber HOJA MEMBRETADA como base64 =====================
    const HOJA_PATH = path.join(__dirname, process.env.HOJA_MEMBRETADA_PATH || 'assets/hoja_membretada.png');
    let hojaDataUri = '';
    if (fs.existsSync(HOJA_PATH)) {
        const hojaBuffer = fs.readFileSync(HOJA_PATH);
        hojaDataUri = `data:image/png;base64,${hojaBuffer.toString('base64')}`;
        log(`🖼️ Hoja membretada cargada: ${(hojaBuffer.length / 1024).toFixed(1)} KB`);
    } else {
        log(`⚠️ No se encontró la hoja membretada en ${HOJA_PATH}`);
    }

    // ===================== Embeber LOGO como base64 (por si se usa en otra parte) =====================
    let logoDataUri = '';
    if (fs.existsSync(LOGO_PATH)) {
        const logoBuffer = fs.readFileSync(LOGO_PATH);
        const ext = path.extname(LOGO_PATH).toLowerCase().replace('.', '');
        const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : 'image/png';
        logoDataUri = `data:${mime};base64,${logoBuffer.toString('base64')}`;
    } else {
        log(`⚠️ No se encontró el logo en ${LOGO_PATH}`);
    }

    // ===================== Reemplazar todos los placeholders =====================
    html = html.replace(/{{HOJA_MEMBRETADA_PATH}}/g, hojaDataUri);
    html = html.replace(/{{LOGO_PATH}}/g, logoDataUri);
    html = html.replace(/{{INSTITUCION_NOMBRE}}/g, INSTITUCION_NOMBRE);
    html = html.replace(/{{INSTITUCION_LEMA}}/g, INSTITUCION_LEMA);
    html = html.replace(/{{PERIODO}}/g, periodo);
    html = html.replace(/{{TOTAL}}/g, reportes.length);
    html = html.replace(/{{FECHA_EMISION}}/g, fechaEmision);
    html = html.replace(/{{FILAS}}/g, filas);

    // ===================== Generar PDF con Puppeteer =====================
    const browser = await puppeteer.launch({
        headless: 'new',
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    const pdfBuffer = await page.pdf({
        format: 'Letter',
        printBackground: true,
        margin: { top: '0', bottom: '0', left: '0', right: '0' }
    });
    await browser.close();

    return Buffer.from(pdfBuffer);
}

// ===================== ENVIAR CORREO VIA API RESEND (FASE 3.1) =====================
async function enviarCorreo(pdfBuffer, periodo, totalReportes) {
    if (!process.env.RESEND_API_KEY) {
        throw new Error('Falta RESEND_API_KEY en el archivo .env');
    }
    if (!process.env.EMAIL_DESTINO) {
        throw new Error('Falta EMAIL_DESTINO en el archivo .env');
    }

    const fecha = new Date().toLocaleDateString('es-VE', { timeZone: 'America/Caracas' });
    const nombreArchivo = `Reporte_SIERRA_${fecha.replace(/\//g, '-')}.pdf`;

    // Buffer → base64 string
    const bufferReal = Buffer.isBuffer(pdfBuffer) ? pdfBuffer : Buffer.from(pdfBuffer);
    let base64Content = bufferReal.toString('base64');

    // Eliminar cualquier prefijo "data:...;base64," si existiera
    if (base64Content.startsWith('data:')) {
        base64Content = base64Content.split(',')[1];
    }

    // Limpiar espacios/saltos por seguridad
    base64Content = base64Content.replace(/\s/g, '');

    
    const emailData = {
        from: `${process.env.EMAIL_FROM_NAME || 'Sistema SIERRA'} <${process.env.EMAIL_FROM}>`,
        to: [process.env.EMAIL_DESTINO],
        subject: `Reporte Consolidado SIERRA - ${periodo} (${fecha})`,
        html: `
            <p>Buen día,</p>
            <p>Adjunto encontrará el reporte consolidado de operaciones correspondiente al período <strong>${periodo}</strong>.</p>
            <p><strong>Total de reportes:</strong> ${totalReportes}</p>
            <p>Documento generado automáticamente por el Sistema SIERRA.</p>
            <br>
            <p><em>${INSTITUCION_LEMA}</em></p>
            <p style="color: #777; font-size: 12px;">${INSTITUCION_NOMBRE}</p>
        `,
        attachments: [
            {
                filename: nombreArchivo,
                content: base64Content
            }
        ]
    };

    if (process.env.EMAIL_CC && process.env.EMAIL_CC.trim() !== '') {
        emailData.cc = [process.env.EMAIL_CC.trim()];
    }

    const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(emailData)
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Error de Resend (${response.status}): ${errorText}`);
    }

    const data = await response.json();
    log(`📧 Correo enviado vía Resend. ID: ${data.id}`);
    return data;
}

// ===================== VALIDACIONES =====================
function isValidDate(dateStr) {
    const date = new Date(dateStr);
    return !isNaN(date.getTime());
}

function isValidTime(timeStr) {
    const regex = /^([0-1]?[0-9]|2[0-3]):[0-5][0-9]\s?(AM|PM)?$/i;
    return regex.test(timeStr.trim());
}

function isValidPositiveInteger(str) {
    const num = Number(str);
    return Number.isInteger(num) && num > 0;
}

function isValidNonNegativeInteger(str) {
    const num = Number(str);
    return Number.isInteger(num) && num >= 0;
}

function isValidPercentage(str) {
    const num = Number(str);
    return !isNaN(num) && num >= 0 && num <= 100;
}

// ===================== MENÚS =====================
function buildMenu(options, title = 'Selecciona una opción:') {
    let menu = title + '\n\n';
    options.forEach(opt => {
        menu += `${opt.id} - ${opt.label}\n`;
    });
    return menu;
}

// ===================== ESTADÍSTICAS =====================
function formatearFecha(fecha) {
    const d = new Date(fecha);
    const dia = String(d.getDate()).padStart(2, '0');
    const mes = String(d.getMonth() + 1).padStart(2, '0');
    const anio = d.getFullYear();
    return `${dia}/${mes}/${anio}`;
}

function filtrarPorRango(reportes, desde, hasta) {
    return reportes.filter(r => {
        const t = new Date(r.timestamp).getTime();
        return t >= desde.getTime() && t <= hasta.getTime();
    });
}

function contarPor(reportes, campo) {
    const conteo = {};
    reportes.forEach(r => {
        const clave = r[campo] || 'sin_definir';
        conteo[clave] = (conteo[clave] || 0) + 1;
    });
    return conteo;
}

function formatearConteo(conteo) {
    const entradas = Object.entries(conteo).sort((a, b) => b[1] - a[1]);
    if (entradas.length === 0) return '  (sin datos)\n';
    let texto = '';
    entradas.forEach(([k, v]) => {
        texto += `  • ${k}: ${v}\n`;
    });
    return texto;
}

function generarStats(titulo, reportes) {
    let msg = `📊 ${titulo}\n`;
    msg += `Total: ${reportes.length} reportes\n\n`;

    if (reportes.length === 0) {
        msg += 'Sin reportes en este período.';
        return msg;
    }

    msg += '🔹 Por tipo de procedimiento:\n';
    msg += formatearConteo(contarPor(reportes, 'tipo'));

    msg += '\n🔹 Por unidad asignada:\n';
    msg += formatearConteo(contarPor(reportes, 'unidad'));

    msg += '\n🔹 Por operador (nombre):\n';
    msg += formatearConteo(contarPor(reportes, 'personal'));

    const exitosos = reportes.filter(r => r.enviado_kobo).length;
    const fallidos = reportes.length - exitosos;
    msg += `\n✅ Enviados OK: ${exitosos}\n`;
    msg += `⚠️ Fallidos: ${fallidos}`;

    return msg;
}

// ===================== ROLES =====================
function normalizarNumero(identificador) {
    return String(identificador || '').split('@')[0].replace(/\D/g, '');
}

const lidCache = {};

async function resolverNumeroReal(msg) {
    if (!msg || typeof msg.from !== 'string') {
        return null;
    }
    if (msg.from.endsWith('@c.us')) {
        return normalizarNumero(msg.from);
    }
    if (lidCache[msg.from]) {
        return lidCache[msg.from];
    }
    try {
        const contact = await msg.getContact();
        if (contact && contact.number) {
            lidCache[msg.from] = contact.number;
            log(`🔗 LID ${msg.from} → número real ${contact.number}`);
            return contact.number;
        }
    } catch (err) {
        log(`⚠️ No se pudo resolver LID ${msg.from}: ${err.message}`);
    }
    try {
        const contact = await msg.getContact();
        if (contact && contact.id && contact.id.user) {
            lidCache[msg.from] = contact.id.user;
            log(`🔗 LID ${msg.from} → id.user ${contact.id.user}`);
            return contact.id.user;
        }
    } catch (err) {}
    return normalizarNumero(msg.from);
}

const ADMIN_NUMEROS = new Set(
    Array.from(ADMIN_USERS).map(normalizarNumero)
);

async function getRol(msg) {
    if (ADMIN_USERS.has(msg.from)) return 'admin';
    const numero = await resolverNumeroReal(msg);
    if (numero && ADMIN_NUMEROS.has(numero)) return 'admin';
    const fromNorm = normalizarNumero(msg.from);
    if (ADMIN_NUMEROS.has(fromNorm)) return 'admin';
    return 'operator';
}


// ===================== AYUDA =====================
function getAyuda(rol) {
    let ayuda = '🤖 *COMANDOS DISPONIBLES*\n\n';
    ayuda += '👤 *Para todos:*\n';
    ayuda += '  !reporte — Iniciar un reporte\n';
    ayuda += '  !cancelar — Cancelar el reporte actual\n';
    ayuda += '  !ayuda — Ver esta lista\n';

    if (rol === 'admin') {
        ayuda += '\n👑 *Solo administradores:*\n';
        ayuda += '  !stats hoy — Reportes de hoy\n';
        ayuda += '  !stats semana — Últimos 7 días\n';
        ayuda += '  !stats mes — Mes actual\n';
        ayuda += '  !stats tipo — Por tipo de procedimiento\n';
        ayuda += '  !stats unidad — Por unidad asignada\n';
        ayuda += '  !stats operador — Por operador\n';
        ayuda += '  !pendientes — Reportes con fallo de envío\n';
        ayuda += '  !usuarios — Lista de administradores\n';
        ayuda += '  !broadcast <mensaje> — Avisar a todos los operadores\n';
        ayuda += '  !borrar <id> — Eliminar un reporte\n';
        ayuda += '  !exportar — Descargar CSV con todos los reportes\n';
        ayuda += '  !correo hoy — Enviar PDF del día por correo\n';
        ayuda += '  !correo semana — Enviar PDF de la semana\n';
        ayuda += '  !correo mes — Enviar PDF del mes\n';
        ayuda += '  !correo todo — Enviar PDF histórico completo\n';
    }

    return ayuda;
}

// ===================== CONSTRUCCIÓN DEL XML OPENROSA =====================
function esc(str) {
    return String(str === undefined || str === null ? '' : str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

function el(name, value) {
    return '<' + name + '>' + esc(value) + '</' + name + '>';
}

function formatGeoPoint(valor) {
    const partes = String(valor || '').trim().split(/[\s,]+/).filter(p => p !== '');
    if (partes.length >= 2) {
        const lat = parseFloat(partes[0]);
        const lon = parseFloat(partes[1]);
        if (!isNaN(lat) && !isNaN(lon)) {
            const alt = partes[2] || '0';
            const acc = partes[3] || '0';
            return `${lat} ${lon} ${alt} ${acc}`;
        }
    }
    return '0 0 0 0';
}

function buildKoboXML(data) {
    const instanceID = 'uuid:' + crypto.randomUUID();
    const formUuid = crypto.randomUUID().replace(/-/g, '');

    let xml = '<?xml version="1.0" encoding="UTF-8"?>';
    xml += '<afV2T5WK3JbeBZUEZtVTFc id="afV2T5WK3JbeBZUEZtVTFc" ';
    xml += 'xmlns="http://opendatakit.org/submissions" ';
    xml += 'xmlns:jr="http://openrosa.org/javarosa" ';
    xml += 'xmlns:orx="http://openrosa.org/xforms">';
    xml += '<formhub><uuid>' + formUuid + '</uuid></formhub>';

    xml += el('Fecha', data.Fecha);
    xml += el('Hora_de_Inicio', data.Hora_de_Inicio);
    xml += el('Hora_de_Finalizaci_n', data.Hora_de_Finalizacion);
    xml += el('Ubicaci_n', formatGeoPoint(data.Ubicacion));
    xml += el('Personal_Asignado', data.Personal_Asignado);
    xml += el('Unidad_Asignada', data.Unidad_Asignada);
    xml += el('Tipo_de_Procedimiento', data.Tipo_de_Procedimiento);

    if (data.Tipo_de_Procedimiento === 'emergencia') {
        xml += '<g_emergencia>';
        xml += el('Cant_Heridos', data.Cant_Heridos || 0);
        const heridos = data.repeat_heridos || [];
        for (let i = 0; i < heridos.length; i++) {
            const h = heridos[i];
            xml += '<repeat_heridos>';
            xml += el('Nombres_Apellidos', h.Nombres_Apellidos);
            xml += el('C_I', h.C_I);
            xml += el('Tension_Arterial', h.Tension_Arterial);
            xml += el('Frecuencia_Cardiaca', h.Frecuencia_Cardiaca);
            xml += el('SpO2', h.SpO2);
            xml += el('Glicemia', h.Glicemia);
            xml += el('Diagnostico', h.Diagnostico);
            xml += '</repeat_heridos>';
        }
        xml += '</g_emergencia>';
    }

    if (data.Tipo_de_Procedimiento === 'inspeccion') {
        xml += '<g_inspeccion>';
        xml += el('Tipo_Inspeccion', data.Tipo_Inspeccion);

        const inspMap = {
            'local_comercial':    'g_insp_comercial',
            'unidad_educativa':   'g_insp_educativa',
            'edificacion_altura': 'g_insp_altura',
            'industrial':         'g_insp_industrial',
            'habitacional':       'g_insp_habitacional',
            'terreno':            'g_insp_terreno',
            'arbolado':           'g_insp_arbolado',
            'vialidad':           'g_insp_vialidad'
        };
        const grupoInsp = inspMap[data.Tipo_Inspeccion];
        if (grupoInsp) {
            xml += '<' + grupoInsp + '>';
            if (data.Tipo_Inspeccion === 'edificacion_altura') {
                if (data.Sector_Edificacion) xml += el('Sector_Edificacion', data.Sector_Edificacion);
                if (data.Rif_Gubernamental)  xml += el('Rif_Gubernamental', data.Rif_Gubernamental);
                if (data.Datos_Propietario)  xml += el('Datos_Propietario', data.Datos_Propietario);
            }
            const items = data.inspecciones || {};
            for (const key of Object.keys(items)) {
                xml += el(key, items[key]);
            }
            xml += '</' + grupoInsp + '>';
        }
        xml += '</g_inspeccion>';
    }

    if (data.Tipo_de_Procedimiento === 'traslado') {
        xml += '<g_traslado>';
        xml += el('Punto_Llegada', formatGeoPoint(data.Punto_Llegada));
        xml += el('Cant_Pacientes_Traslado', data.Cant_Pacientes_Traslado || 0);
        const pacientes = data.repeat_pacientes_traslado || [];
        for (let i = 0; i < pacientes.length; i++) {
            const p = pacientes[i];
            xml += '<repeat_pacientes_traslado>';
            xml += el('Traslado_Nombres_Apellidos', p.Traslado_Nombres_Apellidos);
            xml += el('Traslado_C_I', p.Traslado_C_I);
            xml += el('Traslado_Diagnostico', p.Traslado_Diagnostico);
            xml += '</repeat_pacientes_traslado>';
        }
        xml += '</g_traslado>';
    }

    if (data.Tipo_de_Procedimiento === 'educacion_capacitacion') {
        xml += '<g_educacion>';
        xml += el('Edu_Tema', data.Tema_Capacitacion);
        xml += el('Edu_Cant_Participantes', data.Total_Participantes);
        xml += el('Edu_Cant_Maculinos', data.Cant_Masculinos);
        xml += el('Edu_Cant_Femeninos', data.Cant_Femeninas);
        const participantes = data.repeat_participantes || [];
        for (let i = 0; i < participantes.length; i++) {
            const p = participantes[i];
            xml += '<repeat_participantes>';
            xml += el('Edu_Nombres_Apellidos', p.Edu_Nombres_Apellidos);
            xml += el('Edu_C_I', p.Edu_C_I);
            xml += el('Edu_Edad', p.Edu_Edad);
            xml += '</repeat_participantes>';
        }
        xml += '</g_educacion>';
    }

    if (data.Tipo_de_Procedimiento === 'operaciones_charlie') {
        xml += '<g_operaciones_charlie>';
        xml += el('Litros_Despechados', data.Litros_Despachados);
        xml += el('Estado_Tanque', data.Estado_Tanque);
        xml += '</g_operaciones_charlie>';
    }

    if (data.Tipo_de_Procedimiento === 'despliegue') {
        xml += '<g_despliegue>';
        xml += el('Motivo_Despliegue', data.Motivo_Despliegue);
        xml += el('Organismos_Presentes', data.Organismos_Presentes);
        xml += el('Cant_Efectivos', data.Cant_Efectivos);
        xml += '</g_despliegue>';
    }

    if (data.Tipo_de_Procedimiento === 'puesto_de_operaciones_vigente') {
        xml += '<g_pov>';
        xml += el('Tipo_Evento', data.Tipo_Evento);
        xml += el('Motivo_POV', data.Motivo_POV);
        xml += el('Estatus_POV', data.Estatus_POV);
        xml += el('Cant_Personas_Atendidas', data.Cant_Personas_Atendidas);
        xml += '</g_pov>';
    }

    if (data.Tipo_de_Procedimiento === 'monitoreo_hidromet') {
        xml += '<g_monitoreo>';
        xml += el('Mon_Tipo_Evento', data.Mon_Tipo_Evento);
        xml += el('Mon_Nombre_Cause_Sector', data.Mon_Nombre_Cause_Sector);
        xml += el('Mon_Nivel_Riesgo', data.Mon_Nivel_Riesgo);
        xml += el('Mon_Viviendas_Riesgo', data.Mon_Viviendas_Riesgo);
        xml += el('Mon_Acciones_Tomadas', data.Mon_Acciones_Tomadas);
        xml += '</g_monitoreo>';
    }

    xml += el('Observaciones_Procedimientos', data.Observaciones_Procedimientos || '');

    let fotoFilename = null;
    if (data.Foto_Evidencia
        && data.Foto_Evidencia !== 'Sin foto'
        && !data.Foto_Evidencia.startsWith('No')
        && fs.existsSync(data.Foto_Evidencia)) {
        fotoFilename = path.basename(data.Foto_Evidencia);
        xml += el('Foto_Evidencia', fotoFilename);
    }

    xml += '<meta>';
    xml += '<instanceID>' + instanceID + '</instanceID>';
    xml += '</meta>';

    xml += '</afV2T5WK3JbeBZUEZtVTFc>';

    return { xml: xml, fotoFilename: fotoFilename };
}

// ===================== ENVÍO A KOBOTOOLBOX =====================
const KOBO_ENDPOINTS = [
    'https://kc-eu.kobotoolbox.org/submission'
];

function enviarAUnEndpoint(endpoint, form) {
    return new Promise((resolve) => {
        const url = new URL(endpoint);
        const options = {
            hostname: url.hostname,
            port: 443,
            path: url.pathname + (url.search || ''),
            method: 'POST',
            headers: Object.assign(
                {
                    'X-OpenRosa-Version': '1.0',
                    'Authorization': 'Token ' + KOBO_TOKEN
                },
                form.getHeaders()
            ),
            timeout: 30000
        };

        const req = https.request(options, (res) => {
            let body = '';
            res.on('data', c => { body += c; });
            res.on('end', () => {
                resolve({ status: res.statusCode, body: body });
            });
        });

        req.on('error', (err) => {
            resolve({ status: 0, body: 'Error de red: ' + (err.message || err) });
        });

        req.on('timeout', () => {
            req.destroy();
            resolve({ status: 0, body: 'Timeout' });
        });

        form.pipe(req);
    });
}

async function submitToKobo(data) {
    const built = buildKoboXML(data);
    const xml = built.xml;

    console.log('🔍 DEBUG - XML generado (primeros 500 caracteres):');
    console.log(xml.substring(0, 500));
    console.log('...');

    for (const endpoint of KOBO_ENDPOINTS) {
        const form = new FormData();
        form.append('xml_submission_file', Buffer.from(xml, 'utf-8'), {
            filename: 'submission.xml',
            contentType: 'text/xml'
        });

        if (built.fotoFilename && fs.existsSync(data.Foto_Evidencia)) {
            form.append('Foto_Evidencia', fs.createReadStream(data.Foto_Evidencia), {
                filename: built.fotoFilename,
                contentType: 'image/jpeg'
            });
        }

        console.log('🌐 Probando endpoint: ' + endpoint);
        const inicio = Date.now();
        const res = await enviarAUnEndpoint(endpoint, form);
        const duracion = ((Date.now() - inicio) / 1000).toFixed(2);

        console.log('⏱️ Tiempo: ' + duracion + 's - Status: ' + res.status);

        if (res.status === 201 || res.status === 202) {
            console.log('✅ Datos enviados a KoboToolbox correctamente usando ' + endpoint);
            return true;
        } else if (res.status === 404) {
            console.log('   ↳ 404 en este endpoint, probando el siguiente...');
            continue;
        } else if (res.status === 401 || res.status === 403) {
            console.error('❌ Autenticación fallida en ' + endpoint + ': ' + res.body.substring(0, 200));
            return false;
        } else if (res.status === 400 || res.status === 500) {
            console.error('❌ Error ' + res.status + ' en ' + endpoint + ':');
            console.error(res.body.substring(0, 500));
            return false;
        } else {
            console.warn('   ↳ Status ' + res.status + ', probando siguiente...');
            console.warn('   Body: ' + res.body.substring(0, 200));
            continue;
        }
    }

    console.error('❌ Ningún endpoint funcionó. Verifica tu token y conexión.');
    return false;
}

// ===================== DEFINICIÓN DE OPCIONES =====================
const CHOICES = {
    Unidad_Asignada: [
        { id: '1', name: 'a_01_u', label: 'A-01.U' },
        { id: '2', name: 'c_01_u', label: 'C-01.U' },
        { id: '3', name: 'r_01_u', label: 'R-01.U' },
        { id: '4', name: 'm_01_u', label: 'M-01.U' },
        { id: '5', name: 'm_02_u', label: 'M-02.U' }
    ],
    Tipo_de_Procedimiento: [
        { id: '1', name: 'emergencia', label: 'Emergencia' },
        { id: '2', name: 'traslado', label: 'Traslado Medico' },
        { id: '3', name: 'inspeccion', label: 'Inspeccion' },
        { id: '4', name: 'educacion_capacitacion', label: 'Educacion/Capacitacion' },
        { id: '5', name: 'operaciones_charlie', label: 'Operaciones Charlie' },
        { id: '6', name: 'despliegue', label: 'Despliegue Operativo' },
        { id: '7', name: 'puesto_de_operaciones_vigente', label: 'Puesto de Operaciones Vigente (P.O.V)' },
        { id: '8', name: 'monitoreo_hidromet', label: 'Monitoreo Eventos Adversos/Hidrometeorologicos' }
    ],
    Tipo_Inspeccion: [
        { id: '1', name: 'local_comercial', label: 'Local Comercial' },
        { id: '2', name: 'unidad_educativa', label: 'Unidad Educativa' },
        { id: '3', name: 'edificacion_altura', label: 'Edificacion de Altura (>=3 pisos)' },
        { id: '4', name: 'industrial', label: 'Industrial' },
        { id: '5', name: 'habitacional', label: 'Habitacional' },
        { id: '6', name: 'terreno', label: 'Terreno/Amenazas Geologicas' },
        { id: '7', name: 'arbolado', label: 'Arbolado Urbano' },
        { id: '8', name: 'vialidad', label: 'Vialidad e Infraestructura' }
    ],
    opt_eval: [
        { id: '1', name: 'cumple', label: 'Cumple' },
        { id: '2', name: 'no_cumple', label: 'No Cumple' },
        { id: '3', name: 'no_aplica', label: 'No Aplica' }
    ],
    opt_tipo_evento: [
        { id: '1', name: 'publico', label: 'Publico' },
        { id: '2', name: 'privado', label: 'Privado' }
    ],
    opt_estatus_pov: [
        { id: '1', name: 'en_desarrollo', label: 'En Desarrollo' },
        { id: '2', name: 'culminado', label: 'Culminado' }
    ],
    opt_tipo_amenaza: [
        { id: '1', name: 'crecida_rio', label: 'Crecida de Rio/Quebrada' },
        { id: '2', name: 'lluvias_intensas', label: 'Lluvias Intensas' },
        { id: '3', name: 'deslizamientos', label: 'Deslizamientos/Movimientos de Masa' },
        { id: '4', name: 'vientos_fuertes', label: 'Vientos Fuertes/Rafagas' },
        { id: '5', name: 'anegamiento', label: 'Anegamiento/Inundacion' },
        { id: '6', name: 'otro', label: 'Otro Evento Adverso' }
    ],
    opt_nivel_riesgo: [
        { id: '1', name: 'normal', label: 'Normal' },
        { id: '2', name: 'alerta_amarilla', label: 'Alerta' },
        { id: '3', name: 'alerta_roja', label: 'Peligro Inminente' }
    ]
};

const INSPECCION_ITEMS = {
    local_comercial: [
        { key: 'com_c810', label: 'COVENIN 810: Medios de Escape' },
        { key: 'com_c1040', label: 'COVENIN 1040: Extintores portatiles' },
        { key: 'com_c823', label: 'COVENIN 823: Sistema de Deteccion, Alarma y Extincion' },
        { key: 'com_c187', label: 'COVENIN 187: Colores y Senales de Seguridad' },
        { key: 'com_c200', label: 'COVENIN 200: Codigo Electrico Nacional' },
        { key: 'com_c2260', label: 'COVENIN 2260: Programa de Seguridad e Higiene Ocupacional' }
    ],
    unidad_educativa: [
        { key: 'edu_c810', label: 'COVENIN 810: Medios de Escape' },
        { key: 'edu_c1040', label: 'COVENIN 1040: Extintores portatiles' },
        { key: 'edu_c823', label: 'COVENIN 823: Sistema de Deteccion, Alarma y Extincion' },
        { key: 'edu_c187', label: 'COVENIN 187: Colores y Senales de Seguridad' },
        { key: 'edu_c1756', label: 'COVENIN 1756: Edificaciones Sismoresistentes' },
        { key: 'edu_c200', label: 'COVENIN 200: Codigo Electrico Nacional' },
        { key: 'edu_c948_1517', label: 'COVENIN 948/1517: Normas Sanitarias y Plantas Fisicas' },
        { key: 'edu_c928', label: 'COVENIN 328: Instalacion de Tuberias de Gas' }
    ],
    edificacion_altura: [
        { key: 'alt_c810', label: 'COVENIN 810: Medios de Escape' },
        { key: 'alt_c1331', label: 'COVENIN 1331: Extincion Fija con Agua' },
        { key: 'alt_c823_1376', label: 'COVENIN 823/1376: Deteccion y Alarma de Incendios' },
        { key: 'alt_c621_3121', label: 'COVENIN 621/3121: Ascensores y Montacargas' },
        { key: 'alt_c200', label: 'COVENIN 200: Codigo Electrico Nacional' }
    ],
    industrial: [
        { key: 'ind_c2266_88', label: 'COVENIN 2266-88: Condiciones de Higiene y Seguridad' },
        { key: 'ind_c2226_1990', label: 'COVENIN 2226-1990: Planes de Emergencia y Contingencia' },
        { key: 'ind_c474', label: 'COVENIN 474: Estadisticas de las Lesiones de Trabajo' },
        { key: 'ind_c1764', label: 'COVENIN 1764: Guias para la Inspeccion de Sistemas de Prevencion' },
        { key: 'ind_c823', label: 'COVENIN 823: Sistema de Deteccion, Alarma y Extincion' },
        { key: 'ind_c1040', label: 'COVENIN 1040: Extintores portatiles' },
        { key: 'ind_c810', label: 'COVENIN 810: Medios de Escape' },
        { key: 'ind_c758_1376', label: 'COVENIN 758-1376: Extinciones Manuales y Sistemas Fijos' },
        { key: 'ind_c2253', label: 'COVENIN 2253: Polvos, Gases y Vapores Inflamables' },
        { key: 'ind_c2250', label: 'COVENIN 2250: Ventilacion en Lugares de Trabajo' },
        { key: 'ind_c2254', label: 'COVENIN 2254: Calor y Humedad en Areas de Trabajo' },
        { key: 'ind_c1565_2255', label: 'COVENIN 1565/2255: Ruido y Vibracion Ocupacional' },
        { key: 'ind_c2273_1991', label: 'COVENIN 2273/1991: Principios Ergonomicos' },
        { key: 'ind_c187', label: 'COVENIN 187: Colores y Senales de Seguridad' },
        { key: 'ind_c2274', label: 'COVENIN 2274: Servicios Medicos en Empresas' },
        { key: 'ind_c253_99', label: 'COVENIN 253-99: Colores de Tuberias' },
        { key: 'ind_c200', label: 'COVENIN 200: Codigo Electrico Nacional' },
        { key: 'ind_c3059', label: 'COVENIN 3059: Sustancias Peligrosas no Radioactivas' },
        { key: 'ind_c3153', label: 'COVENIN 3153: Espacios Confinados' },
        { key: 'ind_c2248', label: 'COVENIN 2248: Manejo de Equipos de Izamiento' },
        { key: 'ind_c2237', label: 'COVENIN 2237: Equipo de Proteccion Personal' }
    ],
    habitacional: [
        { key: 'hab_c810', label: 'COVENIN 810: Medios de Escape' },
        { key: 'hab_c823', label: 'COVENIN 823: Sistema de Deteccion, Alarma y Extincion' },
        { key: 'hab_c1040', label: 'COVENIN 1040: Extintores portatiles' },
        { key: 'hab_c200', label: 'COVENIN 200: Codigo Electrico Nacional' },
        { key: 'hab_c928', label: 'COVENIN 928: Instalacion de Gas Licuado de Petroleo' },
        { key: 'hab_c1756', label: 'COVENIN 1756: Edificaciones Sismoresistentes' },
        { key: 'hab_c2250', label: 'COVENIN 2250: Ventilacion' },
        { key: 'hab_go4004', label: 'Gaceta Oficial 4004: Normas Sanitarias de Habitabilidad' }
    ],
    terreno: [
        { key: 'ter_c1756', label: 'COVENIN 1756: Evaluacion de Estabilidad Sismorresistente' },
        { key: 'ter_c3621', label: 'COVENIN 3621: Evaluacion de Riesgo Geologico y Taludes' },
        { key: 'ter_c2000', label: 'COVENIN 2000: Movimientos de Tierra y Obras de Preparacion' },
        { key: 'ter_c2266', label: 'COVENIN 2266: Manejo/Presencia de Contaminantes o Desechos' },
        { key: 'ter_edan', label: 'EDAN: Evaluacion de Danos y Analisis de Necesidades' }
    ],
    arbolado: [
        { key: 'arb_c200', label: 'COVENIN 200: Codigo Electrico Nacional' },
        { key: 'arb_go40222', label: 'Gaceta Oficial 40.222: Conservacion Ambiental y Arboles en Vias Publicas' },
        { key: 'arb_ley_riesgos', label: 'Ley Organica Integral de Riesgos Sociotecnologicos' },
        { key: 'arb_ordenanzas', label: 'Ordenanzas Municipales de Ambiente y Proteccion Ambiental' }
    ],
    vialidad: [
        { key: 'vial_c200', label: 'COVENIN 200: Codigo Electrico Nacional' },
        { key: 'vial_c1756', label: 'COVENIN 1756: Puentes y Estructuras Viales' },
        { key: 'vial_c876_80', label: 'COVENIN 867-80: Senalizacion de Obras y Desvios Viales' },
        { key: 'vial_c2733', label: 'COVENIN 2733: Accesibilidad y Supresion de Barreras Arquitectonicas' }
    ]
};

// ===================== CLIENTE DE WHATSAPP =====================
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    }
});

client.on('qr', (qr) => {
    console.log('\n==================================================');
    console.log('ESCANEA ESTE CODIGO QR CON TU WHATSAPP');
    console.log('==================================================\n');
    qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
    console.log('\n==================================================');
    console.log('BOT PROYECTO SIERRA LISTO!');
    console.log('==================================================\n');
    log('BOT PROYECTO SIERRA LISTO');
    log('Enviando a: ' + KOBO_SUBMISSION_URL);
    log('Administradores: ' + ADMIN_USERS.size);
    if (ALLOWED_USERS.size > 0) {
        log('Usuarios autorizados: ' + ALLOWED_USERS.size);
    } else {
        log('Modo abierto (cualquier usuario puede usar el bot)');
    }
    log('Correo configurado: ' + (EMAIL_DESTINO || 'NO CONFIGURADO'));
});

// ===================== WATCHDOG =====================
let isRestarting = false;
let ultimoPingExitoso = Date.now();
let fallosConsecutivos = 0;

const INTERVALO_VERIFICACION = 2 * 60 * 1000;
const INTERVALO_PING = 10 * 60 * 1000;
const TIEMPO_MAX_SIN_PING = 20 * 60 * 1000;
const MAX_FALLOS_ANTES_REINICIO = 3;

async function verificarSalud() {
    if (isRestarting) return;
    try {
        const state = await client.getState();
        if (state !== 'CONNECTED') {
            fallosConsecutivos++;
            log(`⚠️ Watchdog: estado ${state} (fallo ${fallosConsecutivos}/${MAX_FALLOS_ANTES_REINICIO})`);
            if (fallosConsecutivos >= MAX_FALLOS_ANTES_REINICIO) {
                await reiniciarCliente('estado no conectado');
            }
            return;
        }
        if (!client.info || !client.info.wid) {
            fallosConsecutivos++;
            log(`⚠️ Watchdog: sin usuario autenticado (fallo ${fallosConsecutivos}/${MAX_FALLOS_ANTES_REINICIO})`);
            if (fallosConsecutivos >= MAX_FALLOS_ANTES_REINICIO) {
                await reiniciarCliente('sin autenticación');
            }
            return;
        }
        fallosConsecutivos = 0;
        log(`✅ Watchdog: CONNECTED (${client.info.pushname || 'bot'})`);
    } catch (err) {
        fallosConsecutivos++;
        log(`⚠️ Watchdog: error - ${err.message} (fallo ${fallosConsecutivos}/${MAX_FALLOS_ANTES_REINICIO})`);
        if (fallosConsecutivos >= MAX_FALLOS_ANTES_REINICIO) {
            await reiniciarCliente('error de verificación');
        }
    }
}

async function pingActivo() {
    if (isRestarting) return;
    try {
        const miNumero = client.info && client.info.wid ? client.info.wid._serialized : null;
        if (!miNumero) {
            log('⚠️ Ping: no se pudo determinar el número del bot');
            return;
        }
        await client.sendMessage(miNumero, '[PING] ' + Date.now());
        ultimoPingExitoso = Date.now();
        log('🏓 Ping activo exitoso');
    } catch (err) {
        log(`⚠️ Ping activo falló: ${err.message}`);
    }

    const tiempoSinPing = Date.now() - ultimoPingExitoso;
    if (tiempoSinPing > TIEMPO_MAX_SIN_PING) {
        log(`🚨 Sin ping exitoso en ${(tiempoSinPing / 60000).toFixed(1)} min. Reiniciando...`);
        await reiniciarCliente('timeout de ping');
    }
}

async function reiniciarCliente(motivo) {
    if (isRestarting) return;
    isRestarting = true;
    log(`🔄 Reiniciando cliente. Motivo: ${motivo}`);

    try {
        await client.destroy();
        log('🧹 Cliente destruido.');
    } catch (err) {
        log(`⚠️ Error al destruir cliente: ${err.message}`);
    }

    await new Promise(resolve => setTimeout(resolve, 5000));

    try {
        fallosConsecutivos = 0;
        ultimoPingExitoso = Date.now();
        client.initialize();
        log('🚀 Cliente reinicializado.');
    } catch (err) {
        log(`❌ Error al reinicializar: ${err.message}`);
    } finally {
        isRestarting = false;
    }
}

client.on('disconnected', async (reason) => {
    log(`⚠️ Cliente desconectado. Razón: ${reason}`);
    if (reason === 'LOGOUT') {
        log('👋 Sesión cerrada desde el teléfono. Se requiere escanear QR de nuevo.');
        return;
    }
    await reiniciarCliente(`disconnected: ${reason}`);
});

client.on('auth_failure', (msg) => {
    log(`❌ Fallo de autenticación: ${msg}`);
    log('🧹 Borra .wwebjs_auth y vuelve a escanear el QR.');
});

setInterval(verificarSalud, INTERVALO_VERIFICACION);
setInterval(pingActivo, INTERVALO_PING);

log('🐕 Watchdog iniciado (verificación cada 2 min, ping cada 10 min)');

// ===================== MANEJADOR DE MENSAJES =====================
client.on('message', async (msg) => {
    try {
        const from = msg.from;
        const body = (msg.body || '').trim();
        const bodyLower = body.toLowerCase();

        // ✅ FILTRO 1: Ignorar estados, grupos, canales, listas de difusión
        if (!from) return;
        if (from === 'status@broadcast') return;
        if (from.endsWith('@g.us')) return;
        if (from.endsWith('@broadcast')) return;
        if (from.endsWith('@newsletter')) return;
        if (msg.isStatus) return;
        if (msg.fromMe) return;

        // ✅ FILTRO 2: Solo procesar mensajes de usuarios reales
        if (!from.endsWith('@c.us') && !from.endsWith('@lid')) {
            return;
        }

        // ✅ FILTRO 3: Ignorar mensajes vacíos sin media
        if (!body && !msg.hasMedia) {
            return;
        }

        if (ALLOWED_USERS.size > 0 && !ALLOWED_USERS.has(from)) {
            return;
        }

        const rol = await getRol(msg);
        console.log(`🔍 DEBUG - from: "${from}" | rol: ${rol}`);

        // ===================== AYUDA =====================
        if (bodyLower === '!ayuda' || bodyLower === '!help') {
            return await msg.reply(getAyuda(rol));
        }

        // ===================== COMANDOS DE ADMIN =====================
        if (bodyLower.startsWith('!stats') || bodyLower === '!pendientes' || bodyLower === '!usuarios' ||
            bodyLower.startsWith('!broadcast') || bodyLower.startsWith('!borrar') || bodyLower === '!exportar' ||
            bodyLower.startsWith('!correo')) {
            if (rol !== 'admin') {
                return await msg.reply('⛔ No tienes permiso para este comando.');
            }

            if (bodyLower === '!usuarios') {
                let lista = '👥 *ADMINISTRADORES:*\n';
                ADMIN_USERS.forEach(n => { lista += `  • ${n}\n`; });
                if (ALLOWED_USERS.size > 0) {
                    lista += `\n📋 *OPERADORES AUTORIZADOS:*\n`;
                    ALLOWED_USERS.forEach(n => { lista += `  • ${n}\n`; });
                } else {
                    lista += '\n📋 Modo abierto: cualquier usuario puede reportar.';
                }
                return await msg.reply(lista);
            }

            if (bodyLower === '!pendientes') {
                const reportes = loadReportes();
                const pendientes = reportes.filter(r => !r.enviado_kobo);
                if (pendientes.length === 0) {
                    return await msg.reply('✅ No hay reportes pendientes. Todo enviado correctamente.');
                }
                let msg2 = `⚠️ *REPORTES CON FALLO DE ENVÍO:* ${pendientes.length}\n\n`;
                pendientes.slice(-10).forEach(r => {
                    msg2 += `📌 ${formatearFecha(r.timestamp)}\n`;
                    msg2 += `   ID: ${(r.id || '').substring(0, 8)}\n`;
                    msg2 += `   Tipo: ${r.tipo}\n`;
                    msg2 += `   Operador: ${r.personal}\n`;
                    msg2 += `   Unidad: ${r.unidad}\n\n`;
                });
                if (pendientes.length > 10) {
                    msg2 += `... y ${pendientes.length - 10} más.`;
                }
                return await msg.reply(msg2);
            }

            if (bodyLower.startsWith('!broadcast')) {
                const texto = body.substring('!broadcast'.length).trim();
                if (!texto) {
                    return await msg.reply('Uso: `!broadcast <mensaje>`\n\nEjemplo: `!broadcast Mañana hay simulacro a las 8am en la Plaza Bolívar`');
                }

                const destinatarios = recolectarDestinatarios();
                if (destinatarios.length === 0) {
                    return await msg.reply('⚠️ No hay destinatarios registrados todavía. Cuando más personas usen el bot, aparecerán aquí.');
                }

                await msg.reply(`📣 Enviando broadcast a ${destinatarios.length} contacto(s)...`);

                const mensajeBroadcast = `📢 *COMUNICADO OFICIAL*\n\n${texto}\n\n_Enviado por administración_`;
                let enviados = 0;
                let fallidos = 0;

                for (const destino of destinatarios) {
                    try {
                        await client.sendMessage(destino, mensajeBroadcast);
                        enviados++;
                    } catch (err) {
                        fallidos++;
                        log(`⚠️ Broadcast falló a ${destino}: ${err.message}`);
                    }
                    await new Promise(r => setTimeout(r, 500));
                }

                log(`📣 Broadcast: ${enviados} enviados, ${fallidos} fallidos`);
                return await msg.reply(`✅ Broadcast completado.\n\nEnviados: ${enviados}\nFallidos: ${fallidos}`);
            }

            if (bodyLower.startsWith('!borrar')) {
                const idCorto = body.substring('!borrar'.length).trim().toLowerCase();
                if (!idCorto || idCorto.length < 4) {
                    return await msg.reply('Uso: `!borrar <id>`\n\nUsa los primeros 8 caracteres del ID del reporte. Puedes verlos con `!pendientes` o `!stats`.');
                }

                const reportes = loadReportes();
                const indice = reportes.findIndex(r => (r.id || '').toLowerCase().startsWith(idCorto));

                if (indice === -1) {
                    return await msg.reply(`⚠️ No se encontró ningún reporte con ID que empiece por "${idCorto}".`);
                }

                const eliminado = reportes[indice];
                reportes.splice(indice, 1);
                saveReportes(reportes);

                log(`🗑️ Reporte ${idCorto} eliminado por admin`);
                return await msg.reply(`🗑️ Reporte eliminado:\n\nID: ${(eliminado.id || '').substring(0, 8)}\nTipo: ${eliminado.tipo}\nOperador: ${eliminado.personal}\nFecha: ${eliminado.fecha}`);
            }

            if (bodyLower === '!exportar') {
                const reportes = loadReportes();
                if (reportes.length === 0) {
                    return await msg.reply('⚠️ No hay reportes en el historial para exportar.');
                }

                const csv = generarCSV(reportes);
                const nombreArchivo = `reportes_${new Date().toISOString().split('T')[0]}.csv`;
                const rutaArchivo = path.join(__dirname, nombreArchivo);

                try {
                    fs.writeFileSync(rutaArchivo, '\uFEFF' + csv, 'utf8');
                    log(`📄 CSV generado: ${rutaArchivo} (${reportes.length} reportes)`);

                    const media = MessageMedia.fromFilePath(rutaArchivo);
                    await msg.reply(media, undefined, {
                        caption: `📄 *Reporte de datos*\nTotal: ${reportes.length} registros\nFecha: ${new Date().toLocaleDateString('es-VE')}`
                    });

                    setTimeout(() => {
                        try { fs.unlinkSync(rutaArchivo); } catch (e) {}
                    }, 30000);

                    return;
                } catch (err) {
                    log(`❌ Error exportando CSV: ${err.message}`);
                    return await msg.reply(`❌ Error al generar el CSV: ${err.message}`);
                }
            }

            // 🆕 [3.1] !correo
            if (bodyLower.startsWith('!correo')) {
                const arg = body.substring('!correo'.length).trim().toLowerCase();

                const todos = loadReportes();
                if (todos.length === 0) {
                    return await msg.reply('⚠️ No hay reportes en el historial para enviar.');
                }

                const ahora = new Date();
                let filtrados, periodo;

                if (arg === 'hoy' || !arg) {
                    const desde = new Date(ahora.getFullYear(), ahora.getMonth(), ahora.getDate());
                    filtrados = filtrarPorRango(todos, desde, ahora);
                    periodo = `Hoy (${ahora.toLocaleDateString('es-VE')})`;
                } else if (arg === 'semana') {
                    const desde = new Date(ahora.getTime() - 7 * 24 * 60 * 60 * 1000);
                    filtrados = filtrarPorRango(todos, desde, ahora);
                    periodo = `Última semana (${desde.toLocaleDateString('es-VE')} - ${ahora.toLocaleDateString('es-VE')})`;
                } else if (arg === 'mes') {
                    const desde = new Date(ahora.getFullYear(), ahora.getMonth(), 1);
                    filtrados = filtrarPorRango(todos, desde, ahora);
                    periodo = `Mes en curso (${desde.toLocaleDateString('es-VE')} - ${ahora.toLocaleDateString('es-VE')})`;
                } else if (arg === 'todo') {
                    filtrados = todos;
                    periodo = `Histórico completo (${todos.length} reportes)`;
                } else {
                    return await msg.reply('Uso: `!correo hoy` / `!correo semana` / `!correo mes` / `!correo todo`');
                }

                if (filtrados.length === 0) {
                    return await msg.reply(`⚠️ No hay reportes para el período: ${periodo}`);
                }

                await msg.reply(`📄 Generando PDF con ${filtrados.length} reportes...`);

                try {
                    const pdfBuffer = await generarPDF(filtrados, periodo);
                    log(`📄 PDF generado (${(pdfBuffer.length / 1024).toFixed(1)} KB)`);

                    await msg.reply('📧 Enviando correo...');
                    await enviarCorreo(pdfBuffer, periodo, filtrados.length);

                    log(`✅ Reporte enviado a ${EMAIL_DESTINO} (${filtrados.length} reportes)`);
                    return await msg.reply(`✅ Reporte enviado correctamente.\n\n📧 Destino: ${EMAIL_DESTINO}\n📊 Reportes incluidos: ${filtrados.length}\n📅 Período: ${periodo}`);
                } catch (err) {
                    log(`❌ Error en !correo: ${err.message}`);
                    return await msg.reply(`❌ Error al generar o enviar el reporte: ${err.message}`);
                }
            }

            // !stats
            const ahora = new Date();
            let desde, titulo;

            if (bodyLower.includes('hoy')) {
                desde = new Date(ahora.getFullYear(), ahora.getMonth(), ahora.getDate());
                titulo = 'REPORTES DE HOY';
            } else if (bodyLower.includes('semana')) {
                desde = new Date(ahora.getTime() - 7 * 24 * 60 * 60 * 1000);
                titulo = 'REPORTES ÚLTIMOS 7 DÍAS';
            } else if (bodyLower.includes('mes')) {
                desde = new Date(ahora.getFullYear(), ahora.getMonth(), 1);
                titulo = 'REPORTES DEL MES';
            } else if (bodyLower.includes('tipo')) {
                const reportes = loadReportes();
                return await msg.reply(generarStats('REPORTES POR TIPO (histórico)', reportes));
            } else if (bodyLower.includes('unidad')) {
                const reportes = loadReportes();
                return await msg.reply(generarStats('REPORTES POR UNIDAD (histórico)', reportes));
            } else if (bodyLower.includes('operador')) {
                const reportes = loadReportes();
                return await msg.reply(generarStats('REPORTES POR OPERADOR (histórico)', reportes));
            } else {
                desde = new Date(ahora.getFullYear(), ahora.getMonth(), ahora.getDate());
                titulo = 'REPORTES DE HOY';
            }

            const todosStats = loadReportes();
            const filtradosStats = filtrarPorRango(todosStats, desde, ahora);
            return await msg.reply(generarStats(titulo, filtradosStats));
        }

        // ===================== FIN COMANDOS ADMIN =====================

        if (bodyLower === '!cancelar') {
            delete sessions[from];
            saveSessions(sessions);
            return await msg.reply('Reporte cancelado. Escribe !reporte para comenzar uno nuevo.');
        }

        if (bodyLower === '!reporte' || bodyLower === '!start') {
            sessions[from] = {
                step: 'FECHA',
                data: {
                    repeat_heridos: [],
                    repeat_pacientes: [],
                    repeat_participantes: [],
                    inspecciones: {}
                },
                repeatIndex: 0
            };
            saveSessions(sessions);
            return await msg.reply('INICIO DE REPORTE OPERATIVO SIERRA\n\nIndica la Fecha del procedimiento (Ej: 2026-08-30 o responde "hoy"):');
        }

        if (!sessions[from]) {
            return await msg.reply('Hola. Escribe !reporte para iniciar la recoleccion de datos del servicio.');
        }

        const session = sessions[from];

        switch (session.step) {

            case 'FECHA': {
                let fecha = body.toLowerCase() === 'hoy'
                    ? new Date().toLocaleDateString('en-CA')
                    : body;
                if (!isValidDate(fecha)) {
                    return await msg.reply('Fecha invalida. Por favor usa formato YYYY-MM-DD o responde "hoy".');
                }
                session.data.Fecha = fecha;
                session.step = 'HORA_INICIO';
                await msg.reply('Ingresa la Hora de Inicio (Ej: 08:30 AM):');
                break;
            }

            case 'HORA_INICIO': {
                if (!isValidTime(body)) {
                    return await msg.reply('Hora invalida. Usa el formato HH:MM AM/PM (ej. 08:30 AM).');
                }
                session.data.Hora_de_Inicio = body.toUpperCase();
                session.step = 'HORA_FIN';
                await msg.reply('Ingresa la Hora de Finalizacion (Ej: 10:15 AM):');
                break;
            }

            case 'HORA_FIN': {
                if (!isValidTime(body)) {
                    return await msg.reply('Hora invalida. Usa el formato HH:MM AM/PM (ej. 10:15 AM).');
                }
                session.data.Hora_de_Finalizacion = body.toUpperCase();
                session.step = 'UBICACION';
                await msg.reply('Envia la Ubicacion GPS (comparte ubicacion por WhatsApp) o escribe las coordenadas/direccion:');
                break;
            }

            case 'UBICACION': {
                if (msg.hasLocation) {
                    session.data.Ubicacion = msg.location.latitude + ', ' + msg.location.longitude;
                } else {
                    session.data.Ubicacion = body;
                }
                session.step = 'PERSONAL';
                await msg.reply('Ingresa el Personal Asignado (Nombres/Apellidos de la comision):');
                break;
            }

            case 'PERSONAL': {
                if (body.length < 3) {
                    return await msg.reply('Ingresa al menos un nombre valido.');
                }
                session.data.Personal_Asignado = body;
                session.step = 'UNIDAD';
                await msg.reply(buildMenu(CHOICES.Unidad_Asignada, 'Selecciona la Unidad Asignada:'));
                break;
            }

            case 'UNIDAD': {
                const unidadSeleccionada = CHOICES.Unidad_Asignada.find(u => u.id === body);
                if (!unidadSeleccionada) {
                    return await msg.reply('Opcion invalida. Selecciona un numero del menu de Unidades.');
                }
                session.data.Unidad_Asignada = unidadSeleccionada.name;
                session.step = 'TIPO_PROCEDIMIENTO';
                await msg.reply(buildMenu(CHOICES.Tipo_de_Procedimiento, 'Selecciona el Tipo de Procedimiento:'));
                break;
            }

            case 'TIPO_PROCEDIMIENTO': {
                const proc = CHOICES.Tipo_de_Procedimiento.find(p => p.id === body);
                if (!proc) {
                    return await msg.reply('Opcion invalida. Ingresa el numero correspondiente al procedimiento.');
                }
                session.data.Tipo_de_Procedimiento = proc.name;

                if (proc.name === 'emergencia') {
                    session.step = 'EMERGENCIA_CANT_HERIDOS';
                    await msg.reply('Atencion de Emergencia\n\nIngresa la cantidad de heridos/pacientes a registrar:');
                } else if (proc.name === 'traslado') {
                    session.step = 'TRASLADO_PUNTO_LLEGADA';
                    await msg.reply('Servicio de Traslado Medico\n\nIngresa el Punto de Llegada / Centro Hospitalario de Destino:');
                } else if (proc.name === 'inspeccion') {
                    session.step = 'INSPECCION_TIPO';
                    await msg.reply(buildMenu(CHOICES.Tipo_Inspeccion, 'Area de Inspeccion\n\nSelecciona el Tipo de Inspeccion:'));
                } else if (proc.name === 'educacion_capacitacion') {
                    session.step = 'EDU_TEMA';
                    await msg.reply('Educacion y Capacitacion\n\nIngresa el Tema de la Capacitacion:');
                } else if (proc.name === 'operaciones_charlie') {
                    session.step = 'CHARLIE_LITROS';
                    await msg.reply('Operaciones Charlie (Cisterna)\n\nIngresa la cantidad de litros despachados:');
                } else if (proc.name === 'despliegue') {
                    session.step = 'DESPLIEGUE_MOTIVO';
                    await msg.reply('Despliegue Operativo\n\nIngresa el Motivo del Despliegue/Dispositivo:');
                } else if (proc.name === 'puesto_de_operaciones_vigente') {
                    session.step = 'POV_TIPO_EVENTO';
                    await msg.reply('Puesto de Operaciones Vigente (P.O.V)\n\nTipo de Evento:\n1 - Publico\n2 - Privado');
                } else if (proc.name === 'monitoreo_hidromet') {
                    session.step = 'MONITOREO_TIPO';
                    await msg.reply(buildMenu(CHOICES.opt_tipo_amenaza, 'Monitoreo de Eventos Adversos\n\nSelecciona el Tipo de Amenaza Monitoreada:'));
                }
                break;
            }

            case 'TRASLADO_PUNTO_LLEGADA': {
                if (body.length < 3) {
                    return await msg.reply('Ingresa un punto de llegada valido.');
                }
                session.data.Punto_Llegada = body;
                session.step = 'OBSERVACIONES';
                await msg.reply('Ingresa las Observaciones / Descripcion del Procedimiento (o "omitir" si no hay):');
                break;
            }

            case 'INSPECCION_TIPO': {
                const insp = CHOICES.Tipo_Inspeccion.find(i => i.id === body);
                if (!insp) {
                    return await msg.reply('Opcion invalida. Selecciona un numero del menu de Inspeccion.');
                }
                session.data.Tipo_Inspeccion = insp.name;

                const items = INSPECCION_ITEMS[insp.name] || [];
                if (items.length > 0) {
                    session.step = 'INSPECCION_EVAL';
                    session.inspIndex = 0;
                    session.currentInspItems = items;
                    await msg.reply(buildMenu(CHOICES.opt_eval, 'Evaluacion: ' + items[0].label));
                } else {
                    session.step = 'OBSERVACIONES';
                    await msg.reply('Ingresa las Observaciones / Descripcion del Procedimiento (o "omitir" si no hay):');
                }
                break;
            }

            case 'INSPECCION_EVAL': {
                const evalOpt = CHOICES.opt_eval.find(e => e.id === body);
                if (!evalOpt) {
                    return await msg.reply('Opcion invalida. Selecciona 1 (Cumple), 2 (No Cumple) o 3 (No Aplica).');
                }

                const currentItem = session.currentInspItems[session.inspIndex];
                session.data.inspecciones[currentItem.key] = evalOpt.name;
                session.inspIndex++;

                if (session.inspIndex < session.currentInspItems.length) {
                    const nextItem = session.currentInspItems[session.inspIndex];
                    await msg.reply(buildMenu(CHOICES.opt_eval, 'Evaluacion: ' + nextItem.label));
                } else {
                    delete session.inspIndex;
                    delete session.currentInspItems;
                    session.step = 'OBSERVACIONES';
                    await msg.reply('Ingresa las Observaciones / Descripcion del Procedimiento (o "omitir" si no hay):');
                }
                break;
            }

            case 'EDU_TEMA': {
                if (body.length < 3) {
                    return await msg.reply('Ingresa un tema valido.');
                }
                session.data.Tema_Capacitacion = body;
                session.step = 'EDU_TOTAL_PARTICIPANTES';
                await msg.reply('Ingresa el Total de Participantes:');
                break;
            }

            case 'EDU_TOTAL_PARTICIPANTES': {
                if (!isValidPositiveInteger(body)) {
                    return await msg.reply('Cantidad invalida. Debe ser un numero entero positivo.');
                }
                session.data.Total_Participantes = body;
                session.step = 'EDU_CANT_MASCULINOS';
                await msg.reply('Ingresa la Cantidad de Masculinos:');
                break;
            }

            case 'EDU_CANT_MASCULINOS': {
                if (!isValidNonNegativeInteger(body)) {
                    return await msg.reply('Cantidad invalida. Debe ser un numero entero mayor o igual a 0.');
                }
                session.data.Cant_Masculinos = body;
                session.step = 'EDU_CANT_FEMENINAS';
                await msg.reply('Ingresa la Cantidad de Femeninas:');
                break;
            }

            case 'EDU_CANT_FEMENINAS': {
                if (!isValidNonNegativeInteger(body)) {
                    return await msg.reply('Cantidad invalida. Debe ser un numero entero mayor o igual a 0.');
                }
                session.data.Cant_Femeninas = body;
                session.step = 'OBSERVACIONES';
                await msg.reply('Ingresa las Observaciones / Descripcion del Procedimiento (o "omitir" si no hay):');
                break;
            }

            case 'CHARLIE_LITROS': {
                if (!isValidPositiveInteger(body)) {
                    return await msg.reply('Cantidad invalida. Ingresa un numero entero positivo.');
                }
                session.data.Litros_Despachados = body;
                session.step = 'CHARLIE_ESTADO_TANQUE';
                await msg.reply('Ingresa el Estado del Tanque (%):');
                break;
            }

            case 'CHARLIE_ESTADO_TANQUE': {
                if (!isValidPercentage(body)) {
                    return await msg.reply('Porcentaje invalido. Debe ser un numero entre 0 y 100.');
                }
                session.data.Estado_Tanque = body;
                session.step = 'OBSERVACIONES';
                await msg.reply('Ingresa las Observaciones / Descripcion del Procedimiento (o "omitir" si no hay):');
                break;
            }

            case 'DESPLIEGUE_MOTIVO': {
                if (body.length < 3) {
                    return await msg.reply('Ingresa un motivo valido.');
                }
                session.data.Motivo_Despliegue = body;
                session.step = 'DESPLIEGUE_ORGANISMOS';
                await msg.reply('Ingresa los Organismos Presentes:');
                break;
            }

            case 'DESPLIEGUE_ORGANISMOS': {
                if (body.length < 2) {
                    return await msg.reply('Ingresa al menos un organismo.');
                }
                session.data.Organismos_Presentes = body;
                session.step = 'DESPLIEGUE_CANT_EFECTIVOS';
                await msg.reply('Ingresa la Cantidad de Efectivos Presentes:');
                break;
            }

            case 'DESPLIEGUE_CANT_EFECTIVOS': {
                if (!isValidPositiveInteger(body)) {
                    return await msg.reply('Cantidad invalida. Ingresa un numero entero positivo.');
                }
                session.data.Cant_Efectivos = body;
                session.step = 'OBSERVACIONES';
                await msg.reply('Ingresa las Observaciones / Descripcion del Procedimiento (o "omitir" si no hay):');
                break;
            }

            case 'POV_TIPO_EVENTO': {
                const pov = CHOICES.opt_tipo_evento.find(e => e.id === body);
                if (!pov) {
                    return await msg.reply('Opcion invalida. Ingresa 1 para Publico o 2 para Privado.');
                }
                session.data.Tipo_Evento = pov.name;
                session.step = 'POV_MOTIVO';
                await msg.reply('Ingresa el Motivo del P.O.V:');
                break;
            }

            case 'POV_MOTIVO': {
                if (body.length < 3) {
                    return await msg.reply('Ingresa un motivo valido.');
                }
                session.data.Motivo_POV = body;
                session.step = 'POV_ESTATUS';
                await msg.reply(buildMenu(CHOICES.opt_estatus_pov, 'Selecciona el Estatus del Servicio:'));
                break;
            }

            case 'POV_ESTATUS': {
                const estatus = CHOICES.opt_estatus_pov.find(e => e.id === body);
                if (!estatus) {
                    return await msg.reply('Opcion invalida. Selecciona un numero de Estatus.');
                }
                session.data.Estatus_POV = estatus.name;
                session.step = 'POV_CANT_PERSONAS';
                await msg.reply('Ingresa la Cantidad de Personas Atendidas (puede ser 0):');
                break;
            }

            case 'POV_CANT_PERSONAS': {
                if (!isValidNonNegativeInteger(body)) {
                    return await msg.reply('Cantidad invalida. Debe ser un numero entero mayor o igual a 0.');
                }
                session.data.Cant_Personas_Atendidas = body;
                session.step = 'OBSERVACIONES';
                await msg.reply('Ingresa las Observaciones / Descripcion del Procedimiento (o "omitir" si no hay):');
                break;
            }

            case 'MONITOREO_TIPO': {
                const mon = CHOICES.opt_tipo_amenaza.find(a => a.id === body);
                if (!mon) {
                    return await msg.reply('Opcion invalida. Selecciona un numero de Amenaza.');
                }
                session.data.Mon_Tipo_Evento = mon.name;
                session.step = 'MONITOREO_NOMBRE';
                await msg.reply('Ingresa el Nombre del Rio, Quebrada o Sector Monitoreado:');
                break;
            }

            case 'MONITOREO_NOMBRE': {
                if (body.length < 2) {
                    return await msg.reply('Ingresa un nombre valido.');
                }
                session.data.Mon_Nombre_Cause_Sector = body;
                session.step = 'MONITOREO_RIESGO';
                await msg.reply(buildMenu(CHOICES.opt_nivel_riesgo, 'Selecciona el Nivel de Riesgo:'));
                break;
            }

            case 'MONITOREO_RIESGO': {
                const riesgo = CHOICES.opt_nivel_riesgo.find(r => r.id === body);
                if (!riesgo) {
                    return await msg.reply('Opcion invalida. Selecciona un numero de Nivel de Riesgo.');
                }
                session.data.Mon_Nivel_Riesgo = riesgo.name;
                session.step = 'MONITOREO_VIVIENDAS';
                await msg.reply('Ingresa la Cantidad Estimada de Viviendas en Riesgo:');
                break;
            }

            case 'MONITOREO_VIVIENDAS': {
                if (!isValidPositiveInteger(body)) {
                    return await msg.reply('Cantidad invalida. Ingresa un numero entero positivo.');
                }
                session.data.Mon_Viviendas_Riesgo = body;
                session.step = 'MONITOREO_ACCIONES';
                await msg.reply('Ingresa las Acciones Preventivas/Acciones Tomadas:');
                break;
            }

            case 'MONITOREO_ACCIONES': {
                if (body.length < 3) {
                    return await msg.reply('Ingresa al menos una accion.');
                }
                session.data.Mon_Acciones_Tomadas = body;
                session.step = 'OBSERVACIONES';
                await msg.reply('Ingresa las Observaciones / Descripcion del Procedimiento (o "omitir" si no hay):');
                break;
            }

            case 'EMERGENCIA_CANT_HERIDOS': {
                const cant = Number(body);
                if (!Number.isInteger(cant) || cant < 0) {
                    return await msg.reply('Cantidad invalida. Debe ser un numero entero mayor o igual a 0.');
                }
                session.data.Cant_Heridos = cant;
                if (cant > 0) {
                    session.currentHerido = {};
                    session.repeatIndex = 1;
                    session.step = 'HERIDO_NOMBRE';
                    await msg.reply('Paciente #' + session.repeatIndex + '\n\nNombres y Apellidos del paciente:');
                } else {
                    session.step = 'OBSERVACIONES';
                    await msg.reply('Ingresa las Observaciones / Descripcion del Procedimiento (o "omitir" si no hay):');
                }
                break;
            }

            case 'HERIDO_NOMBRE': {
                if (body.length < 3) {
                    return await msg.reply('Ingresa un nombre valido.');
                }
                session.currentHerido.Nombres_Apellidos = body;
                session.step = 'HERIDO_CI';
                await msg.reply('C.I. / Documento de Identidad:');
                break;
            }

            case 'HERIDO_CI': {
                session.currentHerido.C_I = body;
                session.step = 'HERIDO_TA';
                await msg.reply('Tension Arterial (mmHg) (Ej: 120/80):');
                break;
            }

            case 'HERIDO_TA': {
                session.currentHerido.Tension_Arterial = body;
                session.step = 'HERIDO_FC';
                await msg.reply('Frecuencia Cardiaca (lpm):');
                break;
            }

            case 'HERIDO_FC': {
                session.currentHerido.Frecuencia_Cardiaca = body;
                session.step = 'HERIDO_SPO2';
                await msg.reply('SpO2 / Saturacion de Oxigeno (%):');
                break;
            }

            case 'HERIDO_SPO2': {
                session.currentHerido.SpO2 = body;
                session.step = 'HERIDO_GLICEMIA';
                await msg.reply('Glicemia (mg/dl):');
                break;
            }

            case 'HERIDO_GLICEMIA': {
                session.currentHerido.Glicemia = body;
                session.step = 'HERIDO_DX';
                await msg.reply('D(x) / Impresion Diagnostica:');
                break;
            }

            case 'HERIDO_DX': {
                session.currentHerido.Diagnostico = body;
                session.data.repeat_heridos.push(Object.assign({}, session.currentHerido));

                if (session.repeatIndex < session.data.Cant_Heridos) {
                    session.repeatIndex++;
                    session.currentHerido = {};
                    session.step = 'HERIDO_NOMBRE';
                    await msg.reply('Paciente #' + session.repeatIndex + '\n\nNombres y Apellidos del siguiente paciente:');
                } else {
                    delete session.currentHerido;
                    delete session.repeatIndex;
                    session.step = 'OBSERVACIONES';
                    await msg.reply('Ingresa las Observaciones / Descripcion del Procedimiento (o "omitir" si no hay):');
                }
                break;
            }

            case 'OBSERVACIONES': {
                if (body.toLowerCase() === 'omitir') {
                    session.data.Observaciones_Procedimientos = '';
                } else {
                    session.data.Observaciones_Procedimientos = body;
                }
                session.step = 'FOTO';
                await msg.reply('Envia la Fotografia de Evidencia (adjunta una foto) o escribe "omitir":');
                break;
            }

            case 'FOTO': {
                if (msg.hasMedia) {
                    try {
                        const media = await msg.downloadMedia();
                        if (media && media.data) {
                            let extension = '.jpg';
                            const mimetype = msg.mimetype || (msg._data && msg._data.mimetype) || '';
                            if (mimetype.indexOf('png') !== -1) extension = '.png';
                            else if (mimetype.indexOf('webp') !== -1) extension = '.webp';
                            else if (mimetype.indexOf('gif') !== -1) extension = '.gif';

                            const filename = from.replace('@c.us', '').replace(/[^0-9]/g, '') + '_' + Date.now() + extension;
                            const filepath = path.join(PHOTO_DIR, filename);
                            fs.writeFileSync(filepath, Buffer.from(media.data, 'base64'));
                            session.data.Foto_Evidencia = filepath;
                            log('Imagen guardada: ' + filepath);
                        } else {
                            log('media.data vacio, se omite la foto');
                            session.data.Foto_Evidencia = 'No descargada';
                        }
                    } catch (err) {
                        log('Error descargando imagen de ' + from + ': ' + (err.message || err));
                        session.data.Foto_Evidencia = 'No descargada';
                    }
                } else {
                    if (body.toLowerCase() === 'omitir') {
                        session.data.Foto_Evidencia = 'Sin foto';
                    } else {
                        session.data.Foto_Evidencia = body;
                    }
                }

                const enviado = await submitToKobo(session.data);
                session.data.EnvioKoboExitoso = enviado;

                registrarReporte(from, session.data, enviado);

                let resumen = 'REPORTE COMPLETADO EXITOSAMENTE\n\n';
                resumen += '- Fecha: ' + session.data.Fecha + '\n';
                resumen += '- Procedimiento: ' + session.data.Tipo_de_Procedimiento + '\n';
                resumen += '- Ubicacion: ' + session.data.Ubicacion + '\n';
                resumen += '- Personal: ' + session.data.Personal_Asignado + '\n';

                if (session.data.Tipo_de_Procedimiento === 'educacion_capacitacion') {
                    resumen += '- Tema: ' + session.data.Tema_Capacitacion + '\n';
                    resumen += '- Total Participantes: ' + session.data.Total_Participantes + '\n';
                    resumen += '- Masculinos: ' + session.data.Cant_Masculinos + '\n';
                    resumen += '- Femeninas: ' + session.data.Cant_Femeninas + '\n';
                } else if (session.data.Tipo_de_Procedimiento === 'operaciones_charlie') {
                    resumen += '- Litros Despachados: ' + session.data.Litros_Despachados + '\n';
                    resumen += '- Estado del Tanque: ' + session.data.Estado_Tanque + '%\n';
                } else if (session.data.Tipo_de_Procedimiento === 'despliegue') {
                    resumen += '- Motivo: ' + session.data.Motivo_Despliegue + '\n';
                    resumen += '- Organismos: ' + session.data.Organismos_Presentes + '\n';
                    resumen += '- Efectivos: ' + session.data.Cant_Efectivos + '\n';
                } else if (session.data.Tipo_de_Procedimiento === 'puesto_de_operaciones_vigente') {
                    resumen += '- Tipo de Evento: ' + session.data.Tipo_Evento + '\n';
                    resumen += '- Motivo P.O.V: ' + session.data.Motivo_POV + '\n';
                    resumen += '- Estatus: ' + session.data.Estatus_POV + '\n';
                    resumen += '- Personas Atendidas: ' + session.data.Cant_Personas_Atendidas + '\n';
                } else if (session.data.Tipo_de_Procedimiento === 'monitoreo_hidromet') {
                    resumen += '- Tipo Amenaza: ' + session.data.Mon_Tipo_Evento + '\n';
                    resumen += '- Sector: ' + session.data.Mon_Nombre_Cause_Sector + '\n';
                    resumen += '- Nivel Riesgo: ' + session.data.Mon_Nivel_Riesgo + '\n';
                    resumen += '- Viviendas en Riesgo: ' + session.data.Mon_Viviendas_Riesgo + '\n';
                    resumen += '- Acciones: ' + session.data.Mon_Acciones_Tomadas + '\n';
                } else if (session.data.Tipo_de_Procedimiento === 'emergencia' && session.data.repeat_heridos.length > 0) {
                    resumen += '- Pacientes registrados: ' + session.data.repeat_heridos.length + '\n';
                }

                if (session.data.Observaciones_Procedimientos) {
                    resumen += '\nObservaciones: ' + session.data.Observaciones_Procedimientos + '\n';
                }

                if (session.data.Foto_Evidencia && session.data.Foto_Evidencia !== 'Sin foto') {
                    resumen += '\nFotografia: ' + session.data.Foto_Evidencia + '\n';
                } else {
                    resumen += '\nSin fotografia.\n';
                }

                if (session.data.EnvioKoboExitoso) {
                    resumen += '\nDatos enviados correctamente a KoboToolbox.';
                } else {
                    resumen += '\nNo se pudo enviar automaticamente a KoboToolbox.';
                }

                await msg.reply(resumen);
                delete sessions[from];
                saveSessions(sessions);
                break;
            }

            default:
                await msg.reply('Comando no reconocido. Usa !ayuda para ver los comandos disponibles.');
        }

        if (sessions[from]) {
            saveSessions(sessions);
        }
    } catch (error) {
        console.error('❌ Error en el manejador de mensajes:', error.message);
        log(`❌ Error en manejador: ${error.message}`);
    }
});

// ===================== REPORTE AUTOMÁTICO DIARIO (FASE 3.2) =====================
let ultimoEnvioAutomatico = null;

async function notificarAdmin(mensaje) {
    const destinosRaw = process.env.AUTO_REPORTE_NOTIFICAR_A || '';
    const destinos = destinosRaw
        .split(',')
        .map(d => d.trim())
        .filter(d => d.length > 0);

    if (destinos.length === 0) {
        log('⚠️ No hay AUTO_REPORTE_NOTIFICAR_A configurado. No se envía notificación.');
        return;
    }

    let enviados = 0;
    let fallidos = 0;

    for (const destino of destinos) {
        try {
            await client.sendMessage(destino, mensaje);
            enviados++;
            log(`📨 Notificación enviada a ${destino}`);
        } catch (err) {
            fallidos++;
            log(`⚠️ Error al notificar a ${destino}: ${err.message}`);
        }
        // Pequeña pausa entre envíos para no saturar
        await new Promise(r => setTimeout(r, 500));
    }

    log(`📨 Notificaciones: ${enviados} enviadas, ${fallidos} fallidas`);
}

async function enviarReporteAutomatico() {
    log('⏰ Disparando reporte automático diario...');

    try {
        const ahora = new Date();
        const desde = new Date(ahora.getFullYear(), ahora.getMonth(), ahora.getDate());
        const todos = loadReportes();
        const filtrados = filtrarPorRango(todos, desde, ahora);

        const soloConDatos = (process.env.AUTO_REPORTE_SOLO_CON_DATOS || 'true').toLowerCase() === 'true';

        if (filtrados.length === 0 && soloConDatos) {
            log('📭 Reporte automático: sin datos hoy. Se omite el envío.');
            return;
        }

        const periodo = `Hoy (${ahora.toLocaleDateString('es-VE')})`;
        log(`📄 Generando PDF automático con ${filtrados.length} reportes...`);
        const pdfBuffer = await generarPDF(filtrados, periodo);

        log('📧 Enviando correo automático...');
        await enviarCorreo(pdfBuffer, periodo, filtrados.length);

        log(`✅ Reporte automático enviado (${filtrados.length} reportes)`);
        await notificarAdmin(
            `✅ *Reporte automático enviado*\n\n` +
            `📧 Destino: ${EMAIL_DESTINO}\n` +
            `📊 Reportes incluidos: ${filtrados.length}\n` +
            `📅 Período: ${periodo}\n` +
            `🕒 Hora: ${ahora.toLocaleString('es-VE', { timeZone: 'America/Caracas' })}`
        );
    } catch (err) {
        log(`❌ Error en reporte automático: ${err.message}`);
        await notificarAdmin(
            `❌ *Error en reporte automático*\n\n` +
            `Motivo: ${err.message}\n` +
            `🕒 Hora: ${new Date().toLocaleString('es-VE', { timeZone: 'America/Caracas' })}`
        );
    }
}

function programarReporteDiario() {
    const habilitado = (process.env.AUTO_REPORTE_HABILITADO || 'false').toLowerCase() === 'true';
    if (!habilitado) {
        log('⏸️ Reporte automático diario DESHABILITADO.');
        return;
    }

    const horaConfig = parseInt(process.env.AUTO_REPORTE_HORA || '18');
    const minutoConfig = parseInt(process.env.AUTO_REPORTE_MINUTO || '0');

    log(`⏰ Reporte automático programado para las ${String(horaConfig).padStart(2, '0')}:${String(minutoConfig).padStart(2, '0')} (hora local)`);

    setInterval(async () => {
        const ahora = new Date();
        if (ahora.getHours() !== horaConfig || ahora.getMinutes() !== minutoConfig) {
            return;
        }

        // Clave única por minuto para evitar doble disparo
        const clave = `${ahora.getFullYear()}-${ahora.getMonth()}-${ahora.getDate()}-${horaConfig}-${minutoConfig}`;
        if (ultimoEnvioAutomatico === clave) {
            return;
        }
        ultimoEnvioAutomatico = clave;

        await enviarReporteAutomatico();
    }, 60 * 1000); // Revisar cada minuto
}

// Arrancar el programador
programarReporteDiario();

// ===================== CIERRE ORDENADO =====================
process.on('SIGINT', async () => {
    log('🛑 Cerrando bot ordenadamente...');
    try {
        await client.destroy();
        log('✅ Cliente cerrado correctamente.');
    } catch (err) {
        log(`⚠️ Error al cerrar: ${err.message}`);
    }
    process.exit(0);
});

// ===================== INICIAR =====================
client.initialize();