import pg from 'pg';
import { timingSafeEqual } from 'node:crypto';

// Dados no Postgres do Supabase (via pooler); vídeos, apresentações e capas no Storage do Supabase
export const pool = globalThis.__treinamentosPool ||= new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'off' ? false : { rejectUnauthorized: false },
  max: 3,
});
export const q = (sql, params) => pool.query(sql, params).then((r) => r.rows);

const T_COLS = `id, slug, title, description, product, area, manufacturer, cover_url as "coverUrl", published,
  sort_order as "sortOrder", updated_at as "updatedAt"`;
// colunas da aula com o prefixo da tabela (a listagem junta com "modulos")
const aCols = (x) => `${x}.id, ${x}.treinamento_id as "treinamentoId", ${x}.modulo_id as "moduloId", ${x}.kind, ${x}.title, ${x}.description,
  ${x}.media_url as "mediaUrl", ${x}.file_name as "fileName", ${x}.size::int, ${x}.duration_min as "durationMin", ${x}.quiz,
  ${x}.pass_score as "passScore", ${x}.sort_order as "sortOrder", ${x}.updated_at as "updatedAt"`;
const A_COLS = aCols('aulas');
const M_COLS = `id, treinamento_id as "treinamentoId", title, description, sort_order as "sortOrder"`;

// Treinamentos com módulos e aulas. "aulas" já vem na ordem final (módulo a módulo), para numerar e seguir para a próxima.
export async function listTrainings({ onlyPublished = false } = {}) {
  const ts = await q(`select ${T_COLS} from public.treinamentos ${onlyPublished ? 'where published' : ''} order by sort_order, title`);
  const ms = await q(`select ${M_COLS} from public.modulos order by sort_order, created_at`);
  const as = await q(`select ${aCols('a')} from public.aulas a left join public.modulos m on m.id = a.modulo_id
    order by coalesce(m.sort_order, -1), m.created_at, a.sort_order, a.created_at`);
  const byT = new Map(ts.map((t) => [t.id, { ...t, modulos: [], aulas: [] }]));
  ms.forEach((m) => byT.get(m.treinamentoId)?.modulos.push(m));
  as.forEach((a) => byT.get(a.treinamentoId)?.aulas.push(a));
  return [...byT.values()];
}

export const getTraining = (id) => q(`select ${T_COLS} from public.treinamentos where id = $1`, [id]).then((r) => r[0] || null);
export const getModule = (id) => q(`select ${M_COLS} from public.modulos where id = $1`, [id]).then((r) => r[0] || null);
export const getLesson = (id) => q(`select ${A_COLS} from public.aulas where id = $1`, [id]).then((r) => r[0] || null);

// Versão do quiz para o participante: sem a alternativa correta nem a explicação
export function publicLesson(a) {
  if (a.kind !== 'quiz') return a;
  const questions = (a.quiz?.questions || []).map((x) => ({ text: x.text, options: x.options }));
  return { ...a, quiz: { questions } };
}

export const slugify = (s, fallback = 'treinamento') => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/\.[a-z0-9]{2,5}$/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 70) || fallback;

export async function freeSlug(base) {
  const used = new Set((await q(`select slug from public.treinamentos where slug = $1 or slug like $2`, [base, `${base}-%`])).map((r) => r.slug));
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) if (!used.has(`${base}-${n}`)) return `${base}-${n}`;
}

export const isUuid = (s) => typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

// ---------- Storage ----------
export const BUCKET = 'treinamentos';
const SUPABASE_URL = () => (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const storageHeaders = () => ({ apikey: process.env.SUPABASE_SECRET_KEY, Authorization: `Bearer ${process.env.SUPABASE_SECRET_KEY}` });
const PUBLIC_PREFIX = () => `${SUPABASE_URL()}/storage/v1/object/public/${BUCKET}/`;

export const publicUrl = (path) => PUBLIC_PREFIX() + path.split('/').map(encodeURIComponent).join('/');

// Caminho dentro do bucket a partir da URL pública (só arquivos que o próprio app gerou)
export function storagePath(url) {
  if (typeof url !== 'string' || !url.startsWith(PUBLIC_PREFIX())) return null;
  const path = decodeURIComponent(url.slice(PUBLIC_PREFIX().length));
  return /^(videos|apresentacoes|capas)\/[a-z0-9-]+\.(mp4|webm|mov|pdf|pptx|ppt|jpg)$/.test(path) ? path : null;
}
export const isOwnFile = (url, folder) => (storagePath(url) || '').startsWith(folder + '/');

export async function signUpload(path) {
  const r = await fetch(`${SUPABASE_URL()}/storage/v1/object/upload/sign/${BUCKET}/${path}`, { method: 'POST', headers: storageHeaders() });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.message || `storage ${r.status}`);
  return `${SUPABASE_URL()}/storage/v1${d.url}`;
}

export async function removeFiles(urls) {
  const prefixes = [...new Set(urls.map(storagePath).filter(Boolean))];
  if (!prefixes.length) return;
  await fetch(`${SUPABASE_URL()}/storage/v1/object/${BUCKET}`, {
    method: 'DELETE',
    headers: { ...storageHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ prefixes }),
  }).catch(() => {});
}

// ---------- Utilidades ----------
function safeEqual(given, expected) {
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(String(expected || ''));
  return b.length > 0 && a.length === b.length && timingSafeEqual(a, b);
}
export const isAdmin = (password) => safeEqual(password, process.env.ADMIN_PASSWORD);
export const clean = (s, max) => String(s ?? '').trim().slice(0, max);
export const intOrNull = (v) => (v === '' || v == null || !Number.isFinite(Number(v)) ? null : Math.trunc(Number(v)));

export async function readJson(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString() || '{}');
}
