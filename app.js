/* NetguY Fuvar – útiköltség- és fuvardíj-kalkulátor */
(() => {
  'use strict';

  // ---------- Beállítások ----------
  const HOME = { lat: 46.0007, lon: 26.1374 }; // Kézdivásárhely – keresési súlypont
  const PHOTON = 'https://photon.komoot.io/api/';
  const OSRM = [
    'https://routing.openstreetmap.de/routed-car/route/v1/driving/',
    'https://router.project-osrm.org/route/v1/driving/'
  ];
  const VALHALLA = 'https://valhalla1.openstreetmap.de/route';
  const PRESETS = [5.5, 6, 7];
  const STORE_KEY = 'netguy-fuvar:v1';
  const MAX_RECENT = 5;

  const COUNTRY_HU = {
    RO: 'Románia', HU: 'Magyarország', MD: 'Moldova', UA: 'Ukrajna', RS: 'Szerbia', SK: 'Szlovákia',
    AT: 'Ausztria', DE: 'Németország', IT: 'Olaszország', FR: 'Franciaország', ES: 'Spanyolország',
    GB: 'Egyesült Királyság', IE: 'Írország', BG: 'Bulgária', HR: 'Horvátország', SI: 'Szlovénia',
    CZ: 'Csehország', PL: 'Lengyelország', GR: 'Görögország', TR: 'Törökország', NL: 'Hollandia',
    BE: 'Belgium', CH: 'Svájc', LU: 'Luxemburg', DK: 'Dánia', SE: 'Svédország', NO: 'Norvégia',
    FI: 'Finnország', PT: 'Portugália', BA: 'Bosznia-Hercegovina', ME: 'Montenegró', MK: 'Észak-Macedónia',
    US: 'Egyesült Államok', CA: 'Kanada', AL: 'Albánia', XK: 'Koszovó', LT: 'Litvánia', LV: 'Lettország', EE: 'Észtország', BY: 'Fehéroroszország'
  };

  // ---------- Segédfüggvények ----------
  const $ = (id) => document.getElementById(id);
  const norm = (s) => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/ı/g, 'i').replace(/ł/g, 'l').replace(/ß/g, 'ss').trim();
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const parseNum = (s) => {
    if (s == null) return NaN;
    const t = String(s).replace(/\s/g, '').replace(',', '.');
    if (t === '' || !/^-?\d*\.?\d*$/.test(t)) return NaN;
    return parseFloat(t);
  };
  const fmt = (n, d = 2) => Number.isFinite(n)
    ? n.toLocaleString('hu-HU', { minimumFractionDigits: d, maximumFractionDigits: d }) : '–';
  const fmtKm = (km) => Number.isFinite(km) ? `${fmt(km, km >= 100 ? 0 : 1)} km` : '–';
  const fmtLei = (v) => Number.isFinite(v) ? `${fmt(v, 2)} lej` : '–';
  const fmtInputNum = (n, d = 2) => Number.isFinite(n) ? String(+n.toFixed(d)).replace('.', ',') : '';
  const fmtDur = (min) => {
    if (!Number.isFinite(min) || min <= 0) return '–';
    let m = Math.round(min); const h = Math.floor(m / 60); m -= h * 60;
    return h ? (m ? `${h} ó ${m} p` : `${h} óra`) : `${m} perc`;
  };
  const haversine = (a, b) => {
    const R = 6371, r = Math.PI / 180;
    const dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r;
    const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(x));
  };
  const placeKey = (p) => p ? `${p.lat.toFixed(4)},${p.lon.toFixed(4)}` : '';
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

  // ---------- Tárolás (csak ezen az eszközön) ----------
  const defaults = { cons: 6, price: '', mode: 'one', fareOn: false, rate: '', fix: '', recent: [], from: null, to: null };
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(STORE_KEY) || '{}') || {}; } catch { saved = {}; }
  const settings = { ...defaults, ...saved };
  const persist = () => {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(settings)); } catch { /* privát mód */ }
  };

  // ---------- Állapot ----------
  const state = {
    from: null, to: null,
    routes: [], routeIdx: 0,
    manualKm: null, manualMin: null,
    check: null, // Valhalla ellenőrző távolság
    routeSeq: 0
  };

  // ---------- Helyi (romániai, magyar névvel) helynév-index ----------
  let LOCAL = [];
  let COUNTY_RO2HU = {};
  const localReady = fetch('places-ro.json').then((r) => r.json()).then((data) => {
    data.counties.forEach(([ro, hu]) => { COUNTY_RO2HU[norm(ro)] = hu; });
    LOCAL = data.places.map(([ro, hu, ci, lat, lon, t]) => ({
      ro, hu, lat, lon, t,
      county: data.counties[ci] ? data.counties[ci][1] : '',
      nRo: norm(ro), nHu: norm(hu)
    }));
  }).catch(() => { LOCAL = []; });

  const typeRank = { c: 12, t: 8, v: 0, h: -4 };
  function scoreName(n, q) {
    if (!n) return -1;
    if (n === q) return 100;
    if (n.startsWith(q)) return 80 - Math.min(10, (n.length - q.length) / 2);
    const words = n.split(/[\s\-–]+/);
    if (words.some((w) => w.startsWith(q))) return 60;
    if (q.length >= 3 && n.includes(q)) return 35;
    return -1;
  }
  function searchLocal(q) {
    const nq = norm(q);
    if (nq.length < 2) return [];
    const out = [];
    for (const p of LOCAL) {
      const sHu = scoreName(p.nHu, nq), sRo = scoreName(p.nRo, nq);
      const best = Math.max(sHu, sRo);
      if (best < 0) continue;
      const near = haversine(HOME, p) < 120 ? 6 : 0;
      out.push({ p, score: best + typeRank[p.t] + near, byHu: sHu >= sRo && p.hu });
    }
    out.sort((a, b) => b.score - a.score);
    return out.slice(0, 8).map(({ p, byHu }) => {
      const main = byHu ? p.hu : p.ro;
      const alt = p.hu ? (byHu ? p.ro : p.hu) : '';
      return {
        name: main, alt, county: p.county, country: 'Románia', cc: 'RO',
        lat: p.lat, lon: p.lon, type: p.t, src: 'local'
      };
    });
  }

  async function searchPhoton(q, signal) {
    const params = new URLSearchParams({ q, limit: '12', lat: HOME.lat, lon: HOME.lon, location_bias_scale: '0.25' });
    ['place:city', 'place:town', 'place:village', 'place:hamlet', 'place:municipality'].forEach((t) => params.append('osm_tag', t));
    const res = await fetch(`${PHOTON}?${params}`, { signal });
    if (!res.ok) throw new Error('photon');
    const data = await res.json();
    return (data.features || []).map((f) => {
      const pr = f.properties || {};
      const cc = (pr.countrycode || '').toUpperCase();
      let county = pr.county || pr.state || '';
      if (cc === 'RO' && COUNTY_RO2HU[norm(county)]) county = COUNTY_RO2HU[norm(county)];
      const t = { city: 'c', town: 't', village: 'v', hamlet: 'h', municipality: 't' }[pr.osm_value] || 'v';
      return {
        name: pr.name, alt: '', county, country: COUNTRY_HU[cc] || pr.country || '', cc,
        lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0], type: t, src: 'photon'
      };
    }).filter((p) => p.name && scoreName(norm(p.name), norm(q)) >= 0); // csak valóban egyező nevek
  }

  // ---------- Település-mező (autocomplete) ----------
  function setupPlaceField(which) {
    const input = $(`${which}Input`), list = $(`${which}List`), meta = $(`${which}Meta`), wrap = $(`${which}Wrap`);
    let items = [], active = -1, ctrl = null, lastQ = '';

    const close = () => { list.classList.remove('open'); input.setAttribute('aria-expanded', 'false'); active = -1; };
    const highlight = (text, q) => {
      const n = norm(text), nq = norm(q), i = n.indexOf(nq);
      if (!nq || i < 0 || n.length !== text.length) return esc(text);
      return esc(text.slice(0, i)) + '<mark>' + esc(text.slice(i, i + nq.length)) + '</mark>' + esc(text.slice(i + nq.length));
    };
    const render = (q, loading) => {
      if (document.activeElement !== input || state[which]) { close(); return; }
      if (!items.length) {
        list.innerHTML = `<li class="info">${loading ? 'Keresés…' : 'Nincs találat. Próbáld másképp írni.'}</li>`;
      } else {
        list.innerHTML = items.map((p, i) => {
          const lab = { c: 'Város', t: 'Város', v: 'Falu', h: 'Telep' }[p.type] || '';
          const sub = [lab, p.county, p.country].filter(Boolean).join(' · ');
          return `<li role="option" data-i="${i}" class="${i === active ? 'active' : ''}">
            <span class="s-icon ${p.type === 'c' || p.type === 't' ? 'c' : ''}">${esc((p.cc || '').slice(0, 2))}</span>
            <span><span class="s-main">${highlight(p.name, q)}</span>${p.alt ? ` <span class="s-alt">(${highlight(p.alt, q)})</span>` : ''}
            <span class="s-sub" style="display:block">${esc(sub)}</span></span></li>`;
        }).join('') + (loading ? '<li class="info">További találatok keresése…</li>' : '');
      }
      list.classList.add('open'); input.setAttribute('aria-expanded', 'true');
    };

    const remoteSearch = debounce(async (q) => {
      if (ctrl) ctrl.abort();
      ctrl = new AbortController();
      try {
        const remote = await searchPhoton(q, ctrl.signal);
        if (q !== lastQ) return;
        const locals = items.filter((p) => p.src === 'local');
        const extra = remote.filter((r) => !locals.some((l) => haversine(l, r) < 2.5) &&
          !items.some((x) => x.src === 'photon' && haversine(x, r) < 0.5));
        // romániai, magyar név nélküli találatok a helyiek után, a többi ország utánuk
        extra.sort((a, b) => (b.cc === 'RO') - (a.cc === 'RO'));
        items = [...locals, ...extra].slice(0, 12);
        render(q, false);
      } catch (e) {
        if (e.name === 'AbortError') return;
        if (q === lastQ) { render(q, false); if (!items.length) list.innerHTML = '<li class="info">A keresés nem érhető el. Ellenőrizd az internetkapcsolatot.</li>'; }
      }
    }, 280);

    const onInput = async () => {
      const q = input.value.trim();
      lastQ = q;
      if (state[which]) { state[which] = null; meta.textContent = ''; meta.className = 'place-meta'; onPlacesChanged(); }
      wrap.classList.toggle('has-value', !!input.value);
      if (q.length < 2) { items = []; close(); return; }
      await localReady;
      if (q !== lastQ) return;
      items = searchLocal(q);
      active = items.length ? 0 : -1;
      render(q, true);
      remoteSearch(q);
    };

    const choose = (i) => {
      const p = items[i]; if (!p) return;
      input.value = p.name;
      setPlace(which, p);
      close();
      input.blur();
      if (which === 'from' && !state.to) setTimeout(() => $('toInput').focus(), 50);
    };

    input.addEventListener('input', onInput);
    input.addEventListener('focus', () => { if (!state[which] && input.value.trim().length >= 2) onInput(); });
    input.addEventListener('blur', () => setTimeout(() => {
      close();
      if (!state[which] && input.value.trim()) { meta.textContent = 'Válassz a listából!'; meta.className = 'place-meta warn'; }
    }, 150));
    input.addEventListener('keydown', (e) => {
      const n = items.length;
      if (e.key === 'ArrowDown' && n) { e.preventDefault(); active = (active + 1) % n; render(lastQ, false); }
      else if (e.key === 'ArrowUp' && n) { e.preventDefault(); active = (active - 1 + n) % n; render(lastQ, false); }
      else if (e.key === 'Enter') { e.preventDefault(); if (list.classList.contains('open') && active >= 0) choose(active); }
      else if (e.key === 'Escape') close();
    });
    list.addEventListener('pointerdown', (e) => e.preventDefault()); // ne vesszen el a fókusz
    list.addEventListener('click', (e) => {
      const li = e.target.closest('li[data-i]'); if (li) choose(+li.dataset.i);
    });
    wrap.querySelector('.clear-btn').addEventListener('click', () => {
      input.value = ''; wrap.classList.remove('has-value'); items = []; close();
      if (state[which]) { state[which] = null; onPlacesChanged(); }
      meta.textContent = ''; meta.className = 'place-meta';
      input.focus();
    });
  }

  function showPlace(which) {
    const p = state[which], input = $(`${which}Input`), meta = $(`${which}Meta`);
    input.value = p ? p.name : '';
    $(`${which}Wrap`).classList.toggle('has-value', !!p);
    if (p) {
      meta.textContent = [p.alt, p.county, p.country].filter(Boolean).join(' · ');
      meta.className = 'place-meta ok';
    } else { meta.textContent = ''; meta.className = 'place-meta'; }
  }
  function setPlace(which, p) {
    state[which] = p ? { name: p.name, alt: p.alt || '', county: p.county || '', country: p.country || '', cc: p.cc || '', lat: +p.lat, lon: +p.lon } : null;
    showPlace(which);
    onPlacesChanged();
  }

  // ---------- Útvonaltervezés ----------
  function routeLabel(route) {
    const acc = new Map();
    (route.legs || []).forEach((leg) => (leg.steps || []).forEach((s) => {
      const key = (s.ref || '').split(';')[0].trim() || s.name || '';
      if (!key) return;
      acc.set(key, (acc.get(key) || 0) + s.distance);
    }));
    const top = [...acc.entries()].filter(([k]) => k).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k]) => k);
    return top.join(' · ');
  }

  async function fetchOsrm(a, b, signal) {
    const coords = `${a.lon},${a.lat};${b.lon},${b.lat}`;
    let lastErr;
    for (const base of OSRM) {
      try {
        const res = await fetch(`${base}${coords}?overview=false&alternatives=3&steps=true`, { signal });
        if (!res.ok) throw new Error('osrm ' + res.status);
        const d = await res.json();
        if (d.code !== 'Ok' || !d.routes || !d.routes.length) throw new Error('osrm ' + d.code);
        const snap = Math.max(...(d.waypoints || []).map((w) => w.distance || 0));
        return {
          snap,
          routes: d.routes.map((r) => ({ km: r.distance / 1000, min: r.duration / 60, label: routeLabel(r), src: 'OSRM' }))
        };
      } catch (e) { if (e.name === 'AbortError') throw e; lastErr = e; }
    }
    throw lastErr;
  }

  async function fetchValhalla(a, b, signal) {
    const body = {
      locations: [{ lat: a.lat, lon: a.lon }, { lat: b.lat, lon: b.lon }],
      costing: 'auto', units: 'kilometers', alternates: 2, directions_type: 'none'
    };
    const res = await fetch(`${VALHALLA}?json=${encodeURIComponent(JSON.stringify(body))}`, { signal });
    if (!res.ok) throw new Error('valhalla ' + res.status);
    const d = await res.json();
    const trips = [d.trip, ...((d.alternates || []).map((x) => x.trip))].filter(Boolean);
    if (!trips.length) throw new Error('valhalla');
    return trips.map((t) => ({ km: t.summary.length, min: t.summary.time / 60, label: '', src: 'Valhalla' }));
  }

  let routeCtrl = null;
  async function calcRoute() {
    const { from, to } = state;
    if (routeCtrl) routeCtrl.abort();
    state.routes = []; state.routeIdx = 0; state.check = null;
    renderRoutes();
    if (!from || !to) { setStatus(null); return; }
    if (placeKey(from) === placeKey(to)) { setStatus('warn', 'Az indulási és az érkezési hely ugyanaz.'); return; }

    const seq = ++state.routeSeq;
    routeCtrl = new AbortController();
    const signal = routeCtrl.signal;
    setStatus('load', 'Közúti útvonal keresése…');

    const [o, v] = await Promise.allSettled([fetchOsrm(from, to, signal), fetchValhalla(from, to, signal)]);
    if (seq !== state.routeSeq) return;

    const straight = haversine(from, to);
    let routes = [], snap = 0, checkKm = null, checkSrc = '';
    if (o.status === 'fulfilled') {
      routes = o.value.routes; snap = o.value.snap;
      if (v.status === 'fulfilled') { checkKm = v.value[0].km; checkSrc = 'Valhalla'; }
    } else if (v.status === 'fulfilled') {
      routes = v.value;
    }

    if (!routes.length) {
      const cached = settings.recent.find((r) => placeKey(r.from) === placeKey(from) && placeKey(r.to) === placeKey(to));
      if (cached && Number.isFinite(cached.km)) {
        state.routes = [{ km: cached.km, min: cached.min, label: 'legutóbb mentett érték', src: 'mentett' }];
        renderRoutes();
        setStatus('warn', 'Az útvonaltervező most nem érhető el – a legutóbb mentett értéket mutatom.');
      } else {
        setStatus('err', 'Nem sikerült útvonalat tervezni. Ellenőrizd az internetkapcsolatot, vagy írd be a kilométert kézzel.');
      }
      recompute();
      return;
    }

    // Az ellenőrző útvonaltervező alternatívái is választhatók, ha lényegesen eltérnek
    if (o.status === 'fulfilled' && v.status === 'fulfilled') {
      const r = v.value[0];
      if (!routes.some((x) => Math.abs(x.km - r.km) / Math.max(x.km, 0.1) < 0.04)) routes.push({ ...r, label: 'Valhalla útvonaltervező szerint' });
    }
    state.routes = routes.slice(0, 4);
    state.routeIdx = 0;
    state.check = checkKm;
    state.manualKm = null; state.manualMin = null;
    renderRoutes();

    // Figyelmeztetések
    const main = state.routes[0].km;
    const warns = [];
    if (checkKm != null) {
      const diff = Math.abs(main - checkKm);
      if (diff > 2 && diff / Math.min(main, checkKm) > 0.15) {
        warns.push(`A két útvonaltervező eltérő távolságot ad: ${fmtKm(main)} és ${fmtKm(checkKm)}. Ellenőrizd Google Mapsen!`);
      }
    }
    if (snap > 1500) warns.push(`Az egyik pont ${fmt(snap / 1000, 1)} km-re van a legközelebbi úttól – lehet, hogy pontatlan a hely.`);
    if (straight > 3 && main / straight > 2.6) warns.push('Az útvonal szokatlanul hosszú a légvonalhoz képest. Érdemes ellenőrizni.');

    if (warns.length) setStatus('warn', '⚠️ ' + warns.join(' '));
    else if (checkKm != null) {
      const pct = Math.abs(main - checkKm) / Math.min(main, checkKm) * 100;
      setStatus('ok', `✓ Két független útvonaltervező egyezik (${fmtKm(main)} / ${fmtKm(checkKm)}, eltérés ${fmt(pct, 0)}%). Légvonalban ${fmtKm(straight)}.`);
    } else setStatus('info', `Közúti útvonal (${routes[0].src}). Az ellenőrző útvonaltervező most nem válaszolt. Légvonalban ${fmtKm(straight)}.`);

    saveRecent();
    recompute();
  }

  function setStatus(kind, text) {
    const el = $('routeStatus');
    if (!kind) { el.hidden = true; el.textContent = ''; return; }
    el.hidden = false;
    el.className = 'route-status ' + (kind === 'load' || kind === 'info' ? '' : kind);
    el.innerHTML = (kind === 'load' ? '<span class="spinner"></span>' : '') + esc(text);
  }

  function renderRoutes() {
    const el = $('routeList');
    if (state.routes.length <= 1) { el.innerHTML = ''; return; }
    const fastest = Math.min(...state.routes.map((r) => r.min));
    const shortest = Math.min(...state.routes.map((r) => r.km));
    el.innerHTML = state.routes.map((r, i) => {
      const tags = [];
      if (r.min === fastest) tags.push('leggyorsabb');
      if (r.km === shortest) tags.push('legrövidebb');
      return `<button type="button" class="route-opt" role="radio" aria-checked="${i === state.routeIdx && state.manualKm == null}" data-i="${i}">
        <span class="radio"></span>
        <span><span class="r-main">${fmtKm(r.km)} · ${fmtDur(r.min)}</span>
        <span class="r-sub" style="display:block">${esc(r.label || `${i + 1}. útvonal`)}</span></span>
        <span class="r-tag">${tags.join(', ')}</span></button>`;
    }).join('');
  }
  $('routeList').addEventListener('click', (e) => {
    const b = e.target.closest('.route-opt'); if (!b) return;
    state.routeIdx = +b.dataset.i; state.manualKm = null; state.manualMin = null;
    renderRoutes(); saveRecent(); recompute();
  });

  function onPlacesChanged() {
    settings.from = state.from; settings.to = state.to; persist();
    updateMapsLink();
    if (!state.from || !state.to) {
      state.routes = []; state.check = null; renderRoutes(); setStatus(null);
      if (state.manualKm == null) { state.manualMin = null; }
      recompute();
      return;
    }
    state.manualKm = null; state.manualMin = null;
    calcRoute();
  }

  function updateMapsLink() {
    const a = $('gmapsLink'), { from, to } = state;
    if (from && to) {
      const q = new URLSearchParams({ api: '1', origin: `${from.lat},${from.lon}`, destination: `${to.lat},${to.lon}`, travelmode: 'driving' });
      a.href = `https://www.google.com/maps/dir/?${q}`;
      a.classList.remove('disabled'); a.removeAttribute('aria-disabled');
    } else {
      a.href = '#'; a.classList.add('disabled'); a.setAttribute('aria-disabled', 'true');
    }
  }

  // ---------- Korábbi útvonalak ----------
  function saveRecent() {
    const r = state.routes[state.routeIdx];
    if (!state.from || !state.to || !r) return;
    const entry = { from: state.from, to: state.to, km: +r.km.toFixed(2), min: Math.round(r.min), ts: Date.now() };
    settings.recent = [entry, ...settings.recent.filter((x) =>
      !(placeKey(x.from) === placeKey(entry.from) && placeKey(x.to) === placeKey(entry.to)))].slice(0, MAX_RECENT);
    persist(); renderRecent();
  }
  function renderRecent() {
    const list = settings.recent || [];
    $('recentSection').hidden = !list.length;
    $('recentList').innerHTML = list.map((r, i) => `<button type="button" class="recent-item" data-i="${i}">
      <div class="ri-main">${esc(r.from.name)} → ${esc(r.to.name)}</div>
      <div class="ri-sub">${fmtKm(r.km)} · ${fmtDur(r.min)}</div></button>`).join('');
  }
  $('recentList').addEventListener('click', (e) => {
    const b = e.target.closest('.recent-item'); if (!b) return;
    const r = settings.recent[+b.dataset.i]; if (!r) return;
    state.from = r.from; state.to = r.to;
    showPlace('from'); showPlace('to');
    onPlacesChanged();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
  $('clearRecent').addEventListener('click', () => {
    if (!confirm('Törlöd a korábbi útvonalakat?')) return;
    settings.recent = []; persist(); renderRecent();
  });

  // ---------- Felcserélés ----------
  $('swapBtn').addEventListener('click', () => {
    [state.from, state.to] = [state.to, state.from];
    showPlace('from'); showPlace('to');
    onPlacesChanged();
  });

  // ---------- Kézi km / idő ----------
  const kmInput = $('kmInput'), hInput = $('hInput'), mInput = $('mInput');
  function currentOneWay() {
    const r = state.routes[state.routeIdx];
    const km = state.manualKm != null ? state.manualKm : (r ? r.km : NaN);
    const min = state.manualMin != null ? state.manualMin : (r ? r.min : NaN);
    return { km, min };
  }
  kmInput.addEventListener('input', () => {
    const v = parseNum(kmInput.value);
    state.manualKm = Number.isFinite(v) && v >= 0 ? v : (kmInput.value.trim() === '' ? null : state.manualKm);
    renderRoutes(); recompute(false);
  });
  const onTime = () => {
    const h = parseNum(hInput.value), m = parseNum(mInput.value);
    if (hInput.value.trim() === '' && mInput.value.trim() === '') state.manualMin = null;
    else state.manualMin = (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
    recompute(false);
  };
  hInput.addEventListener('input', onTime);
  mInput.addEventListener('input', onTime);
  $('resetManual').addEventListener('click', () => { state.manualKm = null; state.manualMin = null; renderRoutes(); recompute(); });

  // ---------- Üzemanyag ----------
  const consInput = $('consInput'), priceInput = $('priceInput');
  function renderCons() {
    const c = settings.cons;
    const isPreset = PRESETS.includes(c);
    document.querySelectorAll('#consChips .chip').forEach((b) => b.classList.toggle('active', +b.dataset.cons === c));
    consInput.parentElement.classList.toggle('active', !isPreset && Number.isFinite(c));
    if (isPreset && document.activeElement !== consInput) consInput.value = '';
  }
  $('consChips').addEventListener('click', (e) => {
    const b = e.target.closest('.chip'); if (!b) return;
    settings.cons = +b.dataset.cons; consInput.value = '';
    persist(); renderCons(); recompute();
  });
  consInput.addEventListener('input', () => {
    const v = parseNum(consInput.value);
    if (Number.isFinite(v) && v > 0 && v < 40) { settings.cons = v; persist(); }
    renderCons(); recompute();
  });
  priceInput.addEventListener('input', () => { settings.price = priceInput.value.trim(); persist(); recompute(); });

  // ---------- Út típusa ----------
  const seg = document.querySelector('.segmented');
  function renderMode() {
    seg.dataset.mode = settings.mode;
    seg.querySelectorAll('button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.mode === settings.mode)));
  }
  seg.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-mode]'); if (!b) return;
    settings.mode = b.dataset.mode; persist(); renderMode(); recompute();
  });

  // ---------- Fuvarár ----------
  const fareToggle = $('fareToggle'), rateInput = $('rateInput'), fixInput = $('fixInput');
  fareToggle.addEventListener('change', () => {
    settings.fareOn = fareToggle.checked; persist();
    $('fareBody').hidden = !fareToggle.checked; recompute();
  });
  rateInput.addEventListener('input', () => { settings.rate = rateInput.value.trim(); persist(); recompute(); });
  fixInput.addEventListener('input', () => { settings.fix = fixInput.value.trim(); persist(); recompute(); });

  // ---------- Számítás ----------
  function recompute(syncInputs = true) {
    const { km: oneKm, min: oneMin } = currentOneWay();
    const round = settings.mode === 'round';
    const mult = round ? 2 : 1;
    const totalKm = oneKm * mult;
    const totalMin = oneMin * mult;
    const cons = settings.cons;
    const price = parseNum(settings.price);
    const liters = totalKm * cons / 100;
    const cost = liters * price;
    const hasKm = Number.isFinite(oneKm) && oneKm > 0;

    // Kézi mezők szinkronizálása az útvonaltervező értékével
    if (syncInputs) {
      if (document.activeElement !== kmInput) kmInput.value = hasKm ? fmtInputNum(oneKm, 1) : '';
      if (document.activeElement !== hInput && document.activeElement !== mInput) {
        if (Number.isFinite(oneMin) && oneMin > 0) {
          const t = Math.round(oneMin); hInput.value = String(Math.floor(t / 60)); mInput.value = String(t % 60);
        } else { hInput.value = ''; mInput.value = ''; }
      }
    }
    const manual = state.manualKm != null || state.manualMin != null;
    kmInput.parentElement.classList.toggle('manual-set', state.manualKm != null);
    document.querySelectorAll('.time-inputs .input-unit').forEach((x) => x.classList.toggle('manual-set', state.manualMin != null));
    $('resetManual').hidden = !(manual && state.routes.length);
    $('manualHint').textContent = manual
      ? (state.routes.length ? 'Kézzel megadott érték – ezzel számolok.' : 'Kézzel megadott érték.')
      : 'A kilométer és a menetidő kézzel is átírható.';

    $('outKm').textContent = hasKm ? fmtKm(totalKm) : '–';
    $('outTime').textContent = hasKm ? fmtDur(totalMin) : '–';
    $('outLiters').textContent = hasKm ? `${fmt(liters, 2)} l` : '–';
    $('outCost').textContent = hasKm && Number.isFinite(price) ? fmtLei(cost) : '–';

    let note;
    if (!hasKm) note = 'Add meg az útvonalat vagy a kilométert.';
    else if (!Number.isFinite(price)) note = 'Írd be a benzin literenkénti árát a költséghez.';
    else note = `${round ? `Oda-vissza: 2 × ${fmtKm(oneKm)}` : `Csak oda: ${fmtKm(oneKm)}`} · ${fmt(cons, 1)} l/100 km · ${fmt(price, 2)} lej/l`;
    $('heroNote').textContent = note;

    // Összehasonlítás
    $('compareSub').textContent = hasKm ? `· ${fmtKm(totalKm)}` : '';
    $('compareList').innerHTML = PRESETS.map((c) => {
      const l = totalKm * c / 100;
      return `<div class="cmp-row ${c === cons ? 'active' : ''}">
        <span class="cmp-cons">${fmt(c, 1)} l</span>
        <span class="cmp-l">${hasKm ? `${fmt(l, 2)} liter` : '–'}</span>
        <span class="cmp-cost">${hasKm && Number.isFinite(price) ? fmtLei(l * price) : '–'}</span></div>`;
    }).join('') + (!PRESETS.includes(cons) && Number.isFinite(cons) ? `<div class="cmp-row active">
        <span class="cmp-cons">${fmt(cons, 1)} l</span>
        <span class="cmp-l">${hasKm ? `${fmt(liters, 2)} liter` : '–'}</span>
        <span class="cmp-cost">${hasKm && Number.isFinite(price) ? fmtLei(cost) : '–'}</span></div>` : '');

    // Fuvarár – mindig csak az odaút
    if (settings.fareOn) {
      const rate = parseNum(settings.rate);
      const fixRaw = parseNum(settings.fix);
      const fix = Number.isFinite(fixRaw) ? fixRaw : 0;
      const fare = hasKm && Number.isFinite(rate) ? oneKm * rate + fix : NaN;
      const remain = fare - cost;
      $('outFare').textContent = fmtLei(fare);
      $('fareCalc').textContent = hasKm && Number.isFinite(rate)
        ? `Odaút: ${fmtKm(oneKm)} × ${fmt(rate, 2)} lej${fix ? ` + ${fmt(fix, 2)} lej fix` : ''}` : 'Csak az odaút kilométereivel';
      $('outFareFuel').textContent = hasKm && Number.isFinite(price) ? `− ${fmtLei(cost)}` : '–';
      $('fareFuelCalc').textContent = hasKm ? `${round ? 'Oda-vissza' : 'Csak oda'}: ${fmtKm(totalKm)}` : '';
      const remEl = $('outRemain');
      remEl.textContent = Number.isFinite(remain) ? fmtLei(remain) : '–';
      remEl.classList.toggle('minus', Number.isFinite(remain) && remain < 0);
    }
  }

  // ---------- Indítás ----------
  setupPlaceField('from');
  setupPlaceField('to');
  priceInput.value = settings.price;
  rateInput.value = settings.rate;
  fixInput.value = settings.fix;
  fareToggle.checked = !!settings.fareOn;
  $('fareBody').hidden = !settings.fareOn;
  if (!PRESETS.includes(settings.cons) && Number.isFinite(settings.cons)) consInput.value = fmtInputNum(settings.cons, 2);
  renderCons(); renderMode(); renderRecent();
  if (settings.from && settings.to) {
    state.from = settings.from; state.to = settings.to;
    showPlace('from'); showPlace('to');
    onPlacesChanged();
  } else {
    if (settings.from) { state.from = settings.from; showPlace('from'); }
    updateMapsLink();
    recompute();
  }

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
  }
})();
