export function errMsg(error: unknown): string {
  const message = (error as { message?: string } | null | undefined)?.message
  return message || String(error)
}
