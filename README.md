# Plataforma de Treinamentos · Sellmed Brasil

Treinamentos de produto com **vídeos**, **apresentações (PPTX/PDF)** e **quizzes**, na identidade visual da Sellmed.

- `index.html`: área do participante. A pessoa entra com nome e e-mail (e o código de acesso, se ele estiver configurado). Lá ela assiste às aulas, responde aos quizzes, acompanha o próprio progresso e emite o certificado ao concluir.
- `admin.html`: painel com senha para criar treinamentos, adicionar aulas, montar quizzes e ver os resultados (com exportação CSV).

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
api/aluno.js      entrar, conteúdo, concluir aula, corrigir quiz
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
| `ACCESS_CODE` | *(opcional)* código exigido na entrada dos participantes, ex.: `SELLMED2026` |
| `MAX_UPLOAD_MB` | *(opcional)* padrão 50; aumente só em plano pago do Supabase |
