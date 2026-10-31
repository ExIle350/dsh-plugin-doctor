/* ============================================================================
 * dsh-plugin-doctor — Host 半侧
 * ----------------------------------------------------------------------------
 * 解决一个真实存在但没人做的痛点：**DSH 的插件行级失败是静默的**。
 * 不写日志、不报错、不弹窗，表现就是「装了、什么都没发生」。
 *
 * 本插件把三件事摊开：
 *   1) loader 里每一行的 id / name / 是否被禁用 / 处于什么状态
 *   2) profile 声明的 bundles 与 node_modules 里实际能否解析到入口文件
 *      （缺 client 构建产物、缺 peer 包这类问题在这一步就会显形）
 *   3) 一份可复制的 JSON 诊断文本
 *
 * 设计约束（都是从踩坑里来的）：
 *   · 零运行时依赖；
 *   · apply() 内任何异常都不外抛，绝不让宿主起不来；
 *   · 读不到 loader 内部就如实报 entriesApi:false，不假装成功。
 * ========================================================================== */

import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const NS = 'dsh-plugin-doctor'
const ROUTE = '/dsh-doctor'
const VERSION = '0.1.0'

const name = NS
const inject = ['webServer', 'connection']

/* ── 工具 ─────────────────────────────────────────────────────────────────── */

function safe(fn, fallback) {
  try {
    return fn()
  } catch (err) {
    return { __error__: String((err && (err.code || err.message)) || err) }
  }
}

/** profile 目录：优先环境变量，其次宿主上下文，最后退回默认位置。 */
function profileDir(ctx) {
  const candidates = [
    process.env.DSH_PROFILE_DIR,
    safe(() => ctx.profileContext?.profileDir),
    safe(() => ctx.profile?.dir),
    safe(() => ctx.get('profileContext')?.profileDir),
    path.join(process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '', '.dsh'), 'profiles', 'desktop'),
  ]
  for (const c of candidates) {
    if (typeof c === 'string' && c && fs.existsSync(path.join(c, 'package.json'))) return { dir: c, via: 'fs' }
  }
  return { dir: null, via: 'not-found' }
}

/** 读 loader 里的每一行。这是本插件的核心，也是最不确定的一环。 */
function readEntries(ctx) {
  const out = { entriesApi: false, error: null, rows: [] }
  const loader = ctx.loader
  if (!loader || typeof loader.entries !== 'function') {
    out.error = 'ctx.loader.entries 不可用'
    return out
  }
  const res = safe(() => [...loader.entries()])
  if (res && res.__error__) {
    out.error = 'entries() 抛错: ' + res.__error__
    return out
  }
  out.entriesApi = true
  for (const e of res || []) {
    out.rows.push(
      safe(() => ({
        id: e.options?.id,
        name: e.options?.name,
        disabled: e.disabled === true || e.options?.disabled === true,
        enabled: e.enabled,
        status: safe(() => e.status) ?? e.state ?? null,
        group: safe(() => e.group?.options?.id) ?? null,
      })) ?? { id: null, error: '读取该条目失败' },
    )
  }
  return out
}

/** 宿主版本：插件可能装在 profile（甚至别的盘），createRequire 走不进 asar，
    所以按优先级多试几条路，全失败就如实返回 null。 */
function hostVersion(ctx) {
  const r = createRequire(import.meta.url)
  const tries = [
    () => JSON.parse(fs.readFileSync(r.resolve('@deepseek-ai/dsh/package.json'), 'utf8')).version,
    () => JSON.parse(fs.readFileSync(r.resolve('@deepseek-ai/dsh-web-app/package.json'), 'utf8')).version,
    safe(() => ctx.profileContext?.dshVersion),
    safe(() => ctx.version),
    process.env.DSH_VERSION,
  ]
  /* Electron 给 fs 打过补丁，app.asar 里的路径可以直接读；从 exe 位置推出来 */
  if (process.execPath) {
    const base = path.dirname(process.execPath)
    for (const rel of [
      path.join('resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
      path.join('resources', 'app.asar.unpacked', 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
    ]) {
      tries.push(() => JSON.parse(fs.readFileSync(path.join(base, rel), 'utf8')).version)
    }
  }
  for (const t of tries) {
    const v = typeof t === 'function' ? safe(t) : t
    if (typeof v === 'string' && v) return { version: v }
  }
  return { version: null, note: '未能确定宿主版本（不影响其余诊断）' }
}

/** 核对 bundles 声明与实际可解析性：缺文件、缺包在这一步显形。 */
function checkBundles(dir) {
  const out = { bundles: [], problems: [] }
  if (!dir) return out
  const pkg = safe(() => JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')))
  if (!pkg || pkg.__error__) {
    out.problems.push({ item: 'package.json', problem: '读取失败: ' + (pkg && pkg.__error__) })
    return out
  }
  const bundles = (pkg.dsh && pkg.dsh.profile && pkg.dsh.profile.bundles) || []
  const deps = pkg.dependencies || {}
  for (const b of bundles) {
    const rec = { name: b, resolved: false, entry: null, client: null, notes: [] }
    const pkgDir = path.join(dir, 'node_modules', ...b.split('/'))
    rec.inNodeModules = fs.existsSync(pkgDir)
    const meta = safe(() => JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8')))
    if (meta && !meta.__error__) {
      const exp = meta.exports || {}
      const pick = (v) => (typeof v === 'string' ? v : v && v.default) || null
      const mainRel = pick(exp['.']) || meta.main || 'index.js'
      const clientRel = pick(exp['./client'])
      rec.entry = mainRel
      rec.resolved = fs.existsSync(path.join(pkgDir, mainRel.replace(/^\.\//, '')))
      if (!rec.resolved) rec.notes.push('入口文件缺失: ' + mainRel)
      if (clientRel) {
        rec.client = clientRel
        const okClient = fs.existsSync(path.join(pkgDir, clientRel.replace(/^\.\//, '')))
        if (!okClient) rec.notes.push('⚠ exports["./client"] 指向的文件不存在: ' + clientRel + ' —— 这会让宿主启动即崩')
      }
      for (const peer of Object.keys(meta.peerDependencies || {})) {
        if ((meta.peerDependenciesMeta || {})[peer]?.optional) continue
        if (peer.startsWith('@deepseek-ai/') || peer === 'react' || peer === 'react-dom') continue
        rec.notes.push('需自行安装的非宿主 peer: ' + peer)
      }
    } else {
      /* @deepseek-ai/* 的 bundle 是**内置在应用里**的（app.asar），不在 profile 的
         node_modules —— 这是正常状态，不能报成故障。 */
      if (b.startsWith('@deepseek-ai/')) {
        rec.host = true
        rec.resolved = true
      } else {
        rec.notes.push('node_modules 里找不到该包目录（未安装或 link 失效）')
      }
    }
    if (!deps[b] && !rec.host) rec.notes.push('不在 package.json 的 dependencies 里（pnpm 下次安装可能被剪掉）')
    out.bundles.push(rec)
    if (rec.notes.length) out.problems.push({ item: b, problems: rec.notes })
  }
  return out
}

function buildReport(ctx) {
  const pd = profileDir(ctx)
  const entries = readEntries(ctx)
  const bundles = checkBundles(pd.dir)

  /* 关键区分：只有「用户自己装的插件被禁用」才是故障信号。
     宿主内置行（tool-bash / plan-mode / tool-web 等）被关掉是正常状态，
     一律标红等于喊狼来了。 */
  const installed = new Set(bundles.bundles.map((b) => b.name))
  for (const r of entries.rows) {
    r.origin = installed.has(r.name) || installed.has(r.id) ? 'installed' : 'host'
  }
  const off = entries.rows.filter((r) => r.disabled)
  const mine = off.filter((r) => r.origin === 'installed')
  const hostOff = off.filter((r) => r.origin !== 'installed')

  return {
    ok: true,
    plugin: { name: NS, version: VERSION },
    at: new Date().toISOString(),
    host: hostVersion(ctx),
    profile: { dir: pd.dir, via: pd.via },
    loader: {
      entriesApi: entries.entriesApi,
      error: entries.error,
      rowCount: entries.rows.length,
      /* 只有这一项非空才值得红色告警 */
      disabledInstalled: mine.map((r) => r.id || r.name),
      disabledHostCount: hostOff.length,
      disabledHost: hostOff.map((r) => r.id || r.name),
      rows: entries.rows,
    },
    bundles: bundles.bundles,
    problems: bundles.problems,
  }
}

/* ── 插件主体 ─────────────────────────────────────────────────────────────── */

function resolveWebServer(ctx) {
  try {
    const viaGet = typeof ctx.get === 'function' ? ctx.get('webServer') : undefined
    if (viaGet) return viaGet
  } catch { /* noop */ }
  return ctx.webServer
}

function apply(ctx) {
  const disposers = []
  try {
    const webServer = resolveWebServer(ctx)
    if (!webServer || typeof webServer.register !== 'function') return

    function rejected(req, res) {
      try {
        const conn = (typeof ctx.get === 'function' ? ctx.get('connection') : undefined) || ctx.connection
        if (!conn || typeof conn.requestRejection !== 'function') return false
        const code = conn.requestRejection(req)
        if (code === undefined || code === null || code === false) return false
        res.statusCode = typeof code === 'number' ? code : 403
        res.end()
        return true
      } catch {
        return false
      }
    }

    function route(path_, handler) {
      return webServer.register({
        kind: 'exact',
        path: path_,
        handler: async (req, res) => {
          if (rejected(req, res)) return
          return handler(req, res)
        },
      })
    }

    function json(res, payload) {
      const body = Buffer.from(JSON.stringify(payload, null, 2), 'utf8')
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': String(body.length) })
      res.end(body)
    }

    disposers.push(
      route(ROUTE + '/probe', (req, res) => {
        const e = readEntries(ctx)
        json(res, { ok: true, entriesApi: e.entriesApi, error: e.error, rowCount: e.rows.length, sample: e.rows.slice(0, 5) })
      }),
    )

    disposers.push(
      route(ROUTE + '/report', (req, res) => {
        json(res, safe(() => buildReport(ctx)) ?? { ok: false, error: '报告生成失败' })
      }),
    )

    ctx.effect(() => () => {
      for (const d of disposers) {
        try {
          d()
        } catch { /* noop */ }
      }
    })
  } catch (err) {
    try {
      ctx.logger?.warn?.(`[${NS}] 初始化失败: ${(err && err.message) || err}`)
    } catch { /* noop */ }
  }
}

export { apply, buildReport, inject, name }
