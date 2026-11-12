import { clean, getLesson, isUuid, listTrainings, publicLesson, q, readJson } from './_lib.js';
import {
  DOMAIN, MIN_PASSWORD, allowedEmail, consumeLink, endSession, linkInfo, login, normEmail, sendLinkEmail, sessionParticipant,
} from './_auth.js';

const domainError = () => `Use seu e-mail corporativo @${DOMAIN}.`;

// Treinamentos publicados (sem gabarito) + progresso do participante
async function content(p) {
  const trainings = (await listTrainings({ onlyPublished: true }))
    .map((t) => ({ ...t, aulas: t.aulas.map(publicLesson) }));
  const done = await q(`select aula_id as "aulaId", done_at as "doneAt" from public.conclusoes where participante_id = $1`, [p.id]);
  const attempts = await q(
    `select aula_id as "aulaId", max(score)::int as best, count(*)::int as tries, bool_or(passed) as passed, max(created_at) as "lastAt"
       from public.tentativas where participante_id = $1 group by aula_id`, [p.id]);
  return { participante: p, treinamentos: trainings, conclusoes: done, quizzes: attempts };
}

const fail = (res, status, error, extra = {}) => res.status(status).json({ error, ...extra });

// Área do participante: login com senha, primeiro acesso / esqueci a senha (link por e-mail), conteúdo, aulas e quizzes
export default async function handler(req, res) {
  try {
    if (req.method === 'GET') return res.status(200).json({ domain: DOMAIN, minPassword: MIN_PASSWORD });
    if (req.method !== 'POST') return res.status(405).end();
    const body = await readJson(req);
    const { action } = body;

    if (action === 'login') {
      const email = normEmail(body.email);
      if (!allowedEmail(email)) return fail(res, 400, domainError());
      if (!body.password) return fail(res, 400, 'Informe sua senha.');
      const r = await login(email, String(body.password).slice(0, 200));
      if (!r.ok) return fail(res, 401, r.noPassword
        ? 'Você ainda não criou sua senha. Clique em "Primeiro acesso" para receber o link por e-mail.'
        : 'E-mail ou senha incorretos.');
      const p = await sessionParticipant(r.session);
      return res.status(200).json({ session: r.session, ...(await content(p)) });
    }

    if (action === 'primeiroAcesso' || action === 'esqueci') {
      const email = normEmail(body.email);
      if (!allowedEmail(email)) return fail(res, 400, domainError());
      let [p] = await q(`select id, name, email, password_hash is not null as "hasPassword" from public.participantes where lower(email) = $1`, [email]);
      if (action === 'primeiroAcesso' && !p) {
        const name = clean(body.name, 120);
        if (name.split(/\s+/).length < 2) return fail(res, 400, 'Informe nome e sobrenome.');
        [p] = await q(`insert into public.participantes (name, email) values ($1, $2) returning id, name, email, false as "hasPassword"`, [name, email]);
      } else if (action === 'primeiroAcesso' && !p.hasPassword && clean(body.name, 120)) {
        [p] = await q(`update public.participantes set name = $2 where id = $1 returning id, name, email, false as "hasPassword"`, [p.id, clean(body.name, 120)]);
      }
      // "esqueci" para e-mail sem conta: mesma resposta, sem revelar quem está cadastrado
      const extra = p ? await sendLinkEmail(req, p, p.hasPassword ? 'redefinir' : 'primeiro') : {};
      return res.status(200).json({
        ok: true,
        message: action === 'primeiroAcesso' && !p.hasPassword
          ? `Enviamos um link para ${email}. Abra o e-mail e clique em "Criar minha senha".`
          : `Se houver uma conta com ${email}, enviamos um link para criar uma nova senha.`,
        ...extra,
      });
    }

    if (action === 'link') {
      const info = await linkInfo(body.token);
      return res.status(200).json(info ? { valid: true, purpose: info.purpose, name: info.name, email: info.email } : { valid: false });
    }

    if (action === 'definirSenha') {
      const pw = String(body.password || '');
      if (pw.length < MIN_PASSWORD) return fail(res, 400, `A senha precisa ter pelo menos ${MIN_PASSWORD} caracteres.`);
      if (pw.length > 200) return fail(res, 400, 'Senha longa demais.');
      const r = await consumeLink(body.token, pw);
      if (!r) return fail(res, 400, 'Este link expirou ou já foi usado. Peça um novo em "Primeiro acesso" ou "Esqueci minha senha".', { expired: true });
      const p = await sessionParticipant(r.session);
      return res.status(200).json({ session: r.session, ...(await content(p)) });
    }

    if (action === 'sair') { await endSession(body.session); return res.status(200).json({ ok: true }); }

    const p = await sessionParticipant(body.session);
    if (!p || !allowedEmail(normEmail(p.email))) return fail(res, 401, 'Sua sessão expirou. Entre novamente.', { relogin: true });

    if (action === 'conteudo') return res.status(200).json(await content(p));

    if (action === 'concluir') {
      const a = isUuid(body.aulaId) && await getLesson(body.aulaId);
      if (!a || a.kind === 'quiz') return fail(res, 400, 'Aula inválida.');
      await q(`insert into public.conclusoes (participante_id, aula_id) values ($1, $2) on conflict do nothing`, [p.id, a.id]);
      return res.status(200).json({ ok: true });
    }

    if (action === 'quiz') {
      const a = isUuid(body.aulaId) && await getLesson(body.aulaId);
      if (!a || a.kind !== 'quiz') return fail(res, 400, 'Quiz inválido.');
      const questions = a.quiz?.questions || [];
      const answers = Array.isArray(body.answers) ? body.answers : [];
      if (!questions.length) return fail(res, 400, 'Este quiz ainda não tem perguntas.');
      if (answers.length !== questions.length || answers.some((x, i) => !Number.isInteger(x) || x < 0 || x >= questions[i].options.length)) {
        return fail(res, 400, 'Responda todas as perguntas.');
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

    fail(res, 400, 'Ação inválida.');
  } catch (e) {
    res.status(e.status || 500).json({ error: e.status ? e.message : 'Erro no servidor: ' + e.message });
  }
}
