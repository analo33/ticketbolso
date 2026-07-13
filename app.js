/* ============================================================================
   Tickets — Gestión de gastos deducibles (autónomos, España)
   App 100% en el navegador. Los datos NO salen del teléfono: se guardan en
   IndexedDB (imágenes y PDFs) del propio dispositivo.
   ========================================================================== */

'use strict';

/* ----------------------------- Constantes -------------------------------- */
const MESES = ['Enero','Febrero','Marzo','Abril','Mayo','Junio',
               'Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];

const CATEGORIAS = [
  {id:'comidas',     label:'Comidas',     emoji:'🍽️'},
  {id:'transporte',  label:'Transporte',  emoji:'🚕'},
  {id:'material',    label:'Material',     emoji:'📎'},
  {id:'suministros', label:'Suministros', emoji:'💡'},
  {id:'otros',       label:'Otros',        emoji:'🧾'},
];
const CAT_LABEL = Object.fromEntries(CATEGORIAS.map(c=>[c.id,c.label]));

const RATES = [21,10,4,0]; // tipos de IVA en España

/* ------------------------- Utilidades numéricas -------------------------- */
function parseMoney(s){
  if(s===null||s===undefined) return null;
  s = String(s).trim().replace(/[^\d.,\-]/g,'');
  if(!s) return null;
  const hasDot = s.includes('.'), hasComma = s.includes(',');
  if(hasDot && hasComma){
    // el separador decimal es el que aparece más a la derecha
    if(s.lastIndexOf(',') > s.lastIndexOf('.')) s = s.replace(/\./g,'').replace(',', '.');
    else s = s.replace(/,/g,'');
  } else if(hasComma){
    s = s.replace(',', '.');
  }
  const n = parseFloat(s);
  return isNaN(n) ? null : n;
}
const eur = n => (Number(n)||0).toLocaleString('es-ES',{minimumFractionDigits:2,maximumFractionDigits:2}) + ' €';
const num2 = n => (Number(n)||0).toLocaleString('es-ES',{minimumFractionDigits:2,maximumFractionDigits:2});
function round2(n){ return Math.round((Number(n)+Number.EPSILON)*100)/100; }
function uid(){ return (crypto.randomUUID ? crypto.randomUUID() : 'id'+Date.now()+Math.random().toString(16).slice(2)); }

function monthKeyFromDate(iso){ return iso ? iso.slice(0,7) : ''; }
function monthLabel(key){
  if(!key) return 'Sin fecha';
  const [y,m] = key.split('-');
  return `${key} · ${MESES[parseInt(m,10)-1]||''} ${y}`;
}
function monthShort(key){
  const [y,m] = key.split('-');
  return `${MESES[parseInt(m,10)-1]||''} ${y}`;
}
function fmtDate(iso){
  if(!iso) return '—';
  const [y,m,d] = iso.split('-');
  return `${d}/${m}/${y}`;
}
function slug(s){
  return (s||'').normalize('NFD').replace(/[̀-ͯ]/g,'')
    .replace(/[^a-zA-Z0-9]+/g,'-').replace(/^-+|-+$/g,'').toLowerCase().slice(0,28) || 'ticket';
}

/* ============================================================================
   Capa de datos — IndexedDB
   Store 'tickets': metadatos (indexado por monthKey)
   Store 'blobs'  : imágenes originales y PDFs (por id)
   ========================================================================== */
const DB = (() => {
  let db = null;
  function open(){
    return new Promise((res,rej)=>{
      const req = indexedDB.open('tickets-gastos', 1);
      req.onupgradeneeded = e => {
        const d = e.target.result;
        if(!d.objectStoreNames.contains('tickets')){
          const s = d.createObjectStore('tickets', {keyPath:'id'});
          s.createIndex('monthKey','monthKey',{unique:false});
        }
        if(!d.objectStoreNames.contains('blobs')){
          d.createObjectStore('blobs', {keyPath:'id'});
        }
      };
      req.onsuccess = e => { db = e.target.result; res(db); };
      req.onerror = e => rej(e.target.error);
    });
  }
  function tx(store, mode){ return db.transaction(store, mode).objectStore(store); }
  function reqP(r){ return new Promise((res,rej)=>{ r.onsuccess=()=>res(r.result); r.onerror=()=>rej(r.error); }); }

  return {
    async init(){ if(!db) await open(); return db; },
    async putTicket(t){ return reqP(tx('tickets','readwrite').put(t)); },
    async getTicket(id){ return reqP(tx('tickets','readonly').get(id)); },
    async deleteTicket(id){ return reqP(tx('tickets','readwrite').delete(id)); },
    async allTickets(){ return reqP(tx('tickets','readonly').getAll()); },
    async putBlob(id, blob, type){ return reqP(tx('blobs','readwrite').put({id, blob, type})); },
    async getBlob(id){ const r = await reqP(tx('blobs','readonly').get(id)); return r ? r.blob : null; },
    async deleteBlob(id){ return reqP(tx('blobs','readwrite').delete(id)); },
  };
})();

/* ============================================================================
   Navegación entre pantallas
   ========================================================================== */
const nav = {
  stack: ['home'],
  go(id){
    document.querySelectorAll('.screen').forEach(s=>s.classList.remove('active'));
    document.getElementById(id).classList.add('active');
    window.scrollTo(0,0);
    if(this.stack[this.stack.length-1] !== id) this.stack.push(id);
    if(id === 'home') refreshHomeStats();
  },
  replace(id){
    document.querySelectorAll('.screen').forEach(s=>s.classList.remove('active'));
    document.getElementById(id).classList.add('active');
    this.stack[this.stack.length-1] = id;
    window.scrollTo(0,0);
  },
  back(){
    // Al salir de la cámara, apágala
    stopCamera();
    this.stack.pop();
    const prev = this.stack[this.stack.length-1] || 'home';
    document.querySelectorAll('.screen').forEach(s=>s.classList.remove('active'));
    document.getElementById(prev).classList.add('active');
    if(prev === 'home') refreshHomeStats();
    if(prev === 'archive') renderMonths();
    if(prev === 'month' && state.currentMonth) openMonth(state.currentMonth, true);
    window.scrollTo(0,0);
  }
};

/* ------------------------------- Toast ----------------------------------- */
let toastT;
function toast(msg){
  const el = document.getElementById('toast');
  el.textContent = msg; el.classList.add('show');
  clearTimeout(toastT); toastT = setTimeout(()=>el.classList.remove('show'), 2600);
}
function overlay(show, text, sub){
  const o = document.getElementById('overlay');
  if(show){ document.getElementById('ovText').textContent = text||'Procesando…';
            document.getElementById('ovSub').textContent = sub||''; o.classList.add('show'); }
  else o.classList.remove('show');
}

/* ============================================================================
   Estado global
   ========================================================================== */
const state = {
  captureBitmap: null,   // ImageBitmap/HTMLCanvas de la foto original
  corners: null,         // 4 esquinas detectadas [{x,y}...]
  scanBlob: null,        // imagen final del escaneo (jpeg)
  scanURL: null,
  draft: null,           // ticket en edición
  editingId: null,       // si estamos editando uno existente
  currentMonth: null,
  selected: new Set(),
};

/* ============================================================================
   CÁMARA
   ========================================================================== */
let mediaStream = null;
async function startCamera(){
  const video = document.getElementById('video');
  try{
    mediaStream = await navigator.mediaDevices.getUserMedia({
      video:{ facingMode:{ideal:'environment'}, width:{ideal:1920}, height:{ideal:1080} },
      audio:false
    });
    video.srcObject = mediaStream;
    await video.play().catch(()=>{});
  }catch(err){
    console.warn('Cámara no disponible:', err);
    toast('No se pudo abrir la cámara. Usa «Galería».');
  }
}
function stopCamera(){
  if(mediaStream){ mediaStream.getTracks().forEach(t=>t.stop()); mediaStream = null; }
  const video = document.getElementById('video');
  if(video) video.srcObject = null;
}
function captureFromVideo(){
  const video = document.getElementById('video');
  const w = video.videoWidth, h = video.videoHeight;
  if(!w || !h){ toast('La cámara aún no está lista'); return null; }
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  c.getContext('2d').drawImage(video, 0, 0, w, h);
  return c;
}

/* ============================================================================
   Detección de bordes y corrección de perspectiva — 100% JavaScript
   (sin dependencias pesadas: funciona sin conexión y rápido en el móvil)
   ========================================================================== */

/* Ordena 4 puntos: [arriba-izq, arriba-der, abajo-der, abajo-izq] */
function orderCorners(pts){
  const p = pts.slice();
  p.sort((a,b)=>a.y-b.y);
  const top = p.slice(0,2).sort((a,b)=>a.x-b.x);
  const bot = p.slice(2,4).sort((a,b)=>a.x-b.x);
  return [top[0], top[1], bot[1], bot[0]];
}

/* Detecta el rectángulo del papel por brillo (el ticket suele ser más claro que
   la mesa). Funciona con CUALQUIER proporción: tickets cuadrados o tiras muy
   estrechas y largas (típico ticket de restaurante). Devuelve 4 esquinas o null. */
function autoDetectCorners(canvas){
  const maxW = 340;
  const s = Math.min(1, maxW / canvas.width);
  const w = Math.max(1, Math.round(canvas.width*s)), h = Math.max(1, Math.round(canvas.height*s));
  const tmp = document.createElement('canvas'); tmp.width=w; tmp.height=h;
  const tctx = tmp.getContext('2d'); tctx.drawImage(canvas,0,0,w,h);
  const d = tctx.getImageData(0,0,w,h).data;
  const gray = new Float32Array(w*h); let sum=0;
  for(let i=0,p=0;i<d.length;i+=4,p++){ const g=d[i]*0.299+d[i+1]*0.587+d[i+2]*0.114; gray[p]=g; sum+=g; }
  const mean = sum/(w*h);
  const thr = Math.min(238, mean + 18);             // umbral de "papel claro"
  const colC = new Int32Array(w), rowC = new Int32Array(h);
  let total = 0;
  for(let y=0;y<h;y++) for(let x=0;x<w;x++){ if(gray[y*w+x] > thr){ colC[x]++; rowC[y]++; total++; } }
  if(total < w*h*0.015) return null;                // casi nada claro: no hay papel

  // Caja que contiene el grueso de los píxeles claros (percentiles), sin depender
  // de la forma: se recorta un 1,5% de masa por lado para ignorar ruido disperso.
  const cut = total * 0.015;
  let acc, x0=0, x1=w-1, y0=0, y1=h-1;
  acc=0; for(let x=0;x<w;x++){ acc+=colC[x]; if(acc>=cut){ x0=x; break; } }
  acc=0; for(let x=w-1;x>=0;x--){ acc+=colC[x]; if(acc>=cut){ x1=x; break; } }
  acc=0; for(let y=0;y<h;y++){ acc+=rowC[y]; if(acc>=cut){ y0=y; break; } }
  acc=0; for(let y=h-1;y>=0;y--){ acc+=rowC[y]; if(acc>=cut){ y1=y; break; } }
  if(x1-x0 < w*0.06 || y1-y0 < h*0.06) return null; // caja degenerada

  const fx = canvas.width/w, fy = canvas.height/h, pad = 2;
  const L = Math.max(0,(x0-pad)*fx), R = Math.min(canvas.width,(x1+1+pad)*fx);
  const T = Math.max(0,(y0-pad)*fy), B = Math.min(canvas.height,(y1+1+pad)*fy);
  return [ {x:L,y:T},{x:R,y:T},{x:R,y:B},{x:L,y:B} ];
}

/* Resuelve la homografía que lleva el cuadrilátero 'from' al 'to' (from -> to). */
function solveHomography(from, to){
  const M = [], b = [];
  for(let i=0;i<4;i++){
    const x=from[i].x, y=from[i].y, X=to[i].x, Y=to[i].y;
    M.push([x,y,1,0,0,0,-X*x,-X*y]); b.push(X);
    M.push([0,0,0,x,y,1,-Y*x,-Y*y]); b.push(Y);
  }
  const h = gaussSolve(M, b);        // 8 incógnitas
  return [h[0],h[1],h[2],h[3],h[4],h[5],h[6],h[7],1];
}
/* Eliminación gaussiana con pivoteo parcial (sistema n x n). */
function gaussSolve(A, b){
  const n = b.length;
  const M = A.map((r,i)=>r.concat(b[i]));
  for(let c=0;c<n;c++){
    let piv=c; for(let r=c+1;r<n;r++) if(Math.abs(M[r][c])>Math.abs(M[piv][c])) piv=r;
    [M[c],M[piv]]=[M[piv],M[c]];
    const pv = M[c][c] || 1e-12;
    for(let r=0;r<n;r++){ if(r===c) continue; const f=M[r][c]/pv;
      for(let k=c;k<=n;k++) M[r][k]-=f*M[c][k]; }
  }
  return M.map((r,i)=>r[n]/(r[i]||1e-12));
}

/* Rectifica el cuadrilátero 'corners' del canvas origen a un rectángulo recto. */
function warpQuad(srcCanvas, corners){
  const [tl,tr,br,bl] = corners;
  const wA=Math.hypot(br.x-bl.x,br.y-bl.y), wB=Math.hypot(tr.x-tl.x,tr.y-tl.y);
  const hA=Math.hypot(tr.x-br.x,tr.y-br.y), hB=Math.hypot(tl.x-bl.x,tl.y-bl.y);
  let W=Math.round(Math.max(wA,wB)), H=Math.round(Math.max(hA,hB));
  const cap = 1600, m = Math.max(W,H);
  if(m>cap){ const k=cap/m; W=Math.round(W*k); H=Math.round(H*k); }
  W=Math.max(120,W); H=Math.max(120,H);

  const sctx = srcCanvas.getContext('2d');
  const sImg = sctx.getImageData(0,0,srcCanvas.width,srcCanvas.height);
  const sd = sImg.data, sw = srcCanvas.width, sh = srcCanvas.height;
  const out = document.createElement('canvas'); out.width=W; out.height=H;
  const octx = out.getContext('2d');
  const oImg = octx.createImageData(W,H), od = oImg.data;

  // homografía destino -> origen (para muestrear cada píxel de salida)
  const dstC = [{x:0,y:0},{x:W,y:0},{x:W,y:H},{x:0,y:H}];
  const H9 = solveHomography(dstC, corners);
  const [a,b2,c,dd,e,f,g,h2,i2] = H9;
  for(let y=0;y<H;y++){
    for(let x=0;x<W;x++){
      const den = g*x + h2*y + i2;
      let sx = (a*x + b2*y + c)/den, sy = (dd*x + e*y + f)/den;
      const o = (y*W + x)*4;
      if(sx<0||sy<0||sx>=sw-1||sy>=sh-1){ od[o]=od[o+1]=od[o+2]=255; od[o+3]=255; continue; }
      const x0=sx|0, y0=sy|0, fx=sx-x0, fy=sy-y0;
      const p00=(y0*sw+x0)*4, p10=p00+4, p01=p00+sw*4, p11=p01+4;
      for(let ch=0;ch<3;ch++){
        const top = sd[p00+ch]*(1-fx)+sd[p10+ch]*fx;
        const bot = sd[p01+ch]*(1-fx)+sd[p11+ch]*fx;
        od[o+ch] = top*(1-fy)+bot*fy;
      }
      od[o+3]=255;
    }
  }
  octx.putImageData(oImg,0,0);
  return out;
}

/* Mejora tipo "escáner": gris + normalización de contraste. Rápido y fiable. */
function enhanceScan(canvas){
  const ctx = canvas.getContext('2d');
  const {width:w, height:h} = canvas;
  const img = ctx.getImageData(0,0,w,h);
  const d = img.data;
  // 1) a gris y buscar min/max para estirar contraste
  let min=255, max=0;
  const gray = new Uint8ClampedArray(w*h);
  for(let i=0,p=0;i<d.length;i+=4,p++){
    const g = (d[i]*0.299 + d[i+1]*0.587 + d[i+2]*0.114)|0;
    gray[p]=g; if(g<min)min=g; if(g>max)max=g;
  }
  const range = Math.max(1, max-min);
  // 2) estirar + subir un poco el gamma para blanquear el papel
  for(let i=0,p=0;i<d.length;i+=4,p++){
    let v = (gray[p]-min)*255/range;
    v = 255 * Math.pow(v/255, 0.72);
    v = Math.max(0, Math.min(255, v));
    d[i]=d[i+1]=d[i+2]=v; d[i+3]=255;
  }
  ctx.putImageData(img,0,0);
  return canvas;
}

/* Redimensiona un canvas manteniendo proporción a un ancho máximo. */
function resizeCanvas(canvas, maxW){
  if(canvas.width <= maxW) return canvas;
  const s = maxW / canvas.width;
  const c = document.createElement('canvas');
  c.width = maxW; c.height = Math.round(canvas.height*s);
  c.getContext('2d').drawImage(canvas, 0, 0, c.width, c.height);
  return c;
}
function canvasToBlob(canvas, type='image/jpeg', q=0.9){
  return new Promise(res=>canvas.toBlob(res, type, q));
}
function canvasToDataURL(canvas, q=0.7){ return canvas.toDataURL('image/jpeg', q); }

/* ============================================================================
   Pantalla de RECORTE (ajuste de esquinas)
   ========================================================================== */
const cropState = { canvas:null, ctx:null, img:null, corners:null, drag:-1, scale:1, ox:0, oy:0 };

function openCropWith(sourceCanvas){
  state.captureBitmap = sourceCanvas;
  const cvCanvas = document.getElementById('cropCanvas');
  cropState.canvas = cvCanvas;
  cropState.ctx = cvCanvas.getContext('2d');
  cropState.img = sourceCanvas;

  // detectar bordes del papel; si no se ven, usar un margen interior por defecto
  const w = sourceCanvas.width, h = sourceCanvas.height;
  const found = autoDetectCorners(sourceCanvas);
  if(found){
    cropState.corners = found;
    document.getElementById('cropMsg').textContent = 'Ajusta las esquinas si hace falta';
  } else {
    cropState.corners = [
      {x:w*0.06,y:h*0.06},{x:w*0.94,y:h*0.06},{x:w*0.94,y:h*0.94},{x:w*0.06,y:h*0.94}
    ];
    document.getElementById('cropMsg').textContent = 'Arrastra las esquinas para encuadrar el ticket';
  }
  fitCropCanvas();
  drawCrop();
  nav.go('crop');
}

function fitCropCanvas(){
  const stage = document.querySelector('.crop-stage');
  const maxW = stage.clientWidth - 24, maxH = stage.clientHeight - 24;
  const img = cropState.img;
  const s = Math.min(maxW/img.width, maxH/img.height);
  cropState.scale = s;
  const cw = Math.round(img.width*s), ch = Math.round(img.height*s);
  cropState.canvas.width = cw; cropState.canvas.height = ch;
}

function drawCrop(){
  const {ctx, canvas, img, corners, scale} = cropState;
  ctx.clearRect(0,0,canvas.width,canvas.height);
  ctx.drawImage(img, 0,0, canvas.width, canvas.height);
  // polígono
  ctx.beginPath();
  corners.forEach((c,i)=>{ const x=c.x*scale, y=c.y*scale; i?ctx.lineTo(x,y):ctx.moveTo(x,y); });
  ctx.closePath();
  ctx.fillStyle='rgba(31,122,224,.18)'; ctx.fill();
  ctx.lineWidth=2.5; ctx.strokeStyle='#2b8bf2'; ctx.stroke();
  // asas
  corners.forEach(c=>{
    const x=c.x*scale, y=c.y*scale;
    ctx.beginPath(); ctx.arc(x,y,11,0,7); ctx.fillStyle='#fff'; ctx.fill();
    ctx.lineWidth=3; ctx.strokeStyle='#2b8bf2'; ctx.stroke();
  });
}

function cropPointerPos(e){
  const r = cropState.canvas.getBoundingClientRect();
  const t = e.touches ? e.touches[0] : e;
  return { x:(t.clientX-r.left)/cropState.scale, y:(t.clientY-r.top)/cropState.scale };
}
function cropDown(e){
  e.preventDefault();
  const p = cropPointerPos(e);
  let idx=-1, best=1e9;
  cropState.corners.forEach((c,i)=>{ const d=Math.hypot(c.x-p.x,c.y-p.y); if(d<best){best=d; idx=i;} });
  if(best < 60/cropState.scale) cropState.drag = idx;
}
function cropMove(e){
  if(cropState.drag<0) return;
  e.preventDefault();
  const p = cropPointerPos(e);
  const img = cropState.img;
  cropState.corners[cropState.drag] = {
    x: Math.max(0, Math.min(img.width, p.x)),
    y: Math.max(0, Math.min(img.height, p.y))
  };
  drawCrop();
}
function cropUp(){ cropState.drag = -1; }

async function confirmCrop(){
  overlay(true, 'Procesando escaneo…', 'Enderezando y mejorando');
  await new Promise(r=>setTimeout(r,30));
  const corners = orderCorners(cropState.corners.slice());
  let out = warpQuad(cropState.img, corners);   // endereza (corrige perspectiva)
  enhanceScan(out);                              // mejora: gris + contraste
  state.scanBlob = await canvasToBlob(out, 'image/jpeg', 0.9);
  if(state.scanURL) URL.revokeObjectURL(state.scanURL);
  state.scanURL = URL.createObjectURL(state.scanBlob);
  // miniatura para las listas
  const thumb = resizeCanvas(out, 240);
  state.draftThumb = canvasToDataURL(thumb, 0.6);
  overlay(false);
  startReview(out);
}

/* ============================================================================
   OCR (Tesseract) + interpretación de datos del ticket
   ========================================================================== */
/* Normaliza el ancho a ~1200px para que la letra tenga un tamaño que Tesseract
   lee bien: amplía tickets estrechos (tiras de restaurante) y reduce los anchos. */
function scaleForOCR(canvas){
  const target = 1200;
  let scale = target / canvas.width;
  scale = Math.min(scale, 3);        // no ampliar más de 3x (evita emborronar)
  if(Math.abs(scale - 1) < 0.03) return canvas;
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(canvas.width*scale));
  c.height = Math.max(1, Math.round(canvas.height*scale));
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(canvas, 0, 0, c.width, c.height);
  return c;
}
async function runOCR(canvas){
  if(!window.Tesseract) return '';
  try{
    const work = scaleForOCR(canvas);
    const { data } = await Tesseract.recognize(work, 'spa', {
      // sin logger para no ralentizar
    });
    return data && data.text ? data.text : '';
  }catch(e){ console.warn('OCR error', e); return ''; }
}

/* Interpreta el texto OCR y devuelve campos best-effort. */
function parseReceipt(text){
  const res = { merchant:'', taxId:'', date:'', total:null, base:null, ivaRate:null, ivaAmount:null };
  if(!text) return res;
  const rawLines = text.split('\n').map(l=>l.trim());
  const lines = rawLines.filter(Boolean);
  const upper = text.toUpperCase();

  // ---- Comercio: primera línea "con nombre" en la parte superior
  for(const l of lines.slice(0,6)){
    const letters = (l.match(/[A-Za-zÁÉÍÓÚÑáéíóúñ]/g)||[]).length;
    if(letters>=3 && letters/l.length>0.4 &&
       !/^\s*(factura|ticket|recibo|c\.?i\.?f|n\.?i\.?f|tel|fecha|hora|nº|num)/i.test(l)){
      res.merchant = l.replace(/\s{2,}/g,' ').slice(0,60); break;
    }
  }

  // ---- CIF / NIF (9 caracteres exactos: letra+8díg, 8díg+letra, o letra+7díg+control)
  // Se busca dentro de la MISMA línea del rótulo para no colarse a la línea siguiente.
  const idPat = /([A-Z]\d{7}[0-9A-Z]|\d{8}[A-Z]|[A-Z]\d{8})/;
  const kw = /C\.?\s?I\.?\s?F|N\.?\s?I\.?\s?F/;
  for(const line of rawLines){
    const u = line.toUpperCase();
    if(kw.test(u)){
      // se quita primero el rótulo (CIF/NIF) para que su letra no forme un token falso
      const cleaned = u.replace(new RegExp(kw.source,'g'),' ').replace(/[\s.\-]/g,'');
      const mm = cleaned.match(idPat);
      if(mm){ res.taxId = mm[1]; break; }
    }
  }
  if(!res.taxId){
    const mm = upper.match(new RegExp('\\b' + idPat.source + '\\b'));
    if(mm) res.taxId = mm[1];
  }

  // ---- Fecha (dd/mm/aaaa, dd-mm-aa, etc.)
  const dm = text.match(/\b(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})\b/);
  if(dm){
    let d=+dm[1], mo=+dm[2], y=+dm[3];
    if(y<100) y += 2000;
    if(d>31 && dm[3].length>=4){ /* formato aaaa-mm-dd */ y=+dm[1]; mo=+dm[2]; d=+dm[3]; }
    if(mo>=1&&mo<=12&&d>=1&&d<=31&&y>=2000&&y<2100){
      res.date = `${y}-${String(mo).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    }
  }

  // ---- Todos los importes del texto
  const moneyRe = /(\d{1,3}(?:[.\s]\d{3})*|\d+)[.,]\d{2}\b/g;
  const amounts = [];
  let mm; while((mm = moneyRe.exec(text))){ const v = parseMoney(mm[0]); if(v!==null) amounts.push(v); }

  // ---- Total: línea con TOTAL; si no, el importe mayor
  const totalLine = lines.find(l=>/\btotal\b/i.test(l) && !/base|iva|subtotal|s\/total/i.test(l))
                 || lines.find(l=>/\btotal\b/i.test(l));
  if(totalLine){
    const t = [...totalLine.matchAll(moneyRe)].map(x=>parseMoney(x[0])).filter(v=>v!==null);
    if(t.length) res.total = t[t.length-1];
  }
  if(res.total===null && amounts.length) res.total = Math.max(...amounts);

  // ---- Tipo de IVA
  const rm = upper.match(/I\.?V\.?A\.?[^\d%]{0,8}(\d{1,2})\s*%/) || upper.match(/\b(21|10|4)\s*%/);
  if(rm) res.ivaRate = parseInt(rm[1],10);

  // ---- Cuota de IVA e base imponible si aparecen explícitas
  const ivaLine = lines.find(l=>/\biva\b/i.test(l) && /\d[.,]\d{2}/.test(l));
  if(ivaLine){
    const t = [...ivaLine.matchAll(moneyRe)].map(x=>parseMoney(x[0])).filter(v=>v!==null);
    if(t.length) res.ivaAmount = t[t.length-1];
  }
  const baseLine = lines.find(l=>/\bbase\b|\bb\.?\s?i\.?\b/i.test(l) && /\d[.,]\d{2}/.test(l));
  if(baseLine){
    const t = [...baseLine.matchAll(moneyRe)].map(x=>parseMoney(x[0])).filter(v=>v!==null);
    if(t.length) res.base = t[t.length-1];
  }
  return res;
}

/* ============================================================================
   Pantalla de REVISIÓN / ficha editable
   ========================================================================== */
function buildCatChips(){
  const wrap = document.getElementById('cats'); wrap.innerHTML='';
  CATEGORIAS.forEach(c=>{
    const b=document.createElement('button'); b.className='cat'; b.dataset.id=c.id;
    b.innerHTML = `${c.emoji} ${c.label}`;
    b.onclick=()=>{ state.draft.category=c.id; markCats(); };
    wrap.appendChild(b);
  });
}
function markCats(){
  document.querySelectorAll('#cats .cat').forEach(b=>b.classList.toggle('on', b.dataset.id===state.draft.category));
}
function buildRateChips(){
  const wrap = document.getElementById('rates'); wrap.innerHTML='';
  RATES.forEach(r=>{
    const b=document.createElement('button'); b.className='rate'; b.dataset.r=r; b.textContent = r+'%';
    b.onclick=()=>{ state.draft.ivaRate=r; recalcFromTotal(); markRates(); };
    wrap.appendChild(b);
  });
}
function markRates(){
  document.querySelectorAll('#rates .rate').forEach(b=>b.classList.toggle('on', +b.dataset.r===state.draft.ivaRate));
}

/* Recalcula base y cuota a partir de total y tipo. */
function recalcFromTotal(){
  const d = state.draft;
  const total = parseMoney(document.getElementById('fTotal').value);
  d.total = total;
  if(total!==null && d.ivaRate!==null){
    d.base = round2(total / (1 + d.ivaRate/100));
    d.ivaAmount = round2(total - d.base);
    document.getElementById('fBase').value = num2(d.base);
    document.getElementById('fIva').value = num2(d.ivaAmount);
  }
  updateCalcNote();
}
function updateCalcNote(){
  const d = state.draft;
  const el = document.getElementById('calcNote');
  const base = parseMoney(document.getElementById('fBase').value);
  const iva  = parseMoney(document.getElementById('fIva').value);
  const total= parseMoney(document.getElementById('fTotal').value);
  if(base!==null && iva!==null && total!==null){
    const sum = round2(base+iva);
    const ok = Math.abs(sum-total) <= 0.02;
    el.innerHTML = ok
      ? `✅ Base <b>${num2(base)}</b> + IVA <b>${num2(iva)}</b> = <b>${num2(total)} €</b>`
      : `⚠️ Base + IVA = <b>${num2(sum)} €</b>, pero el total es <b>${num2(total)} €</b>. Revísalo.`;
  } else {
    el.textContent = 'Introduce el total y elige el tipo de IVA; la base y la cuota se calculan solas.';
  }
}

async function startReview(finalCanvas){
  state.editingId = null;
  state.draft = { category:'comidas', ivaRate:null, total:null, base:null, ivaAmount:null };
  document.getElementById('reviewImg').src = state.scanURL;
  document.getElementById('fMerchant').value='';
  document.getElementById('fTaxId').value='';
  document.getElementById('fDate').value = new Date().toISOString().slice(0,10);
  document.getElementById('fTotal').value='';
  document.getElementById('fBase').value='';
  document.getElementById('fIva').value='';
  markCats(); markRates(); updateCalcNote();
  document.getElementById('ocrStatus').classList.remove('hidden');
  document.getElementById('ocrStatus').innerHTML = '<span class="spin"></span> Leyendo el ticket…';
  nav.go('review');

  // OCR en segundo plano
  const text = await runOCR(finalCanvas);
  const p = parseReceipt(text);
  // rellenar solo lo vacío (por si la usuaria ya escribió algo)
  if(p.merchant && !document.getElementById('fMerchant').value) document.getElementById('fMerchant').value = p.merchant;
  if(p.taxId && !document.getElementById('fTaxId').value) document.getElementById('fTaxId').value = p.taxId;
  if(p.date) document.getElementById('fDate').value = p.date;
  if(p.ivaRate!==null){ state.draft.ivaRate = p.ivaRate; markRates(); }
  if(p.total!==null) document.getElementById('fTotal').value = num2(p.total);
  if(p.total!==null && state.draft.ivaRate!==null) recalcFromTotal();
  if(p.base!==null) document.getElementById('fBase').value = num2(p.base);
  if(p.ivaAmount!==null) document.getElementById('fIva').value = num2(p.ivaAmount);
  updateCalcNote();

  const got = [p.merchant&&'comercio', p.date&&'fecha', p.total!==null&&'total'].filter(Boolean);
  const st = document.getElementById('ocrStatus');
  if(got.length) st.innerHTML = `✨ Detecté: ${got.join(', ')}. Revisa y corrige si hace falta.`;
  else st.innerHTML = '⚠️ No pude leer los datos con seguridad. Rellénalos a mano (2 toques).';
}

async function saveTicket(){
  const merchant = document.getElementById('fMerchant').value.trim();
  const total = parseMoney(document.getElementById('fTotal').value);
  const date = document.getElementById('fDate').value;
  if(!merchant){ toast('Falta el nombre del comercio'); document.getElementById('fMerchant').focus(); return; }
  if(total===null){ toast('Falta el total'); document.getElementById('fTotal').focus(); return; }
  if(!date){ toast('Falta la fecha'); return; }

  overlay(true, 'Guardando…', 'Generando el PDF justificante');
  await new Promise(r=>setTimeout(r,20));

  const d = state.draft;
  const ticket = {
    id: state.editingId || uid(),
    createdAt: new Date().toISOString(),
    merchant,
    taxId: document.getElementById('fTaxId').value.trim().toUpperCase(),
    date,
    monthKey: monthKeyFromDate(date),
    category: d.category || 'otros',
    total: round2(total),
    ivaRate: d.ivaRate,
    base: parseMoney(document.getElementById('fBase').value),
    ivaAmount: parseMoney(document.getElementById('fIva').value),
    thumbnail: state.draftThumb || null,
    imageId: null, pdfId: null,
  };

  try{
    if(state.editingId){
      // edición: conservar imagen/pdf previos salvo que haya nuevo escaneo
      const prev = await DB.getTicket(state.editingId);
      ticket.imageId = prev.imageId; ticket.pdfId = prev.pdfId;
      ticket.thumbnail = state.draftThumb || prev.thumbnail;
      if(state.scanBlob){
        ticket.imageId = ticket.imageId || uid();
        await DB.putBlob(ticket.imageId, state.scanBlob, 'image/jpeg');
      }
    } else {
      ticket.imageId = uid();
      await DB.putBlob(ticket.imageId, state.scanBlob, 'image/jpeg');
    }
    // PDF justificante (siempre se regenera con los datos confirmados)
    const pdfBlob = await buildTicketPDF(ticket);
    ticket.pdfId = ticket.pdfId || uid();
    await DB.putBlob(ticket.pdfId, pdfBlob, 'application/pdf');

    await DB.putTicket(ticket);
    overlay(false);
    toast(`Guardado en ${monthShort(ticket.monthKey)} ✓`);
    // limpiar escaneo temporal
    state.scanBlob = null; if(state.scanURL){ URL.revokeObjectURL(state.scanURL); state.scanURL=null; }
    state.currentMonth = ticket.monthKey;
    nav.stack = ['home'];
    openMonth(ticket.monthKey);
  }catch(e){
    console.error(e); overlay(false); toast('Error al guardar: '+e.message);
  }
}

/* ============================================================================
   PDF justificante (jsPDF) con la imagen del escaneo incrustada
   ========================================================================== */
function blobToDataURL(blob){
  return new Promise((res,rej)=>{ const r=new FileReader(); r.onload=()=>res(r.result); r.onerror=rej; r.readAsDataURL(blob); });
}
async function buildTicketPDF(ticket){
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({unit:'mm', format:'a4'});
  const W = 210, M = 16;
  let y = 20;

  doc.setFont('helvetica','bold'); doc.setFontSize(17); doc.setTextColor(13,27,42);
  doc.text('JUSTIFICANTE DE GASTO', M, y);
  doc.setFont('helvetica','normal'); doc.setFontSize(9); doc.setTextColor(120,130,145);
  doc.text('Gasto deducible · generado con Tickets', M, y+6);
  doc.setDrawColor(228,233,239); doc.line(M, y+10, W-M, y+10);
  y += 20;

  const rows = [
    ['Comercio', ticket.merchant || '—'],
    ['CIF / NIF', ticket.taxId || '—'],
    ['Fecha', fmtDate(ticket.date)],
    ['Categoría', CAT_LABEL[ticket.category] || ticket.category || '—'],
    ['Base imponible', ticket.base!=null ? num2(ticket.base)+' €' : '—'],
    ['IVA', (ticket.ivaRate!=null?ticket.ivaRate+'% · ':'') + (ticket.ivaAmount!=null?num2(ticket.ivaAmount)+' €':'—')],
    ['TOTAL', num2(ticket.total)+' €'],
  ];
  doc.setFontSize(11);
  rows.forEach(([k,v],i)=>{
    const bold = k==='TOTAL';
    doc.setDrawColor(235,239,244); doc.line(M, y+2, W-M, y+2);
    doc.setTextColor(120,130,145); doc.setFont('helvetica','normal');
    doc.text(k, M, y);
    doc.setTextColor(13,27,42); doc.setFont('helvetica', bold?'bold':'normal');
    if(bold) doc.setFontSize(13);
    doc.text(String(v), W-M, y, {align:'right'});
    if(bold) doc.setFontSize(11);
    y += 9;
  });
  y += 6;

  // Imagen del escaneo original
  try{
    const blob = state.scanBlob || (ticket.imageId ? await DB.getBlob(ticket.imageId) : null);
    if(blob){
      const dataURL = await blobToDataURL(blob);
      const dim = await imageSize(dataURL);
      const maxW = W - 2*M, maxH = 297 - y - 16;
      let iw = maxW, ih = iw * dim.h/dim.w;
      if(ih > maxH){ ih = maxH; iw = ih * dim.w/dim.h; }
      const x = M + (maxW - iw)/2;
      doc.setFont('helvetica','bold'); doc.setFontSize(9); doc.setTextColor(120,130,145);
      doc.text('ESCANEO ORIGINAL', M, y);
      y += 4;
      doc.addImage(dataURL, 'JPEG', x, y, iw, ih);
      doc.setDrawColor(228,233,239); doc.rect(x, y, iw, ih);
    }
  }catch(e){ console.warn('PDF img', e); }

  return doc.output('blob');
}
function imageSize(dataURL){
  return new Promise((res)=>{ const i=new Image(); i.onload=()=>res({w:i.width,h:i.height}); i.onerror=()=>res({w:1,h:1}); i.src=dataURL; });
}

/* ============================================================================
   HOME stats
   ========================================================================== */
async function refreshHomeStats(){
  const all = await DB.allTickets();
  const el = document.getElementById('homeStats');
  if(!all.length){ el.textContent = 'Aún no hay tickets. Escanea el primero 👆'; return; }
  const months = new Set(all.map(t=>t.monthKey));
  const sum = all.reduce((a,t)=>a+(t.total||0),0);
  el.textContent = `${all.length} tickets · ${months.size} meses · ${eur(sum)}`;
}

/* ============================================================================
   ARCHIVO — lista de meses
   ========================================================================== */
async function renderMonths(){
  const all = await DB.allTickets();
  const cont = document.getElementById('monthsList');
  if(!all.length){
    cont.innerHTML = `<div class="empty"><div class="big">🗂️</div>Todavía no has archivado ningún ticket.<br>Escanea uno y aparecerá aquí, ordenado por mes.</div>`;
    return;
  }
  const byMonth = {};
  all.forEach(t=>{ (byMonth[t.monthKey] ||= []).push(t); });
  const keys = Object.keys(byMonth).sort().reverse();
  cont.innerHTML = '';
  keys.forEach(k=>{
    const list = byMonth[k];
    const total = list.reduce((a,t)=>a+(t.total||0),0);
    const [y,m]=k.split('-');
    const card = document.createElement('div'); card.className='month-card';
    card.innerHTML = `
      <div class="month-ic">📅</div>
      <div class="month-info">
        <div class="month-name">${k} · ${MESES[parseInt(m,10)-1]||''}</div>
        <div class="month-sub">${list.length} ticket${list.length!==1?'s':''} · ${y}</div>
      </div>
      <div class="month-total">${eur(total)}</div>
      <div class="chev">›</div>`;
    card.onclick = ()=>openMonth(k);
    cont.appendChild(card);
  });
}

/* ============================================================================
   DETALLE DE MES + selección
   ========================================================================== */
async function openMonth(key, keepSelection){
  state.currentMonth = key;
  if(!keepSelection) state.selected = new Set();
  const all = await DB.allTickets();
  const list = all.filter(t=>t.monthKey===key).sort((a,b)=> (a.date<b.date?1:-1));
  const [y,m]=key.split('-');
  document.getElementById('monthTitle').textContent = `${MESES[parseInt(m,10)-1]||''} ${y}`;
  const total = list.reduce((a,t)=>a+(t.total||0),0);
  document.getElementById('monthTotal').textContent = eur(total);
  document.getElementById('monthCount').textContent = `${list.length} ticket${list.length!==1?'s':''}`;

  const cont = document.getElementById('ticketsList');
  cont.innerHTML='';
  if(!list.length){
    cont.innerHTML = `<div class="empty">Este mes no tiene tickets.</div>`;
  }
  list.forEach(t=>{
    const el = document.createElement('div'); el.className='tk'+(state.selected.has(t.id)?' sel':'');
    el.innerHTML = `
      <div class="chk">✓</div>
      <img class="thumb" src="${t.thumbnail||''}" alt="">
      <div class="ti">
        <div class="tm">${escapeHTML(t.merchant||'—')}</div>
        <div class="td">${fmtDate(t.date)}</div>
        <span class="cat-tag">${CAT_LABEL[t.category]||t.category||''}</span>
      </div>
      <div class="ta">${eur(t.total)}</div>`;
    // tocar la fila (excepto la casilla) abre el detalle; la casilla selecciona
    el.querySelector('.chk').onclick = (e)=>{ e.stopPropagation(); toggleSelect(t.id, el); };
    el.onclick = ()=>openTicket(t.id);
    cont.appendChild(el);
  });
  state.monthTickets = list;
  nav.go('month');
}
function toggleSelect(id, el){
  if(state.selected.has(id)) state.selected.delete(id); else state.selected.add(id);
  el.classList.toggle('sel', state.selected.has(id));
}
function escapeHTML(s){ return (s||'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

function selectedTickets(){
  const sel = state.monthTickets.filter(t=>state.selected.has(t.id));
  return sel.length ? sel : state.monthTickets; // si no hay selección => todo el mes
}

/* ============================================================================
   DETALLE DE TICKET
   ========================================================================== */
async function openTicket(id){
  const t = await DB.getTicket(id);
  if(!t) return;
  state.viewingTicket = t;
  const blob = t.imageId ? await DB.getBlob(t.imageId) : null;
  const url = blob ? URL.createObjectURL(blob) : (t.thumbnail||'');
  const cont = document.getElementById('ticketDetail');
  cont.innerHTML = `
    <img class="pic" src="${url}" alt="Escaneo">
    <div class="kv">
      <div class="r"><span class="k">Comercio</span><span class="v">${escapeHTML(t.merchant||'—')}</span></div>
      <div class="r"><span class="k">CIF / NIF</span><span class="v">${escapeHTML(t.taxId||'—')}</span></div>
      <div class="r"><span class="k">Fecha</span><span class="v">${fmtDate(t.date)}</span></div>
      <div class="r"><span class="k">Categoría</span><span class="v">${CAT_LABEL[t.category]||t.category||'—'}</span></div>
      <div class="r"><span class="k">Base imponible</span><span class="v">${t.base!=null?eur(t.base):'—'}</span></div>
      <div class="r"><span class="k">IVA ${t.ivaRate!=null?'('+t.ivaRate+'%)':''}</span><span class="v">${t.ivaAmount!=null?eur(t.ivaAmount):'—'}</span></div>
      <div class="r"><span class="k"><b>Total</b></span><span class="v"><b>${eur(t.total)}</b></span></div>
    </div>
    <div class="detail-actions">
      <button class="btn btn-outline" id="dEdit">✏️ Editar</button>
      <button class="btn btn-del" id="dDel">🗑️ Borrar</button>
    </div>`;
  cont.querySelector('#dEdit').onclick = ()=>editTicket(t);
  cont.querySelector('#dDel').onclick = ()=>deleteTicketFlow(t);
  nav.go('ticket');
}

async function downloadTicketPDF(){
  const t = state.viewingTicket; if(!t) return;
  const blob = t.pdfId ? await DB.getBlob(t.pdfId) : null;
  if(!blob){ toast('No hay PDF'); return; }
  downloadBlob(blob, `justificante_${slug(t.merchant)}_${t.date}.pdf`);
}

async function editTicket(t){
  state.editingId = t.id;
  state.draft = { category:t.category||'otros', ivaRate:t.ivaRate, total:t.total, base:t.base, ivaAmount:t.ivaAmount };
  state.scanBlob = null;
  const blob = t.imageId ? await DB.getBlob(t.imageId) : null;
  if(state.scanURL){ URL.revokeObjectURL(state.scanURL); }
  state.scanURL = blob ? URL.createObjectURL(blob) : (t.thumbnail||'');
  state.draftThumb = t.thumbnail;
  document.getElementById('reviewImg').src = state.scanURL;
  document.getElementById('fMerchant').value = t.merchant||'';
  document.getElementById('fTaxId').value = t.taxId||'';
  document.getElementById('fDate').value = t.date||'';
  document.getElementById('fTotal').value = t.total!=null?num2(t.total):'';
  document.getElementById('fBase').value = t.base!=null?num2(t.base):'';
  document.getElementById('fIva').value = t.ivaAmount!=null?num2(t.ivaAmount):'';
  markCats(); markRates(); updateCalcNote();
  document.getElementById('ocrStatus').innerHTML = '✏️ Editando ticket guardado';
  nav.go('review');
}

async function deleteTicketFlow(t){
  if(!confirm(`¿Borrar el ticket de "${t.merchant}" (${eur(t.total)})?`)) return;
  if(t.imageId) await DB.deleteBlob(t.imageId);
  if(t.pdfId) await DB.deleteBlob(t.pdfId);
  await DB.deleteTicket(t.id);
  toast('Ticket borrado');
  state.selected.delete(t.id);
  openMonth(state.currentMonth);
}

/* ============================================================================
   EXCEL (SheetJS) — una fila por ticket + fila de totales
   ========================================================================== */
function buildExcel(tickets, monthKey){
  const XLSX = window.XLSX;
  const header = ['Fecha','Comercio','CIF/NIF','Categoría','Base (€)','IVA %','Cuota IVA (€)','Total (€)'];
  const rows = tickets
    .slice().sort((a,b)=>(a.date<b.date?-1:1))
    .map(t=>[ fmtDate(t.date), t.merchant||'', t.taxId||'', CAT_LABEL[t.category]||t.category||'',
              t.base!=null?round2(t.base):'', t.ivaRate!=null?t.ivaRate:'',
              t.ivaAmount!=null?round2(t.ivaAmount):'', round2(t.total||0) ]);
  const sumBase = round2(tickets.reduce((a,t)=>a+(t.base||0),0));
  const sumIva  = round2(tickets.reduce((a,t)=>a+(t.ivaAmount||0),0));
  const sumTot  = round2(tickets.reduce((a,t)=>a+(t.total||0),0));
  rows.push([]);
  rows.push(['TOTALES','','','', sumBase, '', sumIva, sumTot]);

  const aoa = [header, ...rows];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = [{wch:12},{wch:26},{wch:12},{wch:13},{wch:11},{wch:7},{wch:12},{wch:11}];
  // formato numérico de 2 decimales en columnas E,G,H
  const range = XLSX.utils.decode_range(ws['!ref']);
  for(let r=1;r<=range.e.r;r++){
    ['E','G','H'].forEach(col=>{
      const cell = ws[col+(r+1)];
      if(cell && typeof cell.v === 'number') cell.z = '#,##0.00';
    });
  }
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, monthShort(monthKey).slice(0,31));
  return XLSX.write(wb, {bookType:'xlsx', type:'array'});
}

async function exportExcel(){
  const tickets = selectedTickets();
  if(!tickets.length){ toast('No hay tickets'); return; }
  const arr = buildExcel(tickets, state.currentMonth);
  const blob = new Blob([arr], {type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
  downloadBlob(blob, `gastos_${state.currentMonth}.xlsx`);
  toast(`Excel con ${tickets.length} tickets ✓`);
}

/* ============================================================================
   PAQUETE ZIP (JSZip) — escaneos + PDFs + Excel
   ========================================================================== */
async function buildZip(tickets, monthKey){
  const zip = new JSZip();
  const root = zip.folder(`${monthKey}_gastos`);
  const escFolder = root.folder('escaneos');
  const pdfFolder = root.folder('justificantes_pdf');
  const sorted = tickets.slice().sort((a,b)=>(a.date<b.date?-1:1));
  let i=1;
  for(const t of sorted){
    const n = String(i).padStart(2,'0');
    const base = `${n}_${slug(t.merchant)}_${t.date}`;
    if(t.imageId){ const b = await DB.getBlob(t.imageId); if(b) escFolder.file(base+'.jpg', b); }
    if(t.pdfId){ const b = await DB.getBlob(t.pdfId); if(b) pdfFolder.file(base+'.pdf', b); }
    i++;
  }
  const xls = buildExcel(sorted, monthKey);
  root.file(`gastos_${monthKey}.xlsx`, xls);
  return zip.generateAsync({type:'blob'});
}

async function exportZip(){
  const tickets = selectedTickets();
  if(!tickets.length){ toast('No hay tickets'); return; }
  overlay(true,'Preparando paquete…', `${tickets.length} tickets (escaneos + PDF + Excel)`);
  try{
    const blob = await buildZip(tickets, state.currentMonth);
    overlay(false);
    downloadBlob(blob, `gastos_${state.currentMonth}.zip`);
    toast('Paquete ZIP descargado ✓');
  }catch(e){ console.error(e); overlay(false); toast('Error al crear el ZIP'); }
}

/* Enviar al asesor: Web Share con archivos si está disponible; si no, ZIP + email. */
async function sendToAdvisor(){
  const tickets = selectedTickets();
  if(!tickets.length){ toast('No hay tickets'); return; }
  overlay(true,'Preparando envío…', `${tickets.length} tickets`);
  let zipBlob;
  try{ zipBlob = await buildZip(tickets, state.currentMonth); }
  catch(e){ overlay(false); toast('Error al preparar los archivos'); return; }
  overlay(false);

  const fname = `gastos_${state.currentMonth}.zip`;
  const file = new File([zipBlob], fname, {type:'application/zip'});
  const subject = `Gastos ${monthShort(state.currentMonth)} — ${tickets.length} tickets`;
  const total = tickets.reduce((a,t)=>a+(t.total||0),0);
  const body = `Hola,\n\nTe adjunto los gastos de ${monthShort(state.currentMonth)}: ${tickets.length} tickets, total ${eur(total)}.\nDentro del ZIP van los escaneos, los PDF justificantes y el Excel resumen.\n\nUn saludo.`;

  if(navigator.canShare && navigator.canShare({files:[file]})){
    try{
      await navigator.share({ files:[file], title:subject, text:body });
      return;
    }catch(e){ if(e && e.name==='AbortError') return; /* si falla, seguimos al plan B */ }
  }
  // Plan B: descargar ZIP y abrir el correo para adjuntarlo a mano
  downloadBlob(zipBlob, fname);
  toast('ZIP descargado. Abriendo tu correo…');
  setTimeout(()=>{ window.location.href = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body+'\n\n(Adjunta el archivo '+fname+' que se acaba de descargar.)')}`; }, 400);
}

/* --------------------------- Descargar blob ------------------------------ */
function downloadBlob(blob, filename){
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href=url; a.download=filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(url), 4000);
}

/* ============================================================================
   Manejo de imagen subida (galería) — comparte el flujo de recorte
   ========================================================================== */
function handleFile(file){
  if(!file) return;
  const img = new Image();
  img.onload = ()=>{
    const c = document.createElement('canvas'); c.width=img.width; c.height=img.height;
    c.getContext('2d').drawImage(img,0,0);
    openCropWith(c);
  };
  img.onerror = ()=>toast('No pude leer la imagen');
  img.src = URL.createObjectURL(file);
}

/* ============================================================================
   Cableado de eventos
   ========================================================================== */
function wire(){
  // HOME
  document.getElementById('btnScan').onclick = async ()=>{ nav.go('camera'); await startCamera(); };
  document.getElementById('btnUpload').onclick = ()=>document.getElementById('fileInput').click();
  document.getElementById('btnArchive').onclick = ()=>{ renderMonths(); nav.go('archive'); };
  document.getElementById('fileInput').onchange = e=>{ if(e.target.files[0]) handleFile(e.target.files[0]); e.target.value=''; };

  // CÁMARA
  document.getElementById('camBack').onclick = ()=>nav.back();
  document.getElementById('camUpload').onclick = ()=>document.getElementById('fileInput').click();
  document.getElementById('btnShutter').onclick = ()=>{
    const c = captureFromVideo(); if(!c) return;
    stopCamera();
    openCropWith(c);
  };

  // RECORTE
  document.getElementById('cropBack').onclick = ()=>nav.back();
  document.getElementById('cropRetry').onclick = ()=>{ nav.back(); };
  document.getElementById('cropConfirm').onclick = confirmCrop;
  const cc = document.getElementById('cropCanvas');
  cc.addEventListener('mousedown', cropDown); cc.addEventListener('mousemove', cropMove);
  window.addEventListener('mouseup', cropUp);
  cc.addEventListener('touchstart', cropDown, {passive:false});
  cc.addEventListener('touchmove', cropMove, {passive:false});
  cc.addEventListener('touchend', cropUp);

  // REVISIÓN
  document.getElementById('reviewBack').onclick = ()=>nav.back();
  document.getElementById('btnSave').onclick = saveTicket;
  document.getElementById('fTotal').addEventListener('input', recalcFromTotal);
  document.getElementById('fBase').addEventListener('input', updateCalcNote);
  document.getElementById('fIva').addEventListener('input', updateCalcNote);
  buildCatChips(); buildRateChips();

  // ARCHIVO
  document.getElementById('archBack').onclick = ()=>nav.back();

  // MES
  document.getElementById('monthBack').onclick = ()=>nav.back();
  document.getElementById('selAll').onclick = ()=>{ state.monthTickets.forEach(t=>state.selected.add(t.id)); openMonth(state.currentMonth, true); };
  document.getElementById('selNone').onclick = ()=>{ state.selected.clear(); openMonth(state.currentMonth, true); };
  document.getElementById('btnExcel').onclick = exportExcel;
  document.getElementById('btnZip').onclick = exportZip;
  document.getElementById('btnSend').onclick = sendToAdvisor;

  // TICKET
  document.getElementById('ticketBack').onclick = ()=>nav.back();
  document.getElementById('ticketPdf').onclick = downloadTicketPDF;

  // botón atrás del navegador/gesto
  window.addEventListener('popstate', ()=>{ if(nav.stack.length>1) nav.back(); });
}

/* ------------------------------- Arranque -------------------------------- */
window.addEventListener('DOMContentLoaded', async ()=>{
  wire();
  try{ await DB.init(); }catch(e){ console.error('DB', e); toast('No se pudo abrir el almacenamiento'); }
  refreshHomeStats();
  // registrar service worker (para "añadir a inicio" y uso offline del cascarón)
  if('serviceWorker' in navigator){ navigator.serviceWorker.register('sw.js').catch(()=>{}); }
});

// Exponer algunas funciones para pruebas/depuración
window.__app = { DB, parseReceipt, parseMoney, buildExcel, buildZip, autoDetectCorners, state };
