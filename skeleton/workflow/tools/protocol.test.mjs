#!/usr/bin/env node
/**
 * protocol.test.mjs — тесты движка протокола. Зависимостей нет, нужен только Node.js >= 20.
 *
 *   node --test                       (все тесты; ~2 секунды)
 *   node --test workflow/tools/protocol.test.mjs
 *
 * Зачем: состояние проекта — это файлы, и ошибка в движке тихо ломает реестр задач.
 * Поэтому claim/finish/check/prune/context проверяются на КОПИИ проекта во временной папке:
 * рабочие файлы проекта тесты не читают и не меняют. Конкурентность проверяется
 * настоящими процессами (node protocol.mjs claim N), а не имитацией ветки кода.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import * as P from "./protocol.mjs"

const TASKS = `# TASKS — реестр задач

| # | Задача | Статус | Кто взял | Когда |
|---|--------|--------|----------|-------|
| 1 | Первая задача (демо) | СВОБОДНА | — | — |
| 2 | Закрытая задача | ГОТОВА (16.11.2026: закрыто \`protocol finish\`) | сессия A | 16.11.2026 |
`

const STATUS = `# STATUS

**Обновлено:** 16.11.2026 (**этап 0 «Старт»**).

| этап | название | статус |
|---|---|---|
| 0 | Старт | ✅ установлено 16.11.2026 |
`

const LOG = `# LOG — журнал работ

## [16.11.2026 12:00] — Старт проекта — ГОТОВА
- Сделано: развёрнут шаблон.
- Осталось / открытыми: задача №1 — прочитать AGENTS.md.
`

const STATE = `{
  "stage": { "id": "0", "title": "Старт", "status": "open" },
  "stages": [{ "id": "0", "title": "Старт", "status": "open" }],
  "plans": {
    "demo": {
      "title": "Демо-план",
      "status": "open",
      "steps": [{ "id": "A", "task": 1, "title": "Первая задача", "status": "open" }]
    }
  },
  "next": {
    "kind": "step",
    "task": 1,
    "plan": "demo",
    "text": "Шаг A плана «Демо-план»: Первая задача",
    "why": "первый незакрытый шаг"
  },
  "updated": "2026-11-16T12:00:00+03:00"
}
`

/** Временная копия проекта: четыре файла протокола, ничего лишнего. */
function fixture(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "protocol-test-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const wf = path.join(dir, "workflow")
  mkdirSync(wf, { recursive: true })
  writeFileSync(path.join(wf, "TASKS.md"), TASKS)
  writeFileSync(path.join(wf, "STATUS.md"), STATUS)
  writeFileSync(path.join(wf, "LOG.md"), LOG)
  writeFileSync(path.join(wf, "state.json"), STATE)
  return dir
}

/** Вызов CLI на копии: cwd и файлы настоящего проекта не участвуют. */
function run(dir, ...args) {
  const prev = process.env.PROTOCOL_ROOT
  process.env.PROTOCOL_ROOT = dir
  try {
    return P.main(args)
  } finally {
    if (prev === undefined) delete process.env.PROTOCOL_ROOT
    else process.env.PROTOCOL_ROOT = prev
  }
}

const read = (dir, p) => readFileSync(path.join(dir, p), "utf8")
const write = (dir, p, text) => writeFileSync(path.join(dir, p), text)
const taskRow = (dir, n) => P.parseTasks(read(dir, "workflow/TASKS.md")).find((x) => x.num === n)
const stateOf = (dir) => JSON.parse(read(dir, "workflow/state.json"))
const tmpLeft = (dir) => readdirSync(path.join(dir, "workflow")).filter((f) => f.endsWith(".tmp"))
const lockDir = (dir) => path.join(dir, P.LOCK_PATH)

/* ------------------------------------- настоящие процессы (а не имитация гонки) */

const ENGINE = path.join(path.dirname(fileURLToPath(import.meta.url)), "protocol.mjs")

/** Запуск движка отдельным процессом — ровно то, что делает агент руками. */
function runProcess(dir, args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [ENGINE, ...args], {
      cwd: dir,
      env: { ...process.env, PROTOCOL_ROOT: dir, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    })
    let out = ""
    let err = ""
    child.stdout.on("data", (d) => (out += d))
    child.stderr.on("data", (d) => (err += d))
    child.on("close", (code) => resolve({ code, text: out + err }))
  })
}

const claimProcess = (dir, n, owner, env) => runProcess(dir, ["claim", String(n), "--as", owner], env)

/* ------------------------------------------------------------------ разбор */

test("parseTasks: номер, статус и «|» внутри названия", () => {
  const md = ["| # | Задача | Статус | Кто взял |", "|---|---|---|---|", "| 7 | Ошибка | в тексте | В РАБОТЕ (16.11, art) |"].join("\n")
  const [row] = P.parseTasks(md)
  assert.equal(row.num, 7)
  assert.equal(row.statusWord, "В РАБОТЕ")
  assert.equal(row.title, "Ошибка | в тексте")
})

test("parseLog: дата, время, заголовок, «Осталось»", () => {
  const [entry] = P.parseLog(LOG)
  assert.equal(entry.date, "16.11.2026")
  assert.equal(entry.time, "12:00")
  assert.equal(entry.title, "Старт проекта — ГОТОВА")
  assert.match(entry.leftover, /задача №1/)
})

/* --------------------------------------------------- чтение состояния (read) */

test("next: шаг плана и задача", (t) => {
  const res = run(fixture(t), "next")
  assert.equal(res.code, 0, res.text)
  assert.match(res.text, /СЛЕДУЮЩИЙ ШАГ/)
  assert.match(res.text, /№1/)
})

test("check: чистый проект — без расхождений и с версией движка", (t) => {
  const res = run(fixture(t), "check")
  assert.equal(res.code, 0, res.text)
  assert.match(res.text, /Расхождений нет/)
  assert.match(res.text, /движок: v\d+\.\d+\.\d+/)
  assert.ok(P.ENGINE_VERSION.length > 0)
})

test("open: незакрытые задачи и «Осталось» из журнала", (t) => {
  const res = run(fixture(t), "open")
  assert.equal(res.code, 0, res.text)
  assert.match(res.text, /№1/)
  assert.doesNotMatch(res.text, /№2 — .*ГОТОВА/)
})

/* ------------------------------------------------------------------ claim */

test("claim: В РАБОТЕ + захват на 3 часа", (t) => {
  const dir = fixture(t)
  const res = run(dir, "claim", "1", "--as", "art")
  assert.equal(res.code, 0, res.text)
  assert.equal(taskRow(dir, 1).statusWord, "В РАБОТЕ")
  const claim = JSON.parse(read(dir, "workflow/claims/1.json"))
  assert.equal(claim.owner, "art")
  const ttl = Date.parse(claim.expiresAt) - Date.parse(claim.takenAt)
  assert.ok(Math.abs(ttl - P.CLAIM_TTL_MS) < 60_000, "TTL должен быть ≈3 ч, получено " + ttl)
  assert.deepEqual(tmpLeft(dir), [], "временных файлов после записи быть не должно")
})

test("claim: второй чат получает отказ, TASKS не переписан", (t) => {
  const dir = fixture(t)
  run(dir, "claim", "1", "--as", "art")
  const before = read(dir, "workflow/TASKS.md")
  const res = run(dir, "claim", "1", "--as", "bob")
  assert.equal(res.code, 2, res.text)
  assert.match(res.text, /уже занята: «art»/)
  assert.equal(read(dir, "workflow/TASKS.md"), before)
  assert.equal(JSON.parse(read(dir, "workflow/claims/1.json")).owner, "art")
})

test("claim --force: перехват чужого захвата", (t) => {
  const dir = fixture(t)
  run(dir, "claim", "1", "--as", "art")
  const res = run(dir, "claim", "1", "--as", "bob", "--force")
  assert.equal(res.code, 0, res.text)
  assert.equal(JSON.parse(read(dir, "workflow/claims/1.json")).owner, "bob")
})

test("claim: просроченный захват в файле — перезапись без ошибок", (t) => {
  const dir = fixture(t)
  mkdirSync(path.join(dir, "workflow/claims"), { recursive: true })
  // Захват просрочен: файл существует, но задача считается свободной.
  write(
    dir,
    "workflow/claims/1.json",
    JSON.stringify({ task: 1, owner: "ghost", takenAt: "2026-11-16T10:00:00+03:00", expiresAt: "2026-11-16T11:00:00+03:00" }) + "\n",
  )
  const res = run(dir, "claim", "1", "--as", "art")
  assert.equal(res.code, 0, res.text)
  assert.equal(JSON.parse(read(dir, "workflow/claims/1.json")).owner, "art")
  assert.equal(taskRow(dir, 1).statusWord, "В РАБОТЕ")
})

test("claim: активный чужой захват в файле — отказ, TASKS не переписан", (t) => {
  const dir = fixture(t)
  mkdirSync(path.join(dir, "workflow/claims"), { recursive: true })
  const future = new Date(Date.now() + P.CLAIM_TTL_MS).toISOString()
  write(
    dir,
    "workflow/claims/1.json",
    JSON.stringify({ task: 1, owner: "bob", takenAt: new Date().toISOString(), expiresAt: future }) + "\n",
  )
  const res = run(dir, "claim", "1", "--as", "art")
  assert.equal(res.code, 2, res.text)
  assert.match(res.text, /уже занята: «bob»/)
  assert.equal(taskRow(dir, 1).statusWord, "СВОБОДНА", "TASKS не должен врать про второго")
})

/* ------------------------------------------- конкурентность настоящими процессами */

test("claim: три процесса одновременно — задачу получает ровно один", async (t) => {
  const dir = fixture(t)
  const results = await Promise.all([0, 1, 2].map((i) => claimProcess(dir, 1, "bot" + i)))
  const winners = results.filter((r) => r.code === 0)
  assert.equal(
    winners.length,
    1,
    "победителей должно быть ровно 1:\n" + results.map((r) => `exit ${r.code}: ${r.text.trim().split("\n")[0]}`).join("\n"),
  )
  const other = results.filter((r) => r.code !== 0)
  for (const r of other) assert.match(r.text, /уже занята: «bot\d»/)
  const claim = JSON.parse(read(dir, "workflow/claims/1.json"))
  assert.match(claim.owner, /^bot\d$/, "владелец — один из участников")
  assert.equal(taskRow(dir, 1).statusWord, "В РАБОТЕ")
  assert.deepEqual(tmpLeft(dir), [], "временных файлов быть не должно")
  assert.equal(existsSync(lockDir(dir)), false, "блокировка должна сниматься")
})

test("claim: просроченный захват + три процесса — перехватывает ровно один", async (t) => {
  const dir = fixture(t)
  mkdirSync(path.join(dir, "workflow/claims"), { recursive: true })
  write(
    dir,
    "workflow/claims/1.json",
    JSON.stringify({ task: 1, owner: "ghost", takenAt: "2026-11-16T10:00:00+03:00", expiresAt: "2026-11-16T11:00:00+03:00" }) + "\n",
  )
  const results = await Promise.all([0, 1, 2].map((i) => claimProcess(dir, 1, "bot" + i)))
  assert.equal(
    results.filter((r) => r.code === 0).length,
    1,
    results.map((r) => `exit ${r.code}: ${r.text.trim().split("\n")[0]}`).join("\n"),
  )
  const claim = JSON.parse(read(dir, "workflow/claims/1.json"))
  assert.match(claim.owner, /^bot\d$/, "брошенный захват «ghost» не должен остаться")
  assert.equal(taskRow(dir, 1).statusWord, "В РАБОТЕ")
})

test("lock: брошенная блокировка от умершего процесса снимается по возрасту", async (t) => {
  const dir = fixture(t)
  mkdirSync(lockDir(dir), { recursive: true })
  const old = new Date(Date.now() - 60_000)
  utimesSync(lockDir(dir), old, old) // процесс оставил блокировку минуту назад и умер
  const res = await claimProcess(dir, 1, "art", { PROTOCOL_LOCK_WAIT_MS: "1000" })
  assert.equal(res.code, 0, res.text)
  assert.equal(JSON.parse(read(dir, "workflow/claims/1.json")).owner, "art")
  assert.equal(existsSync(lockDir(dir)), false, "после команды блокировки быть не должно")
})

test("lock: живая блокировка — команда ждёт и честно сообщает, что не дождалась", async (t) => {
  const dir = fixture(t)
  mkdirSync(lockDir(dir), { recursive: true }) // кто-то сейчас работает
  const res = await claimProcess(dir, 1, "art", { PROTOCOL_LOCK_WAIT_MS: "100" })
  assert.equal(res.code, 1, res.text)
  assert.match(res.text, /не дождался блокировки/)
  assert.equal(existsSync(path.join(dir, "workflow/claims/1.json")), false, "захват не должен появиться")
  assert.equal(existsSync(lockDir(dir)), true, "чужую блокировку снимать нельзя")
  assert.equal(taskRow(dir, 1).statusWord, "СВОБОДНА", "TASKS не должен меняться")
})

test("claim: готовую задачу взять нельзя", (t) => {
  const res = run(fixture(t), "claim", "2", "--as", "art")
  assert.equal(res.code, 1)
  assert.match(res.text, /уже закрыта/)
})

test("claim: несуществующая задача — понятная ошибка", (t) => {
  const res = run(fixture(t), "claim", "99", "--as", "art")
  assert.equal(res.code, 1)
  assert.match(res.text, /нет в workflow\/TASKS\.md/)
})

test("release: задача снова свободна, захват снят", (t) => {
  const dir = fixture(t)
  run(dir, "claim", "1", "--as", "art")
  const res = run(dir, "release", "1")
  assert.equal(res.code, 0, res.text)
  assert.equal(taskRow(dir, 1).statusWord, "СВОБОДНА")
  assert.equal(existsSync(path.join(dir, "workflow/claims/1.json")), false)
})

/* ----------------------------------------------------------------- finish */

test("finish: ГОТОВА, захват снят, шаг плана done, next пересчитан", (t) => {
  const dir = fixture(t)
  run(dir, "claim", "1", "--as", "art")
  const res = run(dir, "finish", "1")
  assert.equal(res.code, 0, res.text)
  assert.equal(taskRow(dir, 1).statusWord, "ГОТОВА")
  assert.equal(existsSync(path.join(dir, "workflow/claims/1.json")), false)
  const st = stateOf(dir)
  assert.equal(st.plans.demo.steps[0].status, "done")
  assert.equal(st.plans.demo.status, "closed")
  assert.equal(st.next.kind, "decision")
  assert.deepEqual(tmpLeft(dir), [])
})

test("finish: повторное закрытие — отказ", (t) => {
  const res = run(fixture(t), "finish", "2")
  assert.equal(res.code, 1)
  assert.match(res.text, /уже закрыта/)
})

test("finish: несуществующая задача — понятная ошибка", (t) => {
  const res = run(fixture(t), "finish", "99")
  assert.equal(res.code, 1)
  assert.match(res.text, /нет в workflow\/TASKS\.md/)
})

/* ------------------------------------------- аварийные сценарии (это и есть «доказательство») */

test("check ловит последствия сбоя посреди finish: задача закрыта, state не обновлён", (t) => {
  const dir = fixture(t)
  write(
    dir,
    "workflow/TASKS.md",
    read(dir, "workflow/TASKS.md").replace(
      "| 1 | Первая задача (демо) | СВОБОДНА | — | — |",
      "| 1 | Первая задача (демо) | ГОТОВА (16.11.2026: закрыто) | art | 16.11.2026 |",
    ),
  )
  const res = run(dir, "check")
  assert.equal(res.code, 1, res.text)
  assert.match(res.text, /next ссылается на уже закрытую задачу №1/)
  assert.match(res.text, /шаг A открыт, но задача №1 уже ГОТОВА/)
})

test("check ловит рассинхрон: шаг плана done, задача открыта", (t) => {
  const dir = fixture(t)
  const st = stateOf(dir)
  st.plans.demo.steps[0].status = "done"
  write(dir, "workflow/state.json", JSON.stringify(st, null, 2) + "\n")
  const res = run(dir, "check")
  assert.equal(res.code, 1, res.text)
  assert.match(res.text, /помечен done, но задача №1 — СВОБОДНА/)
})

test("check ловит отставание STATUS от журнала", (t) => {
  const dir = fixture(t)
  write(dir, "workflow/LOG.md", read(dir, "workflow/LOG.md").replace("[16.11.2026 12:00]", "[17.11.2026 12:00]"))
  const res = run(dir, "check")
  assert.equal(res.code, 1, res.text)
  assert.match(res.text, /STATUS\.md отстаёт от журнала/)
})

/* ------------------------------------------------------------------ prune */

test("prune --dry ничего не меняет, prune переносит в архив", (t) => {
  const dir = fixture(t)
  const before = read(dir, "workflow/TASKS.md")
  const dry = run(dir, "prune", "--dry", "--days", "0", "--keep", "0")
  assert.equal(dry.code, 0, dry.text)
  assert.equal(read(dir, "workflow/TASKS.md"), before)

  const res = run(dir, "prune", "--days", "0", "--keep", "0")
  assert.equal(res.code, 0, res.text)
  assert.equal(taskRow(dir, 2), undefined, "закрытая задача ушла из TASKS")
  assert.ok(taskRow(dir, 1), "открытая задача осталась")
  assert.match(read(dir, "workflow/TASKS-archive.md"), /Закрытая задача/)
  assert.deepEqual(tmpLeft(dir), [])
})

/* ---------------------------------------------------------------- context */

test("context --write: файл ≤ 4 КБ и без временных файлов", (t) => {
  const dir = fixture(t)
  const res = run(dir, "context", "--write")
  assert.equal(res.code, 0, res.text)
  const bytes = Buffer.byteLength(read(dir, "workflow/CONTEXT.md"), "utf8")
  assert.ok(bytes > 0 && bytes <= P.CONTEXT_LIMIT, "CONTEXT " + bytes + " байт")
  assert.deepEqual(tmpLeft(dir), [])
})
