/**
 * dsh-scheduled-send — 宿主端（定时发送）。
 *
 * 输入框发送按钮旁的那个箭头只是入口：真正「到点发出去」发生在宿主。
 * 客户端点「定时发送」时把 `{ sessionId, text, dueAt }` POST 给本插件的一条
 * 前缀路由，宿主把它记进自己的待发送队列；到点后调用
 * `ctx.sessionController.prompt(...)` —— 和输入框里按回车走的是同一条宿主
 * 路径，所以落进会话日志的就是一条普通的用户消息（source.kind === 'user'），
 * 页面关着、宿重启过都不影响。
 *
 * 路由（前缀 `/dsh-scheduled-send/api`）：
 *   GET  /info                      版本与队列规模
 *   POST /list    { sessionId }     该会话的待发送条目
 *   POST /create  { sessionId, text, dueAt, timeZone? } -> { item }
 *   POST /cancel  { id }            撤销一条
 *   POST /fire    { id }            立刻投递一条（自测 / 补发用）
 *
 * 队列落在 `$DSH_HOME/storages/dsh-scheduled-send/tasks.json`：插件 HMR 或宿主
 * 重启之后按绝对时间（epoch ms）重建，不依赖任何内存状态。
 *
 * @module dsh-scheduled-send
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** 插件 id，同时是客户端模块 id 与存储目录名。 */
export const name = 'dsh-scheduled-send'

/** 路由主体 + 投递用的会话服务。 */
export const inject = ['webServer', 'sessionController']

/** 路由前缀。 */
const API = '/dsh-scheduled-send/api'

/** 队列文件格式版本。 */
const STORE_VERSION = 1

/** 请求体上限：一条消息远小于这个数，这里只防滥用。 */
const MAX_BODY_BYTES = 64 * 1024

/** 单条消息的字符上限（与输入框的实际情况相比已经非常宽松）。 */
const MAX_TEXT_CHARS = 20_000

/** 允许的最小提前量：小于它就当成「现在」，直接拒掉。 */
const MIN_LEAD_MS = 1_000

/** 允许的最大提前量：一年。 */
const MAX_LEAD_MS = 366 * 24 * 60 * 60 * 1000

/** 扫描间隔：决定投递时间点的精度（1s 足够）。 */
const SCAN_INTERVAL_MS = 1_000

/** 投递失败后的重试间隔。 */
const RETRY_DELAY_MS = 60_000

/** 投递失败的最大重试次数，超过后丢弃并记一条 warning。 */
const MAX_ATTEMPTS = 5

/** 单次投递的时限。 */
const DELIVERY_TIMEOUT_MS = 30_000

/** 错误码：客户端按 err_<CODE> 查本地化文案。 */
export const ERR = {
	BAD_BODY: 'BAD_BODY',
	BAD_SESSION: 'BAD_SESSION',
	EMPTY: 'EMPTY',
	TOO_LONG: 'TOO_LONG',
	BAD_TIME: 'BAD_TIME',
	NOT_FUTURE: 'NOT_FUTURE',
	TOO_FAR: 'TOO_FAR',
	BAD_TZ: 'BAD_TZ',
	NOT_FOUND: 'NOT_FOUND',
	UNKNOWN: 'UNKNOWN',
	INTERNAL: 'INTERNAL',
}

/**
 * 读一条请求的 JSON 体。
 *
 * @param {import('node:http').IncomingMessage} req - 请求。
 * @returns {Promise<unknown>} 解析后的 JSON。
 */
function readBody(req) {
	return new Promise((resolve, reject) => {
		let size = 0
		const chunks = []
		req.on('data', (chunk) => {
			size += chunk.length
			if (size > MAX_BODY_BYTES) {
				reject(new Error('body too large'))
				return
			}
			chunks.push(chunk)
		})
		req.on('end', () => {
			const text = Buffer.concat(chunks).toString('utf8')
			if (text.trim() === '') {
				resolve({})
				return
			}
			try {
				resolve(JSON.parse(text))
			} catch (error) {
				reject(error)
			}
		})
		req.on('error', reject)
	})
}

/**
 * 回一个 JSON 响应。
 *
 * @param {import('node:http').ServerResponse} res - 响应。
 * @param {number} status - HTTP 状态码。
 * @param {unknown} payload - 响应体。
 */
function sendJson(res, status, payload) {
	if (res.headersSent === true || res.writableEnded === true) return
	const body = JSON.stringify(payload)
	res.writeHead(status, {
		'content-type': 'application/json; charset=utf-8',
		'cache-control': 'no-store',
		'content-length': Buffer.byteLength(body),
	})
	res.end(body)
}

/**
 * 校验一个 IANA 时区名。
 *
 * @param {unknown} value - 客户端给的时区。
 * @returns {string | undefined} 合法时区，或 undefined。
 */
function normalizeTimeZone(value) {
	if (typeof value !== 'string') return undefined
	const trimmed = value.trim()
	if (trimmed === '' || trimmed.length > 64) return undefined
	try {
		new Intl.DateTimeFormat('en-US', { timeZone: trimmed })
		return trimmed
	} catch {
		return undefined
	}
}

/** 面板里用的存储目录：$DSH_HOME/storages/<plugin>。 */
function storePath() {
	const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME !== ''
		? process.env.DSH_HOME
		: join(homedir(), '.dsh')
	return join(home, 'storages', name, 'tasks.json')
}

/**
 * 待发送队列：一个 JSON 文件 + 内存镜像。
 *
 * 所有写入串行化（一条 promise 链），写临时文件再 rename，避免半个文件。
 */
class TaskStore {
	/**
	 * @param {import('@deepseek-ai/cordis').Context} ctx - 插件上下文（只为 logger）。
	 */
	constructor(ctx) {
		this.ctx = ctx
		/** @type {string} */
		this.file = storePath()
		/** @type {Array<Record<string, unknown>>} */
		this.items = []
		/** @type {Promise<unknown>} */
		this.writeChain = Promise.resolve()
		/** @type {Promise<void>} */
		this.ready = this.load()
	}

	/** 读盘；文件不存在或坏掉都当成空队列，不让插件起不来。 */
	async load() {
		try {
			const raw = await readFile(this.file, 'utf8')
			const data = JSON.parse(raw)
			const items = Array.isArray(data?.items) ? data.items : []
			this.items = items.filter((item) => typeof item?.id === 'string'
				&& typeof item.sessionId === 'string'
				&& typeof item.text === 'string'
				&& Number.isFinite(item.dueAt))
		} catch (error) {
			if (error?.code !== 'ENOENT') {
				this.ctx.logger?.warn?.(`[${name}] 读取队列失败，按空队列启动：${error?.message ?? error}`)
			}
			this.items = []
		}
	}

	/** 落盘（串行）。 */
	persist() {
		const snapshot = JSON.stringify({ version: STORE_VERSION, items: this.items }, null, 2)
		this.writeChain = this.writeChain.then(async () => {
			await mkdir(dirname(this.file), { recursive: true })
			const temporary = `${this.file}.${process.pid}.tmp`
			await writeFile(temporary, snapshot, 'utf8')
			await rename(temporary, this.file)
		}).catch((error) => {
			this.ctx.logger?.warn?.(`[${name}] 写队列失败：${error?.message ?? error}`)
		})
		return this.writeChain
	}

	/** 某个会话的待发送条目，按时间升序。 */
	list(sessionId) {
		return this.items
			.filter((item) => item.sessionId === sessionId)
			.slice()
			.sort((a, b) => a.dueAt - b.dueAt)
	}

	/** 按 id 取一条。 */
	get(id) {
		return this.items.find((item) => item.id === id)
	}

	/** 追加一条并落盘。 */
	async add(item) {
		this.items.push(item)
		await this.persist()
		return item
	}

	/** 移除一条并落盘。 */
	async remove(id) {
		const before = this.items.length
		this.items = this.items.filter((item) => item.id !== id)
		if (this.items.length === before) return false
		await this.persist()
		return true
	}
}

/**
 * 到点投递：每秒扫一次队列，把到期的条目交给宿主的会话服务。
 */
class Scheduler {
	/**
	 * @param {import('@deepseek-ai/cordis').Context} ctx - 插件上下文。
	 * @param {TaskStore} store - 队列。
	 */
	constructor(ctx, store) {
		this.ctx = ctx
		this.store = store
		/** @type {ReturnType<typeof setInterval> | undefined} */
		this.timer = undefined
		/** 一次只跑一轮，避免慢投递叠起来。 */
		this.busy = false
		/** @type {Promise<void>} */
		this.stopped = Promise.resolve()
	}

	/** 起扫描。 */
	start() {
		if (this.timer !== undefined) return
		this.timer = setInterval(() => { void this.tick() }, SCAN_INTERVAL_MS)
		this.timer.unref?.()
		void this.tick()
	}

	/** 停扫描并等当前这一轮跑完。 */
	stop() {
		if (this.timer !== undefined) {
			clearInterval(this.timer)
			this.timer = undefined
		}
		return this.stopped
	}

	/** 一轮扫描。 */
	async tick() {
		if (this.busy === true) return
		this.busy = true
		const run = (async () => {
			await this.store.ready
			const now = Date.now()
			const due = this.store.items.filter((item) => item.dueAt <= now && (item.nextAttemptAt ?? 0) <= now)
			for (const item of due) {
				await this.deliver(item)
			}
		})()
		this.stopped = run.then(() => undefined, () => undefined)
		try {
			await run
		} finally {
			this.busy = false
		}
	}

	/**
	 * 投递一条：`mode: 'queue'` 表示「排一条普通消息」，会话忙就等它空下来。
	 *
	 * @param {Record<string, any>} item - 队列条目。
	 * @returns {Promise<{ ok: boolean, error?: string }>} 结果。
	 */
	async deliver(item) {
		const controller = new AbortController()
		const timeout = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS)
		timeout.unref?.()
		try {
			await this.ctx.sessionController.prompt({
				requestId: randomUUID(),
				sessionId: item.sessionId,
				mode: 'queue',
				content: [{ type: 'text', text: item.text }],
				...(typeof item.timeZone === 'string' ? { clientTimeZone: item.timeZone } : {}),
			}, controller.signal)
			await this.store.remove(item.id)
			return { ok: true }
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			const attempts = (item.attempts ?? 0) + 1
			if (attempts >= MAX_ATTEMPTS) {
				await this.store.remove(item.id)
				this.ctx.logger?.warn?.(`[${name}] 定时消息投递失败 ${attempts} 次，已丢弃（session ${item.sessionId}）：${message}`)
			} else {
				item.attempts = attempts
				item.lastError = message
				item.nextAttemptAt = Date.now() + RETRY_DELAY_MS
				await this.store.persist()
				this.ctx.logger?.warn?.(`[${name}] 定时消息投递失败，${RETRY_DELAY_MS / 1000}s 后重试（session ${item.sessionId}）：${message}`)
			}
			return { ok: false, error: message }
		} finally {
			clearTimeout(timeout)
		}
	}
}

/** 对外的条目形状：不带重试簿记。 */
function publicItem(item) {
	return {
		id: item.id,
		sessionId: item.sessionId,
		text: item.text,
		dueAt: item.dueAt,
		createdAt: item.createdAt,
	}
}

/** 只回收自己那条陈旧路由（HMR 之后上一代的 dispose 已经丢了）。 */
function reclaimRoute(ctx) {
	try {
		const table = ctx.webServer?.prefixes
		if (!(table instanceof Map)) return
		if (!table.has(API)) return
		table.delete(API)
		ctx.logger?.warn?.(`[${name}] reclaimed stale route ${API}`)
	} catch {
		/* prefixes 不是稳定契约，失败就交给 register 自己报错 */
	}
}

/**
 * 造路由处理函数。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - 插件上下文。
 * @param {TaskStore} store - 队列。
 * @param {Scheduler} scheduler - 投递器。
 * @returns {(req: any, res: any) => Promise<void>} 处理函数。
 */
function createHandler(ctx, store, scheduler) {
	const log = ctx.logger

	return async (req, res) => {
		const url = typeof req.url === 'string' ? req.url.split('?')[0] : ''
		const action = url.startsWith(`${API}/`) ? url.slice(API.length + 1).replace(/\/+$/, '') : ''

		try {
			if (action === 'info') {
				await store.ready
				sendJson(res, 200, {
					ok: true,
					name,
					version: '0.1.0',
					queued: store.items.length,
				})
				return
			}

			if (req.method !== 'POST') {
				sendJson(res, 405, { ok: false, code: ERR.UNKNOWN, message: 'POST required' })
				return
			}

			let body
			try {
				body = await readBody(req)
			} catch (error) {
				sendJson(res, 400, { ok: false, code: ERR.BAD_BODY, message: error instanceof Error ? error.message : 'invalid JSON' })
				return
			}
			const input = body !== null && typeof body === 'object' ? body : {}
			const sessionId = typeof input.sessionId === 'string' ? input.sessionId.trim() : ''

			if (action === 'list') {
				await store.ready
				if (sessionId === '') {
					sendJson(res, 400, { ok: false, code: ERR.BAD_SESSION, message: 'sessionId is required' })
					return
				}
				sendJson(res, 200, { ok: true, items: store.list(sessionId).map(publicItem) })
				return
			}

			if (action === 'create') {
				await store.ready
				if (sessionId === '') {
					sendJson(res, 400, { ok: false, code: ERR.BAD_SESSION, message: 'sessionId is required' })
					return
				}
				const text = typeof input.text === 'string' ? input.text.trim() : ''
				if (text === '') {
					sendJson(res, 400, { ok: false, code: ERR.EMPTY, message: 'message text is empty' })
					return
				}
				if (text.length > MAX_TEXT_CHARS) {
					sendJson(res, 400, { ok: false, code: ERR.TOO_LONG, message: `message text must be at most ${MAX_TEXT_CHARS} characters` })
					return
				}
				const dueAt = Number(input.dueAt)
				if (!Number.isFinite(dueAt)) {
					sendJson(res, 400, { ok: false, code: ERR.BAD_TIME, message: 'dueAt must be an epoch millisecond number' })
					return
				}
				const lead = dueAt - Date.now()
				if (lead < MIN_LEAD_MS) {
					sendJson(res, 400, { ok: false, code: ERR.NOT_FUTURE, message: 'dueAt must be in the future' })
					return
				}
				if (lead > MAX_LEAD_MS) {
					sendJson(res, 400, { ok: false, code: ERR.TOO_FAR, message: 'dueAt must be within a year' })
					return
				}
				let timeZone
				if (input.timeZone !== undefined && input.timeZone !== null && input.timeZone !== '') {
					timeZone = normalizeTimeZone(input.timeZone)
					if (timeZone === undefined) {
						sendJson(res, 400, { ok: false, code: ERR.BAD_TZ, message: 'timeZone must be UTC or a valid IANA Area/Location name' })
						return
					}
				}
				const item = {
					id: randomUUID(),
					sessionId,
					text,
					dueAt: Math.round(dueAt),
					createdAt: Date.now(),
					...(timeZone === undefined ? {} : { timeZone }),
				}
				await store.add(item)
				log?.info?.(`[${name}] 排入一条定时消息 ${item.id}（${new Date(item.dueAt).toISOString()}，session ${sessionId}）`)
				sendJson(res, 200, { ok: true, item: publicItem(item) })
				return
			}

			if (action === 'cancel') {
				await store.ready
				const id = typeof input.id === 'string' ? input.id.trim() : ''
				if (id === '') {
					sendJson(res, 400, { ok: false, code: ERR.NOT_FOUND, message: 'id is required' })
					return
				}
				const removed = await store.remove(id)
				sendJson(res, 200, { ok: true, removed })
				return
			}

			if (action === 'fire') {
				await store.ready
				const id = typeof input.id === 'string' ? input.id.trim() : ''
				const item = store.get(id)
				if (item === undefined) {
					sendJson(res, 404, { ok: false, code: ERR.NOT_FOUND, message: 'no queued item with that id' })
					return
				}
				const result = await scheduler.deliver(item)
				sendJson(res, 200, result.ok ? { ok: true } : { ok: false, code: ERR.INTERNAL, message: result.error ?? 'delivery failed' })
				return
			}

			sendJson(res, 404, { ok: false, code: ERR.UNKNOWN, message: `unknown route: ${url}` })
		} catch (error) {
			log?.warn?.(`[${name}] 路由处理失败：${error instanceof Error ? error.message : String(error)}`)
			sendJson(res, 500, { ok: false, code: ERR.INTERNAL, message: error instanceof Error ? error.message : 'internal error' })
		}
	}
}

/**
 * 挂载宿主端。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - 带 webServer / sessionController 的上下文。
 */
export function apply(ctx) {
	const store = new TaskStore(ctx)
	const scheduler = new Scheduler(ctx, store)

	ctx.effect(() => {
		scheduler.start()
		return () => { void scheduler.stop() }
	}, 'dsh-scheduled-send: scheduler')

	reclaimRoute(ctx)
	ctx.effect(
		() => ctx.webServer.register({ kind: 'prefix', path: API, handler: createHandler(ctx, store, scheduler) }),
		'dsh-scheduled-send: route',
	)
}
