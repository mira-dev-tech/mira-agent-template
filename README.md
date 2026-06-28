# Mirá Agent — config-as-code

Gerencie o seu agente de IA do **Mirá Connect** como código: o prompt, o modelo, as ferramentas
(integrações MCP, ex.: VTEX) e a aparência do widget ficam **versionados neste repositório** e são
aplicados **via API** — sem ninguém tocar no banco. Você edita com o Cursor/Claude, testa e publica.

```
agent/system-prompt.md   ← o "cérebro" do agente (edite aqui)
agent/agent.json         ← modelo, temperatura, limites, quais ferramentas MCP
widget/widget.json       ← aparência do chat no site (cores, mensagem, origens)
mcp/mcp.json             ← integrações (ex.: VTEX) e de quais ENV vêm as credenciais
mira.config.json         ← para qual ambiente/agente você publica (sem segredos)
```

## Pré-requisitos

- **Node.js 18+** (recomendado 20+).
- Acesso ao Mirá Connect (login) com permissão de gerenciar agentes.

## Começando

1. **Configurar segredos** — copie `.env.example` para `.env` e preencha (o `.env` é ignorado pelo git):
   ```bash
   cp .env.example .env
   # edite .env: MIRA_EMAIL / MIRA_PASSWORD e, se usar VTEX, VTEX_ACCOUNT/APPKEY/APPTOKEN
   ```
2. **Login**:
   ```bash
   node bin/mira.mjs login
   ```
   > Em breve o `login` abrirá o navegador para você autenticar (sem senha no `.env`).
3. **Descobrir seus IDs** e preencher `mira.config.json` (`agentId`, `inboxId`):
   ```bash
   node bin/mira.mjs status
   ```
4. **Baixar a config atual** para os arquivos locais:
   ```bash
   node bin/mira.mjs pull
   ```

## Fluxo do dia a dia

1. Edite `agent/system-prompt.md` (e/ou `agent/agent.json`, `widget/widget.json`) — peça ajuda ao
   Cursor/Claude; veja `AGENTS.md`.
2. **Valide** (offline): `node bin/mira.mjs validate`
3. **Teste** sem afetar clientes (dry-run): `node bin/mira.mjs simulate -m "oi, quero comprar"`
4. **Veja o diff** vs o que está no ar: `node bin/mira.mjs diff`
5. **Publique**: `node bin/mira.mjs apply` (confirma a org/agente antes)

Cada `apply` cria uma **nova versão** no histórico do agente — dá para reverter pelo painel.

## Comandos

| Comando | O que faz |
|---|---|
| `mira login` | Autentica e guarda o token em `.mira/credentials.json` (ignorado pelo git) |
| `mira status` | Mostra usuário, org ativa, modelos permitidos e lista seus agentes/inboxes |
| `mira pull` | Baixa a config atual (agente + widget) para os arquivos locais |
| `mira validate` | Valida os arquivos locais (offline) |
| `mira diff` | Compara local vs publicado |
| `mira simulate -m "..."` | Testa o agente sem enviar nada a clientes |
| `mira apply [--yes]` | Publica local → remoto (MCP, widget, agente) |

(`node bin/mira.mjs <cmd>` ou, se preferir, `npm run mira -- <cmd>`.)

## Segurança

- **Nunca** comite segredos. Credenciais ficam só no `.env` (local) ou no secret store do seu CI.
- `mcp/mcp.json` guarda **só os nomes das variáveis** de ambiente, nunca os valores.
- O servidor é a verdade final: ele revalida tudo no `apply` (modelo permitido, limites, etc.).

## Modelo do agente

Deixe `"model": ""` para usar o padrão da plataforma. Para escolher outro, use um slug permitido
(`mira status` mostra a allowlist — famílias `mira*` e `gpt*`).
