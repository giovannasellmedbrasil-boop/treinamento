// Roda a plataforma inteira no computador, sem contas externas: Postgres embutido (PGlite),
// um Storage imitando o Supabase (arquivos em .local/) e as MESMAS funções de api/ usadas em produção.
// Uso (fora do iCloud): npm install && npm run local → http://localhost:4173 (senha do painel: local)
import { createServer } from 'node:http';
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const data = join(process.env.LOCAL_DATA || join(root, '.local'));
mkdirSync(join(data, 'storage'), { recursive: true });
const PORT = Number(process.env.PORT || 4173), STORAGE = PORT + 1, PGPORT = PORT + 2;

const db = await PGlite.create(join(data, 'pg'));
await db.exec(`do $$ begin create role anon; exception when others then null; end $$;
  do $$ begin create role authenticated; exception when others then null; end $$;
  create schema if not exists storage;
  create table if not exists storage.buckets (id text primary key, name text, public bool, file_size_limit bigint, allowed_mime_types text[]);`);
await db.exec(readFileSync(join(root, 'supabase/schema.sql'), 'utf8'));
await new PGLiteSocketServer({ db, port: PGPORT, host: '127.0.0.1' }).start();

Object.assign(process.env, {
  DATABASE_URL: `postgresql://postgres:postgres@127.0.0.1:${PGPORT}/postgres?sslmode=disable`, DATABASE_SSL: 'off',
  SUPABASE_URL: `http://127.0.0.1:${STORAGE}`, SUPABASE_SECRET_KEY: 'local', ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || 'local',
  DEV_EMAIL_LINKS: process.env.SMTP_HOST ? '0' : '1', // sem SMTP, o link de senha aparece no terminal e na tela
});

const MIME = { '.html': 'text/html; charset=utf-8', '.svg': 'image/svg+xml', '.mjs': 'text/javascript', '.js': 'text/javascript', '.jpg': 'image/jpeg', '.png': 'image/png', '.pdf': 'application/pdf',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation', '.ppt': 'application/vnd.ms-powerpoint' };
const body = async (req) => { const c = []; for await (const x of req) c.push(x); return Buffer.concat(c); };
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' };

// Imita as rotas do Supabase Storage usadas pelo app
createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const p = decodeURIComponent(u.pathname).replace('/storage/v1', '');
  const file = (s) => join(data, 'storage', normalize(s).replace(/^(\.\.[/\\])+/, ''));
  const send = (c, o, h = {}) => { res.writeHead(c, { ...cors, ...h }); res.end(typeof o === 'string' || Buffer.isBuffer(o) ? o : JSON.stringify(o)); };
  if (req.method === 'OPTIONS') return send(204, '');
  if (p.startsWith('/object/upload/sign/') && req.method === 'POST') return send(200, { url: `/object/upload/sign/${p.split('/').slice(4).join('/')}?token=t` });
  if (p.startsWith('/object/upload/sign/') && req.method === 'PUT') {
    const f = file(p.split('/').slice(4).join('/')); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, await body(req)); return send(200, {});
  }
  if (p.startsWith('/object/public/') && req.method === 'GET') {
    const f = file(p.slice('/object/public/'.length));
    if (!existsSync(f)) return send(404, 'not found');
    const size = statSync(f).size, type = MIME[extname(f)] || 'application/octet-stream';
    const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
    if (m) { // vídeos precisam de Range para avançar/voltar
      const start = m[1] ? Number(m[1]) : 0, end = m[2] ? Number(m[2]) : size - 1;
      res.writeHead(206, { ...cors, 'Content-Type': type, 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Accept-Ranges': 'bytes' });
      return createReadStream(f, { start, end }).pipe(res);
    }
    res.writeHead(200, { ...cors, 'Content-Type': type, 'Content-Length': size, 'Accept-Ranges': 'bytes',
      ...(u.searchParams.has('download') ? { 'Content-Disposition': `attachment; filename="${u.searchParams.get('download')}"` } : {}) });
    return createReadStream(f).pipe(res);
  }
  if (p.startsWith('/object/treinamentos') && req.method === 'DELETE') {
    const { prefixes } = JSON.parse(await body(req)); prefixes.forEach((x) => rmSync(file('treinamentos/' + x), { force: true })); return send(200, []);
  }
  if (p.startsWith('/object/') && req.method === 'POST') {
    const f = file(p.slice('/object/'.length)); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, await body(req)); return send(200, {});
  }
  send(404, { message: 'rota não imitada: ' + req.method + ' ' + p });
}).listen(STORAGE, '127.0.0.1');

// Servidor do site: arquivos estáticos + funções reais de api/ (com as respostas da Vercel imitadas)
const load = (p) => import(join(root, 'api', p + '.js')).then((m) => m.default);
createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const route = u.pathname.startsWith('/api/') ? u.pathname.slice(5) : null;
  if (route) {
    if (!['aluno', 'upload', 'admin'].includes(route)) { res.writeHead(404); return res.end(); }
    req.query = Object.fromEntries(u.searchParams);
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (o) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(o)); };
    res.send = (s) => res.end(s);
    res.redirect = (c, url) => { res.writeHead(c, { Location: url }); res.end(); };
    return (await load(route))(req, res);
  }
  const f = join(root, normalize(u.pathname === '/' ? 'index.html' : decodeURIComponent(u.pathname)));
  if (!f.startsWith(root + '/') || /\/(scripts|supabase|\.local|api|node_modules)\//.test(f.slice(root.length)) || !existsSync(f) || !statSync(f).isFile()) { res.writeHead(404); return res.end('404'); }
  res.writeHead(200, { 'Content-Type': MIME[extname(f)] || 'application/octet-stream' });
  createReadStream(f).pipe(res);
}).listen(PORT, '127.0.0.1', () => console.log(`http://localhost:${PORT}  (painel: /admin.html · senha: ${process.env.ADMIN_PASSWORD})`));
