import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'

type ActiveAppContext = {
  processName: string
  title: string
  mode: string
}

const voiceAPI = {
  onStartRecording(callback: () => void): () => void {
    const listener = (): void => {
      callback()
    }

    ipcRenderer.on('voice:start', listener)

    return () => {
      ipcRenderer.removeListener('voice:start', listener)
    }
  },

  onStopRecording(callback: () => void): () => void {
    const listener = (): void => {
      callback()
    }

    ipcRenderer.on('voice:stop', listener)

    return () => {
      ipcRenderer.removeListener('voice:stop', listener)
    }
  },

  onCancelRecording(callback: () => void): () => void {
    const listener = (): void => {
      callback()
    }

    ipcRenderer.on('voice:cancel', listener)

    return () => {
      ipcRenderer.removeListener('voice:cancel', listener)
    }
  },

  onContext(callback: (context: ActiveAppContext) => void): () => void {
    const listener = (_event: IpcRendererEvent, context: ActiveAppContext): void => {
      callback(context)
    }

    ipcRenderer.on('voice:context', listener)

    return () => {
      ipcRenderer.removeListener('voice:context', listener)
    }
  },

  getStore(): Promise<unknown> {
    return ipcRenderer.invoke('store:get')
  },

  addDictionaryWord(word: string): Promise<unknown> {
    return ipcRenderer.invoke('dictionary:add', word)
  },

  removeDictionaryWord(word: string): Promise<unknown> {
    return ipcRenderer.invoke('dictionary:remove', word)
  },

  addSnippet(data: { trigger: string; expansion: string }): Promise<unknown> {
    return ipcRenderer.invoke('snippets:add', data)
  },

  removeSnippet(id: string): Promise<unknown> {
    return ipcRenderer.invoke('snippets:remove', id)
  },

  setWritingStyle(style: string): Promise<unknown> {
    return ipcRenderer.invoke('settings:set-writing-style', style)
  },

  updateSettings(patch: Record<string, unknown>): Promise<unknown> {
    return ipcRenderer.invoke('settings:update', patch)
  },

  clearHistory(): Promise<unknown> {
    return ipcRenderer.invoke('history:clear')
  },

  onHistoryUpdated(callback: (item: unknown) => void): () => void {
    const listener = (_event: IpcRendererEvent, item: unknown): void => {
      callback(item)
    }

    ipcRenderer.on('history:updated', listener)

    return () => {
      ipcRenderer.removeListener('history:updated', listener)
    }
  },

  finalizeLiveTranscript(
    text: string
  ): Promise<{ rawText: string; cleanedText: string }> {
    return ipcRenderer.invoke('voice:finalize-live', text)
  },

  processRecording(audio: ArrayBuffer): Promise<{ rawText: string; cleanedText: string }> {
    return ipcRenderer.invoke('voice:process-recording', audio)
  }
}

contextBridge.exposeInMainWorld('voiceAPI', voiceAPI)
