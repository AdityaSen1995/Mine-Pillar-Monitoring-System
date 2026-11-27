/* Browser implementation of the Mine Pillar Monitoring notebook. */
'use strict';

const CONFIG = Object.freeze({
  utmZone: 45,
  hemisphere: 'N',
  inclusiveDays: true,
  useElevationIfAvailable: true,
  minZoom: 10,
  maxZoom: 18,
  startZoom: 17
});

const $ = (id) => document.getElementById(id);
const ui = {
  pastInput: $('past-file'), presentInput: $('present-file'),
  pastName: $('past-name'), presentName: $('present-name'),
  run: $('run'), clearPast: $('clear-past'), status: $('status'),
  mapStatus: $('map-status'), note: $('layout-note'),
  shell: $('map-shell'), grid: $('grid-toggle'), arrows: $('arrows-toggle'),
  snapshot: $('snapshot'), exportReport: $('export-report')
};

let map = null;
let survey = null;
let renderedPillars = [];
let regularArrowLayers = [];
let surveyLayers = [];
let gridLayer = null;
let gridOn = false;
let allArrows = false;
let currentBounds = null;
let resizeObserver = null;

const utmCrs = `EPSG:${(CONFIG.hemisphere === 'N' ? 32600 : 32700) + CONFIG.utmZone}`;

ui.pastInput.addEventListener('change', () => updateFileName(ui.pastInput, ui.pastName));
ui.presentInput.addEventListener('change', () => updateFileName(ui.presentInput, ui.presentName));
$('past-select').addEventListener('click', () => openFilePicker(ui.pastInput));
$('present-select').addEventListener('click', () => openFilePicker(ui.presentInput));
ui.clearPast.addEventListener('click', () => {
  ui.pastInput.value = '';
  ui.pastName.textContent = 'No file selected';
  ui.status.textContent = 'Past CSV cleared. Click Run to plot the present survey as new pillars.';
});
ui.run.addEventListener('click', runDashboard);
ui.grid.addEventListener('click', toggleGrid);
ui.arrows.addEventListener('click', toggleArrows);
ui.snapshot.addEventListener('click', saveSnapshot);
ui.exportReport.addEventListener('click', exportReport);

function openFilePicker(input) {
  // Keep the picker call synchronous inside the trusted button-click handler.
  try {
    if (typeof input.showPicker === 'function') input.showPicker();
    else input.click();
  } catch (_) {
    input.click();
  }
}

window.addEventListener('error', event => {
  if (event.message && /proj4|L is not defined|ExcelJS/.test(event.message)) {
    ui.status.textContent = 'A required map library did not load. Check your internet connection, then refresh the page.';
  }
});

function updateFileName(input, label) {
  label.textContent = input.files?.[0]?.name || 'No file selected';
  label.title = input.files?.[0]?.name || '';
  ui.status.textContent = input.files?.[0]
    ? 'File selection changed. Click Run to update the map.'
    : 'No file selected.';
}

function parseCsv(text, filename) {
  text = text.replace(/^\uFEFF/, '');
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some(value => value.trim() !== '')) rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) throw new Error(`${filename}: CSV has no data rows.`);
  const headers = rows.shift().map(value => value.trim());
  const required = ['ID', 'Date', 'Easting', 'Northing'];
  const missing = required.filter(name => !headers.includes(name));
  if (missing.length) throw new Error(`${filename}: missing columns ${missing.join(', ')}.`);
  const hasElevation = headers.includes('Elevation');
  const seen = new Set();
  const data = rows.map((values, rowIndex) => {
    const record = Object.fromEntries(headers.map((name, index) => [name, (values[index] ?? '').trim()]));
    const id = record.ID;
    if (!id) throw new Error(`${filename}: row ${rowIndex + 2} has a blank ID.`);
    if (seen.has(id)) throw new Error(`${filename}: duplicate ID ${id}.`);
    seen.add(id);
    record._date = parseDate(record.Date, filename, rowIndex + 2);
    for (const key of ['Easting', 'Northing', ...(hasElevation ? ['Elevation'] : [])]) {
      const value = Number(record[key]);
      if (!Number.isFinite(value)) throw new Error(`${filename}: invalid ${key} on row ${rowIndex + 2}.`);
      record[key] = value;
    }
    return record;
  });
  if (!data.length) throw new Error(`${filename}: CSV has no data rows.`);
  return {data, hasElevation};
}

function parseDate(value, filename, row) {
  const match = /^(\d{2})-(\d{2})-(\d{4})$/.exec(value);
  if (!match) throw new Error(`${filename}: dates must use dd-mm-yyyy (row ${row}).`);
  const [, dd, mm, yyyy] = match;
  const date = new Date(Date.UTC(Number(yyyy), Number(mm) - 1, Number(dd)));
  if (date.getUTCDate() !== Number(dd) || date.getUTCMonth() !== Number(mm) - 1)
    throw new Error(`${filename}: invalid date ${value} on row ${row}.`);
  return date;
}

function formatDate(date) {
  if (!date) return '';
  return `${String(date.getUTCDate()).padStart(2, '0')}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${date.getUTCFullYear()}`;
}

function transformCoordinate(easting, northing) {
  ensureProjection();
  const [longitude, latitude] = proj4(utmCrs, 'EPSG:4326', [easting, northing]);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 85)
    throw new Error('Coordinates cannot be displayed; check UTM zone and units.');
  return {latitude, longitude};
}

function ensureProjection() {
  if (typeof proj4 === 'undefined') throw new Error('The coordinate conversion library did not load. Check your internet connection and refresh the page.');
  if (!proj4.defs(utmCrs)) {
    proj4.defs(utmCrs, `+proj=utm +zone=${CONFIG.utmZone} ${CONFIG.hemisphere === 'S' ? '+south ' : ''}+datum=WGS84 +units=m +no_defs`);
  }
}

// Vincenty inverse calculation on WGS84, returning initial bearing and metres.
function geodesic(lat1, lon1, lat2, lon2) {
  const a = 6378137, f = 1 / 298.257223563, b = (1 - f) * a;
  const toRad = Math.PI / 180;
  const U1 = Math.atan((1 - f) * Math.tan(lat1 * toRad));
  const U2 = Math.atan((1 - f) * Math.tan(lat2 * toRad));
  const L = (lon2 - lon1) * toRad;
  let lambda = L, previous, sinSigma, cosSigma, sigma, sinAlpha, cosSqAlpha, cos2SigmaM;
  for (let i = 0; i < 200; i++) {
    const sinLambda = Math.sin(lambda), cosLambda = Math.cos(lambda);
    sinSigma = Math.sqrt((Math.cos(U2) * sinLambda) ** 2 +
      (Math.cos(U1) * Math.sin(U2) - Math.sin(U1) * Math.cos(U2) * cosLambda) ** 2);
    if (sinSigma === 0) return {distance: 0, bearing: 0};
    cosSigma = Math.sin(U1) * Math.sin(U2) + Math.cos(U1) * Math.cos(U2) * cosLambda;
    sigma = Math.atan2(sinSigma, cosSigma);
    sinAlpha = Math.cos(U1) * Math.cos(U2) * sinLambda / sinSigma;
    cosSqAlpha = 1 - sinAlpha * sinAlpha;
    cos2SigmaM = cosSqAlpha ? cosSigma - 2 * Math.sin(U1) * Math.sin(U2) / cosSqAlpha : 0;
    const C = f / 16 * cosSqAlpha * (4 + f * (4 - 3 * cosSqAlpha));
    previous = lambda;
    lambda = L + (1 - C) * f * sinAlpha * (sigma + C * sinSigma *
      (cos2SigmaM + C * cosSigma * (-1 + 2 * cos2SigmaM ** 2)));
    if (Math.abs(lambda - previous) < 1e-12) break;
  }
  if (Math.abs(lambda - previous) >= 1e-8) return sphericalGeodesic(lat1, lon1, lat2, lon2);
  const uSq = cosSqAlpha * (a * a - b * b) / (b * b);
  const A = 1 + uSq / 16384 * (4096 + uSq * (-768 + uSq * (320 - 175 * uSq)));
  const B = uSq / 1024 * (256 + uSq * (-128 + uSq * (74 - 47 * uSq)));
  const deltaSigma = B * sinSigma * (cos2SigmaM + B / 4 *
    (cosSigma * (-1 + 2 * cos2SigmaM ** 2) - B / 6 * cos2SigmaM *
    (-3 + 4 * sinSigma ** 2) * (-3 + 4 * cos2SigmaM ** 2)));
  const distance = b * A * (sigma - deltaSigma);
  const bearing = Math.atan2(Math.cos(U2) * Math.sin(lambda),
    Math.cos(U1) * Math.sin(U2) - Math.sin(U1) * Math.cos(U2) * Math.cos(lambda)) / toRad;
  return {distance, bearing: (bearing + 360) % 360};
}

function sphericalGeodesic(lat1, lon1, lat2, lon2) {
  const r = Math.PI / 180, p1 = lat1 * r, p2 = lat2 * r, dl = (lon2 - lon1) * r, dp = p2 - p1;
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  const d = 2 * 6371008.8 * Math.asin(Math.sqrt(Math.min(1, h)));
  const bearing = Math.atan2(Math.sin(dl) * Math.cos(p2),
    Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl)) / r;
  return {distance: d, bearing: (bearing + 360) % 360};
}

async function calculate(pastFile, presentFile) {
  const presentParsed = parseCsv(await presentFile.text(), presentFile.name);
  const pastParsed = pastFile ? parseCsv(await pastFile.text(), pastFile.name) : {data: [], hasElevation: presentParsed.hasElevation};
  if (CONFIG.useElevationIfAvailable && pastFile && pastParsed.hasElevation !== presentParsed.hasElevation)
    throw new Error('Elevation must be supplied in both CSVs, or neither.');
  const pastById = new Map(pastParsed.data.map(row => [row.ID, row]));
  const pastIds = new Set(pastParsed.data.map(row => row.ID));
  const output = presentParsed.data.map(current => {
    const previous = pastById.get(current.ID) || null;
    const presentPosition = transformCoordinate(current.Easting, current.Northing);
    const record = {
      ID: current.ID, Date_present: current._date,
      Easting_present: current.Easting, Northing_present: current.Northing,
      Elevation_present: presentParsed.hasElevation ? current.Elevation : null,
      present_lat: presentPosition.latitude, present_long: presentPosition.longitude,
      is_present_only: !previous, color: 'pink',
      dXY: null, dZ: null, TD: null, 'TD/n_days': null, bearing: null, n_days: null,
      Date_past: null, Easting_past: null, Northing_past: null, Elevation_past: null
    };
    if (!previous) return record;
    const elapsed = Math.floor((current._date - previous._date) / 86400000);
    if (elapsed <= 0) throw new Error(`Every present date must be later than its matching past date (pillar ${current.ID}).`);
    const pastPosition = transformCoordinate(previous.Easting, previous.Northing);
    const move = geodesic(pastPosition.latitude, pastPosition.longitude,
      presentPosition.latitude, presentPosition.longitude);
    record.Date_past = previous._date;
    record.Easting_past = previous.Easting;
    record.Northing_past = previous.Northing;
    record.Elevation_past = pastParsed.hasElevation ? previous.Elevation : null;
    record.n_days = elapsed + (CONFIG.inclusiveDays ? 1 : 0);
    record.bearing = move.bearing;
    record.dXY = move.distance * 1000;
    record.dZ = pastParsed.hasElevation ? Math.abs(current.Elevation - previous.Elevation) * 1000 : 0;
    record.TD = Math.hypot(record.dXY, record.dZ);
    record['TD/n_days'] = record.TD / record.n_days;
    record.color = record['TD/n_days'] >= 5 ? 'red' : record['TD/n_days'] >= 3 ? '#FFD700' : 'lightgreen';
    record.is_present_only = false;
    return record;
  });
  return {
    rows: output,
    pastOnlyIds: [...pastIds].filter(id => !new Set(presentParsed.data.map(row => row.ID)).has(id)).sort(),
    mode: !pastFile ? 'Present survey only (no past data)' : pastParsed.hasElevation ? '3D (with elevation)' : '2D (horizontal only)'
  };
}

function initMap() {
  if (map) return;
  if (typeof L === 'undefined') throw new Error('The map library did not load. Check your internet connection and refresh the page.');
  ensureProjection();
  map = L.map('map', {
    zoomControl: true, minZoom: CONFIG.minZoom, maxZoom: CONFIG.maxZoom,
    zoomSnap: 0.25, zoomDelta: 0.25, wheelPxPerZoomLevel: 120,
    preferCanvas: true, attributionControl: true
  });
  map.createPane('grid'); map.getPane('grid').style.zIndex = 350;
  map.createPane('arrows'); map.getPane('arrows').style.zIndex = 450;
  map.createPane('points'); map.getPane('points').style.zIndex = 500;
  map.createPane('labels'); map.getPane('labels').style.zIndex = 550;
  L.tileLayer('https://mt1.google.com/vt/lyrs=s&x={x}&y={y}&z={z}', {
    attribution: 'Map data © Google', maxZoom: CONFIG.maxZoom,
    maxNativeZoom: CONFIG.maxZoom, crossOrigin: 'anonymous'
  }).addTo(map);
  map.on('moveend zoomend resize', () => { if (gridOn) drawGrid(); placeLabels(); });
  addNorthArrow();
  addLegend();
  resizeObserver = new ResizeObserver(() => {
    if (!map) return;
    map.invalidateSize({pan: false});
    if (gridOn) drawGrid();
    placeLabels();
  });
  resizeObserver.observe($('map-shell'));
}

function addNorthArrow() {
  const control = L.control({position: 'topright'});
  control.onAdd = () => {
    const div = L.DomUtil.create('div', 'north-arrow');
    div.innerHTML = 'N<span>↑</span>';
    return div;
  };
  control.addTo(map);
}

function addLegend() {
  const control = L.control({position: 'bottomleft'});
  control.onAdd = () => {
    const div = L.DomUtil.create('div', 'legend');
    div.innerHTML = `<div class="legend-title">Legend</div>
      <div class="legend-row"><i class="legend-dot" style="background:lightgreen"></i>Safe pillar</div>
      <div class="legend-row"><i class="legend-dot" style="background:#FFD700"></i>Threshold pillar</div>
      <div class="legend-row"><i class="legend-dot" style="background:red"></i>Unsafe pillar</div>
      <div class="legend-row"><i class="legend-dot" style="background:pink"></i>New pillar</div>
      <div class="legend-rule"></div>
      <div class="legend-row"><span class="legend-arrow" style="color:lightgreen">➜</span>&lt;3 mm/d</div>
      <div class="legend-row"><span class="legend-arrow" style="color:#FFD700">➜</span>&gt;3 mm/d</div>
      <div class="legend-row"><span class="legend-arrow" style="color:red">➜</span>&gt;5 mm/d</div>`;
    L.DomEvent.disableClickPropagation(div);
    return div;
  };
  control.addTo(map);
}

function divMarker(latlng, className, html, size, anchor, pane) {
  return L.marker(latlng, {
    pane,
    interactive: false,
    icon: L.divIcon({className, html, iconSize: size, iconAnchor: anchor})
  });
}

function renderMap(result) {
  initMap();
  clearMapData();
  survey = result;
  const points = result.rows;
  const highGroup = L.layerGroup().addTo(map);
  surveyLayers.push(highGroup);
  regularArrowLayers = [];
  renderedPillars = [];
  points.forEach(row => {
    const loc = [row.present_lat, row.present_long];
    const rate = row['TD/n_days'];
    if (Number.isFinite(row.dXY) && row.dXY > 1e-6) {
      const color = row.color;
      const arrowHtml = `<div style="width:50px;height:50px;transform:rotate(${row.bearing}deg);transform-origin:25px 45px;pointer-events:none">
        <div style="position:absolute;left:23px;top:12px;width:4px;height:33px;background:${color}"></div>
        <div style="position:absolute;left:16px;top:0;border-left:9px solid transparent;border-right:9px solid transparent;border-bottom:15px solid ${color}"></div></div>`;
      const arrow = divMarker(loc, '', arrowHtml, [50, 50], [25, 45], 'arrows');
      if (rate > 3) arrow.addTo(highGroup);
      else regularArrowLayers.push(arrow);
    }
    const pointHtml = `<div style="width:16px;height:16px;border:2px solid black;border-radius:50%;background:${row.color};box-sizing:border-box"></div>`;
    const pointMarker=divMarker(loc, '', pointHtml, [16, 16], [8, 8], 'points').addTo(map);
    surveyLayers.push(pointMarker);
    const id = escapeHtml(row.ID);
    const bearing = Number.isFinite(row.bearing) && row.dXY > 1e-6 ? `${row.bearing.toFixed(1)}°` : 'N/A';
    const label = row.is_present_only ? `<div class="pillar-label">${id}</div>` :
      `<div class="pillar-label"><span class="pillar-id">${id}</span><br>${rate.toFixed(1)} mm/d<br>${bearing}</div>`;
    const marker = divMarker(loc, '', label, [120, 48], [-12, -8], 'labels').addTo(map);
    surveyLayers.push(marker);
    renderedPillars.push(marker);
  });
  map.fitBounds(L.latLngBounds(points.map(row => [row.present_lat, row.present_long])), {
    padding: [65, 65], maxZoom: CONFIG.maxZoom
  });
  map.once('moveend', placeLabels);
  if (allArrows) regularArrowLayers.forEach(layer => layer.addTo(map));
  if (gridOn) drawGrid();
  setTimeout(() => { map.invalidateSize(); placeLabels(); }, 150);
}

function clearMapData() {
  if (!map) return;
  if (gridLayer) map.removeLayer(gridLayer);
  surveyLayers.forEach(layer=>map.removeLayer(layer));
  regularArrowLayers.forEach(layer=>map.removeLayer(layer));
  // Preserve the basemap, Leaflet controls, north arrow and legend on reruns.
  surveyLayers=[];
  regularArrowLayers = [];
  renderedPillars = [];
  gridLayer = null;
}

function toggleArrows() {
  allArrows = !allArrows;
  ui.arrows.setAttribute('aria-pressed', String(allArrows));
  ui.arrows.textContent = allArrows ? 'Arrows: All' : 'Arrows: >3';
  if (!map) return;
  if (allArrows) regularArrowLayers.forEach(layer => layer.addTo(map));
  else regularArrowLayers.forEach(layer => map.removeLayer(layer));
}

function toggleGrid() {
  gridOn = !gridOn;
  ui.grid.setAttribute('aria-pressed', String(gridOn));
  ui.grid.textContent = gridOn ? 'Grid: On' : 'Grid: Off';
  if (!map) return;
  if (gridOn) drawGrid();
  else if (gridLayer) { map.removeLayer(gridLayer); gridLayer = null; }
}

function drawGrid() {
  if (!map || !gridOn) return;
  if (gridLayer) map.removeLayer(gridLayer);
  gridLayer = L.layerGroup().addTo(map);
  const bounds = map.getBounds();
  const corners = [bounds.getNorthWest(), bounds.getNorthEast(), bounds.getSouthWest(), bounds.getSouthEast()];
  const xy = corners.map(point => proj4('EPSG:4326', utmCrs, [point.lng, point.lat]));
  const minE = Math.min(...xy.map(p => p[0])), maxE = Math.max(...xy.map(p => p[0]));
  const minN = Math.min(...xy.map(p => p[1])), maxN = Math.max(...xy.map(p => p[1]));
  const span = Math.max(maxE - minE, maxN - minN);
  const step = niceGridStep(span / 7);
  const toGeo = (e,n) => {
    const p=proj4(utmCrs,'EPSG:4326',[e,n]);
    return [p[1],p[0]];
  };
  for (let e=Math.floor(minE/step)*step; e<=maxE+step; e+=step) {
    const pts=[];
    for (let n=minN-step; n<=maxN+step; n+=Math.max(step/6,10)) pts.push(toGeo(e,n));
    L.polyline(pts,{pane:'grid',color:'#fff',weight:1,opacity:.7,interactive:false}).addTo(gridLayer);
    const pos=toGeo(e,minN+step*.05);
    L.marker(pos,{pane:'grid',interactive:false,icon:L.divIcon({className:'',html:`<div class="grid-label">E ${Math.round(e)} m</div>`,iconSize:null,iconAnchor:[0,0]})}).addTo(gridLayer);
  }
  for (let n=Math.floor(minN/step)*step; n<=maxN+step; n+=step) {
    const pts=[];
    for (let e=minE-step; e<=maxE+step; e+=Math.max(step/6,10)) pts.push(toGeo(e,n));
    L.polyline(pts,{pane:'grid',color:'#fff',weight:1,opacity:.7,interactive:false}).addTo(gridLayer);
    const pos=toGeo(minE+step*.05,n);
    L.marker(pos,{pane:'grid',interactive:false,icon:L.divIcon({className:'',html:`<div class="grid-label">N ${Math.round(n)} m</div>`,iconSize:null,iconAnchor:[0,0]})}).addTo(gridLayer);
  }
}

function niceGridStep(value) {
  const power=10**Math.floor(Math.log10(Math.max(1,value)));
  const fraction=value/power;
  return (fraction<=1?1:fraction<=2?2:fraction<=5?5:10)*power;
}

function placeLabels() {
  if (!map || !renderedPillars.length) return;
  const mapRect=map.getContainer().getBoundingClientRect();
  const obstacles=[...map.getContainer().querySelectorAll(
    '.leaflet-points-pane .leaflet-marker-icon > div,.leaflet-arrows-pane .leaflet-marker-icon > div > div,.leaflet-control,.grid-label')]
    .map(el=>el.getBoundingClientRect()).filter(r=>r.width&&r.height);
  const placed=[];
  const candidates=[[12,-8],[12,8],[-12,-8],[-12,8],[0,-20],[0,20],[22,0],[-22,0],
    [18,-18],[18,18],[-18,-18],[-18,18],[0,-30],[0,30]];
  const overlap=(a,b)=>a.left<b.right&&a.right>b.left&&a.top<b.bottom&&a.bottom>b.top;
  renderedPillars.forEach(marker=>{
    const icon=marker.getElement(), label=icon?.querySelector('.pillar-label');
    if(!label) return;
    const pt=map.latLngToContainerPoint(marker.getLatLng());
    label.style.visibility='hidden';
    let selected=null, best=Infinity;
    for (const [dx,dy] of candidates) {
      const r=label.getBoundingClientRect();
      const width=r.width,height=r.height;
      const left=pt.x+dx,right=left+width,top=pt.y+dy,bottom=top+height;
      if(left<2||top<2||right>mapRect.width-2||bottom>mapRect.height-2) continue;
      const box={left,right,top,bottom};
      let score=0;
      for(const obstacle of obstacles) if(overlap(box,obstacle)) score+=1000;
      for(const previous of placed) if(overlap(box,previous)) score+=1000;
      const id=label.querySelector('.pillar-id');
      if(id) {
        const idRect=id.getBoundingClientRect();
        // Keep the ID near the point while testing placements.
        if(Math.hypot((left+idRect.width/2)-pt.x,(top+idRect.height/2)-pt.y)>42) score+=30;
      }
      score+=Math.hypot(dx,dy);
      if(score<best){best=score;selected={box,dx,dy};}
      if(score<42) break;
    }
    if(!selected){label.style.visibility='visible';return;}
    label.style.transform=`translate(${selected.dx}px, ${selected.dy}px)`;
    label.style.visibility='visible';
    placed.push(selected.box);
  });
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
}

async function runDashboard() {
  if (ui.run.disabled) return;
  const presentFile=ui.presentInput.files?.[0];
  if (!presentFile) { ui.status.textContent='Select the present CSV file first.'; return; }
  ui.run.disabled=true;
  ui.status.textContent='Calculating pillar movement and preparing the map…';
  try {
    const result=await calculate(ui.pastInput.files?.[0] || null,presentFile);
    renderMap(result);
    const presentOnly=result.rows.filter(row=>row.is_present_only).map(row=>row.ID);
    const listedPastOnly=result.pastOnlyIds.length?result.pastOnlyIds.join(', '):'None';
    ui.status.innerHTML=`<b>${result.rows.length} pillars loaded.</b> ${escapeHtml(result.mode)}; UTM ${CONFIG.utmZone}${CONFIG.hemisphere}; ${CONFIG.inclusiveDays?'inclusive':'elapsed'} day count. Initial arrows: rate &gt;3 mm/day. Pan or zoom to separate nearby labels.<br><b>Present-only pillars (pink): ${presentOnly.length}</b> — ${escapeHtml(presentOnly.join(', ')||'None')}<br><b>Past-only IDs (no present position; not plotted):</b> ${escapeHtml(listedPastOnly)}`;
  } catch(error) {
    ui.status.textContent=`Unable to run: ${error.message}`;
  } finally {
    ui.run.disabled=false;
  }
}

async function saveSnapshot() {
  if(!map || !survey){ui.mapStatus.textContent='Run the survey first to create a map.';return;}
  ui.snapshot.disabled=true;ui.mapStatus.textContent='Creating JPEG…';
  try {
    if(typeof html2canvas==='undefined') throw new Error('Snapshot library did not load. Check internet access.');
    placeLabels();
    if(gridOn) drawGrid();
    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    const canvas=await html2canvas(map.getContainer(),{
      useCORS:true,allowTaint:false,scale:2,backgroundColor:'#fff',logging:false,
      ignoreElements:el=>el.classList?.contains('leaflet-control-zoom')
    });
    const link=document.createElement('a');
    link.download=`Mine_pillar_snapshot_${new Date().toISOString().replace(/[-:TZ.]/g,'').slice(0,14)}.jpg`;
    link.href=canvas.toDataURL('image/jpeg',.95);link.click();
    ui.mapStatus.textContent='Snapshot downloaded as JPEG.';
  } catch(error) {ui.mapStatus.textContent=`Snapshot failed: ${error.message}`;}
  finally {ui.snapshot.disabled=false;}
}

async function exportReport() {
  if(!survey){ui.mapStatus.textContent='Run the survey first to prepare the report.';return;}
  if(typeof ExcelJS==='undefined'){ui.mapStatus.textContent='Excel export library did not load. Check internet access.';return;}
  const rows=survey.rows;
  const col=[
    ['ID','Pillar ID'],['Date_past','Past Date'],['Easting_past','Easting'],['Northing_past','Northing'],['Elevation_past','Elevation'],
    ['Date_present','Present Date'],['Easting_present','Easting'],['Northing_present','Northing'],['Elevation_present','Elevation'],
    ['dXY','Horizontal Displacement (mm)'],['dZ','Vertical Displacement (mm)'],['TD','Total Displacement (mm)'],['TD/n_days','Rate (mm/Day)'],['bearing','Bearing (Degrees)']
  ];
  const workbook=new ExcelJS.Workbook();
  const sheet=workbook.addWorksheet('Pillar Monitoring Report');
  sheet.columns=col.map(([key,header])=>({key,header}));
  sheet.getRow(1).height=45;
  sheet.getRow(1).eachCell(cell=>{
    cell.font={name:'Calibri',size:11,bold:true,color:{argb:'FFFFFFFF'}};
    cell.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF0070C0'}};
    cell.alignment={vertical:'middle',wrapText:true};
    cell.border={top:{style:'thin',color:{argb:'FF000000'}},left:{style:'thin',color:{argb:'FF000000'}},bottom:{style:'thin',color:{argb:'FF000000'}},right:{style:'thin',color:{argb:'FF000000'}}};
  });
  rows.forEach(row=>{
    const vals={
      ID:String(row.ID),Date_past:row.Date_past||null,
      Easting_past:row.Easting_past,Northing_past:row.Northing_past,Elevation_past:row.Elevation_past,
      Date_present:row.Date_present,Easting_present:row.Easting_present,Northing_present:row.Northing_present,
      Elevation_present:row.Elevation_present,dXY:round2(row.dXY),dZ:round2(row.dZ),TD:round2(row.TD),
      'TD/n_days':round2(row['TD/n_days']),bearing:round2(row.bearing)
    };
    const out=sheet.addRow(vals);
    const rate=row['TD/n_days'];
    const fill=Number.isFinite(rate)&&rate>5?'FFFF7D7D':Number.isFinite(rate)&&rate>=3?'FFFFFF85':null;
    out.eachCell({includeEmpty:true},cell=>{
      cell.font={name:'Calibri',size:11,bold:Number.isFinite(rate)&&rate>=3,color:{argb:'FF000000'}};
      cell.border={top:{style:'thin',color:{argb:'FF000000'}},left:{style:'thin',color:{argb:'FF000000'}},bottom:{style:'thin',color:{argb:'FF000000'}},right:{style:'thin',color:{argb:'FF000000'}}};
      if(fill)cell.fill={type:'pattern',pattern:'solid',fgColor:{argb:fill}};
    });
    out.getCell(2).numFmt='dd-mm-yyyy';out.getCell(6).numFmt='dd-mm-yyyy';
  });
  sheet.columns.forEach(column=>{
    let max=0;
    column.eachCell({includeEmpty:true},cell=>{max=Math.max(max,String(cell.value??'').length);});
    column.width=max+2;
  });
  const buffer=await workbook.xlsx.writeBuffer();
  downloadBlob(new Blob([buffer],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}),
    `Report_${new Date().toISOString().slice(0,10).replaceAll('-','')}.xlsx`);
  ui.mapStatus.textContent='Excel report downloaded.';
}

function round2(value){return Number.isFinite(value)?Math.round((value+Number.EPSILON)*100)/100:null;}
function downloadBlob(blob,name){const a=document.createElement('a');const url=URL.createObjectURL(blob);a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1500);}
