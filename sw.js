/* Patchwork Service Worker: offline nutzbar, Updates beim nächsten Start */
const CACHE='patchwork-v1';
const CORE=['./','index.html','backup.js','manifest.webmanifest','icon-180.png','icon-192.png','icon-512.png'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(CACHE).then(c=>c.addAll(CORE)).then(()=>self.skipWaiting()));});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k.startsWith('patchwork-')&&k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));});
function timeout(ms){return new Promise((_,rej)=>setTimeout(()=>rej(new Error('timeout')),ms));}
self.addEventListener('fetch',e=>{
 const req=e.request;if(req.method!=='GET')return;
 const url=new URL(req.url);
 // App-Seite: zuerst Netz (für Updates), sonst Cache
 if(req.mode==='navigate'||(url.origin===location.origin&&/\/(index\.html)?$/.test(url.pathname))){
  e.respondWith(Promise.race([fetch(req),timeout(4000)]).then(res=>{if(res&&res.ok){const cp=res.clone();caches.open(CACHE).then(c=>c.put('index.html',cp));}return res;}).catch(()=>caches.match('index.html').then(r=>r||caches.match('./'))));
  return;}
 // Eigene Dateien: sofort aus Cache, im Hintergrund aktualisieren
 if(url.origin===location.origin){
  e.respondWith(caches.open(CACHE).then(c=>c.match(req,{ignoreSearch:true}).then(hit=>{const net=fetch(req).then(res=>{if(res&&res.ok)c.put(req,res.clone());return res;}).catch(()=>hit);return hit||net;})));
  return;}
 // Schriften von Google: einmal laden, dann offline aus dem Cache
 if(/fonts\.(googleapis|gstatic)\.com$/.test(url.hostname)){
  e.respondWith(caches.open(CACHE).then(c=>c.match(req).then(hit=>hit||fetch(req).then(res=>{c.put(req,res.clone());return res;}).catch(()=>new Response('',{status:503})))));
 }
});
