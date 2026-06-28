# Instruções para o agente de código (Cursor / Claude)

Este repositório controla um **agente de IA do Mirá Connect** como código. Seu trabalho aqui é
ajudar a pessoa a **melhorar o agente** editando os arquivos de config e publicando via o CLI `mira`
— que conversa com a API do Mirá Connect. **Você nunca acessa banco de dados.**

## Mapa dos arquivos

- `agent/system-prompt.md` — o prompt do agente (a maior parte das melhorias é aqui).
- `agent/agent.json` — `model` (vazio = padrão da plataforma; senão um slug permitido), `temperature`
  (0–2), `maxToolIterations` (1–50), e `mcp` = quais integrações o agente usa, no formato
  `{"vtex": {"tools": ["catalog_search_products", ...]}}` (use `"tools": "*"` para todas).
- `widget/widget.json` — aparência do chat (cores, mensagem de boas-vindas, `allowedOrigins`).
- `mcp/mcp.json` — integrações a ativar (ex.: VTEX) e **de quais variáveis de ambiente** vêm as
  credenciais (`credentialsEnv` mapeia campo → NOME da env, nunca o valor).
- `mira.config.json` — ponteiros não-secretos: `apiBaseUrl`, `orgId`, `inboxId`, `agentId`.

## Fluxo obrigatório ao mudar algo

1. Edite os arquivos.
2. `node bin/mira.mjs validate` — corrija erros antes de seguir.
3. `node bin/mira.mjs simulate -m "<mensagem realista>"` — confira a resposta e as tools usadas.
   Itere no prompt até ficar bom. **Simule sempre antes de aplicar.**
4. `node bin/mira.mjs diff` — confirme que só muda o que você quis.
5. **Peça confirmação à pessoa** antes de `node bin/mira.mjs apply` (publica em produção).

## Regras (não quebrar)

- **Segredos nunca no repo.** Não escreva valores de senha/token/appkey em nenhum arquivo versionado.
  Eles vivem só no `.env` (ignorado) ou no secret store do CI. Em `mcp/mcp.json` ficam só os NOMES das envs.
- **Não invente IDs nem slugs.** `model` deve estar na allowlist (`mira status`). Slugs de MCP devem
  existir no catálogo (ex.: `vtex`). O servidor revalida e rejeita o que for inválido.
- **`apply` é ação de produção.** Sempre `validate` + `simulate` antes, e confirme com a pessoa.
- **O servidor é a verdade final.** Se a validação local divergir do servidor, vale o servidor;
  ajuste os arquivos conforme o erro retornado.
- Mudou o prompt? Descreva no commit o que mudou e por quê (facilita rollback pelo histórico de versões).

## Dicas de qualidade do prompt

- Seja específico sobre tom, objetivo e regras de não-alucinação (preço/estoque/prazo via ferramentas).
- Para vendas: sempre mostrar preço + disponibilidade; confirmar antes de fechar; oferecer humano se travar.
- Teste casos reais com `simulate` (cliente indeciso, fora de cobertura, pedindo desconto, etc.).
