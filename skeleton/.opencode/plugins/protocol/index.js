/**
 * Плагин protocol — принудительное соблюдение протокола AGENTS.md.
 *
 * Что делает (всё выключается одним флаг-файлом):
 *  1. Авто-контекст на старте сессии: правила + workflow/CONTEXT.md (≤ 4 КБ).
 *     Полные STATUS/TASKS/LOG в контекст НЕ вливаются — агент читает их файлами
 *     (полный файловый бриф остался фолбэком, если нет CONTEXT.md и ядра протокола).
 *  2. Реестр живых сессий: workflow/sessions/<sessionID>.json, heartbeat на каждом
 *     сообщении, TTL 24 ч, старые файлы чистятся. На каждом запросе к модели в
 *     system добавляется блок «Активные сессии» (если есть другие чаты) — так
 *     чаты видят друг друга и не перехватывают чужую задачу вслепую.
 *  3. Напоминание на каждое сообщение + чек-ин на первом.
 *  4. Контроль журнала: если в сессии правились файлы кода/сервера, а
 *     workflow/LOG.md не обновлён после последней правки — приписка «задача не
 *     завершена» (не блокирует, только напоминает). Запись в %TEMP% правкой не считается.
 *  5. Гвард опасных shell-команд (dnf/apt/rm -rf/DROP/migrate:fresh/...):
 *     permission deny с пояснением. Ослабляется, если последние сообщения
 *     пользователя содержат «разрешаю/подтверждаю/одобряю».
 *
 * KILL-SWITCH (один файл):
 *  ВКЛЮЧЕНО:  существует файл workflow/PROTOCOL-ON (содержимое ≠ "off"/"0")
 *  ВЫКЛЮЧЕНО: файла нет, или внутри "off"/"0".
 *  Отключить — удалить файл; включить обратно — создать.
 *  STATUS/LOG/TASKS от плагина не зависят.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"

const SESSION_TTL_MS = 24 * 60 * 60 * 1000 // реестр: сколько живёт запись о сессии
const CLAIM_TTL_MS = 3 * 60 * 60 * 1000 // захват задачи: 3 часа БЕЗ активности (продлевается)
const LOG_ENTRIES = 3 // сколько последних записей LOG вливать
const LOG_HEAD = 1200 // символов из начала записи LOG
const LOG_TAIL = 600 // символов из конца записи LOG («Осталось / открытыми»)
const TOPIC_MAX = 120 // длина темы сессии (первое сообщение пользователя)
const REMIND_COOLDOWN_MS = 60 * 1000 // не чаще одной приписки в минуту

const PROTOCOL_FILES = /[\\/]workflow[\\/](STATUS|TASKS|LOG|CONTEXT)\.md$/i
const MUTATION_TOOL = /^(edit|write|patch|multiedit|apply_patch|create_file|replace)/i
const SHELL_TOOL = /^(shell|bash|exec|run|terminal|cmd)/i
const MUTATING_CMD =
  /\b(scp|rsync|rm|mv|sed\s+-i|chmod|chown|dnf|apt|apt-get|yum|systemctl|migrate|deploy)\b|>\s*[^\s&|]|\bgit\s+(commit|push|reset|switch|checkout|merge)\b/i
// Команды ядра protocol.mjs, которые надо подхватить из shell-вызова сессии.
const CLAIM_CMD = /protocol\.mjs["']?\s+claim\s+(\d+)/i
const RELEASE_CMD = /protocol\.mjs["']?\s+(?:release|finish)\s+(\d+)/i

// ---------- чистые хелперы (экспортируются для тестов) ----------

export function readText(p) {
  try {
    return readFileSync(p, "utf8")
  } catch {
    return ""
  }
}

export function readJson(p) {
  try {
    return JSON.parse(readFileSync(p, "utf8"))
  } catch {
    return null
  }
}

/** Записи журнала: массив строк, каждая начинается с "## [". */
export function splitLogEntries(md) {
  return md
    .split(/^## \[/m)
    .slice(1)
    .map((chunk) => ("## [" + chunk).trim())
}

/** Строка таблицы TASKS, у которой статус — не «ГОТОВА». */
export function isOpenTaskRow(row) {
  return /\|\s*(СВОБОДНА|В РАБОТЕ|ПЕРЕХВАЧЕНА)/.test(row)
}

export function openTaskRows(tasksMd) {
  return tasksMd
    .split(/\r?\n/)
    .filter((line) => line.startsWith("|") && isOpenTaskRow(line))
}

/** Длинную запись режем по краям: начало (что сделано) + конец (что осталось). */
export function clip(text, head = LOG_HEAD, tail = LOG_TAIL) {
  const t = String(text).trim()
  if (t.length <= head + tail + 40) return t
  return (
    t.slice(0, head).trimEnd() +
    "\n… (обрезано; полный текст — workflow/LOG.md)\n" +
    t.slice(-tail).trimStart()
  )
}

function fmtClock(iso) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return "?"
  const p = (n) => String(n).padStart(2, "0")
  return `${p(d.getDate())}.${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function mtimeMs(p) {
  try {
    return statSync(p).mtimeMs
  } catch {
    return 0
  }
}

function sessionsDir(dir) {
  return path.join(dir, "workflow", "sessions")
}

/** Удаляет записи, heartbeat которых старше TTL. */
function cleanupSessions(dir, now = Date.now()) {
  const d = sessionsDir(dir)
  if (!existsSync(d)) return
  for (const file of readdirSync(d)) {
    if (!file.endsWith(".json")) continue
    const full = path.join(d, file)
    const info = readJson(full)
    const hb = info ? Date.parse(info.heartbeatAt) : NaN
    if (!Number.isFinite(hb) || now - hb > SESSION_TTL_MS) {
      try {
        unlinkSync(full)
      } catch {
        // файл уже удалён параллельной сессией — не мешаем работе
      }
    }
  }
}

/** Запись/обновление своей сессии (heartbeat). Своя тема не перезаписывается. */
export function heartbeat(dir, sessionID, topic) {
  try {
    const d = sessionsDir(dir)
    if (!existsSync(d)) mkdirSync(d, { recursive: true })
    const file = path.join(d, sessionID + ".json")
    const prev = readJson(file) || {}
    const now = new Date().toISOString()
    writeFileSync(
      file,
      JSON.stringify(
        {
          sessionID,
          startedAt: prev.startedAt || now,
          heartbeatAt: now,
          directory: dir,
          topic: prev.topic || topic || "",
          userMessages: (prev.userMessages || 0) + 1,
        },
        null,
        2,
      ) + "\n",
    )
  } catch {
    // реестр — вспомогательный: не смогли записать — работа продолжается
  }
}

/** Блок «кто ещё работает» для system-контекста (без своей сессии). */
export function sessionsBlock(dir, selfID, now = Date.now()) {
  const d = sessionsDir(dir)
  if (!existsSync(d)) return ""
  const rows = []
  for (const file of readdirSync(d)) {
    if (!file.endsWith(".json")) continue
    const info = readJson(path.join(d, file))
    if (!info || !info.sessionID || info.sessionID === selfID) continue
    const hb = Date.parse(info.heartbeatAt)
    if (!Number.isFinite(hb) || now - hb > SESSION_TTL_MS) continue
    rows.push({ ...info, ageMin: Math.max(0, Math.round((now - hb) / 60000)) })
  }
  if (!rows.length) return ""
  rows.sort((a, b) => Date.parse(b.heartbeatAt) - Date.parse(a.heartbeatAt))
  const lines = rows.map(
    (r) =>
      `- ${String(r.sessionID).slice(0, 14)}… «${r.topic || "(без темы)"}» — активность ${r.ageMin} мин назад, старт ${fmtClock(r.startedAt)}`,
  )
  return (
    "===== Активные сессии (workflow/sessions, TTL 24 ч) =====\n" +
    lines.join("\n") +
    "\nЗахват задачи: своя строка в workflow/TASKS.md «В РАБОТЕ» + дата. Чужую задачу, взятую менее часа назад, не перехватывать."
  )
}

/** Блок «кто что взял» (workflow/claims, TTL 3 ч) для system-контекста. */
export function claimsBlock(dir, now = Date.now()) {
  const d = path.join(dir, "workflow", "claims")
  if (!existsSync(d)) return ""
  const rows = []
  for (const file of readdirSync(d)) {
    if (!file.endsWith(".json")) continue
    const info = readJson(path.join(d, file))
    if (!info || !Number.isInteger(info.task)) continue
    const exp = Date.parse(info.expiresAt)
    if (!Number.isFinite(exp) || exp <= now) continue
    rows.push(info)
  }
  if (!rows.length) return ""
  rows.sort((a, b) => a.task - b.task)
  const lines = rows.map(
    (r) =>
      `- №${r.task} — занята «${r.owner || "?"}»${r.session ? " (сессия " + String(r.session).slice(0, 14) + "…)" : ""}, истекает ${fmtClock(r.expiresAt)}`,
  )
  return "===== Захваты задач (workflow/claims, TTL 3 ч без активности) =====\n" + lines.join("\n")
}

/** Продление своих захватов: пока сессия пишет — 3 ч отсчитываются заново. */
export function refreshClaims(dir, tasks, sessionID, now = Date.now()) {
  for (const task of tasks) {
    const p = path.join(dir, "workflow", "claims", `${task}.json`)
    const info = readJson(p)
    if (!info || !Number.isInteger(info.task)) continue
    try {
      info.heartbeatAt = new Date(now).toISOString()
      info.expiresAt = new Date(now + CLAIM_TTL_MS).toISOString()
      if (!info.session && sessionID) info.session = sessionID
      writeFileSync(p, JSON.stringify(info, null, 2) + "\n", "utf8")
    } catch {
      // захват — вспомогательный: не смогли продлить, истечёт сам
    }
  }
}

/** Правила — коротко. Полные файлы в контекст не вливаются (см. workflow/CONTEXT.md). */
export const BRIEF_RULES =
  "[protocol] ПРАВИЛА ПРОЕКТА (AGENTS.md): 1) правки кода/файлов проекта и любые действия на сервере — " +
  "ТОЛЬКО по явной команде пользователя «делай»; 2) закончил задачу — запись в workflow/LOG.md сверху + " +
  "обновить workflow/STATUS.md и workflow/TASKS.md, иначе задача считается незавершённой; 3) новый этап — только " +
  "по «делай»; 4) деструктивные команды на сервере без подтверждения запрещены; 5) ПЕРВЫЙ ответ сессии " +
  "начни строкой «(protocol✔) STATUS прочитан — <дата>, задачи в работе: №…, беру/отвечаю: …»; " +
  "6) состояние проекта (что дальше / что не доделано / шаг плана) — командой " +
  "`node workflow/tools/protocol.mjs next|open|step|claim|finish|check`, а не по памяти; полные TASKS/LOG читай файлами."

/** Полный бриф для первого запроса сессии (фолбэк, если нет workflow/CONTEXT.md и ядра). */
export function buildBrief({ status, tasks, log, sessions = "", claims = "" }) {
  const rows = openTaskRows(tasks)
  const entries = splitLogEntries(log).slice(0, LOG_ENTRIES)
  const rules = BRIEF_RULES

  const parts = [rules]
  parts.push("===== workflow/STATUS.md (полностью) =====\n" + status.trim())
  parts.push(
    `===== workflow/TASKS.md — только незакрытые задачи (${rows.length}) =====\n` +
      (rows.length ? rows.join("\n") : "(незакрытых задач нет)"),
  )
  parts.push(
    `===== workflow/LOG.md — последние ${entries.length} записей =====\n` +
      (entries.length ? entries.map((e) => clip(e)).join("\n\n") : "(журнал пуст)"),
  )
  if (sessions) parts.push(sessions)
  if (claims) parts.push(claims)
  return parts.join("\n\n")
}

/** Что считается правкой файлов/сервера в этой сессии. */
export function touchedTarget(tool, input) {
  const name = String(tool || "")
  const data = input || {}
  if (MUTATION_TOOL.test(name)) {
    const file = String(data.path || data.filePath || data.file_path || data.file || "")
    // Временные файлы (%TEMP%, /tmp) — не правка проекта: тесты и выгрузки не должны
    // требовать записи в LOG.
    return TEMP_TARGET.test(file) ? "" : file
  }
  if (SHELL_TOOL.test(name)) {
    const cmd = stripTempRedirects(String(data.command || data.cmd || ""))
    if (MUTATING_CMD.test(cmd)) return cmd.slice(0, TOPIC_MAX)
  }
  return ""
}

const TEMP_TARGET = /(%temp%|\$env:temp|\$env:tmp|[\\/](temp|tmp)[\\/])/i

/**
 * Запись в %TEMP% — не правка проекта: иначе тесты и выгрузки в temp дают
 * ложное «правил файлы, а LOG не обновлён».
 */
export function stripTempRedirects(cmd) {
  return String(cmd).replace(/>>?\s*("[^"]*"|[^\s&|;]+)/g, (whole, target) => {
    const t = String(target).replace(/^"|"$/g, "")
    return TEMP_TARGET.test(t) ? "" : whole
  })
}

function oneLine(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, TOPIC_MAX)
}

// ---------- плагин ----------

export default {
  id: "protocol",
  async setup(ctx) {
    const dir = ctx.location?.directory || process.cwd()
    const seen = new Set() // sessionID, куда уже влит полный бриф
    const greeted = new Set() // sessionID, где уже был чек-ин
    const state = new Map() // sessionID -> { touches, lastTouchAt, lastRemindedAt }
    const regs = []

    const enabled = () => {
      try {
        const p = path.join(dir, "workflow", "PROTOCOL-ON")
        if (!existsSync(p)) return false
        const v = readFileSync(p, "utf8").trim().toLowerCase()
        return v !== "off" && v !== "0"
      } catch {
        return false
      }
    }

    const stateOf = (sessionID) => {
      let s = state.get(sessionID)
      if (!s) {
        s = { touches: [], lastTouchAt: 0, lastRemindedAt: 0, claims: new Set() }
        state.set(sessionID, s)
      }
      return s
    }

    // Один недоступный хук не должен ронять весь протокол.
    const reg = async (label, register) => {
      try {
        regs.push(await register())
      } catch (err) {
        try {
          console.error("[protocol] хук не зарегистрирован: " + label + " — " + (err && err.message))
        } catch {}
      }
    }

    // --- 1+2. Авто-контекст сессии (system) + живой список сессий ---
    // Ядро protocol.mjs — единый источник состояния (если файла нет, остаётся фолбэк по файлам).
    let core = null
    try {
      core = await import(pathToFileURL(path.join(dir, "workflow", "tools", "protocol.mjs")).href)
    } catch {
      core = null
    }

    await reg("session.context", () =>
      ctx.session.hook("context", (event) => {
        if (!enabled()) return
        try {
          if (!seen.has(event.sessionID)) {
            seen.add(event.sessionID)
            cleanupSessions(dir)
            const extra = [sessionsBlock(dir, event.sessionID), claimsBlock(dir)].filter(Boolean).join("\n\n")

            // Бриф = правила + workflow/CONTEXT.md (≤4 КБ). Полные STATUS/TASKS/LOG в контекст НЕ вливаются.
            let text = ""
            try {
              const digest =
                core && typeof core.contextText === "function"
                  ? core.contextText(dir)
                  : core && typeof core.buildContext === "function"
                    ? core.buildContext(dir, 0)
                    : readText(path.join(dir, "workflow", "CONTEXT.md"))
              if (digest) text = BRIEF_RULES + "\n\n" + digest + (extra ? "\n\n" + extra : "")
            } catch {
              text = ""
            }

            if (!text) {
              // Фолбэк: нет CONTEXT.md и нет ядра — компактный бриф из STATUS + открытых задач + 3 записей LOG
              const status = readText(path.join(dir, "workflow", "STATUS.md"))
              const tasks = readText(path.join(dir, "workflow", "TASKS.md"))
              const log = readText(path.join(dir, "workflow", "LOG.md"))
              if (!status && !tasks && !log) return // файлы протокола недоступны
              text = buildBrief({ status, tasks, log, sessions: sessionsBlock(dir, event.sessionID), claims: claimsBlock(dir) })
            }
            event.system.push({ type: "text", text })
            return
          }
          const live = sessionsBlock(dir, event.sessionID)
          if (live) event.system.push({ type: "text", text: "[protocol] " + live })
        } catch {
          // контекст — вспомогательный: ошибка реестра не должна ломать запрос
        }
      }),
    )

    // --- 3+4. Чек-ин/напоминание + контроль журнала + heartbeat ---
    await reg("session.prompt", () =>
      ctx.session.hook("prompt", (event) => {
        if (!enabled()) return
        const sessionID = event.sessionID
        const text = event.prompt.text || ""
        const s = stateOf(sessionID)

        heartbeat(dir, sessionID, oneLine(text))

        // Свои захваты (protocol claim N из этой сессии) продлеваются на каждом сообщении
        if (s.claims && s.claims.size) refreshClaims(dir, s.claims, sessionID)

        // Контроль журнала: были правки файлов, а LOG.md не обновлён после них
        const logMtime = mtimeMs(path.join(dir, "workflow", "LOG.md"))
        const now = Date.now()
        let journalNote = ""
        if (s.touches.length && logMtime < s.lastTouchAt && now - s.lastRemindedAt > REMIND_COOLDOWN_MS) {
          s.lastRemindedAt = now
          const uniq = [...new Set(s.touches)].slice(-5)
          journalNote =
            "\n\n(protocol) В этой сессии уже правились файлы/сервер (" +
            s.touches.length +
            " действий: " +
            uniq.join("; ") +
            "), а workflow/LOG.md после них не обновлён. По AGENTS.md: закончил задачу → LOG + STATUS + TASKS, иначе задача считается незавершённой."
        } else if (logMtime >= s.lastTouchAt) {
          s.touches = []
        }

        if (text.includes("(protocol)")) {
          if (journalNote) event.prompt.text = text + journalNote
          return // защита от дублей
        }

        if (!greeted.has(sessionID)) {
          greeted.add(sessionID)
          let stamp = "см. авто-контекст ниже"
          try {
            const head = readText(path.join(dir, "workflow", "STATUS.md")).slice(0, 500)
            const m = head.match(/Обновлено[^\n]*/)
            if (m) stamp = m[0].trim()
          } catch {}
          event.prompt.text =
            text +
            "\n\n(protocol) ВНИМАНИЕ: первый запрос сессии. НАЧНИ ОТВЕТ с чек-ина — ПЕРВОЙ строкой, до всего остального, строго в формате:\n" +
            "(protocol✔) STATUS прочитан — " +
            stamp +
            "; задачи в работе: №<номер из TASKS> «<название>»; беру/отвечаю: <кратко>.\n" +
            "ЭТО ОБЯЗАТЕЛЬНО. Только после этой строки — ответ на запрос пользователя." +
            journalNote
        } else {
          event.prompt.text =
            text +
            " (protocol) Правила AGENTS.md: правки/сервер — только по «делай»; закончив задачу — LOG + STATUS + TASKS." +
            journalNote
        }
      }),
    )

    // --- 4. Учёт правок файлов/сервера для контроля журнала ---
    await reg("tool.execute.before", () =>
      ctx.tool.hook("execute.before", (event) => {
        if (!enabled()) return
        const sessionID = event.sessionID
        if (!sessionID) return
        const s = stateOf(sessionID)

        // Захваты: запоминаем, какие задачи эта сессия взяла (claim) или закрыла (release/finish)
        if (SHELL_TOOL.test(event.tool)) {
          const cmd = String((event.input && (event.input.command || event.input.cmd)) || "")
          const claim = cmd.match(CLAIM_CMD)
          if (claim) s.claims.add(Number(claim[1]))
          const done = cmd.match(RELEASE_CMD)
          if (done) s.claims.delete(Number(done[1]))
        }

        const target = touchedTarget(event.tool, event.input)
        if (!target || PROTOCOL_FILES.test(target)) return
        s.touches.push(target)
        s.lastTouchAt = Date.now()
        if (s.touches.length > 25) s.touches = s.touches.slice(-25)
      }),
    )

    // --- 5. Гвард опасных команд ---
    const DANGEROUS =
      /\b(dnf|yum|apt|apt-get)\s+(install|remove|update|upgrade|autoremove)\b|\bshutdown\b|\breboot\b|rm\s+(-[a-z]*r[a-z]*f|--no-preserve-root)|\bdd\s+if=|chmod\s+-R\s+777|chown\s+-R|DROP\s+(DATABASE|TABLE)\b|TRUNCATE\s+TABLE\b|migrate:fresh|\bmkfs\b/i
    const CONSENT = /(разреша|подтвержда|одобря|согласен)/i

    await reg("permission.evaluate", () =>
      ctx.permission.hook("evaluate", async (event) => {
        if (!enabled()) return
        const isShell = /bash|shell|command|exec|run/i.test(event.action || "")
        if (!isShell) return
        const text = (event.resources || []).join(" ")
        if (!DANGEROUS.test(text)) return
        try {
          const msgs = await ctx.session.context({ sessionID: event.sessionID })
          const tail = msgs
            .slice(-12)
            .map((m) => JSON.stringify(m))
            .join(" ")
          if (CONSENT.test(tail)) return // пользователь уже разрешил — действуют обычные правила (ask/allow)
        } catch {
          // не смогли прочитать транскрипт — блокируем по умолчанию
        }
        event.effect = "deny"
        event.message =
          "protocol: опасная команда заблокирована. Изменяющие систему/сервер действия запрещены без явного разрешения " +
          "пользователя. Если пользователь в чате сам приказал это действие — сообщи ему и попроси написать «подтверждаю», " +
          "затем повтори команду."
      }),
    )

    return () => regs.forEach((r) => r.dispose().catch(() => {}))
  },
}
