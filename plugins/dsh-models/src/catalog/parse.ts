import type { ModelsDevCatalog, ModelsDevModel, ModelsDevProvider, ModelsDevReasoningOption } from './types'

const MAX_CLIENT_BODY_CHARS = 16 * 1024 * 1024

function record(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null
}

function string(value: unknown) {
	return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function bool(value: unknown) {
	return value === true
}

function positiveInt(value: unknown) {
	const n = Number(value)
	return Number.isSafeInteger(n) && n > 0 ? n : undefined
}

function strings(value: unknown) {
	if (!Array.isArray(value)) return []
	return value.flatMap((item) => (typeof item === 'string' && item.trim() ? [item.trim()] : []))
}

function parseModel(key: string, raw: unknown): ModelsDevModel | null {
	const item = record(raw)
	if (!item) return null
	const id = string(item.id) ?? key
	if (!id) return null
	const modalities = record(item.modalities)
	const limit = record(item.limit)
	return {
		id,
		name: string(item.name) ?? id,
		description: string(item.description),
		type: string(item.type),
		reasoning: bool(item.reasoning),
		reasoningOptions: Array.isArray(item.reasoning_options)
			? item.reasoning_options.filter((option): option is ModelsDevReasoningOption => record(option) !== null)
			: [],
		toolCall: bool(item.tool_call),
		status: string(item.status),
		modalities: {
			input: strings(modalities?.input),
			output: strings(modalities?.output),
		},
		limit: {
			context: positiveInt(limit?.context),
			output: positiveInt(limit?.output),
		},
	}
}

export function parseCatalogWire(
	raw: unknown,
	metadata?: {
		etag?: string | null
		checkedAt?: number | null
		updatedAt?: number | null
	},
): ModelsDevCatalog {
	const root = record(raw)
	if (!root) throw new Error('models.dev 目录根节点不是对象')
	const providers: ModelsDevProvider[] = []
	for (const [key, value] of Object.entries(root)) {
		const item = record(value)
		if (!item) continue
		const id = string(item.id) ?? key
		const modelsObject = record(item.models)
		if (!id || !modelsObject) continue
		const models: ModelsDevModel[] = []
		for (const [modelKey, modelRaw] of Object.entries(modelsObject)) {
			const model = parseModel(modelKey, modelRaw)
			if (model) models.push(model)
		}
		models.sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id))
		providers.push({
			id,
			name: string(item.name) ?? id,
			npm: string(item.npm),
			api: string(item.api),
			env: strings(item.env),
			models,
		})
	}
	if (providers.length === 0) throw new Error('models.dev 目录中没有有效 Provider')
	providers.sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id))
	return {
		providers,
		providerById: new Map(providers.map((provider) => [provider.id, provider])),
		etag: metadata?.etag ?? null,
		checkedAt: metadata?.checkedAt ?? null,
		updatedAt: metadata?.updatedAt ?? null,
	}
}

function headerTime(value: string | null) {
	if (!value) return null
	const n = Number(value)
	return Number.isFinite(n) && n > 0 ? n : null
}

let cached: ModelsDevCatalog | null = null
let cachedEtag: string | null = null
let inflight: Promise<ModelsDevCatalog> | null = null

export async function loadCatalog(force = false): Promise<ModelsDevCatalog> {
	if (inflight) return inflight
	inflight = (async () => {
		const headers: Record<string, string> = { Accept: 'application/json' }
		if (!force && cachedEtag) headers['If-None-Match'] = cachedEtag
		const response = await fetch('/dsh-models/catalog', { method: 'GET', headers })
		if (response.status === 304 && cached) return cached
		const text = await response.text()
		if (text.length > MAX_CLIENT_BODY_CHARS) throw new Error('Host 目录响应超过客户端体积上限')
		if (!response.ok) {
			let message = `Host 目录接口返回 HTTP ${response.status}`
			try {
				const body = JSON.parse(text) as { error?: string; detail?: string }
				message = body.detail || body.error || message
			} catch {}
			throw new Error(message)
		}
		let raw: unknown
		try {
			raw = JSON.parse(text)
		} catch {
			throw new Error('Host 返回了无效的 models.dev JSON')
		}
		const catalog = parseCatalogWire(raw, {
			etag: response.headers.get('etag'),
			checkedAt: headerTime(response.headers.get('x-dsh-models-checked-at')),
			updatedAt: headerTime(response.headers.get('x-dsh-models-updated-at')),
		})
		cached = catalog
		cachedEtag = catalog.etag
		return catalog
	})()
	try {
		return await inflight
	} finally {
		inflight = null
	}
}

export function resetCatalogCacheForTest() {
	cached = null
	cachedEtag = null
	inflight = null
}
