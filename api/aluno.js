import { accessCodeOk, accessCodeRequired, clean, getLesson, isUuid, listTrainings, publicLesson, q, readJson } from './_lib.js';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function participant(pid) {
  if (!isUuid(pid)) return null;
  const r = await q(`update public.participantes set last_seen = now() where id = $1 returning id, name, email, area`, [pid]);
  return r[0] || null;
}

// Treinamentos publicados (sem gabarito) + progresso do participante
async function content(p) {
  const trainings = (await listTrainings({ onlyPublished: true }))
    .map((t) => ({ ...t, aulas: t.aulas.map(publicLesson) }));
  const done = (await q(`select aula_id as "aulaId", done_at as "doneAt" from public.conclusoes where participante_id = $1`, [p.id]));
  const attempts = await q(
    `select aula_id as "aulaId", max(score)::int as best, count(*)::int as tries, bool_or(passed) as passed, max(created_at) as "lastAt"
       from public.tentativas where participante_id = $1 group by aula_id`, [p.id]);
  return { participante: p, treinamentos: trainings, conclusoes: done, quizzes: attempts };
}

// Área do participante: entrar (nome + e-mail), carregar conteúdo, concluir aula, responder quiz
export default async function handler(req, res) {
  try {
    if (req.method === 'GET') return res.status(200).json({ requiresCode: accessCodeRequired() });
    if (req.method !== 'POST') return res.status(405).end();
    const body = await readJson(req);
    const { action } = body;

    if (action === 'entrar') {
      const name = clean(body.name, 120), email = clean(body.email, 160).toLowerCase(), area = clean(body.area, 80);
      if (!accessCodeOk(body.code)) return res.status(401).json({ error: 'Código de acesso incorreto.' });
      if (!name) return res.status(400).json({ error: 'Informe seu nome.' });
      if (!EMAIL.test(email)) return res.status(400).json({ error: 'Informe um e-mail válido.' });
      const [p] = await q(
        `insert into public.participantes (name, email, area) values ($1, $2, $3)
         on conflict (lower(email)) do update set name = excluded.name, area = case when excluded.area = '' then participantes.area else excluded.area end, last_seen = now()
         returning id, name, email, area`, [name, email, area]);
      return res.status(200).json(await content(p));
    }

    const p = await participant(body.pid);
    if (!p) return res.status(401).json({ error: 'Sessão expirada. Entre novamente.', relogin: true });

    if (action === 'conteudo') return res.status(200).json(await content(p));

    if (action === 'concluir') {
      const a = isUuid(body.aulaId) && await getLesson(body.aulaId);
      if (!a || a.kind === 'quiz') return res.status(400).json({ error: 'Aula inválida.' });
      await q(`insert into public.conclusoes (participante_id, aula_id) values ($1, $2) on conflict do nothing`, [p.id, a.id]);
      return res.status(200).json({ ok: true });
    }

    if (action === 'quiz') {
      const a = isUuid(body.aulaId) && await getLesson(body.aulaId);
      if (!a || a.kind !== 'quiz') return res.status(400).json({ error: 'Quiz inválido.' });
      const questions = a.quiz?.questions || [];
      const answers = Array.isArray(body.answers) ? body.answers : [];
      if (!questions.length) return res.status(400).json({ error: 'Este quiz ainda não tem perguntas.' });
      if (answers.length !== questions.length || answers.some((x, i) => !Number.isInteger(x) || x < 0 || x >= questions[i].options.length)) {
        return res.status(400).json({ error: 'Responda todas as perguntas.' });
      }
      const review = questions.map((x, i) => ({ correct: x.correct, ok: answers[i] === x.correct, explanation: x.explanation || '' }));
      const correct = review.filter((r) => r.ok).length;
      const score = Math.round((correct / questions.length) * 100);
      const passed = score >= a.passScore;
      await q(`insert into public.tentativas (participante_id, aula_id, score, correct, total, passed, answers) values ($1,$2,$3,$4,$5,$6,$7)`,
        [p.id, a.id, score, correct, questions.length, passed, JSON.stringify(answers)]);
      if (passed) await q(`insert into public.conclusoes (participante_id, aula_id) values ($1, $2) on conflict do nothing`, [p.id, a.id]);
      return res.status(200).json({ score, correct, total: questions.length, passed, passScore: a.passScore, review });
    }

    res.status(400).json({ error: 'Ação inválida.' });
  } catch (e) {
    res.status(500).json({ error: 'Erro no servidor: ' + e.message });
  }
}
