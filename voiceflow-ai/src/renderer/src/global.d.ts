export {}

declare global {
  type WritingStyle = 'natural' | 'professional' | 'concise' | 'friendly' | 'developer'
  type LanguagePreference = 'auto' | 'en-IN' | 'hi-IN'
  type ShortcutPreset = 'ctrl-space' | 'ctrl-shift-space'

  interface HistoryItem {
    id: string
    rawText: string
    finalText: string
    processName: string
    windowTitle: string
    mode: string
    createdAt: string
  }

  interface Snippet {
    id: string
    trigger: string
    expansion: string
  }

  interface VoiceFlowStore {
    history: HistoryItem[]
    dictionary: string[]
    snippets: Snippet[]
    settings: {
      writingStyle: WritingStyle
      microphoneId: string
      language: LanguagePreference
      shortcut: ShortcutPreset
      launchAtStartup: boolean
      soundFeedback: boolean
    }
  }

  interface Window {
    voiceAPI: {
      onStartRecording: (callback: () => void) => () => void

      onStopRecording: (callback: () => void) => () => void

      onCancelRecording: (callback: () => void) => () => void

      onContext: (
        callback: (context: {
          processName: string
          title: string
          mode: string
        }) => void
      ) => () => void

      getStore: () => Promise<VoiceFlowStore>

      addDictionaryWord: (word: string) => Promise<VoiceFlowStore>

      removeDictionaryWord: (word: string) => Promise<VoiceFlowStore>

      addSnippet: (data: { trigger: string; expansion: string }) => Promise<VoiceFlowStore>

      removeSnippet: (id: string) => Promise<VoiceFlowStore>

      setWritingStyle: (style: WritingStyle) => Promise<VoiceFlowStore>

      updateSettings: (
        patch: Partial<VoiceFlowStore['settings']>
      ) => Promise<VoiceFlowStore>

      clearHistory: () => Promise<VoiceFlowStore>

      onHistoryUpdated: (callback: (item: HistoryItem) => void) => () => void

      finalizeLiveTranscript: (text: string) => Promise<{
        rawText: string
        cleanedText: string
      }>

      processRecording: (audio: ArrayBuffer) => Promise<{
        rawText: string

        cleanedText: string
      }>
    }
  }
}
