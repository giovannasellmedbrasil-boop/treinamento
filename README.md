# Plataforma de Treinamentos · Sellmed Brasil

Treinamentos de produto com **vídeos**, **apresentações (PPTX/PDF)** e **quizzes**, na identidade visual da Sellmed.

- `index.html`: área do participante. Só entra quem tem e-mail **@sellmedbrasil.com** e senha (veja *Acesso* abaixo). Lá a pessoa assiste às aulas, responde aos quizzes, acompanha o próprio progresso e emite o certificado ao concluir.
- `admin.html`: painel com senha. **Novo treinamento** abre em abas (Dados · Vídeo · Apresentação · Quiz, já com 5 perguntas) e cria tudo de uma vez. Depois, mais aulas podem ser adicionadas na lista do treinamento. Também mostra os resultados, com exportação CSV.

## Acesso (login com senha)

1. **Primeiro acesso:** a pessoa informa nome e sobrenome e o e-mail @sellmedbrasil.com. Ela recebe um e-mail com um link para criar a senha.
2. **Entrar:** e-mail + senha. A sessão fica aberta por 30 dias no navegador; "Sair" encerra.
3. **Esqueci minha senha:** o mesmo link por e-mail, para criar uma senha nova. Redefinir a senha encerra as sessões abertas em outros aparelhos.

- Os links valem por 24 horas e só funcionam uma vez. São no máximo 3 por hora para cada e-mail.
- Senhas têm no mínimo 8 caracteres e são guardadas com hash (scrypt), nunca em texto. Depois de 8 senhas erradas seguidas, a conta fica bloqueada por 15 minutos.
- No painel, em **Resultados → Participantes**, aparece quem já criou a senha. Dali é possível **convidar por e-mail**, reenviar o link ou mandar um link para redefinir a senha.
- O envio dos e-mails usa SMTP (variáveis `SMTP_*` abaixo). Sem elas, a plataforma recusa o primeiro acesso com um aviso. No servidor local, o link aparece na tela e no terminal.

## Como funciona

| Tipo de aula | O que aceita | Como o participante vê |
|---|---|---|
| Vídeo | MP4/WEBM/MOV até 50 MB **ou** link do YouTube, Vimeo ou Google Drive | Player na página. Vídeo enviado é concluído sozinho ao chegar a 90%; link, pelo botão "Marcar como concluída" |
| Apresentação | PPTX, PPT ou PDF até 50 MB **ou** link (Google Slides, OneDrive…) | PDF no leitor do navegador; PowerPoint no visualizador do Office Online; botões Baixar e Tela cheia |
| Quiz | Perguntas de múltipla escolha (2 a 8 alternativas, 1 correta), explicação opcional e nota mínima | Responde, recebe a nota e a correção comentada; pode refazer. Aprovado = aula concluída |

- O **gabarito nunca vai para o navegador** do participante: a correção é feita no servidor.
- Vídeos longos: publique no YouTube como **Não listado** e cole o link. É o melhor caminho para arquivos acima de 50 MB, que é o limite do plano gratuito do Supabase.
- Perguntas podem ser **importadas de texto** (botão "Importar de texto" no quiz):
  ```
  1. Pergunta?
  a) errada
  *b) correta          ← ou "b) correta (correta)"
  > explicação opcional
  ```
- Treinamento em **Rascunho** não aparece para os participantes.
- O progresso fica salvo no banco, vinculado ao e-mail. A pessoa pode trocar de dispositivo e continua de onde parou.

## Estrutura

```
index.html  admin.html  assets/logo.svg
api/_lib.js       conexão Postgres + Storage do Supabase
api/aluno.js      login, primeiro acesso, esqueci a senha, conteúdo, concluir aula, corrigir quiz
api/_auth.js      senhas (scrypt), links por e-mail, sessões, envio SMTP e modelo do e-mail
api/admin.js      CRUD de treinamentos/aulas, ordem, resultados
api/upload.js     URL assinada para o navegador enviar o arquivo direto ao Storage
supabase/schema.sql   tabelas + bucket "treinamentos"
scripts/dev-local.mjs servidor local completo (Postgres embutido + Storage simulado)
```

## Rodar no computador (sem contas externas)

O iCloud não combina com `node_modules`, então copie a pasta para fora dele antes:

```bash
rsync -a --exclude node_modules "…/APPs/Treinamentos Sellmed - App/" ~/tmp/treinamentos/
cd ~/tmp/treinamentos && npm install && npm run local
# http://localhost:4173  ·  painel: /admin.html  ·  senha: local
# sem SMTP: o link de criar senha aparece na própria tela e no terminal
```

A pré-visualização de PowerPoint só funciona no site publicado, porque o Office Online precisa de um link público.

## Publicar (Vercel + Supabase)

1. Supabase: rode `supabase/schema.sql` no SQL Editor do projeto.
2. Vercel: crie as variáveis de ambiente abaixo e publique com `vercel deploy --prod`.

| Variável | Valor |
|---|---|
| `DATABASE_URL` | string do **pooler** (porta 6543, usuário `postgres.<ref>`) |
| `SUPABASE_URL` | `https://<ref>.supabase.co` |
| `SUPABASE_SECRET_KEY` | chave `sb_secret_…` (Settings → API Keys) |
| `ADMIN_PASSWORD` | senha do painel |
| `APP_URL` | `https://treinamento-sellmed.vercel.app` (base dos links enviados por e-mail) |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` | servidor de envio dos e-mails de senha (porta 465 = SSL; 587 = STARTTLS) |
| `SMTP_FROM` | *(opcional)* remetente, ex.: `Treinamentos Sellmed <treinamentos@sellmedbrasil.com>`; padrão = `SMTP_USER` |
| `ALLOWED_DOMAIN` | *(opcional)* domínio aceito no login; padrão `sellmedbrasil.com` |
| `MAX_UPLOAD_MB` | *(opcional)* padrão 50; aumente só em plano pago do Supabase |
