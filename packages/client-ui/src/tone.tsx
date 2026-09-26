import type { ReactNode } from 'react'
import tone from './tone.module.css'

export type Tone = 'ok' | 'warn' | 'err'

export const toneStyles = tone

export function ToneChip(props: { tone: Tone; children: ReactNode }) {
  const color = props.tone === 'ok' ? tone.chipOk : props.tone === 'warn' ? tone.chipWarn : tone.chipErr
  return (
    <span className={tone.chip + ' ' + color} role="status">
      {props.children}
    </span>
  )
}
