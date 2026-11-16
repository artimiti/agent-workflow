# {{PROJECT_NAME}}

> Шаблон установлен {{DATE}}. Здесь одна-две строки: что это за проект и для кого.
> Заполните этот абзац — он первое, что читают люди и агенты.

## Структура

```
AGENTS.md                     правила работы агентов (обязательны к прочтению)
README.md                     этот файл
.gitignore
.gitattributes                переводы строк LF, бинарные файлы
project/
  specs/                      спеки проекта + реестр INDEX.md
  design-refs/screens/        скриншоты/референсы экранов
  modules/                    планы модулей: <модуль>-…-plan.md
  roadmap.md                  план этапов проекта
workflow/                     рабочие файлы протокола
  STATUS.md                   что сейчас (обновляет агент)
  TASKS.md                    реестр задач
  LOG.md                      журнал работ (дописывается сверху)
  CONTEXT.md                  краткий бриф для нового чата (генерируется)
  state.json                  машиночитаемое состояние: этап, шаги планов, «что дальше»
  tools/protocol.mjs          CLI протокола
  tools/protocol.test.mjs     тесты движка (node --test)
.opencode/plugins/protocol/   плагин OpenCode: контекст чата + напоминания + гвард
```

## Как работать

1. Открыть папку проекта в OpenCode (или другом агенте с shell).
2. Первое, что делает агент, — читает `AGENTS.md`; дальше — `workflow/STATUS.md` и `workflow/TASKS.md`.
3. Состояние спрашивать командой, а не по памяти:

```
node workflow/tools/protocol.mjs next      # что дальше
node workflow/tools/protocol.mjs open      # что не доделано
node workflow/tools/protocol.mjs claim 1   # взять задачу
node workflow/tools/protocol.mjs finish 1  # закрыть задачу
node workflow/tools/protocol.mjs check     # сверка файлов протокола
node --test                # тесты движка (25 проверок)
```

4. Закончил работу — запись в `workflow/LOG.md` сверху, обновить `workflow/STATUS.md`, коммит.

`claim`/`release`/`finish`/`prune` работают под блокировкой `workflow/.protocol.lock`
(каталог, атомарный `mkdir`): два чата, взявших одну задачу одновременно, не перетирают
друг друга — один получает задачу, второй понятный отказ. Брошенную блокировку
(процесс убили) движок снимает сам через 10 секунд.

## С чего начать

- Прочитать `AGENTS.md` (правила: правки — только по «делай»).
- Заполнить этот `README.md` и `workflow/STATUS.md` (что за проект).
- Завести первую настоящую спеку в `project/specs/` и записать её в `project/specs/INDEX.md`.
- Когда появится модуль — план в `project/modules/<модуль>-…-plan.md`, шаги — в `workflow/state.json`.

Демо-файлы (`example-spec.md`, `example-module-plan.md`, демо-задача №1, пример `roadmap.md`)
можно оставить как образец стиля или удалить — протоколу они не нужны.
