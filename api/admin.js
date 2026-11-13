import { DOMAIN, allowedEmail, normEmail, sendLinkEmail, smtpDiagnose } from './_auth.js';
import { clean, freeSlug, pool, getLesson, getModule, getTraining, intOrNull, isAdmin, isOwnFile, isUuid, listTrainings, q, readJson, removeFiles, slugify, storagePath } from './_lib.js';

const isHttp = (u) => typeof u === 'string' && /^https?:\/\/\S+$/i.test(u) && u.length <= 1000;

function trainingFields(it) {
  return {
    title: clean(it.title, 140),
    description: clean(it.description, 1200),
    product: clean(it.product, 120),
    area: clean(it.area, 60),
    manufacturer: clean(it.manufacturer, 60),
    coverUrl: isOwnFile(it.coverUrl, 'capas') ? it.coverUrl : null,
    published: it.published !== false,
    sortOrder: intOrNull(it.sortOrder),
  };
}

// Valida o quiz montado no painel: 1–100 perguntas, 2–8 alternativas, uma correta
function cleanQuiz(quiz) {
  const qs = Array.isArray(quiz?.questions) ? quiz.questions : [];
  if (!qs.length) throw new Error('Adicione pelo menos uma pergunta.');
  if (qs.length > 100) throw new Error('Máximo de 100 perguntas por quiz.');
  return {
    questions: qs.map((x, i) => {
      const text = clean(x.text, 1000);
      // alternativas vazias são descartadas; o índice da correta acompanha a nova posição
      const raw = (Array.isArray(x.options) ? x.options : []).map((o) => clean(o, 400));
      const options = raw.filter(Boolean);
      const ci = x.correct == null || x.correct === '' ? NaN : Number(x.correct);
      const correct = Number.isInteger(ci) && raw[ci] ? raw.slice(0, ci).filter(Boolean).length : NaN;
      if (!text) throw new Error(`Pergunta ${i + 1}: escreva o enunciado.`);
      if (options.length < 2 || options.length > 8) throw new Error(`Pergunta ${i + 1}: use de 2 a 8 alternativas.`);
      if (!Number.isInteger(correct) || correct < 0 || correct >= options.length) throw new Error(`Pergunta ${i + 1}: marque a alternativa correta.`);
      return { text, options, correct, explanation: clean(x.explanation, 1000) };
    }),
  };
}

function lessonFields(it) {
  const kind = ['video', 'apresentacao', 'quiz'].includes(it.kind) ? it.kind : null;
  if (!kind) throw new Error('Tipo de aula inválido.');
  const f = {
    kind,
    title: clean(it.title, 140),
    description: clean(it.description, 1200),
    mediaUrl: null, fileName: '', size: 0,
    durationMin: intOrNull(it.durationMin),
    quiz: null,
    passScore: Math.min(100, Math.max(0, intOrNull(it.passScore) ?? 70)),
  };
  if (!f.title) throw new Error('Informe o título da aula.');
  if (kind === 'quiz') f.quiz = cleanQuiz(it.quiz);
  else {
    const folder = kind === 'video' ? 'videos' : 'apresentacoes';
    if (storagePath(it.mediaUrl)) {
      if (!isOwnFile(it.mediaUrl, folder)) throw new Error('Arquivo inválido para este tipo de aula.');
      Object.assign(f, { mediaUrl: it.mediaUrl, fileName: clean(it.fileName, 200), size: Number(it.size) || 0 });
    } else if (isHttp(it.mediaUrl)) f.mediaUrl = it.mediaUrl.trim();
    else throw new Error(kind === 'video' ? 'Envie o vídeo ou cole o link (YouTube, Vimeo, Drive…).' : 'Envie a apresentação (PPTX ou PDF) ou cole um link.');
  }
  return f;
}

async function results() {
  const progresso = await q(`
    select p.id as "participanteId", p.name, p.email, p.area, p.last_seen as "lastSeen",
           t.id as "treinamentoId", t.title as treinamento,
           count(a.id)::int as total,
           count(c.aula_id)::int as concluidas,
           max(c.done_at) as "ultimaConclusao"
      from public.participantes p
      cross join public.treinamentos t
      join public.aulas a on a.treinamento_id = t.id
      left join public.conclusoes c on c.aula_id = a.id and c.participante_id = p.id
     group by p.id, t.id
    having count(c.aula_id) > 0 or exists (select 1 from public.tentativas x join public.aulas y on y.id = x.aula_id where x.participante_id = p.id and y.treinamento_id = t.id)
     order by max(c.done_at) desc nulls last, p.name`);
  const tentativas = await q(`
    select x.id, p.id as "participanteId", p.name, p.email, p.area, t.title as treinamento, a.title as quiz,
           x.score, x.correct, x.total, x.passed, x.created_at as "createdAt"
      from public.tentativas x
      join public.participantes p on p.id = x.participante_id
      join public.aulas a on a.id = x.aula_id
      join public.treinamentos t on t.id = a.treinamento_id
     order by x.created_at desc limit 5000`);
  const participantes = await q(`
    select p.id, p.name, p.email, p.area, p.created_at as "createdAt", p.last_seen as "lastSeen",
           p.password_set_at as "senhaEm",
           (select count(*)::int from public.conclusoes c where c.participante_id = p.id) as concluidas,
           (select count(*)::int from public.tentativas x where x.participante_id = p.id) as tentativas
      from public.participantes p order by p.last_seen desc`);
  return { progresso, tentativas, participantes };
}

// Módulo onde a aula vai entrar: o informado (se for do mesmo treinamento) ou o primeiro; cria "Módulo 1" se não houver nenhum
async function resolveModule(treinamentoId, moduloId) {
  if (isUuid(moduloId)) {
    const m = await getModule(moduloId);
    if (m && m.treinamentoId === treinamentoId) return m;
    throw Object.assign(new Error('Módulo inválido.'), { status: 400 });
  }
  const [first] = await q(`select id from public.modulos where treinamento_id = $1 order by sort_order, created_at limit 1`, [treinamentoId]);
  if (first) return first;
  return (await q(`insert into public.modulos (treinamento_id, title, sort_order) values ($1, 'Módulo 1', 10) returning id`, [treinamentoId]))[0];
}
const moduleFields = (it) => ({ title: clean(it.title, 140), description: clean(it.description, 1200) });

async function insertLesson(db, treinamentoId, moduloId, l, order) {
  await db.query(`insert into public.aulas (treinamento_id, modulo_id, kind, title, description, media_url, file_name, size, duration_min, quiz, pass_score, sort_order)
                  values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [treinamentoId, moduloId, l.kind, l.title, l.description, l.mediaUrl, l.fileName, l.size, l.durationMin, l.quiz && JSON.stringify(l.quiz), l.passScore, order]);
}
async function inTransaction(fn) {
  const c = await pool.connect();
  try { await c.query('begin'); const r = await fn(c); await c.query('commit'); return r; }
  catch (e) { await c.query('rollback').catch(() => {}); throw e; }
  finally { c.release(); }
}

const nextOrder = (table, where = '', params = []) =>
  q(`select coalesce(max(sort_order), 0) + 10 as n from public.${table} ${where}`, params).then((r) => r[0].n);

// Ações do painel (todas exigem a senha de administrador)
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  try {
    const { password, action, item = {} } = await readJson(req);
    if (!isAdmin(password)) return res.status(401).json({ error: 'Senha incorreta.' });

    if (action === 'resultados') return res.status(200).json(await results());

    if (action === 'saveTraining') {
      const f = trainingFields(item);
      if (!f.title) return res.status(400).json({ error: 'Informe o título do treinamento.' });
      if (item.id) {
        const old = isUuid(item.id) && await getTraining(item.id);
        if (!old) return res.status(404).json({ error: 'Treinamento não encontrado.' });
        await q(`update public.treinamentos set title=$2, description=$3, product=$4, area=$5, manufacturer=$6, cover_url=$7, published=$8,
                   sort_order=coalesce($9, sort_order), updated_at=now() where id=$1`,
          [old.id, f.title, f.description, f.product, f.area, f.manufacturer, f.coverUrl, f.published, f.sortOrder]);
        if (old.coverUrl && old.coverUrl !== f.coverUrl) await removeFiles([old.coverUrl]);
      } else {
        await q(`insert into public.treinamentos (slug, title, description, product, area, manufacturer, cover_url, published, sort_order)
                 values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [await freeSlug(slugify(f.title)), f.title, f.description, f.product, f.area, f.manufacturer, f.coverUrl, f.published,
            f.sortOrder ?? await nextOrder('treinamentos')]);
      }
    } else if (action === 'createFull') {
      // treinamento novo com módulos e aulas, tudo ou nada. item.modulos = [{ title, lessons: [...] }]
      const f = trainingFields(item);
      if (!f.title) return res.status(400).json({ error: 'Informe o título do treinamento.' });
      const rawMods = Array.isArray(item.modulos) ? item.modulos : [{ title: 'Módulo 1', lessons: item.lessons }];
      let mods;
      try {
        mods = rawMods.slice(0, 30).map((m, i) => ({ ...moduleFields(m), title: clean(m.title, 140) || `Módulo ${i + 1}`,
          lessons: (Array.isArray(m.lessons) ? m.lessons : []).slice(0, 100).map(lessonFields) }));
      } catch (e) { return res.status(400).json({ error: e.message }); }
      if (!mods.length) mods = [{ title: 'Módulo 1', description: '', lessons: [] }];
      const slug = await freeSlug(slugify(f.title)), order = f.sortOrder ?? await nextOrder('treinamentos');
      const createdId = await inTransaction(async (c) => {
        const id = (await c.query(`insert into public.treinamentos (slug, title, description, product, area, manufacturer, cover_url, published, sort_order)
                 values ($1,$2,$3,$4,$5,$6,null,$7,$8) returning id`,
          [slug, f.title, f.description, f.product, f.area, f.manufacturer, f.published, order])).rows[0].id;
        for (let i = 0; i < mods.length; i++) {
          const mid = (await c.query(`insert into public.modulos (treinamento_id, title, description, sort_order) values ($1,$2,$3,$4) returning id`,
            [id, mods[i].title, mods[i].description, (i + 1) * 10])).rows[0].id;
          for (let j = 0; j < mods[i].lessons.length; j++) await insertLesson(c, id, mid, mods[i].lessons[j], (j + 1) * 10);
        }
        return id;
      });
      return res.status(200).json({ treinamentos: await listTrainings(), createdId });
    } else if (action === 'saveModule') {
      const f = moduleFields(item);
      if (!f.title) return res.status(400).json({ error: 'Informe o nome do módulo.' });
      if (item.id) {
        const old = isUuid(item.id) && await getModule(item.id);
        if (!old) return res.status(404).json({ error: 'Módulo não encontrado.' });
        await q(`update public.modulos set title = $2, description = $3 where id = $1`, [old.id, f.title, f.description]);
      } else {
        const t = isUuid(item.treinamentoId) && await getTraining(item.treinamentoId);
        if (!t) return res.status(404).json({ error: 'Treinamento não encontrado.' });
        await q(`insert into public.modulos (treinamento_id, title, description, sort_order) values ($1,$2,$3,$4)`,
          [t.id, f.title, f.description, await nextOrder('modulos', 'where treinamento_id = $1', [t.id])]);
      }
    } else if (action === 'deleteModule') {
      const old = isUuid(item.id) && await getModule(item.id);
      if (!old) return res.status(404).json({ error: 'Módulo não encontrado.' });
      const files = (await q(`select media_url from public.aulas where modulo_id = $1`, [old.id])).map((r) => r.media_url);
      await q(`delete from public.modulos where id = $1`, [old.id]); // as aulas do módulo saem junto (cascade)
      await removeFiles(files);
    } else if (action === 'addLessons') {
      // várias aulas de uma vez no mesmo módulo (envio de vários arquivos)
      const t = isUuid(item.treinamentoId) && await getTraining(item.treinamentoId);
      if (!t) return res.status(404).json({ error: 'Treinamento não encontrado.' });
      let lessons;
      try { lessons = (Array.isArray(item.lessons) ? item.lessons : []).slice(0, 100).map(lessonFields); }
      catch (e) { return res.status(400).json({ error: e.message }); }
      if (!lessons.length) return res.status(400).json({ error: 'Nenhuma aula para adicionar.' });
      const m = await resolveModule(t.id, item.moduloId);
      const start = await nextOrder('aulas', 'where modulo_id = $1', [m.id]);
      await inTransaction(async (c) => { for (let i = 0; i < lessons.length; i++) await insertLesson(c, t.id, m.id, lessons[i], start + i * 10); });
    } else if (action === 'deleteTraining') {
      const old = isUuid(item.id) && (await listTrainings()).find((t) => t.id === item.id);
      if (!old) return res.status(404).json({ error: 'Treinamento não encontrado.' });
      await q(`delete from public.treinamentos where id = $1`, [old.id]);
      await removeFiles([old.coverUrl, ...old.aulas.map((a) => a.mediaUrl)]);
    } else if (action === 'saveLesson') {
      let f;
      try { f = lessonFields(item); } catch (e) { return res.status(400).json({ error: e.message }); }
      if (item.id) {
        const old = isUuid(item.id) && await getLesson(item.id);
        if (!old) return res.status(404).json({ error: 'Aula não encontrada.' });
        // trocar de módulo: vai para o fim do módulo novo
        const m = item.moduloId && item.moduloId !== old.moduloId ? await resolveModule(old.treinamentoId, item.moduloId) : null;
        await q(`update public.aulas set kind=$2, title=$3, description=$4, media_url=$5, file_name=$6, size=$7, duration_min=$8, quiz=$9,
                   pass_score=$10, updated_at=now() where id=$1`,
          [old.id, f.kind, f.title, f.description, f.mediaUrl, f.fileName, f.size, f.durationMin, f.quiz && JSON.stringify(f.quiz), f.passScore]);
        if (m) await q(`update public.aulas set modulo_id = $2, sort_order = $3 where id = $1`, [old.id, m.id, await nextOrder('aulas', 'where modulo_id = $1', [m.id])]);
        if (old.mediaUrl && old.mediaUrl !== f.mediaUrl) await removeFiles([old.mediaUrl]);
      } else {
        const t = isUuid(item.treinamentoId) && await getTraining(item.treinamentoId);
        if (!t) return res.status(404).json({ error: 'Treinamento não encontrado.' });
        const m = await resolveModule(t.id, item.moduloId);
        await insertLesson(pool, t.id, m.id, f, await nextOrder('aulas', 'where modulo_id = $1', [m.id]));
      }
    } else if (action === 'deleteLesson') {
      const old = isUuid(item.id) && await getLesson(item.id);
      if (!old) return res.status(404).json({ error: 'Aula não encontrada.' });
      await q(`delete from public.aulas where id = $1`, [old.id]);
      await removeFiles([old.mediaUrl]);
    } else if (action === 'reorder') {
      // item.ids = ids na nova ordem; item.table = 'aulas' (padrão), 'modulos' ou 'treinamentos'
      const table = ['treinamentos', 'modulos'].includes(item.table) ? item.table : 'aulas';
      const ids = (Array.isArray(item.ids) ? item.ids : []).filter(isUuid);
      for (let i = 0; i < ids.length; i++) await q(`update public.${table} set sort_order = $2 where id = $1`, [ids[i], (i + 1) * 10]);
    } else if (action === 'convidar' || action === 'reenviar') {
      // envia o link de criar senha; "convidar" cadastra a pessoa se ainda não existir
      let p;
      if (action === 'reenviar') {
        if (!isUuid(item.id)) return res.status(400).json({ error: 'Participante inválido.' });
        [p] = await q(`select id, name, email, password_hash is not null as "hasPassword" from public.participantes where id = $1`, [item.id]);
        if (!p) return res.status(404).json({ error: 'Participante não encontrado.' });
      } else {
        const email = normEmail(item.email), name = clean(item.name, 120);
        if (!allowedEmail(email)) return res.status(400).json({ error: `O e-mail precisa ser @${DOMAIN}.` });
        if (name.split(/\s+/).length < 2) return res.status(400).json({ error: 'Informe nome e sobrenome.' });
        [p] = await q(`insert into public.participantes (name, email) values ($1, $2)
                       on conflict (lower(email)) do update set name = case when participantes.password_hash is null then excluded.name else participantes.name end
                       returning id, name, email, password_hash is not null as "hasPassword"`, [name, email]);
      }
      const extra = await sendLinkEmail(req, p, p.hasPassword ? 'redefinir' : 'primeiro');
      return res.status(200).json({ ...(await results()), sentTo: p.email, ...extra });
    } else if (action === 'smtpTest') {
      return res.status(200).json(await smtpDiagnose());
    } else if (action === 'deleteParticipant') {
      if (!isUuid(item.id)) return res.status(400).json({ error: 'Participante inválido.' });
      await q(`delete from public.participantes where id = $1`, [item.id]);
      return res.status(200).json(await results());
    } else if (action !== 'login') {
      return res.status(400).json({ error: 'Ação inválida.' });
    }

    res.status(200).json({ treinamentos: await listTrainings() });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.status ? e.message + (e.detail ? ` (${String(e.detail).slice(0, 200)})` : '') : 'Erro ao salvar: ' + e.message });
  }
}
