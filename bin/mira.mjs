#!/usr/bin/env node
// mira — CLI config-as-code para gerenciar seu agente Mirá Connect via API (sem tocar no banco).
// Node 18+ (fetch nativo, zero dependências). Comandos: login, status, pull, validate, diff,
// simulate, apply. Rode `npx mira <comando>` ou `node bin/mira.mjs <comando>`.

import fs from "node:fs"
import path from "node:path"
import readline from "node:readline"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const p = (...a) => path.join(ROOT, ...a)
const CREDS = p(".mira", "credentials.json")

// Carrega .env (se existir) para process.env, sem dependências.
;(function loadDotenv() {
  try {
    const raw = fs.readFileSync(p(".env"), "utf8")
    for (const line of raw.split("\n")) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/)
      if (!m) continue
      let v = m[2].replace(/^["']|["']$/g, "")
      if (process.env[m[1]] === undefined) process.env[m[1]] = v
    }
  } catch { /* sem .env, tudo bem */ }
})()

// ---------- util ----------
const C = { dim: "\x1b[2m", red: "\x1b[31m", grn: "\x1b[32m", yel: "\x1b[33m", cyan: "\x1b[36m", rst: "\x1b[0m" }
const log = (...a) => console.log(...a)
const ok = (m) => log(`${C.grn}✓${C.rst} ${m}`)
const warn = (m) => log(`${C.yel}!${C.rst} ${m}`)
const die = (m) => { console.error(`${C.red}✗ ${m}${C.rst}`); process.exit(1) }
const readJSON = (fp, dflt) => { try { return JSON.parse(fs.readFileSync(fp, "utf8")) } catch (e) { if (dflt !== undefined) return dflt; die(`não consegui ler ${path.relative(ROOT, fp)}: ${e.message}`) } }
const writeJSON = (fp, obj) => { fs.mkdirSync(path.dirname(fp), { recursive: true }); fs.writeFileSync(fp, JSON.stringify(obj, null, 2) + "\n") }
const ask = (q, { silent } = {}) => new Promise((res) => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true })
  if (silent) { const out = rl.output; rl._writeToOutput = () => out.write("*") }
  rl.question(q, (a) => { rl.close(); if (silent) log(""); res(a.trim()) })
})

function loadConfig() {
  const cfg = readJSON(p("mira.config.json"))
  if (!cfg.apiBaseUrl) die("mira.config.json sem apiBaseUrl")
  cfg.apiBaseUrl = cfg.apiBaseUrl.replace(/\/+$/, "")
  return cfg
}
function loadCreds() { return readJSON(CREDS, null) }
function saveCreds(c) { writeJSON(CREDS, c) }

async function api(method, route, { body, token, base } = {}) {
  const cfg = base ? { apiBaseUrl: base } : loadConfig()
  const headers = { "Content-Type": "application/json" }
  if (token) headers.Authorization = `Bearer ${token}`
  const r = await fetch(cfg.apiBaseUrl + route, { method, headers, body: body ? JSON.stringify(body) : undefined })
  const text = await r.text()
  let data
  try { data = text ? JSON.parse(text) : {} } catch { data = { raw: text } }
  if (!r.ok) {
    const msg = (data && (data.error || data.message)) || text || `HTTP ${r.status}`
    const err = new Error(`${method} ${route} → HTTP ${r.status}: ${msg}`)
    err.status = r.status
    throw err
  }
  return data
}
function authedToken() {
  const c = loadCreds()
  if (!c || !c.token) die("não autenticado. Rode `mira login` primeiro.")
  return c.token
}
const a = (method, route, body) => api(method, route, { body, token: authedToken() })

// ---------- login ----------
async function cmdLogin() {
  const cfg = loadConfig()
  // Auth interina (Fase 1): email+senha → JWT. Será trocado por login-no-navegador (device flow).
  let email = process.env.MIRA_EMAIL || ""
  let password = process.env.MIRA_PASSWORD || ""
  if (!email) email = await ask("Email: ")
  if (!password) password = await ask("Senha: ", { silent: true })
  if (!email || !password) die("email e senha são obrigatórios (ou defina MIRA_EMAIL/MIRA_PASSWORD)")
  const res = await api("POST", "/api/v1/auth/login", { body: { email, password }, base: cfg.apiBaseUrl })
  if (!res.token) die("login falhou (sem token)")
  const org = res.user?.activeOrganization
  saveCreds({ token: res.token, email, orgId: org?.id || null, orgName: org?.name || null, savedAt: new Date().toISOString() })
  ok(`autenticado como ${email}${org ? ` · org: ${org.name} (#${org.id})` : ""}`)
  log(`${C.dim}token salvo em .mira/credentials.json (gitignored)${C.rst}`)
}

// ---------- status ----------
async function cmdStatus() {
  const cfg = loadConfig()
  const me = await a("GET", "/api/v1/me")
  const org = me.activeOrganization
  ok(`usuário: ${me.email || me.name}`)
  log(`  org ativa: ${org ? `${org.name} (#${org.id})` : "—"}`)
  log(`  apiBaseUrl: ${cfg.apiBaseUrl}`)
  log(`  config: agentId=${cfg.agentId || "—"} inboxId=${cfg.inboxId || "—"}`)
  try {
    const def = await a("GET", "/api/v1/platform/llm-default")
    const models = (def.allowedAgentModels || []).map((m) => (typeof m === "string" ? m : m.id)).filter(Boolean)
    log(`  modelos permitidos: ${models.join(", ") || def.platformDefaultModel || "—"}`)
  } catch { /* ignore */ }
  // Lista agentes/inboxes para ajudar a preencher mira.config.json
  try {
    const agents = await a("GET", "/api/v1/agents")
    log(`\n  Agentes da org:`)
    for (const ag of agents) log(`    #${ag.id}  ${ag.name}  ${C.dim}(inbox ${ag.inboxId ?? "—"}, ${ag.kind})${C.rst}`)
    log(`\n  ${C.dim}Preencha agentId/inboxId em mira.config.json com os IDs acima.${C.rst}`)
  } catch (e) { warn(`não listei agentes: ${e.message}`) }
}

// ---------- helpers de tradução slug<->mcp server id ----------
// Cada server tem storeTemplateId (id numérico do template); /mcp-store mapeia esse id → slug
// humano (ex.: "vtex"). Enriquecemos cada server com _slug para o config ficar portável.
async function listMcpServers() {
  let servers = [], templates = []
  try { servers = await a("GET", "/api/v1/mcp-servers") } catch { return [] }
  try { templates = await a("GET", "/api/v1/mcp-store") } catch { /* opcional */ }
  const slugByTemplateId = Object.fromEntries((templates || []).map((t) => [String(t.id), t.slug]))
  for (const s of servers) s._slug = slugByTemplateId[String(s.storeTemplateId)] || String(s.name || "").toLowerCase()
  return servers
}
function findServerBySlug(servers, slug) {
  const s = String(slug).toLowerCase()
  return servers.find((x) => x._slug === s) ||
    servers.find((x) => (x._slug || "").includes(s)) ||
    servers.find((x) => String(x.name || "").toLowerCase().includes(s))
}

// ---------- pull ----------
async function cmdPull() {
  const cfg = loadConfig()
  if (!cfg.agentId) die("defina agentId em mira.config.json (use `mira status` para listar)")
  const ag = await a("GET", `/api/v1/agents/${cfg.agentId}`)
  const c = ag.config || {}
  const servers = await listMcpServers()
  const idToSlug = Object.fromEntries(servers.map((s) => [String(s.id), s._slug || `server-${s.id}`]))
  const mcp = {}
  for (const id of c.toolMcpServerIds || []) {
    const slug = idToSlug[String(id)] || `server-${id}`
    const allow = (c.mcpToolAllowlist || {})[String(id)]
    mcp[slug] = { tools: allow && allow.length ? allow : "*" }
  }
  writeJSON(p("agent", "agent.json"), {
    name: ag.name, enabled: ag.enabled, kind: ag.kind, role: ag.role,
    model: c.model || "", temperature: c.temperature ?? 0.3,
    maxToolIterations: c.maxToolIterations ?? 12,
    systemPromptFile: "system-prompt.md", mcp,
  })
  fs.mkdirSync(p("agent"), { recursive: true })
  fs.writeFileSync(p("agent", "system-prompt.md"), (c.systemPrompt || "") + "\n")
  ok(`agent/agent.json + agent/system-prompt.md atualizados (agente #${ag.id})`)
  if (cfg.inboxId) {
    try {
      const ib = await a("GET", `/api/v1/inboxes/${cfg.inboxId}`)
      if (ib.widget) {
        writeJSON(p("widget", "widget.json"), {
          name: ib.name, allowedOrigins: ib.widget.allowedOrigins || [], appearance: ib.widget.appearance || {},
        })
        ok(`widget/widget.json atualizado (inbox #${ib.id})`)
      }
    } catch (e) { warn(`widget não puxado: ${e.message}`) }
  }
}

// ---------- validate (offline) ----------
function loadLocalAgent() {
  const ag = readJSON(p("agent", "agent.json"))
  const promptFile = p("agent", ag.systemPromptFile || "system-prompt.md")
  ag._systemPrompt = fs.existsSync(promptFile) ? fs.readFileSync(promptFile, "utf8") : ""
  return ag
}
function validateAgent(ag, allowedModels) {
  const errs = []
  if (!ag.name) errs.push("agent.name vazio")
  if (!["eino_chat", "simple_chat", "openai_assistant"].includes(ag.kind)) errs.push(`agent.kind inválido: ${ag.kind}`)
  if (!["primary", "subagent"].includes(ag.role)) errs.push(`agent.role inválido: ${ag.role}`)
  if (ag.temperature != null && (ag.temperature < 0 || ag.temperature > 2)) errs.push("temperature fora de 0–2")
  if (ag.maxToolIterations != null && (ag.maxToolIterations < 1 || ag.maxToolIterations > 50)) errs.push("maxToolIterations fora de 1–50")
  if (ag.model && allowedModels && allowedModels.length && !allowedModels.includes(ag.model)) {
    errs.push(`model "${ag.model}" fora da allowlist (${allowedModels.join(", ")}). Use "" p/ o default.`)
  }
  if (!ag._systemPrompt || !ag._systemPrompt.trim()) errs.push("system-prompt.md vazio")
  return errs
}
async function cmdValidate({ offline = true } = {}) {
  const ag = loadLocalAgent()
  let allowed = null
  if (!offline) {
    try { const def = await a("GET", "/api/v1/platform/llm-default"); allowed = (def.allowedAgentModels || []).map((m) => (typeof m === "string" ? m : m.id)) } catch { /* ignore */ }
  }
  const errs = validateAgent(ag, allowed)
  // widget + mcp existem e são JSON válido?
  if (fs.existsSync(p("widget", "widget.json"))) readJSON(p("widget", "widget.json"))
  if (fs.existsSync(p("mcp", "mcp.json"))) readJSON(p("mcp", "mcp.json"))
  if (errs.length) { errs.forEach((e) => console.error(`${C.red}  - ${e}${C.rst}`)); die(`validação falhou (${errs.length})`) }
  ok("config válida" + (offline ? " (offline)" : ""))
}

// ---------- build do config do agente (resolve slugs→serverIds) ----------
async function buildAgentPayload(ag) {
  const servers = await listMcpServers()
  const toolMcpServerIds = []
  const mcpToolAllowlist = {}
  for (const [slug, spec] of Object.entries(ag.mcp || {})) {
    const srv = findServerBySlug(servers, slug)
    if (!srv) { warn(`MCP "${slug}" não ativado nesta org — rode \`mira apply\` (ativa) ou ative no painel.`); continue }
    toolMcpServerIds.push(srv.id)
    const tools = spec && spec.tools
    if (Array.isArray(tools)) mcpToolAllowlist[String(srv.id)] = tools // [] = nenhuma; lista = só essas
    // tools "*" ou ausente = todas (não inclui no allowlist)
  }
  return {
    name: ag.name, enabled: ag.enabled !== false, kind: ag.kind || "eino_chat", role: ag.role || "primary",
    inboxId: loadConfig().inboxId || undefined,
    config: {
      schemaVersion: 1, model: ag.model || "", temperature: ag.temperature ?? 0.3,
      maxToolIterations: ag.maxToolIterations ?? 12, systemPrompt: ag._systemPrompt,
      toolMcpServerIds, mcpToolAllowlist,
    },
  }
}

// ---------- simulate ----------
async function cmdSimulate(args) {
  const cfg = loadConfig()
  const i = args.indexOf("-m"); const msg = i >= 0 ? args[i + 1] : args.find((x) => !x.startsWith("-"))
  if (!msg) die('uso: mira simulate -m "sua mensagem"')
  const ag = loadLocalAgent()
  const payload = await buildAgentPayload(ag)
  const res = await a("POST", "/api/v1/agents/simulate", {
    config: payload.config, messages: [{ role: "user", content: msg }], inboxId: cfg.inboxId || undefined,
  })
  log(`${C.cyan}↩ resposta:${C.rst}\n${res.reply || "(vazio)"}`)
  const tools = res.debug?.toolInvocations || []
  if (tools.length) log(`${C.dim}tools: ${tools.map((t) => t.name || t.toolName).join(", ")}${C.rst}`)
}

// ---------- apply ----------
function credsFromEnv(map) {
  const out = {}; let missing = []
  for (const [field, envName] of Object.entries(map || {})) {
    const v = process.env[envName]
    if (v == null || v === "") missing.push(envName); else out[field] = v
  }
  return { out, missing }
}
async function applyMcp() {
  if (!fs.existsSync(p("mcp", "mcp.json"))) return
  const items = readJSON(p("mcp", "mcp.json"))
  const servers = await listMcpServers()
  for (const it of items) {
    const slug = it.slug
    const { out: creds, missing } = credsFromEnv(it.credentialsEnv)
    const existing = findServerBySlug(servers, slug)
    if (!existing) {
      if (missing.length) { warn(`MCP ${slug}: faltam envs ${missing.join(", ")} — pulei a ativação`); continue }
      const srv = await a("POST", `/api/v1/mcp-store/${slug}/activate`, { name: it.name || slug, credentials: creds })
      ok(`MCP ${slug} ativado (server #${srv.id})`)
    } else if (Object.keys(creds).length) {
      await a("PUT", `/api/v1/mcp-servers/${existing.id}`, { name: it.name || existing.name, transport: existing.transport, enabled: true, httpHeaders: creds, httpHeadersPatch: "replace" })
      ok(`MCP ${slug} credenciais atualizadas (server #${existing.id})`)
    } else {
      log(`${C.dim}MCP ${slug}: já ativo, sem envs novas — mantido${C.rst}`)
    }
  }
}
async function cmdApply({ yes } = {}) {
  const cfg = loadConfig()
  if (!cfg.agentId) die("defina agentId em mira.config.json")
  await cmdValidate({ offline: false })
  const me = await a("GET", "/api/v1/me")
  if (!yes) {
    const c = await ask(`Aplicar na org "${me.activeOrganization?.name}" (#${me.activeOrganization?.id}), agente #${cfg.agentId}? [y/N] `)
    if (c.toLowerCase() !== "y") die("cancelado")
  }
  await applyMcp()
  if (cfg.inboxId && fs.existsSync(p("widget", "widget.json"))) {
    const w = readJSON(p("widget", "widget.json"))
    await a("PUT", `/api/v1/inboxes/${cfg.inboxId}/widget`, { name: w.name, allowedOrigins: w.allowedOrigins, appearance: w.appearance })
    ok("widget aplicado")
  }
  const ag = loadLocalAgent()
  const payload = await buildAgentPayload(ag)
  await a("PUT", `/api/v1/agents/${cfg.agentId}`, payload)
  ok(`agente #${cfg.agentId} aplicado (nova versão criada no histórico)`)
}

// ---------- diff ----------
async function cmdDiff() {
  const cfg = loadConfig()
  if (!cfg.agentId) die("defina agentId em mira.config.json")
  const ag = await a("GET", `/api/v1/agents/${cfg.agentId}`)
  const remote = ag.config || {}
  const local = loadLocalAgent()
  const cmp = (label, l, r) => { if (JSON.stringify(l) !== JSON.stringify(r)) log(`${C.yel}~ ${label}${C.rst}\n  local : ${JSON.stringify(l)}\n  remoto: ${JSON.stringify(r)}`) }
  cmp("model", local.model || "", remote.model || "")
  cmp("temperature", local.temperature ?? 0.3, remote.temperature ?? 0.3)
  cmp("maxToolIterations", local.maxToolIterations ?? 12, remote.maxToolIterations ?? 12)
  if ((local._systemPrompt || "").trim() !== (remote.systemPrompt || "").trim()) log(`${C.yel}~ systemPrompt difere${C.rst}`)
  ok("diff concluído")
}

// ---------- main ----------
const HELP = `mira — gerencie seu agente Mirá Connect via API (config-as-code)

  mira login                 autentica (email+senha por enquanto; em breve: login no navegador)
  mira status                mostra usuário, org ativa, modelos permitidos e agentes
  mira pull                  baixa a config atual (agente + widget) para os arquivos locais
  mira validate              valida os arquivos locais (offline)
  mira diff                  compara local vs remoto
  mira simulate -m "..."     testa o agente (dry-run, não envia nada ao cliente)
  mira apply [--yes]         aplica local → remoto (MCP, widget, agente)

Config em mira.config.json. Secrets só via env (.env) — nunca no repo.`

async function main() {
  const [cmd, ...args] = process.argv.slice(2)
  try {
    switch (cmd) {
      case "login": return await cmdLogin()
      case "status": return await cmdStatus()
      case "pull": return await cmdPull()
      case "validate": return await cmdValidate({ offline: !args.includes("--online") })
      case "diff": return await cmdDiff()
      case "simulate": return await cmdSimulate(args)
      case "apply": return await cmdApply({ yes: args.includes("--yes") || args.includes("-y") })
      case undefined: case "help": case "-h": case "--help": return log(HELP)
      default: die(`comando desconhecido: ${cmd}\n\n${HELP}`)
    }
  } catch (e) { die(e.message) }
}
main()
