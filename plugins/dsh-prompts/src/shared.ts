export const FILE_PATH = '/dsh-prompts/file'
export const SAVE_PATH = '/dsh-prompts/save'
export const DELETE_PATH = '/dsh-prompts/delete'

export interface PromptFile {
  path: string
  exists: boolean
  content: string
  revision: string | null
}
