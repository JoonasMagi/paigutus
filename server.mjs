import { createServer } from 'http';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { LibreDwg, Dwg_File_Type } from '@mlightcad/libredwg-web';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 3000;
const SAVE_FILE = path.join(__dirname, 'masinate-andmed.json');
const LIBREDWG_WASM = path.join(__dirname, 'node_modules', '@mlightcad', 'libredwg-web', 'wasm', 'libredwg-web.wasm');

let libredwg = null;
const origErr = console.error.bind(console);
console.error = (...a) => { if (typeof a[0] === 'string' && a[0].includes('error code')) return; origErr(...a); };

async function getLib() {
  if (!libredwg) {
    const originalProcessType = process.type;
    try {
      process.type = 'renderer';
      libredwg = await LibreDwg.create(`http://127.0.0.1:${PORT}`);
    } finally {
      process.type = originalProcessType;
    }
  }
  return libredwg;
}

function loadState() {
  try { if (existsSync(SAVE_FILE)) return JSON.parse(readFileSync(SAVE_FILE, 'utf8')); } catch(e) {}
  return { machines: [], svgData: null };
}
function saveState(state) {
  try { writeFileSync(SAVE_FILE, JSON.stringify(state)); } catch(e) {}
}

function dwgToData(db) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

  function expand(x, y) {
    if (isFinite(x) && isFinite(y)) {
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
  }

  // Collect all layers
  const layerSet = new Set();
  const layerTypes = {}; // layer -> set of types

  // First pass: bounds + layer info
  const allParts = [];
  for (const e of db.entities) {
    if (!e.isVisible) continue;
    const t = e.type;
    const lyr = e.layer || '0';
    layerSet.add(lyr);
    if (!layerTypes[lyr]) layerTypes[lyr] = new Set();
    layerTypes[lyr].add(t);

    try {
      if (t === 'LINE') {
        expand(e.startPoint.x, e.startPoint.y); expand(e.endPoint.x, e.endPoint.y);
        allParts.push({ kind:'line', lyr, x1:e.startPoint.x, y1:e.startPoint.y, x2:e.endPoint.x, y2:e.endPoint.y });
      } else if (t === 'CIRCLE') {
        expand(e.center.x-e.radius, e.center.y-e.radius); expand(e.center.x+e.radius, e.center.y+e.radius);
        allParts.push({ kind:'circle', lyr, cx:e.center.x, cy:e.center.y, r:e.radius });
      } else if (t === 'ARC') {
        expand(e.center.x-e.radius, e.center.y-e.radius); expand(e.center.x+e.radius, e.center.y+e.radius);
        allParts.push({ kind:'arc', lyr, cx:e.center.x, cy:e.center.y, r:e.radius, sa:e.startAngle, ea:e.endAngle });
      } else if (t === 'ELLIPSE') {
        const { x:mx, y:my } = e.majorAxisEndPoint;
        const a = Math.sqrt(mx*mx+my*my);
        expand(e.center.x-a, e.center.y-a); expand(e.center.x+a, e.center.y+a);
        allParts.push({ kind:'ellipse', lyr, cx:e.center.x, cy:e.center.y, a, b:a*e.axisRatio, rot:Math.atan2(my,mx), sa:e.startAngle, ea:e.endAngle });
      } else if (t === 'LWPOLYLINE' && e.vertices?.length >= 2) {
        e.vertices.forEach(v => expand(v.x, v.y));
        allParts.push({ kind:'poly', lyr, pts:e.vertices.map(v=>({x:v.x,y:v.y})), closed:!!(e.flag&1) });
      } else if (t === 'TEXT') {
        expand(e.startPoint?.x??0, e.startPoint?.y??0);
        const txt = (e.text||'').replace(/[<>&"]/g, c=>({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c]));
        allParts.push({ kind:'text', lyr, x:e.startPoint?.x??0, y:e.startPoint?.y??0, txt, h:e.textHeight??200 });
      } else if (t === 'MTEXT') {
        expand(e.insertionPoint?.x??0, e.insertionPoint?.y??0);
        const txt = (e.text||'').replace(/\\[a-zA-Z][^;]*;/g,'').replace(/[{}\\]/g,'')
          .replace(/[<>&"]/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c])).trim();
        allParts.push({ kind:'text', lyr, x:e.insertionPoint?.x??0, y:e.insertionPoint?.y??0, txt, h:e.textHeight??200 });
      }
    } catch(err) {}
  }

  if (allParts.length === 0) return null;

  const pad = Math.max(maxX-minX, maxY-minY) * 0.001 || 1000;
  const W = maxX-minX+pad*2, H = maxY-minY+pad*2;
  const tx = x => x-minX+pad;
  const ty = y => H-(y-minY+pad);

  // Build per-layer SVG groups
  const layerGroups = {};
  for (const e of allParts) {
    if (!layerGroups[e.lyr]) layerGroups[e.lyr] = [];
    let el = '';
    if (e.kind==='line') {
      el = `<line x1="${tx(e.x1).toFixed(1)}" y1="${ty(e.y1).toFixed(1)}" x2="${tx(e.x2).toFixed(1)}" y2="${ty(e.y2).toFixed(1)}"/>`;
    } else if (e.kind==='circle') {
      el = `<circle cx="${tx(e.cx).toFixed(1)}" cy="${ty(e.cy).toFixed(1)}" r="${e.r.toFixed(1)}"/>`;
    } else if (e.kind==='arc') {
      const x1=tx(e.cx+e.r*Math.cos(e.sa)), y1=ty(e.cy+e.r*Math.sin(e.sa));
      const x2=tx(e.cx+e.r*Math.cos(e.ea)), y2=ty(e.cy+e.r*Math.sin(e.ea));
      let sw=e.ea-e.sa; if(sw<0)sw+=Math.PI*2;
      el = `<path d="M${x1.toFixed(1)},${y1.toFixed(1)} A${e.r.toFixed(1)},${e.r.toFixed(1)} 0 ${sw>Math.PI?1:0} 0 ${x2.toFixed(1)},${y2.toFixed(1)}"/>`;
    } else if (e.kind==='ellipse') {
      const cx=tx(e.cx), cy=ty(e.cy);
      const full=Math.abs(e.ea-e.sa)<0.001||Math.abs(Math.abs(e.ea-e.sa)-Math.PI*2)<0.001;
      if (full) {
        el = `<ellipse cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" rx="${e.a.toFixed(1)}" ry="${e.b.toFixed(1)}" transform="rotate(${(e.rot*180/Math.PI).toFixed(2)},${cx.toFixed(1)},${cy.toFixed(1)})"/>`;
      } else {
        const steps=24; let sa=e.sa, ea=e.ea; if(ea<sa)ea+=Math.PI*2;
        const pts=[];
        for(let i=0;i<=steps;i++){const ang=sa+(ea-sa)*i/steps;const lx=e.cx+e.a*Math.cos(ang)*Math.cos(e.rot)-e.b*Math.sin(ang)*Math.sin(e.rot);const ly=e.cy+e.a*Math.cos(ang)*Math.sin(e.rot)+e.b*Math.sin(ang)*Math.cos(e.rot);pts.push(`${i===0?'M':'L'}${tx(lx).toFixed(1)},${ty(ly).toFixed(1)}`);}
        el = `<path d="${pts.join(' ')}"/>`;
      }
    } else if (e.kind==='poly') {
      const pts=e.pts.map(p=>`${tx(p.x).toFixed(1)},${ty(p.y).toFixed(1)}`).join(' ');
      el = e.closed?`<polygon points="${pts}"/>`:`<polyline points="${pts}"/>`;
    } else if (e.kind==='text' && e.txt) {
      el = `<text x="${tx(e.x).toFixed(1)}" y="${ty(e.y).toFixed(1)}" font-size="${e.h.toFixed(1)}">${e.txt}</text>`;
    }
    if (el) layerGroups[e.lyr].push(el);
  }

  // Identify text-heavy layers
  const textTypes = new Set(['TEXT','MTEXT']);
  const layerInfo = [...layerSet].sort().map(lyr => {
    const types = [...(layerTypes[lyr]||[])];
    const isText = types.every(t => textTypes.has(t));
    const hasText = types.some(t => textTypes.has(t));
    return { name: lyr, isText, hasText, types };
  });

  const groupSvg = Object.entries(layerGroups).map(([lyr, els]) => {
    const safeid = 'lyr_' + lyr.replace(/[^a-zA-Z0-9]/g,'_');
    return `<g id="${safeid}" data-layer="${lyr}">\n${els.join('\n')}\n</g>`;
  }).join('\n');

  // baseStroke: so that at initial zoom (W fits ~1300px screen), line = 2.5px on screen
  // zoom_init ≈ 1300/W  =>  stroke_screen = zoom * strokeSVG  =>  strokeSVG = 2.5/zoom = 2.5*W/1300
  const baseStroke = Math.max(30, W / 520).toFixed(1);

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W.toFixed(0)} ${H.toFixed(0)}" data-base-stroke="${baseStroke}">
<style>
line,polyline,polygon,path,circle,ellipse{stroke:#ffffff;stroke-width:${baseStroke};fill:none}
text{fill:#cccccc;font-family:monospace}
</style>
${groupSvg}
</svg>`;

  return { svg, width: W, height: H, count: allParts.length, layers: layerInfo };
}

const HTML = readFileSync(new URL('./app.html', import.meta.url), 'utf8');

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(HTML); return;
  }
  if (req.method === 'GET' && url.pathname === '/state') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(loadState())); return;
  }
  if (req.method === 'GET' && url.pathname === '/libredwg-web.wasm') {
    const wasm = readFileSync(LIBREDWG_WASM);
    res.writeHead(200, {
      'Content-Type': 'application/wasm',
      'Content-Length': wasm.length,
      'Cache-Control': 'no-cache'
    });
    res.end(wasm); return;
  }
  if (req.method === 'POST' && url.pathname === '/state') {
    const chunks = []; req.on('data', c => chunks.push(c));
    req.on('end', () => {
      try { saveState(JSON.parse(Buffer.concat(chunks).toString())); res.writeHead(200); res.end('{"ok":true}'); }
      catch(e) { res.writeHead(400); res.end('bad json'); }
    }); return;
  }
  if (req.method === 'POST' && url.pathname === '/parse-dwg') {
    const chunks = []; req.on('data', c => chunks.push(c));
    req.on('end', async () => {
      try {
        const buf = Buffer.concat(chunks);
        const lib = await getLib();
        let dwg;
        try { dwg = lib.dwg_read_data(buf, Dwg_File_Type.DWG); }
        catch(e) { dwg = lib.dwg_read_data(buf, Dwg_File_Type.DXF); }
        const db = lib.convert(dwg);
        lib.dwg_free(dwg);
        const result = dwgToData(db);
        if (!result) { res.writeHead(400,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:'Ei leitud elemente'})); return; }
        console.log(`✓ Parsitud ${result.count} elementi, ${result.layers.length} kihti`);
        res.writeHead(200, {'Content-Type':'application/json'});
        res.end(JSON.stringify(result));
      } catch(err) {
        console.error('Viga:', err.message);
        res.writeHead(500,{'Content-Type':'application/json'});
        res.end(JSON.stringify({error:err.message}));
      }
    }); return;
  }
  res.writeHead(404); res.end();
});

server.listen(PORT, () => console.log(`✓ Avatud: http://localhost:${PORT}`));
