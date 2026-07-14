# Tickets — Gastos deducibles

App web (móvil) para digitalizar tickets de gasto: escanear con la cámara,
extraer los datos, generar un PDF justificante, archivar por meses y exportar
todo (Excel + ZIP) para el asesor fiscal.

Todo funciona **dentro del navegador**. Los tickets, imágenes y PDFs se guardan
en el propio teléfono (IndexedDB). **Nada se sube a ningún servidor.**

## Qué hace

1. **Escanear con la cámara** — botón central. Abre la cámara, detecta el borde
   del ticket, lo endereza (corrige perspectiva) y lo mejora tipo escáner.
   También puedes *Subir una imagen* como opción secundaria.
2. **Extrae los datos** automáticamente (OCR): comercio, CIF/NIF, fecha, base,
   IVA (tipo e importe) y total. Los muestra en una ficha **editable** para
   confirmar o corregir en dos toques, con selector de categoría.
3. **Genera un PDF justificante** por ticket con los datos + la imagen del
   escaneo incrustada. Guarda siempre el escaneo original **y** el PDF.
4. **Archiva por meses** automáticamente según la fecha del ticket
   (`2026-01 Enero`, `2026-02 Febrero`…).
5. **Vista por mes**: total arriba, lista con miniatura/comercio/fecha/importe,
   selección múltiple y:
   - **Excel** (una fila por ticket + fila de totales) listo para el asesor.
   - **Paquete ZIP** (escaneos + PDFs + Excel).
   - **Enviar a mi asesor** (comparte el ZIP por correo/WhatsApp en el móvil).

## Cómo usarla en el móvil

La cámara del navegador **exige HTTPS** (o `localhost`). Opciones:

- **La más fácil — Netlify Drop:** entra en <https://app.netlify.com/drop>
  y **arrastra la carpeta `ticketsbolso` entera** a la página. En segundos te da
  una URL `https://…netlify.app`. Ábrela en el móvil y *Añadir a pantalla de
  inicio*. (Gratis; puede pedirte crear una cuenta.)
- **Vercel:** entra en <https://vercel.com/new>, arrastra la carpeta o sube los
  archivos. (El despliegue automático falló porque la cuenta conectada no tenía
  permiso para crear proyectos; hazlo desde tu propia cuenta.)
- **En el ordenador** (con webcam) para probar: ver abajo.

> La primera vez que escaneas, el OCR descarga el modelo de español (unos MB) y
> queda cacheado; a partir de ahí funciona rápido y sin conexión.

## Probar en el ordenador

```bash
cd ticketsbolso
python3 -m http.server 8123
# abre http://localhost:8123
```

`localhost` es contexto seguro, así que la cámara del portátil funciona.

## Archivos

- `index.html` — interfaz y estilos.
- `app.js` — toda la lógica (cámara, detección de bordes, enderezado, mejora,
  OCR, PDF, archivo por meses, Excel, ZIP, compartir).
- `manifest.webmanifest`, `icon.svg` — para instalarla como app (Añadir a inicio).

## Librerías (desde CDN)

- [Tesseract.js](https://tesseract.projectnaptha.com/) — OCR.
- [jsPDF](https://github.com/parallax/jsPDF) — PDF.
- [SheetJS](https://sheetjs.com/) — Excel.
- [JSZip](https://stuk.github.io/jszip/) — ZIP.

La detección de bordes y el enderezado se hacen en JavaScript propio, sin
librerías pesadas.

## Limitaciones honestas

- **La extracción automática (OCR) es aproximada.** En tickets nítidos suele
  acertar comercio, CIF, fecha e importes; en tickets arrugados, borrosos o con
  tipografías raras se equivoca (sobre todo en el nombre del comercio). Por eso
  la ficha es editable: **revisa siempre los datos antes de guardar.**
- La **detección de bordes** funciona cuando el ticket es más claro que la
  superficie donde está (lo normal). Si no lo detecta, ajustas las esquinas a
  mano.
- La cámara necesita HTTPS o `localhost`.
