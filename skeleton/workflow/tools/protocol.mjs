#!/usr/bin/env node
/**
 * protocol.mjs — ОДНА точка ответа на вопросы о состоянии проекта.
 *
 * Зачем: STATUS.md (проза), TASKS.md (список) и LOG.md (журнал) отвечают по-разному,
 * и каждый чат выбирает удобный ему ответ. Этот скрипт читает те же файлы + `workflow/state.json`
 * и печатает ОДИН и тот же ответ в любом агенте (OpenCode, freebuff, …): команда — это shell,
 * он есть везде. Фолбэк без shell — сгенерированный `workflow/CONTEXT.md`.
 *
 * Источники правды (в порядке приоритета):
 *   1) workflow/state.json — какой этап, какой шаг плана, что дальше (машиночитаемо);
 *   2) workflow/TASKS.md   — задачи и их статусы (СВОБОДНА / В РАБОТЕ / ПЕРЕХВАЧЕНА / ГОТОВА);
 *   3) workflow/LOG.md     — что реально сделано («Осталось / открытыми» в верхней записи);
 *   4) workflow/claims/    — кто что взял (мягкий захват, TTL 3 ч без активности);
 *   5) workflow/sessions/  — реестр живых сессий OpenCode (TTL 24 ч).
 *
 * Команды:
 *   next                 — какой следующий шаг (этап/шаг плана + задача + свободные задачи)
 *   open                 — что не доделано (задачи + захваты + сессии + «Осталось» из LOG)
 *   step <план>          — последний незакрытый шаг плана; если план закрыт — так и скажет
 *   claim <N> [--force]  — взять задачу (workflow/claims/N.json, TTL 3 ч) + отметить «В РАБОТЕ»
 *   release <N>          — освободить задачу
 *   finish <N>           — закрыть задачу: TASKS → ГОТОВА, шаг плана → done, next пересчитан
 *   check                — сверка state ↔ TASKS ↔ LOG (расхождения, свежесть, просрочки)
 *   context [--write]    — компактный бриф (≤4 КБ); --write пишет workflow/CONTEXT.md
 *   sessions             — живые сессии из workflow/sessions
 *   help                 — эта справка
 *
 * Переменные окружения: PROTOCOL_ROOT (корень проекта; по умолчанию cwd),
 * PROTOCOL_OWNER (кто взял задачу), PROTOCOL_TOOL (имя агента для журнала захвата),
 * PROTOCOL_LOCK_WAIT_MS (сколько ждать блокировку; по умолчанию 5000, нужно тестам).
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"

/** Версия движка. Печатается в `check` — чтобы было видно, отстаёт ли проект от шаблона. */
export const ENGINE_VERSION = "0.1.0"

export const CLAIM_TTL_MS = 3 * 60 * 60 * 1000 // 3 часа БЕЗ АКТИВНОСТИ (не «3 часа на задачу»)
export const SESSION_TTL_MS = 24 * 60 * 60 * 1000
export const CONTEXT_LIMIT = 4096 // workflow/CONTEXT.md должен оставаться коротким (байты)

/** Бюджеты, чтобы файлы не раздувались. Превышение — предупреждение в `check`. */
export const BUDGET = {
  context: CONTEXT_LIMIT, // байт
  tasks: 12000, // символов, workflow/TASKS.md
  row: 500, // символов, одна строка задачи
  status: 10000, // символов, workflow/STATUS.md (справочник; в контекст не вливается — см. context)
  logEntry: 2500, // символов, одна запись LOG
}
export const PRUNE_DAYS = 14 // закрытые задачи старше — в архив
export const PRUNE_KEEP = 10 // но последние N закрытых остаются всегда

/**
 * Межпроцессная блокировка на изменяющие команды (claim/release/finish/prune).
 * Каталог вместо файла: mkdir атомарен и в Windows, и в POSIX — либо создали мы,
 * либо он уже есть. Никаких зависимостей и отдельных демонов.
 */
export const LOCK_PATH = "workflow/.protocol.lock"
export const LOCK_TTL_MS = 10_000 // дольше 10 с команда не живёт: значит процесс умер
export const LOCK_STEP_MS = 25 // пауза между попытками
const lockWaitMs = () => {
  const v = Number(process.env.PROTOCOL_LOCK_WAIT_MS)
  return Number.isFinite(v) && v >= 0 ? v : 5000
}

const LOG_HEAD_ENTRIES = 3
const STATUS_WORDS = ["СВОБОДНА", "В РАБОТЕ", "ПЕРЕХВАЧЕНА", "ГОТОВА"]

/* ------------------------------------------------------------------ база */

export class ProtocolError extends Error {
  constructor(message, code = 1) {
    super(message)
    this.code = code
  }
}

export function projectRoot() {
  return process.env.PROTOCOL_ROOT ? path.resolve(process.env.PROTOCOL_ROOT) : process.cwd()
}

const rel = (root, p) => path.join(root, p)

export function readText(p) {
  try {
    return readFileSync(p, "utf8")
  } catch {
    return ""
  }
}

function readJson(p) {
  try {
    return JSON.parse(readFileSync(p, "utf8"))
  } catch {
    return null
  }
}

/**
 * Запись через временный файл + переименование: файл протокола либо старый, либо новый —
 * недописанного состояния не бывает, даже если процесс убьют посреди записи.
 */
function writeText(p, text) {
  mkdirSync(path.dirname(p), { recursive: true })
  const tmp = `${p}.${process.pid}.${Date.now().toString(36)}.tmp`
  try {
    writeFileSync(tmp, text, "utf8")
    renameSync(tmp, p)
  } catch (err) {
    try {
      unlinkSync(tmp)
    } catch {
      // временного файла может и не быть — не мешает основной ошибке
    }
    throw err
  }
}

function writeJson(p, data) {
  writeText(p, JSON.stringify(data, null, 2) + "\n")
}

/** Атомарно СОЗДАЁТ файл: true — создали мы, false — он уже был (кто-то успел раньше). */
function writeJsonNew(p, data) {
  mkdirSync(path.dirname(p), { recursive: true })
  try {
    writeFileSync(p, JSON.stringify(data, null, 2) + "\n", { encoding: "utf8", flag: "wx" })
    return true
  } catch (err) {
    if (err.code === "EEXIST") return false
    throw err
  }
}

/** Сон без зависимостей: Atomics.wait ждёт в ядре, не занимая CPU и не требуя таймеров. */
const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

/**
 * Выполнить изменяющую команду под межпроцессной блокировкой.
 * Блокировка — каталог workflow/.protocol.lock: `mkdir` атомарен и в Windows, и в POSIX,
 * поэтому из двух одновременных команд внутрь входит ровно одна.
 * Брошенную блокировку (процесс убили) снимаем по возрасту: mtime старше LOCK_TTL_MS.
 */
function withLock(root, fn) {
  const lockDir = path.join(root, LOCK_PATH)
  mkdirSync(path.dirname(lockDir), { recursive: true })
  const wait = lockWaitMs()
  const deadline = Date.now() + wait
  for (;;) {
    try {
      mkdirSync(lockDir)
      break
    } catch (err) {
      if (err.code !== "EEXIST") throw err
    }
    let mtime = 0
    try {
      mtime = statSync(lockDir).mtimeMs
    } catch {
      continue // каталог успели снять — пробуем снова
    }
    if (Date.now() - mtime > LOCK_TTL_MS) {
      // Процесс умер, не сняв блокировку: убираем и заходим.
      try {
        rmSync(lockDir, { recursive: true, force: true })
      } catch {
        // уже сняли — не мешает
      }
      continue
    }
    if (Date.now() >= deadline) {
      throw new ProtocolError(
        `не дождался блокировки ${LOCK_PATH}: другая команда протокола ещё работает ` +
          `(ждал ${wait} мс).\nПовтори команду через пару секунд.`,
      )
    }
    sleepMs(LOCK_STEP_MS)
  }
  try {
    return fn()
  } finally {
    try {
      rmSync(lockDir, { recursive: true, force: true })
    } catch {
      // уборка не должна подменять результат команды
    }
  }
}

const pad = (n) => String(n).padStart(2, "0")

/** Локальное ISO-время со смещением: 2026-11-15T19:05:00+03:00 */
export function nowIso(d = new Date()) {
  const off = -d.getTimezoneOffset()
  const sign = off >= 0 ? "+" : "-"
  const abs = Math.abs(off)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(
    d.getMinutes(),
  )}:${pad(d.getSeconds())}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
}

export const fmtDay = (x) => {
  const d = new Date(x)
  return Number.isNaN(d.getTime()) ? "?" : `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`
}

export const fmtClock = (x) => {
  const d = new Date(x)
  return Number.isNaN(d.getTime()) ? "?" : `${pad(d.getDate())}.${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

const today = () => fmtDay(new Date())

function clip(text, max) {
  const t = String(text || "").replace(/\s+/g, " ").trim()
  return t.length <= max ? t : t.slice(0, Math.max(1, max - 1)).trimEnd() + "…"
}

/* --------------------------------------------------------------- TASKS.md */

/**
 * Разбор таблицы задач. Статус ищется по ключевому слову, а не по номеру ячейки:
 * в описаниях встречаются символы «|», из-за которых число ячеек разное.
 */
export function parseTasks(md) {
  const rows = []
  const lines = md.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line.startsWith("|")) continue
    const cells = line.split("|")
    const num = Number(String(cells[1] || "").trim())
    if (!Number.isInteger(num)) continue
    let statusIdx = -1
    let statusWord = ""
    for (let c = 2; c < cells.length; c++) {
      const v = cells[c].trim()
      const word = STATUS_WORDS.find((w) => v.startsWith(w))
      if (word) {
        statusIdx = c
        statusWord = word
        break
      }
    }
    if (statusIdx < 0) continue
    rows.push({
      num,
      title: cells.slice(2, statusIdx).join("|").trim(),
      statusWord,
      statusText: cells[statusIdx].trim(),
      statusIdx,
      cells,
      line,
      lineIndex: i,
    })
  }
  return rows
}

function withStatus(task, text) {
  const cells = task.cells.slice()
  cells[task.statusIdx] = ` ${text} `
  return cells.join("|")
}

function saveTasks(root, md, task, text) {
  const crlf = md.includes("\r\n")
  const lines = md.split(/\r?\n/)
  lines[task.lineIndex] = withStatus(task, text)
  writeText(rel(root, "workflow/TASKS.md"), lines.join(crlf ? "\r\n" : "\n"))
}

/** Дата задачи: последняя ячейка с полной датой (dd.MM.yyyy). Нет даты → null (не архивируем). */
function taskDate(task) {
  const cells = task.cells.slice(1, task.cells.length - 1)
  for (let i = cells.length - 1; i >= 0; i--) {
    const m = cells[i].match(/(\d{2})\.(\d{2})\.(\d{4})/)
    if (m) return Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1]))
  }
  return null
}

/* ----------------------------------------------------------------- LOG.md */

export function parseLog(md) {
  return md
    .split(/^## \[/m)
    .slice(1)
    .map((chunk) => {
      const body = chunk.trim()
      const lines = body.split(/\r?\n/)
      const head = lines[0]
      // Дата — первые dd.MM.yyyy в заголовке; после даты бывает и время, и текст («утро», «вечер»).
      const m = head.match(/^(\d{2}\.\d{2}\.\d{4})(.*?)\]\s*—\s*(.*)$/)
      const time = m ? (m[2].match(/(\d{2}:\d{2})/) || [])[1] || "" : ""
      return {
        head,
        date: m ? m[1] : "",
        time,
        title: m ? m[3] : head,
        body,
        leftover: leftoverOf(lines),
      }
    })
}

/** «Осталось / открытыми: …» верхней записи — то, что нельзя потерять при компактном брифе. */
function leftoverOf(lines) {
  const i = lines.findIndex((l) => /^\s*[-*]\s*Осталось/.test(l))
  if (i < 0) return ""
  const out = [lines[i].replace(/^\s*[-*]\s*Осталось[^:]*:\s*/, "")]
  for (let j = i + 1; j < lines.length; j++) {
    if (/^\s*$/.test(lines[j])) break
    if (/^\s*[-*]\s/.test(lines[j])) break
    out.push(lines[j].trim())
  }
  return out.join(" ").trim()
}

/* ------------------------------------------------------------- state.json */

export function loadState(root) {
  const p = rel(root, "workflow/state.json")
  const s = readJson(p)
  if (!s) throw new ProtocolError("workflow/state.json не найден или битый JSON — восстановите из git")
  if (!s.plans) s.plans = {}
  return s
}

function saveState(root, state) {
  state.updated = nowIso()
  writeJson(rel(root, "workflow/state.json"), state)
}

/* ---------------------------------------------------------------- claims */

export function claimsDir(root) {
  return rel(root, "workflow/claims")
}

export function listClaims(root, now = Date.now()) {
  const dir = claimsDir(root)
  if (!existsSync(dir)) return []
  const out = []
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".json")) continue
    const info = readJson(path.join(dir, file))
    if (!info || !Number.isInteger(info.task)) continue
    const exp = Date.parse(info.expiresAt)
    const hb = Date.parse(info.heartbeatAt || info.takenAt)
    out.push({
      ...info,
      active: Number.isFinite(exp) && exp > now,
      ageMin: Number.isFinite(hb) ? Math.max(0, Math.round((now - hb) / 60000)) : null,
      expires: Number.isFinite(exp) ? exp : null,
    })
  }
  return out.sort((a, b) => a.task - b.task)
}

/* -------------------------------------------------------------- sessions */

export function listSessions(root, now = Date.now()) {
  const dir = rel(root, "workflow/sessions")
  if (!existsSync(dir)) return []
  const out = []
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".json")) continue
    const info = readJson(path.join(dir, file))
    if (!info || !info.sessionID) continue
    const hb = Date.parse(info.heartbeatAt)
    if (!Number.isFinite(hb) || now - hb > SESSION_TTL_MS) continue
    out.push({ ...info, ageMin: Math.max(0, Math.round((now - hb) / 60000)) })
  }
  return out.sort((a, b) => Date.parse(b.heartbeatAt) - Date.parse(a.heartbeatAt))
}

/* ---------------------------------------------------------------- рендер */

function stageLine(state) {
  const s = state.stage
  if (!s) return "Этап: не задан в workflow/state.json"
  const status = s.status === "closed" ? `ЗАКРЫТ${s.closed ? " " + s.closed : ""}` : "ОТКРЫТ"
  return `Этап ${s.id} «${s.title}» — ${status}`
}

function stagesLine(state) {
  if (!Array.isArray(state.stages) || !state.stages.length) return ""
  const done = state.stages.filter((s) => s.status === "done").map((s) => s.id)
  const open = state.stages.filter((s) => s.status !== "done").map((s) => s.id)
  const parts = []
  if (done.length) parts.push("готово: " + done.join(", "))
  if (open.length) parts.push("не начато: " + open.join(", "))
  return parts.join(" · ")
}

function nextBlock(state, tasks) {
  const n = state.next
  if (!n) return ["Следующий шаг: не задан в workflow/state.json"]
  const lines = [`СЛЕДУЮЩИЙ ШАГ: ${n.text || "—"}`]
  if (Number.isInteger(n.task)) {
    const t = tasks.find((x) => x.num === n.task)
    lines.push(
      t
        ? `→ задача №${n.task} · ${t.statusWord} — ${clip(t.title, 120)}`
        : `→ задача №${n.task}: В TASKS НЕ НАЙДЕНА (workflow/state.json рассинхронизирован — запусти check)`,
    )
  }
  if (n.why) lines.push(`  почему: ${clip(n.why, 200)}`)
  return lines
}

/* ------------------------------------------------------------- команды */

function cmdNext(root) {
  const state = loadState(root)
  const tasks = parseTasks(readText(rel(root, "workflow/TASKS.md")))
  const open = tasks.filter((t) => t.statusWord !== "ГОТОВА")
  const lines = [
    `СОСТОЯНИЕ — workflow/state.json (обновлено ${fmtClock(state.updated)}, ${fmtDay(state.updated)})`,
    stageLine(state),
  ]
  const st = stagesLine(state)
  if (st) lines.push(st)
  lines.push("", ...nextBlock(state, tasks), "")
  if (open.length) {
    lines.push(`Незакрытые задачи (${open.length}):`)
    for (const t of open) lines.push(`- №${t.num} · ${t.statusWord} — ${clip(t.title, 110)}`)
  } else {
    lines.push("Незакрытых задач нет.")
  }
  lines.push("", "Подробнее: node workflow/tools/protocol.mjs open | step <план> | check")
  return lines.join("\n")
}

function cmdOpen(root) {
  const state = loadState(root)
  const tasks = parseTasks(readText(rel(root, "workflow/TASKS.md")))
  const open = tasks.filter((t) => t.statusWord !== "ГОТОВА")
  const claims = listClaims(root)
  const sessions = listSessions(root)
  const log = parseLog(readText(rel(root, "workflow/LOG.md")))
  const lines = [`НЕЗАКРЫТЫЕ ЗАДАЧИ (${open.length})`]
  if (!open.length) lines.push("- нет")
  for (const t of open) {
    lines.push(`- №${t.num} · ${t.statusWord} — ${clip(t.title, 150)}`)
  }

  lines.push("", "ЗАХВАТЫ (workflow/claims, TTL 3 ч без активности)")
  const active = claims.filter((c) => c.active)
  const stale = claims.filter((c) => !c.active)
  if (!active.length && !stale.length) lines.push("- нет")
  for (const c of active) {
    lines.push(
      `- №${c.task} — занята «${c.owner}»${c.session ? " (сессия " + c.session + ")" : ""}, взята ${fmtClock(
        c.takenAt,
      )}, истекает ${fmtClock(c.expiresAt)}${c.ageMin === null ? "" : ", активность " + c.ageMin + " мин назад"}`,
    )
  }
  for (const c of stale) lines.push(`- №${c.task} — захват просрочен (${fmtClock(c.expiresAt)}), можно перехватить`)

  lines.push("", "СЕССИИ (workflow/sessions, TTL 24 ч)")
  if (!sessions.length) lines.push("- нет")
  for (const s of sessions) {
    lines.push(`- ${clip(s.topic || "(без темы)", 90)} — активность ${s.ageMin} мин назад, старт ${fmtClock(s.startedAt)}`)
  }

  const top = log[0]
  if (top) {
    lines.push("", `ПОСЛЕДНЯЯ ЗАПИСЬ LOG (${top.date}${top.time ? " " + top.time : ""})`, `- ${clip(top.title, 200)}`)
    if (top.leftover) lines.push(`  Осталось: ${clip(top.leftover, 600)}`)
  }

  if (state.next && state.next.text) {
    lines.push("", ...nextBlock(state, tasks))
  }
  return lines.join("\n")
}

function resolvePlan(state, arg) {
  const plans = state.plans || {}
  if (plans[arg]) return arg
  const norm = (s) => String(s).toLowerCase().replace(/\\/g, "/").trim()
  const a = norm(arg)
  const exact = Object.keys(plans).find((k) => norm(k) === a)
  if (exact) return exact
  const base = a.split("/").pop().replace(/\.md$/, "")
  const found = Object.keys(plans).find((k) => {
    const kb = norm(k).split("/").pop().replace(/\.md$/, "")
    return kb === base || kb.includes(base)
  })
  return found || null
}

function cmdStep(root, arg) {
  const state = loadState(root)
  const keys = Object.keys(state.plans || {})
  if (!arg) {
    if (!keys.length) return "В workflow/state.json нет описанных планов."
    return ["Известные планы:", ...keys.map((k) => `- ${k} — «${state.plans[k].title}»`)].join("\n")
  }
  const key = resolvePlan(state, arg)
  if (!key) {
    throw new ProtocolError(
      `план «${arg}» не описан в workflow/state.json.\nИзвестные: ${keys.length ? keys.join(", ") : "(нет)"}`,
    )
  }
  const plan = state.plans[key]
  const steps = plan.steps || []
  const openSteps = steps.filter((s) => s.status !== "done")
  const lines = [
    `ПЛАН ${key} — этап ${plan.stage || "?"} «${plan.title}»`,
    (plan.status === "closed" ? `Статус: ЗАКРЫТ ${plan.closed || ""}` : "Статус: ОТКРЫТ").trim(),
    "Шаги: " +
      steps
        .map((s) => `${s.id} ${s.status === "done" ? "ГОТОВ" : "ОТКРЫТ"}`)
        .join(" · "),
    "",
  ]
  if (!openSteps.length) {
    const last = steps[steps.length - 1]
    lines.push("Незакрытых шагов НЕТ — план закрыт.")
    if (last) lines.push(`Последний шаг ${last.id} закрыт${last.done ? " " + last.done : ""}${last.task ? ` (задача №${last.task})` : ""}.`)
    lines.push("Не переделывай закрытые шаги: сначала спроси пользователя, что делать дальше.")
    if (state.next && state.next.text) lines.push("", ...nextBlock(state, parseTasks(readText(rel(root, "workflow/TASKS.md")))))
    return lines.join("\n")
  }
  const s = openSteps[0]
  lines.push(`Следующий незакрытый шаг: ${s.id}. ${s.title}`)
  if (s.task) {
    const t = parseTasks(readText(rel(root, "workflow/TASKS.md"))).find((x) => x.num === s.task)
    if (t) lines.push(`Задача: №${s.task} · ${t.statusWord}`)
    else {
      const arch = parseTasks(readText(rel(root, "workflow/TASKS-archive.md"))).find((x) => x.num === s.task)
      lines.push(`Задача: №${s.task}${arch ? " · ГОТОВА (в workflow/TASKS-archive.md)" : " (ни в TASKS, ни в архиве не найдена!)"}`)
    }
  }
  lines.push(`Всего открытых шагов: ${openSteps.length} (${openSteps.map((x) => x.id).join(", ")})`)
  return lines.join("\n")
}

function cmdClaim(root, n, opts) {
  if (!Number.isInteger(n)) throw new ProtocolError("укажите номер задачи: protocol claim 7")
  return withLock(root, () => claimLocked(root, n, opts))
}

function claimLocked(root, n, opts) {
  const md = readText(rel(root, "workflow/TASKS.md"))
  const task = parseTasks(md).find((t) => t.num === n)
  if (!task) {
    const arch = parseTasks(readText(rel(root, "workflow/TASKS-archive.md"))).find((t) => t.num === n)
    if (arch) throw new ProtocolError(`задача №${n} в архиве (workflow/TASKS-archive.md) — закрыта, брать нечего`)
    throw new ProtocolError(`задачи №${n} нет в workflow/TASKS.md`)
  }
  if (task.statusWord === "ГОТОВА") throw new ProtocolError(`задача №${n} уже закрыта`)

  const owner = opts.as || process.env.PROTOCOL_OWNER || "agent"
  const tool = process.env.PROTOCOL_TOOL || "cli"
  const claimPath = rel(root, `workflow/claims/${n}.json`)
  const prev = readJson(claimPath)
  const now = Date.now()
  const prevActive = prev && Date.parse(prev.expiresAt) > now
  const busyText = (info) =>
    [
      `Задача №${n} уже занята: «${info.owner}»${info.session ? " (сессия " + info.session + ")" : ""}.`,
      `Взята ${fmtClock(info.takenAt)}, истекает ${fmtClock(info.expiresAt)}.`,
      "Не перехватывай вслепую — спроси пользователя.",
      `Если он разрешил: node workflow/tools/protocol.mjs claim ${n} --force`,
    ].join("\n")

  if (prevActive && prev.owner !== owner && !opts.force) return { code: 2, text: busyText(prev) }

  const claim = {
    task: n,
    owner,
    tool,
    ...(opts.session ? { session: opts.session } : prev && prev.session ? { session: prev.session } : {}),
    takenAt: prevActive && prev.takenAt ? prev.takenAt : nowIso(),
    heartbeatAt: nowIso(),
    expiresAt: nowIso(new Date(now + CLAIM_TTL_MS)),
  }
  if (prevActive) {
    writeJson(claimPath, claim) // продление своего захвата или --force
  } else if (!writeJsonNew(claimPath, claim)) {
    // Пока читали — захват успел создать другой чат: файл создаётся атомарно («wx»), победитель один.
    const rival = readJson(claimPath)
    if (rival && Date.parse(rival.expiresAt) > Date.now() && rival.owner !== owner && !opts.force) {
      return { code: 2, text: busyText(rival) }
    }
    writeJson(claimPath, claim)
  }
  if (task.statusWord !== "В РАБОТЕ") {
    saveTasks(root, md, task, `В РАБОТЕ (${today()}, ${owner})`)
  }
  return {
    code: 0,
    text: [
      `Взял задачу №${n} — ${clip(task.title, 120)}`,
      `Захват: workflow/claims/${n}.json (владелец «${owner}»), истекает ${fmtClock(nowIso(new Date(now + CLAIM_TTL_MS)))}.`,
      task.statusWord !== "В РАБОТЕ" ? `workflow/TASKS.md: статус → В РАБОТЕ (${today()}, ${owner}).` : "workflow/TASKS.md уже был «В РАБОТЕ».",
      "Правило: пока чат пишет сообщения — захват продлевается; 3 ч молчания → задачу можно перехватить.",
    ].join("\n"),
  }
}

function cmdRelease(root, n) {
  if (!Number.isInteger(n)) throw new ProtocolError("укажите номер задачи: protocol release 7")
  return withLock(root, () => {
    const p = rel(root, `workflow/claims/${n}.json`)
    const existed = existsSync(p)
    if (existed) unlinkSync(p)
    const md = readText(rel(root, "workflow/TASKS.md"))
    const task = parseTasks(md).find((t) => t.num === n)
    if (task && task.statusWord === "В РАБОТЕ") saveTasks(root, md, task, `СВОБОДНА (освобождена ${today()})`)
    return `Задача №${n}: захват ${existed ? "снят" : "отсутствовал"}${task && task.statusWord === "В РАБОТЕ" ? ", статус → СВОБОДНА" : ""}.`
  })
}

function cmdFinish(root, n) {
  if (!Number.isInteger(n)) throw new ProtocolError("укажите номер задачи: protocol finish 7")
  return withLock(root, () => finishLocked(root, n))
}

function finishLocked(root, n) {
  const md = readText(rel(root, "workflow/TASKS.md"))
  const task = parseTasks(md).find((t) => t.num === n)
  if (!task) {
    const arch = parseTasks(readText(rel(root, "workflow/TASKS-archive.md"))).find((t) => t.num === n)
    if (arch) throw new ProtocolError(`задача №${n} уже в архиве (workflow/TASKS-archive.md)`)
    throw new ProtocolError(`задачи №${n} нет в workflow/TASKS.md`)
  }
  const was = task.statusWord
  if (was === "ГОТОВА") throw new ProtocolError(`задача №${n} уже закрыта`)

  saveTasks(root, md, task, `ГОТОВА (${today()}: закрыто \`protocol finish\`)`)
  const claimPath = rel(root, `workflow/claims/${n}.json`)
  if (existsSync(claimPath)) unlinkSync(claimPath)

  const state = loadState(root)
  const lines = [`Задача №${n} закрыта: ${was} → ГОТОВА (${today()}).`]

  let planInfo = null
  for (const [key, plan] of Object.entries(state.plans || {})) {
    const step = (plan.steps || []).find((s) => s.task === n)
    if (!step) continue
    if (step.status !== "done") {
      step.status = "done"
      step.done = today()
      lines.push(`Шаг ${step.id} плана ${key} → ГОТОВ.`)
    }
    const open = (plan.steps || []).filter((s) => s.status !== "done")
    if (!open.length && plan.status !== "closed") {
      plan.status = "closed"
      plan.closed = today()
      lines.push(`План ${key} закрыт (${today()}).`)
    }
    planInfo = { key, plan, open }
    break
  }

  if (planInfo) {
    if (planInfo.open.length) {
      const s = planInfo.open[0]
      state.next = {
        kind: "step",
        task: s.task,
        plan: planInfo.key,
        text: `Шаг ${s.id} плана «${planInfo.plan.title}»: ${s.title}`,
        why: `следующий незакрытый шаг плана ${planInfo.key}`,
      }
    } else {
      state.next = {
        kind: "decision",
        task: null,
        text: `План «${planInfo.plan.title}» закрыт ${today()}. Выбрать следующий этап по project/roadmap.md`,
        why: "в плане не осталось незакрытых шагов",
      }
      if (state.stage && state.stage.plan === planInfo.key) {
        state.stage.status = "closed"
        if (!state.stage.closed) state.stage.closed = today()
      }
    }
  } else if (state.next && state.next.task === n) {
    state.next = {
      kind: "decision",
      task: null,
      text: "Предыдущий шаг закрыт. Определить следующий шаг: workflow/STATUS.md, project/roadmap.md",
      why: `задача №${n} закрыта`,
    }
  }

  saveState(root, state)
  lines.push(`workflow/state.json: next → ${state.next.text}`)
  lines.push("НЕ ЗАБУДЬ (протокол): запись в workflow/LOG.md сверху + обновить workflow/STATUS.md.")
  return lines.join("\n")
}

function cmdPrune(root, opts = {}) {
  return withLock(root, () => pruneLocked(root, opts))
}

function pruneLocked(root, opts) {
  const md = readText(rel(root, "workflow/TASKS.md"))
  if (!md) throw new ProtocolError("workflow/TASKS.md не найден")
  const crlf = md.includes("\r\n")
  const lines = md.split(/\r?\n/)
  const tasks = parseTasks(md)
  const openCount = tasks.filter((t) => t.statusWord !== "ГОТОВА").length
  const closed = tasks.filter((t) => t.statusWord === "ГОТОВА")
  const keepCount = Number.isInteger(opts.keep) ? opts.keep : PRUNE_KEEP
  const days = Number.isInteger(opts.days) ? opts.days : PRUNE_DAYS
  // keepCount = 0 → не оставляем ничего (slice(-0) вернул бы весь массив).
  const keepSet = new Set((keepCount > 0 ? closed.slice(-keepCount) : []).map((t) => t.lineIndex))
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000
  const move = []
  const undated = []
  for (const t of closed) {
    if (keepSet.has(t.lineIndex)) continue
    const ts = taskDate(t)
    if (ts === null) {
      undated.push(t)
      continue
    }
    if (ts < cutoff) move.push(t)
  }
  const undatedNote = undated.length
    ? `\nБез полной даты (не переносил): ${undated.map((t) => "№" + t.num).join(", ")}`
    : ""
  if (!move.length) {
    return {
      code: 0,
      text:
        `Нечего переносить: закрытых ${closed.length}, старше ${days} дн. — 0 ` +
        `(последние ${keepCount} закрытых остаются всегда).${undatedNote}`,
    }
  }
  if (opts.dry) {
    return {
      code: 0,
      text: [
        `ПЕРЕНЕСЁТ В workflow/TASKS-archive.md (${move.length}) — это предпросмотр, ничего не изменено:`,
        ...move.map((t) => `- №${t.num} · ${clip(t.title, 80)} · ${fmtDay(taskDate(t))}`),
        "",
        `Останется в TASKS.md: открытых ${openCount}, закрытых ${closed.length - move.length}.`,
      ].join("\n"),
    }
  }

  const archivePath = rel(root, "workflow/TASKS-archive.md")
  const header =
    "# TASKS-archive — закрытые задачи (история)\n\n" +
    "> Перенесено из `workflow/TASKS.md` командой `node workflow/tools/protocol.mjs prune`.\n" +
    "> В `workflow/TASKS.md` остаются незакрытые и последние 10 закрытых.\n\n" +
    "| # | Задача | Статус | Кто взял | Когда |\n" +
    "|---|--------|--------|----------|-------|"
  const prev = readText(archivePath)
  const body = (prev ? prev.replace(/\s*$/, "") : header) + "\n"
  writeText(archivePath, body + move.map((t) => t.line).join("\n") + "\n")

  const drop = new Set(move.map((t) => t.lineIndex))
  writeText(rel(root, "workflow/TASKS.md"), lines.filter((_, i) => !drop.has(i)).join(crlf ? "\r\n" : "\n"))

  return {
    code: 0,
    text: [
      `Перенесено в workflow/TASKS-archive.md: ${move.length}`,
      ...move.map((t) => `- №${t.num} · ${clip(t.title, 80)} · ${fmtDay(taskDate(t))}`),
      "",
      `В workflow/TASKS.md осталось: открытых ${openCount}, закрытых ${closed.length - move.length}.${undatedNote}`,
    ].join("\n"),
  }
}

/** Бюджет файлов: чтобы «километры текста» не возвращались. */
function budgetReport(root) {
  const statusMd = readText(rel(root, "workflow/STATUS.md"))
  const tasksMd = readText(rel(root, "workflow/TASKS.md"))
  const logMd = readText(rel(root, "workflow/LOG.md"))
  const ctxMd = readText(rel(root, "workflow/CONTEXT.md"))
  const tasks = parseTasks(tasksMd)
  const longestTask = tasks.reduce((a, t) => (!a || t.line.length > a.line.length ? t : a), null)
  const log = parseLog(logMd)
  // Проверяем свежую запись: история append-only, её длину изменить нельзя.
  const latestEntry = log[0] || null

  const fmt = (n) => (n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(n))
  const line = (name, value, max, unit, extra = "") => {
    const ok = value <= max
    return { ok, text: `- ${name}: ${fmt(value)} / ${fmt(max)} ${unit} ${ok ? "✓" : "✗ ПРЕВЫШЕНИЕ"}${extra}` }
  }
  const rows = [
    line("CONTEXT.md", Buffer.byteLength(ctxMd, "utf8"), BUDGET.context, "байт"),
    line("TASKS.md", tasksMd.length, BUDGET.tasks, "симв."),
    line(
      "TASKS: макс. строка",
      longestTask ? longestTask.line.length : 0,
      BUDGET.row,
      "симв.",
      longestTask && longestTask.line.length > BUDGET.row ? ` (№${longestTask.num})` : "",
    ),
    line("STATUS.md", statusMd.length, BUDGET.status, "симв."),
    line(
      "LOG: верхняя запись",
      latestEntry ? latestEntry.body.length : 0,
      BUDGET.logEntry,
      "симв.",
      latestEntry && latestEntry.body.length > BUDGET.logEntry ? ` (${latestEntry.date || "?"})` : "",
    ),
  ]
  return { rows, warnings: rows.filter((r) => !r.ok).length }
}

function cmdCheck(root) {
  const state = loadState(root)
  const tasksMd = readText(rel(root, "workflow/TASKS.md"))
  const logMd = readText(rel(root, "workflow/LOG.md"))
  const tasks = parseTasks(tasksMd)
  const byNum = new Map(tasks.map((t) => [t.num, t]))
  // Архив (`prune`) — те же задачи, только перенесённые; шаги плана и next должны их видеть.
  const archivedByNum = new Map(
    parseTasks(readText(rel(root, "workflow/TASKS-archive.md"))).map((t) => [t.num, t]),
  )
  const findTask = (num) => byNum.get(num) || archivedByNum.get(num)
  const problems = []

  if (!tasks.length) problems.push("workflow/TASKS.md: таблица задач не распознана")

  let stepsTotal = 0
  let stepsDone = 0
  for (const [key, plan] of Object.entries(state.plans || {})) {
    for (const s of plan.steps || []) {
      stepsTotal++
      if (s.status === "done") stepsDone++
      if (!Number.isInteger(s.task)) continue
      const t = findTask(s.task)
      if (!t) {
        problems.push(`${key}: шаг ${s.id} ссылается на задачу №${s.task}, которой нет ни в TASKS, ни в архиве`)
        continue
      }
      if (s.status === "done" && t.statusWord !== "ГОТОВА") {
        problems.push(`${key}: шаг ${s.id} помечен done, но задача №${s.task} — ${t.statusWord}`)
      }
      if (s.status !== "done" && t.statusWord === "ГОТОВА") {
        problems.push(`${key}: шаг ${s.id} открыт, но задача №${s.task} уже ГОТОВА`)
      }
    }
  }

  if (state.next && Number.isInteger(state.next.task)) {
    const t = findTask(state.next.task)
    if (!t) problems.push(`next ссылается на задачу №${state.next.task}, которой нет ни в TASKS, ни в архиве`)
    else if (t.statusWord === "ГОТОВА") {
      const where = byNum.has(state.next.task) ? "закрытую задачу" : "задачу из архива"
      problems.push(`next ссылается на уже ${where} №${t.num}`)
    }
  }

  const claims = listClaims(root)
  const staleClaims = claims.filter((c) => !c.active)

  const log = parseLog(logMd)
  const topDate = log[0] ? log[0].date : ""
  const statusMd = readText(rel(root, "workflow/STATUS.md"))
  const m = statusMd.match(/Обновлено:\**\s*(\d{2}\.\d{2}\.\d{4})/)
  const statusDate = m ? m[1] : ""
  const toTs = (d) => {
    const [dd, mm, yy] = String(d).split(".")
    return Date.UTC(Number(yy), Number(mm) - 1, Number(dd))
  }
  const dateDrift = []
  if (topDate && statusDate && toTs(topDate) > toTs(statusDate)) {
    dateDrift.push(`workflow/STATUS.md отстаёт от журнала: STATUS ${statusDate}, верхняя запись LOG ${topDate}`)
  }
  if (topDate && state.updated && toTs(topDate) > toTs(fmtDay(state.updated))) {
    dateDrift.push(`workflow/state.json отстаёт от журнала: state ${fmtDay(state.updated)}, LOG ${topDate}`)
  }
  problems.push(...dateDrift)

  const open = tasks.filter((t) => t.statusWord !== "ГОТОВА")
  const fresh = dateDrift.length === 0 ? "fresh" : "stale"
  const lines = [
    "ПРОВЕРКА ПРОТОКОЛА",
    `движок: v${ENGINE_VERSION} (workflow/tools/protocol.mjs)`,
    `state.json: ${state.updated ? "обновлён " + fmtClock(state.updated) : "нет поля updated"}`,
    `задачи: ${tasks.length} строк, открытых ${open.length}`,
    `шаги планов: ${stepsDone}/${stepsTotal} закрыто (${Object.keys(state.plans || {}).length} план(ов))`,
    `захваты: активных ${claims.filter((c) => c.active).length}, просроченных ${staleClaims.length}`,
    `свежесть: STATUS ${statusDate || "?"} · LOG ${topDate || "?"} → ${fresh}`,
    "",
  ]
  const budget = budgetReport(root)
  lines.push("", "БЮДЖЕТ (лимиты против разрастания)")
  lines.push(...budget.rows.map((r) => r.text))
  if (budget.warnings) {
    lines.push(
      `Предупреждений по бюджету: ${budget.warnings} (не блокирует; сократить — или \`protocol prune\`, или детали в workflow/tasks/<N>.md)`,
    )
  }
  lines.push("")
  if (problems.length) {
    lines.push(`РАСХОЖДЕНИЯ (${problems.length}):`)
    for (const p of problems) lines.push(`- ${p}`)
  } else {
    lines.push("Расхождений нет.")
  }
  return { code: problems.length ? 1 : 0, text: lines.join("\n") }
}

function cmdSessions(root) {
  const sessions = listSessions(root)
  if (!sessions.length) return "Живых сессий нет (workflow/sessions пуст или все старше 24 ч)."
  return [
    `ЖИВЫЕ СЕССИИ (${sessions.length}, TTL 24 ч)`,
    ...sessions.map(
      (s) =>
        `- ${s.sessionID} — активность ${s.ageMin} мин назад, старт ${fmtClock(s.startedAt)}, сообщений ${s.userMessages || 0}\n  тема: «${clip(s.topic || "(без темы)", 120)}»`,
    ),
  ].join("\n")
}

export function buildContext(root, level = 0) {
  const state = loadState(root)
  const tasks = parseTasks(readText(rel(root, "workflow/TASKS.md")))
  const open = tasks.filter((t) => t.statusWord !== "ГОТОВА")
  const log = parseLog(readText(rel(root, "workflow/LOG.md")))
  const claims = listClaims(root).filter((c) => c.active)
  const sessions = listSessions(root)
  const titleMax = level === 0 ? 90 : level === 1 ? 60 : 40
  const logCount = level === 0 ? LOG_HEAD_ENTRIES : level === 1 ? 2 : 1

  const L = []
  L.push("# CONTEXT — что происходит в проекте (краткий бриф)")
  L.push("")
  L.push(`> Сгенерировано \`node workflow/tools/protocol.mjs context --write\` в ${fmtClock(new Date())}.`)
  L.push("> Вручную не править: перегенерировать командой. Полные данные — `workflow/STATUS.md`, `workflow/TASKS.md`, `workflow/LOG.md`.")
  L.push("")
  L.push("## Этап")
  L.push(stageLine(state))
  const st = stagesLine(state)
  if (st) L.push(st)
  L.push("")
  L.push("## Следующий шаг")
  L.push(...nextBlock(state, tasks))
  L.push("")
  L.push("## Задачи")
  const working = open.filter((t) => t.statusWord === "В РАБОТЕ")
  L.push("В работе: " + (working.length ? working.map((t) => `№${t.num} «${clip(t.title, 60)}»`).join("; ") : "нет"))
  if (open.length) {
    L.push(`Свободно/открыто (${open.length}):`)
    for (const t of open) L.push(`- №${t.num} · ${t.statusWord} — ${clip(t.title, titleMax)}`)
  } else {
    L.push("Незакрытых задач нет.")
  }
  L.push("")
  L.push("## Захваты (TTL 3 ч)")
  if (!claims.length) L.push("нет активных")
  for (const c of claims) L.push(`- №${c.task} — «${c.owner}», истекает ${fmtClock(c.expiresAt)}`)
  if (sessions.length) {
    L.push("")
    L.push("## Живые сессии OpenCode")
    for (const s of sessions) L.push(`- «${clip(s.topic || "(без темы)", 60)}» — ${s.ageMin} мин назад`)
  }
  L.push("")
  L.push("## Последние записи журнала")
  for (const e of log.slice(0, logCount)) {
    L.push(`- ${e.date}${e.time ? " " + e.time : ""} — ${clip(e.title, titleMax + 40)}`)
    if (e.leftover) L.push(`  Осталось: ${clip(e.leftover, level === 0 ? 300 : 150)}`)
  }
  L.push("")
  L.push("## Как отвечать на вопросы о состоянии")
  L.push("Только командами (не по памяти): `node workflow/tools/protocol.mjs next` — что дальше;")
  L.push("`open` — что не доделано; `step <план>` — незакрытый шаг плана; `claim N` / `finish N` — взял/закрыл.")
  L.push("")
  return L.join("\n")
}

/** Бриф для инъекции: то же, что пишет `context --write`, с авто-сжатием до лимита. */
export function contextText(root) {
  let text = buildContext(root, 0)
  for (const level of [1, 2]) {
    if (Buffer.byteLength(text, "utf8") <= CONTEXT_LIMIT) break
    text = buildContext(root, level)
  }
  return text
}

function cmdContext(root, write) {
  const text = contextText(root)
  const bytes = Buffer.byteLength(text, "utf8")
  if (write) {
    writeText(rel(root, "workflow/CONTEXT.md"), text)
    return `workflow/CONTEXT.md записан: ${bytes} байт (лимит ${CONTEXT_LIMIT}).\n\n` + text
  }
  const over = bytes > CONTEXT_LIMIT ? `\n(внимание: ${bytes} байт — больше лимита ${CONTEXT_LIMIT})` : ""
  return text + over
}

export const HELP = `protocol — единый ответ о состоянии проекта (любой агент, shell)

  node workflow/tools/protocol.mjs next                какой следующий шаг
  node workflow/tools/protocol.mjs open                что не доделано (задачи, захваты, сессии, LOG)
  node workflow/tools/protocol.mjs step <план>         последний незакрытый шаг плана
  node workflow/tools/protocol.mjs claim <N>           взять задачу (TTL 3 ч) + TASKS → В РАБОТЕ
  node workflow/tools/protocol.mjs release <N>         освободить задачу
  node workflow/tools/protocol.mjs finish <N>          закрыть: TASKS → ГОТОВА, шаг плана → done, next пересчёт
  node workflow/tools/protocol.mjs check               сверка state ↔ TASKS ↔ LOG + бюджет файлов
  node workflow/tools/protocol.mjs prune [--dry]       закрытые >14 дн. → workflow/TASKS-archive.md (последние 10 остаются)
  node workflow/tools/protocol.mjs context [--write]   компактный бриф (--write → workflow/CONTEXT.md)
  node workflow/tools/protocol.mjs sessions            живые сессии OpenCode
  node --test                          тесты движка (25 проверок, без зависимостей)

Флаги: --force (перехватить чужой активный захват), --as <имя> (кто взял),
       --write (записать workflow/CONTEXT.md), --dry (предпросмотр prune),
       --days N / --keep N (настройки prune).
Окружение: PROTOCOL_ROOT, PROTOCOL_OWNER, PROTOCOL_TOOL.
Бюджеты (check): строка задачи ≤500, TASKS ≤12k, STATUS ≤10k, запись LOG ≤2500, CONTEXT ≤4k.`

/* ----------------------------------------------------------------- main */

function takeFlag(args, name) {
  const i = args.indexOf(name)
  if (i < 0) return false
  args.splice(i, 1)
  return true
}

function takeValue(args, name) {
  const i = args.indexOf(name)
  if (i < 0 || i + 1 >= args.length) return null
  const v = args[i + 1]
  args.splice(i, 2)
  return v
}

export function main(argv = process.argv.slice(2)) {
  const args = [...argv]
  const force = takeFlag(args, "--force")
  const write = takeFlag(args, "--write")
  const dry = takeFlag(args, "--dry")
  const as = takeValue(args, "--as")
  const session = takeValue(args, "--session")
  const days = takeValue(args, "--days")
  const keep = takeValue(args, "--keep")
  const cmd = (args.shift() || "help").toLowerCase()
  const rest = args
  const root = projectRoot()
  const num = rest.length && /^\d+$/.test(rest[0]) ? Number(rest[0]) : NaN

  try {
    switch (cmd) {
      case "next":
        return { code: 0, text: cmdNext(root) }
      case "open":
        return { code: 0, text: cmdOpen(root) }
      case "step":
        return { code: 0, text: cmdStep(root, rest.join(" ").trim()) }
      case "claim":
        return cmdClaim(root, num, { force, as, session })
      case "release":
        return { code: 0, text: cmdRelease(root, num) }
      case "finish":
        return { code: 0, text: cmdFinish(root, num) }
      case "check":
        return cmdCheck(root)
      case "prune":
        return cmdPrune(root, {
          dry,
          days: days && /^\d+$/.test(days) ? Number(days) : undefined,
          keep: keep && /^\d+$/.test(keep) ? Number(keep) : undefined,
        })
      case "context":
        return { code: 0, text: cmdContext(root, write) }
      case "sessions":
        return { code: 0, text: cmdSessions(root) }
      case "help":
      case "--help":
      case "-h":
        return { code: 0, text: HELP }
      default:
        return { code: 1, text: `Неизвестная команда «${cmd}».\n\n${HELP}` }
    }
  } catch (err) {
    return { code: err.code || 1, text: "protocol: " + (err.message || String(err)) }
  }
}

const invokedDirectly = (() => {
  try {
    return import.meta.url === pathToFileURL(process.argv[1]).href
  } catch {
    return false
  }
})()

if (invokedDirectly) {
  const res = main()
  const stream = res.code === 0 ? process.stdout : process.stderr
  stream.write(res.text + "\n")
  process.exitCode = res.code
}
