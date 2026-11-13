import { randomBytes } from 'node:crypto';
import { isAdmin, publicUrl, readJson, signUpload, slugify } from './_lib.js';

const MB = 1024 * 1024;
const MAX_UPLOAD = (Number(process.env.MAX_UPLOAD_MB) || 50) * MB;
const TYPES = {
  video: { folder: 'videos', exts: ['mp4', 'webm', 'mov'], max: MAX_UPLOAD },
  apresentacao: { folder: 'apresentacoes', exts: ['pdf', 'pptx', 'ppt', 'docx', 'doc', 'xlsx', 'xls', 'jpg', 'jpeg', 'png'], max: MAX_UPLOAD },
  capa: { folder: 'capas', exts: ['jpg'], max: 3 * MB },
};

// Autoriza o envio de um arquivo: devolve a URL assinada de upload (o navegador envia direto ao Storage) e a URL pública final
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  try {
    const { password, name, size, type } = await readJson(req);
    if (!isAdmin(password)) return res.status(401).json({ error: 'Senha de administrador inválida.' });
    const t = TYPES[type];
    if (!t) return res.status(400).json({ error: 'Tipo de arquivo inválido.' });
    const ext = String(name || '').toLowerCase().split('.').pop();
    if (!t.exts.includes(ext)) return res.status(400).json({ error: `Formato não aceito. Use: ${t.exts.join(', ').toUpperCase()}.` });
    if (!(Number(size) > 0 && Number(size) <= t.max)) {
      return res.status(400).json({ error: `O arquivo deve ter até ${Math.round(t.max / MB)} MB.${type === 'video' ? ' Para vídeos maiores, publique no YouTube (não listado) ou Vimeo e cole o link.' : ''}` });
    }
    const path = `${t.folder}/${slugify(name, 'arquivo')}-${randomBytes(5).toString('hex')}.${ext}`;
    res.status(200).json({ uploadUrl: await signUpload(path), url: publicUrl(path), maxMb: Math.round(MAX_UPLOAD / MB) });
  } catch (e) {
    res.status(500).json({ error: 'Não foi possível preparar o envio: ' + e.message });
  }
}
