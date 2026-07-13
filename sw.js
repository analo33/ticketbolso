/* Service worker mínimo: cachea el cascarón de la app para "añadir a inicio"
   y para que abra sin conexión. Las librerías (OCR/PDF/Excel/OpenCV) se sirven
   desde CDN y las cachea el propio navegador tras el primer uso. */
const CACHE = 'tickets-v1';
const SHELL = ['./', './index.html', './app.js', './manifest.webmanifest', './icon.svg'];

self.addEventListener('install', e=>{
  e.waitUntil(caches.open(CACHE).then(c=>c.addAll(SHELL)).then(()=>self.skipWaiting()));
});
self.addEventListener('activate', e=>{
  e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));
});
// Estrategia "network-first" para los archivos propios: siempre se intenta la
// versión más reciente (así las actualizaciones se ven al momento) y solo se
// recurre a la caché cuando no hay conexión.
self.addEventListener('fetch', e=>{
  const url = new URL(e.request.url);
  if(url.origin !== location.origin) return; // no interceptar CDNs
  e.respondWith(
    fetch(e.request).then(res=>{
      const copy = res.clone();
      caches.open(CACHE).then(c=>c.put(e.request, copy)).catch(()=>{});
      return res;
    }).catch(()=> caches.match(e.request).then(hit => hit || caches.match('./index.html')))
  );
});
