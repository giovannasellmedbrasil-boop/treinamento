import { createHash, randomBytes, scrypt as _scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { q } from './_lib.js';

const scrypt = promisify(_scrypt);
export const DOMAIN = (process.env.ALLOWED_DOMAIN || 'sellmedbrasil.com').toLowerCase().replace(/^@/, '');
export const MIN_PASSWORD = 8;
const SESSION_DAYS = 30;
const LINK_HOURS = 24;
const MAX_LINKS_PER_HOUR = 3;
const MAX_FAILS = 8, LOCK_MIN = 15;

export const normEmail = (s) => String(s || '').trim().toLowerCase().slice(0, 160);
export const allowedEmail = (e) => new RegExp(`^[^\\s@]+@${DOMAIN.replace(/\./g, '\\.')}$`).test(e);
const sha = (s) => createHash('sha256').update(String(s)).digest('hex');
const newToken = () => randomBytes(32).toString('base64url');

// ---------- Senhas (scrypt com sal) ----------
export async function hashPassword(pw) {
  const salt = randomBytes(16);
  const key = await scrypt(String(pw), salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}
export async function checkPassword(pw, stored) {
  const [alg, salt, hash] = String(stored || '').split('$');
  if (alg !== 'scrypt' || !salt || !hash) return false;
  const want = Buffer.from(hash, 'base64');
  const got = await scrypt(String(pw), Buffer.from(salt, 'base64'), want.length, { N: 16384, r: 8, p: 1 });
  return timingSafeEqual(got, want);
}

// ---------- Sessões ----------
export async function createSession(pid) {
  const token = newToken();
  await q(`insert into public.sessoes (token_hash, participante_id, expires_at) values ($1, $2, now() + interval '${SESSION_DAYS} days')`, [sha(token), pid]);
  await q(`delete from public.sessoes where expires_at < now()`);
  return token;
}
export async function sessionParticipant(token) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 100) return null;
  const r = await q(`
    update public.participantes p set last_seen = now()
      from public.sessoes s
     where s.token_hash = $1 and s.expires_at > now() and p.id = s.participante_id
     returning p.id, p.name, p.email, p.area`, [sha(token)]);
  return r[0] || null;
}
export const endSession = (token) => q(`delete from public.sessoes where token_hash = $1`, [sha(token || '')]);

// ---------- Links por e-mail ----------
// Devolve o token em texto (só vai no e-mail) ou lança erro se passou do limite de envios
export async function createLinkToken(pid, purpose) {
  const [{ n }] = await q(`select count(*)::int n from public.auth_tokens where participante_id = $1 and created_at > now() - interval '1 hour'`, [pid]);
  if (n >= MAX_LINKS_PER_HOUR) throw Object.assign(new Error('Muitos pedidos seguidos. Aguarde alguns minutos e use o último e-mail recebido.'), { status: 429 });
  const token = newToken();
  await q(`insert into public.auth_tokens (token_hash, participante_id, purpose, expires_at) values ($1, $2, $3, now() + interval '${LINK_HOURS} hours')`, [sha(token), pid, purpose]);
  return token;
}
export async function linkInfo(token) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 100) return null;
  const r = await q(`
    select t.purpose, t.participante_id as pid, p.name, p.email
      from public.auth_tokens t join public.participantes p on p.id = t.participante_id
     where t.token_hash = $1 and t.used_at is null and t.expires_at > now()`, [sha(token)]);
  return r[0] || null;
}
// Usa o link: grava a senha, invalida outros links e sessões antigas, abre uma sessão nova
export async function consumeLink(token, password) {
  const info = await linkInfo(token);
  if (!info) return null;
  const used = await q(`update public.auth_tokens set used_at = now() where token_hash = $1 and used_at is null returning 1`, [sha(token)]);
  if (!used.length) return null;
  await q(`update public.participantes set password_hash = $2, password_set_at = now(), failed_logins = 0, locked_until = null where id = $1`,
    [info.pid, await hashPassword(password)]);
  await q(`update public.auth_tokens set used_at = now() where participante_id = $1 and used_at is null`, [info.pid]);
  await q(`delete from public.sessoes where participante_id = $1`, [info.pid]);
  return { pid: info.pid, session: await createSession(info.pid) };
}

// ---------- Login ----------
export async function login(email, password) {
  const [p] = await q(`select id, password_hash, locked_until from public.participantes where lower(email) = $1`, [email]);
  if (p?.locked_until && new Date(p.locked_until) > new Date()) {
    throw Object.assign(new Error(`Muitas tentativas. Tente de novo em ${LOCK_MIN} minutos ou use "Esqueci minha senha".`), { status: 429 });
  }
  const ok = p?.password_hash ? await checkPassword(password, p.password_hash) : (await hashPassword('x'), false); // tempo parecido com ou sem conta
  if (!ok) {
    // a cada MAX_FAILS erros seguidos, bloqueia por LOCK_MIN minutos
    if (p) await q(`update public.participantes set failed_logins = case when failed_logins + 1 >= ${MAX_FAILS} then 0 else failed_logins + 1 end,
                      locked_until = case when failed_logins + 1 >= ${MAX_FAILS} then now() + interval '${LOCK_MIN} minutes' else null end
                    where id = $1`, [p.id]);
    return { ok: false, noPassword: !!p && !p.password_hash };
  }
  await q(`update public.participantes set failed_logins = 0, locked_until = null where id = $1`, [p.id]);
  return { ok: true, pid: p.id, session: await createSession(p.id) };
}

// ---------- Envio de e-mail ----------
// Sem SMTP configurado: em produção dá erro claro; no servidor local (DEV_EMAIL_LINKS=1) o link aparece no terminal.
export const mailConfigured = () => !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);

const smtpPorts = () => {
  const first = Number(process.env.SMTP_PORT) || 587;
  return [first, ...[465, 587].filter((x) => x !== first)]; // a configurada primeiro; a outra como reserva
};
const transport = (nodemailer, port) => nodemailer.createTransport({
  host: process.env.SMTP_HOST, port, secure: port === 465,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 30000,
});
// Erros em que vale tentar a outra porta (servidor não ofereceu login, conexão recusada ou demorou)
const retryable = (e) => /not advertised|AUTH is required|ECONNREFUSED|ETIMEDOUT|ESOCKET|ECONNECTION|Greeting never received/i.test(`${e.code} ${e.message} ${e.response || ''}`);

export async function sendMail({ to, subject, html, text }) {
  if (!mailConfigured()) {
    if (process.env.DEV_EMAIL_LINKS === '1') { console.log(`\n[e-mail simulado] para ${to}: ${subject}\n${text}\n`); return; }
    throw Object.assign(new Error('O envio de e-mails da plataforma ainda não foi configurado. Avise o administrador.'), { status: 503 });
  }
  const { default: nodemailer } = await import('nodemailer');
  const from = process.env.SMTP_FROM || `Treinamentos Sellmed <${process.env.SMTP_USER}>`;
  let lastErr;
  for (const port of smtpPorts()) {
    try { await transport(nodemailer, port).sendMail({ from, to, subject, html, text }); return { port }; }
    catch (e) { lastErr = e; console.error(`SMTP porta ${port}:`, e.code || '', e.response || e.message); if (!retryable(e)) break; }
  }
  throw Object.assign(new Error('Não foi possível enviar o e-mail agora. Tente de novo em alguns minutos ou avise o administrador.'), { status: 502, detail: lastErr?.response || lastErr?.message });
}

// Diagnóstico para o painel: em cada porta, conecta e mostra se o servidor oferece login (não envia nada)
export async function smtpDiagnose() {
  if (!mailConfigured()) return { configured: false };
  const { default: SMTPConnection } = await import('nodemailer/lib/smtp-connection/index.js');
  const out = [];
  for (const port of smtpPorts()) {
    const c = new SMTPConnection({ host: process.env.SMTP_HOST, port, secure: port === 465, connectionTimeout: 12000, greetingTimeout: 12000, socketTimeout: 15000 });
    const r = { port };
    try {
      await new Promise((ok, fail) => { c.once('error', fail); c.connect(ok); });
      r.banner = String(c._greeting || c.lastServerResponse || '').slice(0, 120);
      r.offersAuth = c.allowsAuth; r.authMethods = c._supportedAuth;
      if (c.allowsAuth) {
        await new Promise((ok, fail) => c.login({ user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }, (e) => e ? fail(e) : ok()));
        r.login = 'ok';
      }
    } catch (e) { r.error = `${e.code || ''} ${e.response || e.message}`.trim().slice(0, 200); }
    try { c.quit(); } catch {}
    out.push(r);
  }
  return { configured: true, host: process.env.SMTP_HOST, user: process.env.SMTP_USER, ports: out };
}

// Cria o link de uso único e manda por e-mail; se o envio falhar, o link é descartado (não gasta o limite por hora)
export async function sendLinkEmail(req, p, purpose) {
  const token = await createLinkToken(p.id, purpose);
  const base = appUrl(req), link = `${base}/#/senha/${token}`;
  try { await sendMail({ to: p.email, ...linkEmail({ name: p.name, link, purpose, base }) }); }
  catch (e) { await q(`delete from public.auth_tokens where token_hash = $1`, [sha(token)]); throw e; }
  return process.env.DEV_EMAIL_LINKS === '1' ? { devLink: link } : {};
}

export function appUrl(req) {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/$/, '');
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const proto = req.headers['x-forwarded-proto'] || (/^(localhost|127\.)/.test(host) ? 'http' : 'https');
  return `${proto}://${host}`;
}

const escH = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function linkEmail({ name, link, purpose, base }) {
  const first = purpose === 'primeiro';
  const title = first ? 'Crie sua senha de acesso' : 'Redefina sua senha';
  const intro = first
    ? 'Recebemos seu pedido de acesso à Plataforma de Treinamentos da Sellmed Brasil. Clique no botão abaixo para criar a sua senha.'
    : 'Recebemos um pedido para redefinir a sua senha da Plataforma de Treinamentos da Sellmed Brasil. Clique no botão abaixo para criar uma nova senha.';
  const hi = name ? `Olá, ${escH(name.split(/\s+/)[0])}!` : 'Olá!';
  const html = `<!doctype html><html lang="pt-BR"><body style="margin:0;background:#F2F5F7;font-family:Arial,Helvetica,sans-serif;color:#1D2939">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F2F5F7;padding:28px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #E2E8EC">
<tr><td style="height:6px;background:#1EA4A8;background-image:linear-gradient(90deg,#0C2F79,#1EA4A8,#73CC6E)"></td></tr>
<tr><td style="padding:26px 32px 6px"><img src="${base}/assets/logo-email.png" width="120" alt="Sellmed Brasil" style="display:block;border:0"></td></tr>
<tr><td style="padding:10px 32px 0"><p style="margin:0;font-size:12px;font-weight:bold;letter-spacing:1.2px;color:#1EA4A8;text-transform:uppercase">Plataforma de Treinamentos</p>
<h1 style="margin:8px 0 14px;font-size:22px;color:#0C2F79">${title}</h1>
<p style="margin:0 0 6px;font-size:15px;line-height:1.55">${hi}</p>
<p style="margin:0 0 22px;font-size:15px;line-height:1.55;color:#5B6772">${intro}</p>
<a href="${escH(link)}" style="display:inline-block;background:#0C2F79;color:#ffffff;text-decoration:none;font-weight:bold;font-size:15px;padding:13px 26px;border-radius:8px">${first ? 'Criar minha senha' : 'Redefinir senha'}</a>
<p style="margin:22px 0 0;font-size:13px;line-height:1.5;color:#858683">O link vale por ${LINK_HOURS} horas e só pode ser usado uma vez. Se você não fez este pedido, ignore este e-mail: sua conta continua como está.</p>
<p style="margin:14px 0 0;font-size:12px;line-height:1.5;color:#858683;word-break:break-all">Se o botão não abrir, copie e cole no navegador:<br>${escH(link)}</p></td></tr>
<tr><td style="padding:24px 32px 26px"><p style="margin:0;border-top:1px solid #E2E8EC;padding-top:14px;font-size:12px;color:#858683">Sellmed Brasil · Produtos que salvam vidas</p></td></tr>
</table></td></tr></table></body></html>`;
  const text = `${hi}\n\n${intro}\n\n${link}\n\nO link vale por ${LINK_HOURS} horas e só pode ser usado uma vez. Se você não fez este pedido, ignore este e-mail.\n\nSellmed Brasil · Plataforma de Treinamentos`;
  return { subject: `${title} · Treinamentos Sellmed`, html, text };
}
