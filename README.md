# Proyecto SIERRA

Sistema de captura de reportes operativos vía WhatsApp para la Dirección Municipal de Protección Civil y Administración de Desastres Uribante, Estado Táchira, Venezuela.

## Descripción

Bot de WhatsApp que permite a funcionarios de campo reportar emergencias, inspecciones, traslados y monitoreos sin necesidad de usar plataformas web. Los datos se envían automáticamente a KoboToolbox y se generan reportes PDF institucionales enviados por correo electrónico.

## Requisitos

- Node.js 20 LTS o superior
- Chromium (para Puppeteer)
- Cuenta de KoboToolbox con formulario desplegado
- Cuenta de Resend para envío de correos

## Instalación

1. Clonar el repositorio
2. Instalar dependencias: `npm install`
3. Copiar `.env.example` a `.env` y completar las credenciales
4. Ejecutar: `node index.js`
5. Escanear el código QR con WhatsApp

## Comandos disponibles

- `!reporte` — Iniciar un reporte
- `!cancelar` — Cancelar el reporte actual
- `!ayuda` — Ver todos los comandos
- (Admin) `!stats`, `!correo`, `!exportar`, `!broadcast`, etc.

## Estructura

- `index.js` — Código principal del bot
- `templates/reporte.html` — Plantilla del PDF institucional
- `assets/` — Logo y hoja membretada (no incluidos en el repositorio)
- `photos/` — Evidencia fotográfica (no incluida)

## Licencia

Proyecto institucional sin fines de lucro.

---

*Periculum administratur, non tantum partitur.*