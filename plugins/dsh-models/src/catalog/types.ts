export interface ModelsDevReasoningOption {
  type?: unknown
  values?: unknown
  min?: unknown
  max?: unknown
}

export interface ModelsDevModel {
  id: string
  name: string
  description?: string
  type?: string
  reasoning: boolean
  reasoningOptions: readonly ModelsDevReasoningOption[]
  toolCall: boolean
  status?: string
  modalities: {
    input: readonly string[]
    output: readonly string[]
  }
  limit: {
    context?: number
    output?: number
  }
}

export interface ModelsDevProvider {
  id: string
  name: string
  npm?: string
  api?: string
  env: readonly string[]
  models: readonly ModelsDevModel[]
}

export interface ModelsDevCatalog {
  providers: readonly ModelsDevProvider[]
  providerById: ReadonlyMap<string, ModelsDevProvider>
  etag: string | null
  checkedAt: number | null
  updatedAt: number | null
}

export interface DiscoveredModel {
  id: string
  name?: string
  contextWindow?: number
  maxTokens?: number
}
