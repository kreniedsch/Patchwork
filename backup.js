/* Patchwork Backup – sichert alles, was die App im Browser speichert:
   localStorage und alle IndexedDB-Datenbanken (inkl. Dateien/Blobs).
   Der Entsperr-Schlüssel (patchwork-lock-*) wird NIE gesichert.
   Dateiformat .pwbak: "PWBK1\n" + 4 Byte Header-Länge + Header-JSON + Binärdaten. */
(function () {
  'use strict';
  if (window.__pwBackup) return; window.__pwBackup = true;
  const SKIP = k => /^patchwork-lock/.test(k);
  const TS = 'patchwork-last-backup';

  /* ---------- Werte kodieren (Blobs, ArrayBuffer, Dates) ---------- */
  function encoder(parts, meta) {
    const enc = v => {
      if (v === null || typeof v !== 'object') return v;
      if (v instanceof Blob) { meta.push({ size: v.size, type: v.type || '' }); parts.push(v); return { __pwb: meta.length - 1 }; }
      if (v instanceof ArrayBuffer) { meta.push({ size: v.byteLength, ab: 1 }); parts.push(v); return { __pwb: meta.length - 1 }; }
      if (ArrayBuffer.isView(v)) { const c = v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength); meta.push({ size: c.byteLength, ab: 1, view: v.constructor.name }); parts.push(c); return { __pwb: meta.length - 1 }; }
      if (v instanceof Date) return { __pwd: v.toISOString() };
      if (Array.isArray(v)) return v.map(enc);
      const o = {}; for (const k of Object.keys(v)) o[k] = enc(v[k]); return o;
    };
    return enc;
  }
  function decoder(items) {
    const dec = v => {
      if (v === null || typeof v !== 'object') return v;
      if (Array.isArray(v)) return v.map(dec);
      if ('__pwb' in v) return items[v.__pwb];
      if ('__pwd' in v) return new Date(v.__pwd);
      const o = {}; for (const k of Object.keys(v)) o[k] = dec(v[k]); return o;
    };
    return dec;
  }
  const req2p = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

  /* ---------- Export ---------- */
  async function build() {
    const parts = [], meta = [], enc = encoder(parts, meta);
    const ls = {};
    try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (!SKIP(k) && k !== TS) ls[k] = localStorage.getItem(k); } } catch (e) {}
    const dbs = []; let idbNote = '';
    if (window.indexedDB && indexedDB.databases) {
      for (const info of await indexedDB.databases()) {
        if (!info.name) continue;
        const db = await req2p(indexedDB.open(info.name));
        const stores = [];
        for (const sn of db.objectStoreNames) {
          const tx = db.transaction(sn, 'readonly'), os = tx.objectStore(sn);
          const keys = await req2p(os.getAllKeys()), vals = await req2p(os.getAll());
          const indexes = [...os.indexNames].map(n => { const ix = os.index(n); return { name: n, keyPath: ix.keyPath, unique: ix.unique, multiEntry: ix.multiEntry }; });
          stores.push({ name: sn, keyPath: os.keyPath, autoIncrement: os.autoIncrement, indexes, records: keys.map((k, i) => ({ k: enc(k), v: enc(vals[i]) })) });
        }
        dbs.push({ name: db.name, version: db.version, stores });
        db.close();
      }
    } else idbNote = 'indexedDB.databases() nicht verfügbar';
    const header = { app: 'patchwork', format: 1, exported: new Date().toISOString(), localStorage: ls, idb: dbs, parts: meta, idbNote };
    const hb = new TextEncoder().encode(JSON.stringify(header));
    const len = new Uint8Array(4); new DataView(len.buffer).setUint32(0, hb.length);
    const blob = new Blob([new TextEncoder().encode('PWBK1\n'), len, hb, ...parts], { type: 'application/octet-stream' });
    const records = dbs.reduce((a, d) => a + d.stores.reduce((b, s) => b + s.records.length, 0), 0);
    return { blob, keys: Object.keys(ls).length, records };
  }

  async function share(blob, name) {
    try {
      const file = new File([blob], name, { type: blob.type });
      if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: name }); return true; }
    } catch (e) { if (e && e.name === 'AbortError') return false; }
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000); return true;
  }

  /* ---------- Import ---------- */
  async function read(file) {
    if (await file.slice(0, 6).text() !== 'PWBK1\n') throw new Error('Das ist keine Patchwork-Backup-Datei (.pwbak).');
    const len = new DataView(await file.slice(6, 10).arrayBuffer()).getUint32(0);
    const header = JSON.parse(await file.slice(10, 10 + len).text());
    if (header.app !== 'patchwork') throw new Error('Diese Datei stammt nicht aus Patchwork.');
    return { header, offset: 10 + len };
  }
  async function restore(file) {
    const { header, offset } = await read(file);
    let off = offset; const items = [];
    for (const m of header.parts || []) {
      const sl = file.slice(off, off + m.size); off += m.size;
      if (m.ab) { const buf = await sl.arrayBuffer(); items.push(m.view && window[m.view] ? new window[m.view](buf) : buf); }
      else items.push(new Blob([sl], { type: m.type }));
    }
    const dec = decoder(items);
    for (const [k, v] of Object.entries(header.localStorage || {})) { if (!SKIP(k)) try { localStorage.setItem(k, v); } catch (e) {} }
    for (const d of header.idb || []) {
      let db;
      try {
        db = await new Promise((res, rej) => {
          const r = indexedDB.open(d.name, d.version);
          r.onupgradeneeded = () => {
            const u = r.result, tx = r.transaction;
            for (const s of d.stores) {
              const os = u.objectStoreNames.contains(s.name) ? tx.objectStore(s.name) : u.createObjectStore(s.name, { keyPath: s.keyPath, autoIncrement: s.autoIncrement });
              for (const ix of s.indexes || []) if (!os.indexNames.contains(ix.name)) os.createIndex(ix.name, ix.keyPath, { unique: ix.unique, multiEntry: ix.multiEntry });
            }
          };
          r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
        });
      } catch (e) { db = await req2p(indexedDB.open(d.name)); }
      for (const s of d.stores) {
        if (!db.objectStoreNames.contains(s.name)) continue;
        await new Promise((res, rej) => {
          const tx = db.transaction(s.name, 'readwrite'), os = tx.objectStore(s.name);
          for (const r of s.records) { const v = dec(r.v); if (os.keyPath != null) os.put(v); else os.put(v, dec(r.k)); }
          tx.oncomplete = res; tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error);
        });
      }
      db.close();
    }
    return header;
  }

  /* ---------- Oberfläche: kleiner Knopf unten links ---------- */
  function ui() {
    const css = document.createElement('style');
    css.textContent = `
#pwbk-btn{position:fixed;left:12px;bottom:calc(12px + env(safe-area-inset-bottom,0px));z-index:2147483000;width:38px;height:38px;border-radius:50%;border:1px solid rgba(255,255,255,.18);background:rgba(10,12,16,.55);color:#cfe;display:grid;place-items:center;opacity:.55;backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);cursor:pointer;padding:0}
#pwbk-btn:hover,#pwbk-btn:focus-visible{opacity:1}
#pwbk-btn svg{width:18px;height:18px}
#pwbk-sheet{position:fixed;inset:auto 0 0 0;z-index:2147483001;background:#12151b;color:#e8eef5;border-top:1px solid rgba(255,255,255,.12);border-radius:18px 18px 0 0;padding:18px 16px calc(18px + env(safe-area-inset-bottom,0px));font:15px/1.45 system-ui,-apple-system,sans-serif;box-shadow:0 -12px 40px rgba(0,0,0,.6)}
#pwbk-sheet h3{margin:0 0 2px;font-size:17px}
#pwbk-sheet p{margin:0 0 12px;color:#9aa6b2;font-size:13px}
#pwbk-sheet .r{display:flex;flex-wrap:wrap;gap:8px}
#pwbk-sheet button{font:inherit;font-weight:600;border-radius:12px;padding:11px 14px;border:1px solid rgba(255,255,255,.16);background:rgba(255,255,255,.06);color:inherit;cursor:pointer}
#pwbk-sheet button.p{background:#3ee08f;color:#06210f;border:0}
#pwbk-msg{margin-top:10px!important;color:#cfe!important}`;
    document.head.appendChild(css);
    const btn = document.createElement('button');
    btn.id = 'pwbk-btn'; btn.setAttribute('aria-label', 'Backup');
    btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12M7 10l5 5 5-5M5 21h14"/></svg>';
    document.body.appendChild(btn);
    let sheet = null;
    const last = () => { let t = 0; try { t = +localStorage.getItem(TS) || 0; } catch (e) {} if (!t) return 'Noch nie gesichert.'; const d = Math.floor((Date.now() - t) / 864e5); return d === 0 ? 'Letztes Backup: heute.' : d === 1 ? 'Letztes Backup: gestern.' : `Letztes Backup: vor ${d} Tagen.`; };
    const close = () => { if (sheet) { sheet.remove(); sheet = null; } };
    btn.addEventListener('click', () => {
      if (sheet) return close();
      sheet = document.createElement('div'); sheet.id = 'pwbk-sheet';
      sheet.innerHTML = `<h3>Backup</h3><p>${last()} Der Entsperr-Code wird nicht gesichert.</p>
        <div class="r"><button class="p" data-a="exp">Exportieren</button><button data-a="imp">Importieren</button><button data-a="x">Schliessen</button></div>
        <p id="pwbk-msg" aria-live="polite"></p><input type="file" hidden>`;
      document.body.appendChild(sheet);
      const msg = t => { sheet && (sheet.querySelector('#pwbk-msg').textContent = t); };
      const inp = sheet.querySelector('input');
      sheet.querySelector('[data-a="x"]').onclick = close;
      sheet.querySelector('[data-a="exp"]').onclick = async () => {
        msg('Backup wird erstellt …');
        try {
          const { blob, keys, records } = await build();
          const ok = await share(blob, `patchwork-backup-${new Date().toISOString().slice(0, 10)}.pwbak`);
          if (ok) { try { localStorage.setItem(TS, String(Date.now())); } catch (e) {} msg(`Gesichert: ${keys} Einstellungen, ${records} Datensätze. Tipp: in iCloud Drive ablegen.`); }
          else msg('Export abgebrochen.');
        } catch (e) { msg('Backup fehlgeschlagen: ' + (e && e.message || e)); }
      };
      sheet.querySelector('[data-a="imp"]').onclick = () => inp.click();
      inp.onchange = async () => {
        const f = inp.files && inp.files[0]; inp.value = ''; if (!f) return;
        msg('Import läuft …');
        try { const h = await restore(f); msg(`Import vom ${new Date(h.exported).toLocaleDateString('de-CH')} erfolgreich. Die App lädt neu …`); setTimeout(() => location.reload(), 1200); }
        catch (e) { msg(e && e.message || String(e)); }
      };
    });
  }
  window.PatchworkBackup = { build, restore, read };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ui); else ui();
})();
