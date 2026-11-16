#requires -Version 5.1
<#
.SYNOPSIS
  Установка шаблона agent-workflow в новую папку проекта.

.DESCRIPTION
  Проверяет зависимости (Node.js, Git), при согласии ставит недостающие через winget,
  копирует skeleton/ в указанную папку, подставляет имя проекта и дату, делает git init
  и первый коммит, затем самопроверку протокола.

.PARAMETER Path
  Куда ставить. Папка создаётся; непустая — только с -Force.

.PARAMETER Name
  Название проекта для README/STATUS. По умолчанию — имя папки.

.PARAMETER Auto
  Полностью автоматический режим: план печатается, пауза 5 секунд на отмену.

.PARAMETER Yes
  Отменяет паузу 5 секунд в -Auto (для скриптов и CI).

.PARAMETER InstallDeps
  Разрешаю установщику самому поставить недостающие Node.js / Git через winget.

.PARAMETER DryRun
  Показать план и ничего не делать.

.PARAMETER Doctor
  Проверить машину (node/git/winget/opencode/папка) и выйти, ничего не записывая.

.PARAMETER Force
  Разрешить установку в непустую папку (существующие файлы будут перезаписаны).

.PARAMETER From
  Продолжить с шага N (1 — копирование, 2 — подстановки, 3 — git, 4 — самопроверка).

.EXAMPLE
  .\install.ps1 -Path C:\Проекты\НовыйПроект

.EXAMPLE
  .\install.ps1 -Path C:\Проекты\НовыйПроект -Name "Мой проект" -Auto -Yes -InstallDeps

.EXAMPLE
  .\install.ps1 -Doctor
#>
[CmdletBinding()]
param(
  [Parameter(Position = 0)][string]$Path,
  [string]$Name,
  [switch]$Auto,
  [switch]$Yes,
  [switch]$InstallDeps,
  [switch]$DryRun,
  [switch]$Doctor,
  [switch]$Force,
  [int]$From = 1
)

$ErrorActionPreference = 'Stop'

# Кириллица в консоли Windows: без этого часть терминалов печатает «?????».
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

$Here = $PSScriptRoot
$Skeleton = Join-Path $Here 'skeleton'
$Now = Get-Date
$DateRu = $Now.ToString('dd.MM.yyyy')
$TimeRu = $Now.ToString('HH:mm')
$NowIso = $Now.ToString('yyyy-MM-ddTHH:mm:sszzz')
$LogFile = Join-Path $env:TEMP ("agent-workflow-install-{0}.log" -f $Now.ToString('yyyyMMdd-HHmmss'))

# Для автотестов установщика: AW_FAKE_MISSING=git,node — сделать вид, что программы нет.
$script:FakeMissing = @(
  ($env:AW_FAKE_MISSING -split ',') | ForEach-Object { $_.Trim().ToLower() } | Where-Object { $_ }
)

function Write-Log {
  param([string]$Text, [string]$Color = 'Gray')
  Write-Host $Text -ForegroundColor $Color
  Add-Content -LiteralPath $LogFile -Value $Text -Encoding utf8
}

function Fail {
  param([string]$Text)
  Write-Log "ОШИБКА: $Text" 'Red'
  Write-Log "Лог: $LogFile"
  exit 1
}

# ---------------------------------------------------------------- зависимости

$NODE_CANDIDATES = @(
  @(
    $(if ($env:ProgramFiles) { Join-Path $env:ProgramFiles 'nodejs\node.exe' }),
    $(if (${env:ProgramFiles(x86)}) { Join-Path ${env:ProgramFiles(x86)} 'nodejs\node.exe' }),
    $(if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe' })
  ) | Where-Object { $_ }
)
$GIT_CANDIDATES = @(
  @(
    $(if ($env:ProgramFiles) { Join-Path $env:ProgramFiles 'Git\cmd\git.exe' }),
    $(if (${env:ProgramFiles(x86)}) { Join-Path ${env:ProgramFiles(x86)} 'Git\cmd\git.exe' }),
    $(if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'Programs\Git\cmd\git.exe' })
  ) | Where-Object { $_ }
)

# PATH → стандартные папки установки. Возвращает полный путь или $null.
function Find-Tool {
  param([string]$Name, [string[]]$Candidates)
  if ($script:FakeMissing -contains $Name.ToLower()) { return $null }
  $cmd = Get-Command $Name -ErrorAction SilentlyContinue
  if ($cmd -and $cmd.Source) { return $cmd.Source }
  foreach ($c in $Candidates) {
    if ($c -and (Test-Path -LiteralPath $c)) { return $c }
  }
  return $null
}

function Get-Winget {
  $cmd = Get-Command winget -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  return $null
}

function Get-ToolVersion {
  param([string]$Exe)
  try { return (& $Exe --version 2>$null | Select-Object -First 1) } catch { return '' }
}

function Install-WithWinget {
  param([string]$Title, [string]$WingetId)
  $winget = Get-Winget
  if (-not $winget) { return $false }
  Write-Log "  ставлю $Title через winget (это может занять минуту)…" 'Yellow'
  $wingetArgs = @('install', '--id', $WingetId, '-e', '--accept-source-agreements', '--accept-package-agreements', '--silent')
  & $winget @wingetArgs 2>&1 | Out-String | Write-Host
  return $true
}

<#
  Проверяет зависимость и (по согласию) ставит её.
  Required = $true: без неё установка не имеет смысла (Node для протокола).
  Required = $false: без неё можно, но с потерей (Git — история коммитов).
#>
function Ensure-Dependency {
  param(
    [string]$Key,
    [string]$Title,
    [string[]]$Candidates,
    [string]$WingetId,
    [string]$Site,
    [bool]$Required
  )

  $exe = Find-Tool -Name $Key -Candidates $Candidates
  if ($exe) {
    Write-Log "  $Title`: ok ($exe)" 'Green'
    return $exe
  }

  Write-Log "  $Title`: НЕ НАЙДЕН" 'Yellow'
  $winget = Get-Winget
  $cmd = "winget install --id $WingetId -e"
  $consent = $false

  if ($winget) {
    if ($InstallDeps) {
      $consent = $true
    } elseif ($Auto -and $Yes) {
      $consent = $false
      Write-Log "    авто-режим без -InstallDeps: сам не ставлю. Команда: $cmd" 'Yellow'
    } else {
      $answer = Read-Host "    Поставить сейчас? ($cmd) [y/N]"
      $consent = ($answer -match '^(y|yes|д|да)$')
    }
  } else {
    Write-Log "    winget не найден — поставьте вручную: $Site" 'Yellow'
  }

  if ($consent) {
    Install-WithWinget -Title $Title -WingetId $WingetId | Out-Null
    # В текущем окне PATH ещё старый: снимаем «притворную» отметку и ищем заново.
    $script:FakeMissing = @($script:FakeMissing | Where-Object { $_ -ne $Key.ToLower() })
    $exe = Find-Tool -Name $Key -Candidates $Candidates
    if ($exe) { Write-Log "    установлено: $exe" 'Green'; return $exe }
    Write-Log '    установка прошла, но программа не видна — перезапустите окно терминала' 'Yellow'
  }

  if ($Required) {
    Fail "$Title обязателен. Поставьте его ( $cmd ) или вручную: $Site — и запустите установку снова."
  }
  Write-Log "    продолжаю без $Title (эта часть работы будет недоступна)" 'Yellow'
  return $null
}

# ---------------------------------------------------------------- базовые помощники

function Test-TargetFolder {
  param([string]$p)
  if (-not (Test-Path -LiteralPath $p)) { return @{ exists = $false; empty = $true } }
  $items = @(Get-ChildItem -LiteralPath $p -Force -ErrorAction SilentlyContinue)
  return @{ exists = $true; empty = ($items.Count -eq 0) }
}

function Write-Utf8 {
  param([string]$FilePath, [string]$Content)
  $dir = Split-Path -Parent $FilePath
  if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  $enc = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($FilePath, ($Content -replace "`r`n", "`n"), $enc)
}

# ---------------------------------------------------------------- шаг 0: doctor
function Invoke-Doctor {
  $node = Find-Tool -Name 'node' -Candidates $NODE_CANDIDATES
  $git = Find-Tool -Name 'git' -Candidates $GIT_CANDIDATES
  $winget = Get-Winget
  $oc = Get-Command opencode -ErrorAction SilentlyContinue
  $rows = @()

  $rows += [pscustomobject]@{ ok = [bool]$node; Проверка = 'Node.js >= 20 (нужен протоколу)'; Итог = $(if ($node) { "ok: $node $(Get-ToolVersion $node)" } else { 'НЕТ: winget install --id OpenJS.NodeJS.LTS -e' }) }
  $rows += [pscustomobject]@{ ok = [bool]$git; Проверка = 'Git (история коммитов)'; Итог = $(if ($git) { "ok: $git" } else { 'НЕТ: winget install --id Git.Git -e' }) }
  $rows += [pscustomobject]@{ ok = [bool]$winget; Проверка = 'winget (ставит недостающее)'; Итог = $(if ($winget) { "ok: $winget" } else { 'нет — зависимости ставьте вручную (nodejs.org, git-scm.com)' }) }
  $rows += [pscustomobject]@{ ok = $true; Проверка = 'OpenCode (не обязателен)'; Итог = $(if ($oc) { "ok: $($oc.Source)" } else { 'нет в PATH — папку можно открыть позже' }) }
  $skeletonOk = Test-Path -LiteralPath (Join-Path $Skeleton 'AGENTS.md')
  $rows += [pscustomobject]@{ ok = $skeletonOk; Проверка = 'Шаблон (skeleton/)'; Итог = $(if ($skeletonOk) { 'ok' } else { 'НЕТ: рядом с install.ps1 должна лежать папка skeleton/' }) }

  if ($Path) {
    $t = Test-TargetFolder $Path
    $state = if (-not $t.exists) { 'папки нет — будет создана' } elseif ($t.empty) { 'папка пустая — ok' } else { 'НЕ пустая — нужен -Force' }
    $rows += [pscustomobject]@{ ok = $t.empty; Проверка = "Цель: $Path"; Итог = $state }
  }

  Write-Host ''
  Write-Host 'ПРОВЕРКА МАШИНЫ (ничего не записано)' -ForegroundColor Cyan
  $rows | Select-Object Проверка, Итог | Format-Table -AutoSize | Out-String | Write-Host
  $bad = @($rows | Where-Object { -not $_.ok }).Count
  if ($bad) {
    Write-Host "Проблем: $bad. Либо поставьте недостающее (см. команды справа), либо запустите установку с -InstallDeps." -ForegroundColor Yellow
  } else {
    Write-Host 'Всё готово к установке.' -ForegroundColor Green
  }
  exit $(if ($bad) { 1 } else { 0 })
}

# ---------------------------------------------------------------- шаг 1: план
function Show-Plan {
  param([string]$Target, [string]$ProjectName)
  Write-Log ''
  Write-Log 'ПЛАН УСТАНОВКИ' 'Cyan'
  Write-Log "  куда:        $Target"
  Write-Log "  имя проекта: $ProjectName"
  Write-Log "  шаблон:      $Skeleton"
  Write-Log ''
  Write-Log '  0. проверить зависимости (Node.js, Git); недостающие — поставить по согласию'
  Write-Log '  1. создать папку и скопировать шаблон (AGENTS.md, README.md, project/, workflow/, .opencode/)'
  Write-Log '  2. подставить имя проекта и дату, собрать CONTEXT.md'
  Write-Log '  3. git init + первый коммит «шаблон агентской системы»'
  Write-Log '  4. самопроверка: protocol check (расхождений быть не должно)'
  Write-Log '  5. отчёт: что дальше'
  Write-Log ''
}

function Wait-Go {
  param([string]$What)
  if ($Auto) {
    if (-not $Yes) {
      Write-Log 'Авто-режим: старт через 5 секунд (Ctrl+C — отмена)…' 'Yellow'
      Start-Sleep -Seconds 5
    }
    return $true
  }
  $answer = Read-Host "$What [Enter — дальше, q — стоп]"
  return -not ($answer -match '^(q|й|стоп|exit)$')
}

# ---------------------------------------------------------------- шаг 1: копирование
function Copy-Skeleton {
  param([string]$Target)
  $t = Test-TargetFolder $Target
  if ($t.exists -and -not $t.empty -and -not $Force) {
    Fail "папка $Target не пустая. Установка поверх не делается: укажите другую папку или добавьте -Force (перезапишет совпадающие файлы)."
  }
  if (-not (Test-Path -LiteralPath $Target)) { New-Item -ItemType Directory -Force -Path $Target | Out-Null }
  Copy-Item -Path (Join-Path $Skeleton '*') -Destination $Target -Recurse -Force
  $count = @(Get-ChildItem -LiteralPath $Target -Recurse -File -Force -ErrorAction SilentlyContinue | Where-Object { $_.FullName -notmatch '\\\.git\\' }).Count
  Write-Log "  готово: файлов в проект скопировано — $count" 'Green'
}

# ---------------------------------------------------------------- шаг 2: подстановки
function Set-Placeholders {
  param([string]$Target, [string]$ProjectName)
  $map = [ordered]@{
    '{{PROJECT_NAME}}' = $ProjectName
    '{{DATE}}'         = $DateRu
    '{{TIME}}'         = $TimeRu
    '{{NOW_ISO}}'      = $NowIso
  }
  $touched = 0
  foreach ($file in Get-ChildItem -LiteralPath $Target -Recurse -File -Force) {
    if ($file.Extension -notin '.md', '.json', '.txt') { continue }
    $text = [System.IO.File]::ReadAllText($file.FullName, [System.Text.Encoding]::UTF8)
    $orig = $text
    foreach ($k in $map.Keys) { $text = $text.Replace($k, $map[$k]) }
    if ($text -ne $orig) { Write-Utf8 -FilePath $file.FullName -Content $text; $touched++ }
  }
  Write-Log "  готово: подставлены имя и дата в $touched файл(ах)" 'Green'

  $stateFile = Join-Path $Target 'workflow\state.json'
  try { $null = Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json } catch { Fail "workflow/state.json получился битым JSON: $($_.Exception.Message)" }
  Write-Log '  проверено: workflow/state.json — валидный JSON' 'Green'
}

# ---------------------------------------------------------------- шаг 3: git
function Initialize-Git {
  param([string]$Target, [string]$GitExe)
  if (-not $GitExe) { Write-Log '  ПРОПУЩЕНО: git нет. Файлы на месте, истории коммитов не будет.' 'Yellow'; return }

  Push-Location -LiteralPath $Target
  try {
    if (-not (Test-Path -LiteralPath (Join-Path $Target '.git'))) {
      & $GitExe init -b main -q 2>&1 | Out-String | Write-Host
    }
    & $GitExe add -A 2>&1 | Out-String | Write-Host

    $hasName = (& $GitExe config user.name) 2>$null
    $hasMail = (& $GitExe config user.email) 2>$null
    $ident = @()
    if (-not $hasName) { $ident += @('-c', 'user.name=agent-workflow') }
    if (-not $hasMail) { $ident += @('-c', 'user.email=agent-workflow@localhost') }

    $gitArgs = @()
    if ($ident.Count) { $gitArgs += $ident }
    $gitArgs += @('commit', '-q', '-m', 'шаблон агентской системы: правила, протокол, плагин')
    & $GitExe @gitArgs 2>&1 | Out-String | Write-Host

    $status = (& $GitExe status --porcelain) 2>$null
    if ([string]::IsNullOrWhiteSpace($status)) { Write-Log '  готово: репозиторий создан, рабочее дерево чистое' 'Green' }
    else { Write-Log '  внимание: после коммита остались несохранённые изменения (см. git status)' 'Yellow' }
  }
  finally { Pop-Location }
}

# ---------------------------------------------------------------- шаг 4: самопроверка
function Invoke-SelfCheck {
  param([string]$Target, [string]$NodeExe)
  if (-not $NodeExe) { Write-Log '  ПРОПУЩЕНО: node нет — протокол не проверен' 'Yellow'; return $false }

  Push-Location -LiteralPath $Target
  try {
    $ctx = & $NodeExe 'workflow/tools/protocol.mjs' context --write 2>&1 | Out-String
    $bytes = (Get-Item -LiteralPath (Join-Path $Target 'workflow\CONTEXT.md')).Length
    if ($bytes -gt 4096) { Write-Log "  внимание: CONTEXT.md $bytes байт > 4096" 'Yellow' }
    else { Write-Log "  CONTEXT.md собран ($bytes байт)" 'Green' }

    $check = & $NodeExe 'workflow/tools/protocol.mjs' check 2>&1 | Out-String
    $code = $LASTEXITCODE
    ($check.Trim() -split "`n") | ForEach-Object { Write-Log "    $_" }
    if ($code -ne 0) { Write-Log '  внимание: protocol check нашёл расхождения (см. выше)' 'Yellow'; return $false }

    Write-Log '  готово: protocol check — расхождений нет' 'Green'
    return $true
  }
  finally { Pop-Location }
}

function Show-Report {
  param([string]$Target, [string]$ProjectName, [bool]$Checked, [bool]$HasGit)
  Write-Log ''
  Write-Log 'ГОТОВО' 'Green'
  Write-Log "  проект: $ProjectName"
  Write-Log "  папка:  $Target"
  Write-Log "  лог:    $LogFile"
  Write-Log ''
  Write-Log '  Что дальше:'
  Write-Log '   1. открыть эту папку в OpenCode (File → Open Folder)'
  Write-Log '   2. первый чат агент начнёт с чек-ина: «(protocol✔) STATUS прочитан…»'
  Write-Log '   3. спросить состояние:  node workflow/tools/protocol.mjs next'
  Write-Log '   4. первая задача:       node workflow/tools/protocol.mjs claim 1'
  if (-not $Checked) { Write-Log '  (протокол не проверен: нет Node.js >= 20 — поставьте и запустите check вручную)' 'Yellow' }
  if (-not $HasGit) { Write-Log '  (git нет: истории коммитов тоже нет — поставьте Git и выполните git init в папке проекта)' 'Yellow' }
}

# ---------------------------------------------------------------- main
Write-Log "agent-workflow installer — $(Get-Date -Format 'dd.MM.yyyy HH:mm')" 'Cyan'
Write-Log "лог: $LogFile"

if ($Doctor) { Invoke-Doctor }

if (-not $Path) { Fail 'укажите папку: .\install.ps1 -Path C:\Проекты\НовыйПроект' }
$Target = [System.IO.Path]::GetFullPath($Path)
$ProjectName = if ($Name) { $Name } else { Split-Path -Leaf ($Target.TrimEnd('\', '/')) }

if (-not (Test-Path -LiteralPath (Join-Path $Skeleton 'AGENTS.md'))) { Fail "рядом с install.ps1 нет папки skeleton/ — скачайте репозиторий целиком" }

Show-Plan -Target $Target -ProjectName $ProjectName

if ($DryRun) {
  Write-Log 'DRY-RUN: ничего не создано и не изменено.' 'Yellow'
  Write-Log 'Уберите -DryRun, чтобы установить.'
  exit 0
}

$pre = Test-TargetFolder $Target
if ($pre.exists -and -not $pre.empty -and -not $Force -and $From -le 1) {
  Fail "папка $Target не пустая. Установка поверх не делается: укажите другую папку или добавьте -Force (перезапишет совпадающие файлы)."
}

if ($From -le 1) {
  if (-not (Wait-Go 'Начинаем?')) { Write-Log 'Остановлено пользователем, ничего не изменено.' 'Yellow'; exit 0 }
}

Write-Log ''
Write-Log '[0/4] зависимости:' 'Cyan'
$nodeExe = Ensure-Dependency -Key 'node' -Title 'Node.js' -Candidates $NODE_CANDIDATES `
  -WingetId 'OpenJS.NodeJS.LTS' -Site 'https://nodejs.org (LTS)' -Required $true
$gitExe = Ensure-Dependency -Key 'git' -Title 'Git' -Candidates $GIT_CANDIDATES `
  -WingetId 'Git.Git' -Site 'https://git-scm.com/download/win' -Required $false

if ($nodeExe) {
  $v = Get-ToolVersion $nodeExe
  if ($v -match 'v(\d+)' -and [int]$Matches[1] -lt 20) {
    Fail "нужен Node.js >= 20, найден $v. Обновите: winget install --id OpenJS.NodeJS.LTS -e"
  }
}

$checked = $false
try {
  if ($From -le 1) { Write-Log ''; Write-Log '[1/4] копирование шаблона…' 'Cyan'; Copy-Skeleton -Target $Target }
  if ($From -le 2) {
    Write-Log '[2/4] имя проекта, даты, CONTEXT…' 'Cyan'
    Set-Placeholders -Target $Target -ProjectName $ProjectName
    if ($From -gt 1) {
      Push-Location -LiteralPath $Target
      try { if ($nodeExe) { & $nodeExe 'workflow/tools/protocol.mjs' context --write | Out-Null } } finally { Pop-Location }
    }
  }
  if ($From -le 3) {
    Write-Log '[3/4] git init + первый коммит…' 'Cyan'
    if (Wait-Go 'Создаём репозиторий?') { Initialize-Git -Target $Target -GitExe $gitExe }
    else { Write-Log '  пропущено по команде пользователя' 'Yellow' }
  }
  if ($From -le 4) {
    Write-Log '[4/4] самопроверка протокола…' 'Cyan'
    $checked = Invoke-SelfCheck -Target $Target -NodeExe $nodeExe
  }
}
catch { Fail $_.Exception.Message }

Show-Report -Target $Target -ProjectName $ProjectName -Checked $checked -HasGit ([bool]$gitExe)
exit 0
