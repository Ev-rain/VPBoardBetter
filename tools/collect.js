// Dev-only collector: uses headless Edge to download real XCPCIO data into fixtures/.
// Usage: node tools/collect.js <contest-path>   e.g. node tools/collect.js icpc/50th/nanjing
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const target = (process.argv[2] || 'icpc/50th/nanjing').replace(/^\/+|\/+$/g, '');
const outDir = path.join(__dirname, '..', 'fixtures', target.replace(/\//g, '_'));
const base = 'https://xcpcio.github.io/board-data/data/' + target;
const FILES = ['config.json', 'team.json', 'run.json'];
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 8899;

fs.mkdirSync(outDir, { recursive: true });

const page = `<!doctype html><meta charset="utf-8"><pre id="o">collecting ${base}</pre><script>
const base=${JSON.stringify(base)};
const files=${JSON.stringify(FILES)};
(async()=>{
  const log=[];
  for(const f of files){
    try{
      const r=await fetch(base+'/'+f,{cache:'no-store'});
      const t=await r.text();
      const w=await fetch('/save/'+f,{method:'POST',body:t});
      log.push(f+' '+r.status+' '+t.length+' saved='+(await w.text()));
    }catch(e){log.push(f+' ERR '+e.message);}
  }
  document.getElementById('o').textContent=log.join('\\n');
  document.title='COLLECT-DONE';
})();
</script>`;

const got = new Set();
let finish;
const done = new Promise((res) => (finish = res));

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(page);
    return;
  }
  if (req.method === 'POST' && url.pathname.startsWith('/save/')) {
    const name = url.pathname.slice(6);
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      fs.writeFileSync(path.join(outDir, name), body);
      got.add(name);
      res.end('ok ' + body.length);
      if (FILES.every((f) => got.has(f))) finish();
    });
    return;
  }
  res.writeHead(404);
  res.end('no');
});

server.listen(PORT, '127.0.0.1', async () => {
  const profile = path.join(__dirname, '..', '.edgeprof-collect');
  const edge = spawn(EDGE, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-crash-reporter',
    '--no-first-run', '--user-data-dir=' + profile, '--virtual-time-budget=45000',
    '--dump-dom', `http://127.0.0.1:${PORT}/`
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  edge.stdout.on('data', (d) => (out += d));
  const timeout = setTimeout(() => finish(), 60000);
  await done;
  clearTimeout(timeout);
  try { spawn('taskkill', ['/PID', String(edge.pid), '/T', '/F']); } catch {}
  const dom = out.replace(/<script[\s\S]*?<\/script>/g, '');
  console.log(dom.slice(0, 2000));
  console.log('FILES:', [...got].join(','));
  server.close();
  process.exit(0);
});
