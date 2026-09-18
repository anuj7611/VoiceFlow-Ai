import { app } from 'electron'

import { mkdir, readFile, writeFile } from 'node:fs/promises'

import { join } from 'node:path'

export type WritingStyle = 'natural' | 'professional' | 'concise' | 'friendly' | 'developer'
export type LanguagePreference = 'auto' | 'en-IN' | 'hi-IN'
export type ShortcutPreset = 'ctrl-space' | 'ctrl-shift-space'

export interface HistoryItem {
  id: string

  rawText: string

  finalText: string

  processName: string

  windowTitle: string

  mode: string

  createdAt: string
}

export interface Snippet {
  id: string

  trigger: string

  expansion: string
}

export interface VoiceFlowSettings {
  writingStyle: WritingStyle
  microphoneId: string
  language: LanguagePreference
  shortcut: ShortcutPreset
  launchAtStartup: boolean
  soundFeedback: boolean
}

export interface VoiceFlowStore {
  history: HistoryItem[]

  dictionary: string[]

  snippets: Snippet[]

  settings: VoiceFlowSettings
}

const defaultStore: VoiceFlowStore = {
  history: [],

  dictionary: [],

  snippets: [],

  settings: {
    writingStyle: 'natural',
    microphoneId: '',
    language: 'auto',
    shortcut: 'ctrl-space',
    launchAtStartup: false,
    soundFeedback: true
  }
}

function getStorePath(): string {
  return join(app.getPath('userData'), 'voiceflow-data.json')
}

export async function readVoiceFlowStore(): Promise<VoiceFlowStore> {
  const path = getStorePath()

  try {
    const data = await readFile(path, 'utf-8')

    const parsed = JSON.parse(data)

    return {
      history: Array.isArray(parsed.history) ? parsed.history : [],

      dictionary: Array.isArray(parsed.dictionary) ? parsed.dictionary : [],

      snippets: Array.isArray(parsed.snippets) ? parsed.snippets : [],

      settings: {
        ...defaultStore.settings,
        ...(parsed.settings ?? {}),
        shortcut:
          parsed.settings?.shortcut === 'ctrl-shift-space'
            ? 'ctrl-shift-space'
            : 'ctrl-space'
      }
    }
  } catch {
    await writeVoiceFlowStore(defaultStore)

    return structuredClone(defaultStore)
  }
}

export async function writeVoiceFlowStore(data: VoiceFlowStore): Promise<void> {
  await mkdir(app.getPath('userData'), {
    recursive: true
  })

  await writeFile(getStorePath(), JSON.stringify(data, null, 2), 'utf-8')
}
