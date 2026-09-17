import { useCallback, useEffect, useRef, useState } from 'react'
import type { JSX } from 'react'

import './App.css'

type VoiceStatus = 'idle' | 'listening' | 'processing' | 'done' | 'error'

function getShortcutLabel(shortcut: ShortcutPreset): string {
  switch (shortcut) {
    case 'alt-space':
      return 'Alt + Space'
    case 'ctrl-shift-space':
      return 'Ctrl + Shift + Space'
    default:
      return 'Ctrl + Space'
  }
}

function MainApp(): JSX.Element {
  const [page, setPage] = useState<
    'home' | 'history' | 'dictionary' | 'snippets' | 'settings'
  >('home')
  const [store, setStore] = useState<VoiceFlowStore | null>(null)
  const [dictionaryWord, setDictionaryWord] = useState('')
  const [snippetTrigger, setSnippetTrigger] = useState('')
  const [snippetExpansion, setSnippetExpansion] = useState('')
  const [microphones, setMicrophones] = useState<MediaDeviceInfo[]>([])
  const [microphoneError, setMicrophoneError] = useState('')

  async function loadStore(): Promise<void> {
    const data = await window.voiceAPI.getStore()
    setStore(data)
  }

  const loadMicrophones = useCallback(async (): Promise<void> => {
    try {
      setMicrophoneError('')

      const temporaryStream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const devices = await navigator.mediaDevices.enumerateDevices()

      temporaryStream.getTracks().forEach((track) => track.stop())
      setMicrophones(devices.filter((device) => device.kind === 'audioinput'))
    } catch (error) {
      console.error(error)
      setMicrophoneError('Could not access microphones.')
    }
  }, [])

  useEffect(() => {
    void loadStore()

    const remove = window.voiceAPI.onHistoryUpdated(() => {
      void loadStore()
    })

    return remove
  }, [])

  useEffect(() => {
    if (page === 'settings') {
      void loadMicrophones()
    }
  }, [loadMicrophones, page])

  if (!store) {
    return <div className="app-loading">VoiceFlow AI</div>
  }

  async function addWord(): Promise<void> {
    if (!dictionaryWord.trim()) {
      return
    }

    const updated = await window.voiceAPI.addDictionaryWord(dictionaryWord)
    setStore(updated)
    setDictionaryWord('')
  }

  async function addSnippet(): Promise<void> {
    if (!snippetTrigger.trim() || !snippetExpansion.trim()) {
      return
    }

    const updated = await window.voiceAPI.addSnippet({
      trigger: snippetTrigger,
      expansion: snippetExpansion
    })

    setStore(updated)
    setSnippetTrigger('')
    setSnippetExpansion('')
  }

  async function updateSettings(patch: Partial<VoiceFlowStore['settings']>): Promise<void> {
    const updated = await window.voiceAPI.updateSettings(patch)
    setStore(updated)
  }

  return (
    <div className="desktop-app">
      <aside className="sidebar">
        <div className="sidebar-logo">
          <div>V</div>
          <span>VoiceFlow AI</span>
        </div>

        <nav>
          <button className={page === 'home' ? 'active' : ''} onClick={() => setPage('home')}>
            Home
          </button>
          <button className={page === 'history' ? 'active' : ''} onClick={() => setPage('history')}>
            History
          </button>
          <button
            className={page === 'dictionary' ? 'active' : ''}
            onClick={() => setPage('dictionary')}
          >
            Dictionary
          </button>
          <button
            className={page === 'snippets' ? 'active' : ''}
            onClick={() => setPage('snippets')}
          >
            Snippets
          </button>
          <button
            className={page === 'settings' ? 'active' : ''}
            onClick={() => setPage('settings')}
          >
            Settings
          </button>
        </nav>

        <div className="sidebar-status">
          <span />
          VoiceFlow ready
        </div>
      </aside>

      <main className="app-content">
        {page === 'home' && (
          <>
            <div className="page-header">
              <div>
                <p>VOICEFLOW AI</p>
                <h1>Speak naturally.</h1>
              </div>
            </div>

            <div className="push-card">
              <div className="push-mic">🎙️</div>
              <div>
                <small>PUSH TO TALK</small>
                <h2>Hold {getShortcutLabel(store.settings.shortcut)}</h2>
                <p>Speak anywhere on Windows.</p>
              </div>
            </div>

            <div className="dashboard-stats">
              <div>
                <span>{store.history.length}</span>
                <p>Dictations</p>
              </div>
              <div>
                <span>{store.dictionary.length}</span>
                <p>Custom words</p>
              </div>
              <div>
                <span>{store.snippets.length}</span>
                <p>Snippets</p>
              </div>
            </div>

            <section className="recent-section">
              <h3>Recent dictations</h3>

              {store.history.slice(0, 5).map((item) => (
                <div className="history-row" key={item.id}>
                  <div>
                    <strong>{item.finalText}</strong>
                    <small>
                      {item.processName} · {item.mode}
                    </small>
                  </div>
                  <time>{new Date(item.createdAt).toLocaleTimeString()}</time>
                </div>
              ))}
            </section>
          </>
        )}

        {page === 'history' && (
          <>
            <div className="page-header">
              <div>
                <p>ACTIVITY</p>
                <h1>History</h1>
              </div>

              <button
                className="secondary-button"
                onClick={async () => {
                  const updated = await window.voiceAPI.clearHistory()
                  setStore(updated)
                }}
              >
                Clear history
              </button>
            </div>

            <div className="list-card">
              {store.history.map((item) => (
                <div className="history-item" key={item.id}>
                  <p>{item.finalText}</p>
                  <div>
                    <span>{item.processName}</span>
                    <span>{item.mode}</span>
                    <span>{new Date(item.createdAt).toLocaleString()}</span>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}

        {page === 'dictionary' && (
          <>
            <div className="page-header">
              <div>
                <p>PERSONALIZATION</p>
                <h1>Dictionary</h1>
              </div>
            </div>

            <div className="add-row">
              <input
                value={dictionaryWord}
                onChange={(event) => setDictionaryWord(event.target.value)}
                placeholder="Qdrant, Shadcn, company name..."
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    void addWord()
                  }
                }}
              />

              <button onClick={() => void addWord()}>Add word</button>
            </div>

            <div className="dictionary-grid">
              {store.dictionary.map((word) => (
                <div className="dictionary-chip" key={word}>
                  {word}
                  <button
                    onClick={async () => {
                      const updated = await window.voiceAPI.removeDictionaryWord(word)
                      setStore(updated)
                    }}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          </>
        )}

        {page === 'snippets' && (
          <>
            <div className="page-header">
              <div>
                <p>AUTOMATION</p>
                <h1>Snippets</h1>
              </div>
            </div>

            <div className="snippet-form">
              <input
                value={snippetTrigger}
                onChange={(event) => setSnippetTrigger(event.target.value)}
                placeholder='Voice trigger e.g. "my github"'
              />

              <textarea
                value={snippetExpansion}
                onChange={(event) => setSnippetExpansion(event.target.value)}
                placeholder="Text that should be inserted..."
              />

              <button onClick={() => void addSnippet()}>Create snippet</button>
            </div>

            <div className="list-card">
              {store.snippets.map((snippet) => (
                <div className="snippet-item" key={snippet.id}>
                  <div>
                    <small>SAY</small>
                    <strong>{snippet.trigger}</strong>
                    <p>{snippet.expansion}</p>
                  </div>

                  <button
                    onClick={async () => {
                      const updated = await window.voiceAPI.removeSnippet(snippet.id)
                      setStore(updated)
                    }}
                  >
                    Delete
                  </button>
                </div>
              ))}
            </div>
          </>
        )}

        {page === 'settings' && (
          <>
            <div className="page-header">
              <div>
                <p>VOICEFLOW</p>
                <h1>Settings</h1>
              </div>
            </div>

            <div className="settings-grid">
              <section className="settings-card">
                <h3>Microphone</h3>
                <p>Choose which microphone VoiceFlow records from.</p>
                <select
                  value={store.settings.microphoneId}
                  onChange={(event) =>
                    void updateSettings({ microphoneId: event.target.value })
                  }
                >
                  <option value="">System default</option>
                  {microphones.map((microphone, index) => (
                    <option value={microphone.deviceId} key={microphone.deviceId}>
                      {microphone.label || `Microphone ${index + 1}`}
                    </option>
                  ))}
                </select>
                {microphoneError && <small className="setting-error">{microphoneError}</small>}
              </section>

              <section className="settings-card">
                <h3>Dictation language</h3>
                <p>Auto is recommended for Hinglish and multilingual speech.</p>
                <select
                  value={store.settings.language}
                  onChange={(event) =>
                    void updateSettings({
                      language: event.target.value as LanguagePreference
                    })
                  }
                >
                  <option value="auto">Auto detect</option>
                  <option value="en-IN">English (India)</option>
                  <option value="hi-IN">Hindi</option>
                </select>
              </section>

              <section className="settings-card">
                <h3>Push-to-talk shortcut</h3>
                <p>Hold this shortcut while speaking.</p>
                <select
                  value={store.settings.shortcut}
                  onChange={(event) =>
                    void updateSettings({
                      shortcut: event.target.value as ShortcutPreset
                    })
                  }
                >
                  <option value="ctrl-space">Ctrl + Space</option>
                  <option value="alt-space">Alt + Space</option>
                  <option value="ctrl-shift-space">Ctrl + Shift + Space</option>
                </select>
                <div className="keyboard-help">Press Esc during dictation to cancel.</div>
              </section>

              <section className="settings-card">
                <h3>Writing style</h3>
                <p>Controls final Gemini text polishing.</p>
                <select
                  value={store.settings.writingStyle}
                  onChange={(event) =>
                    void updateSettings({
                      writingStyle: event.target.value as WritingStyle
                    })
                  }
                >
                  <option value="natural">Natural</option>
                  <option value="professional">Professional</option>
                  <option value="concise">Concise</option>
                  <option value="friendly">Friendly</option>
                  <option value="developer">Developer</option>
                </select>
              </section>

              <section className="settings-card toggle-setting">
                <div>
                  <h3>Sound feedback</h3>
                  <p>Play subtle sounds when dictation starts or is cancelled.</p>
                </div>
                <label className="switch">
                  <input
                    type="checkbox"
                    checked={store.settings.soundFeedback}
                    onChange={(event) =>
                      void updateSettings({ soundFeedback: event.target.checked })
                    }
                  />
                  <span />
                </label>
              </section>

              <section className="settings-card toggle-setting">
                <div>
                  <h3>Start with Windows</h3>
                  <p>Launch VoiceFlow silently in the system tray after login.</p>
                </div>
                <label className="switch">
                  <input
                    type="checkbox"
                    checked={store.settings.launchAtStartup}
                    onChange={(event) =>
                      void updateSettings({ launchAtStartup: event.target.checked })
                    }
                  />
                  <span />
                </label>
              </section>
            </div>
          </>
        )}
      </main>
    </div>
  )
}

function VoiceOverlay(): JSX.Element {
  const [status, setStatus] = useState<VoiceStatus>('idle')
  const [liveTranscript, setLiveTranscript] = useState('')
  const [shortcutLabel, setShortcutLabel] = useState('Ctrl + Space')
  const [appContext, setAppContext] = useState({
    processName: '',
    title: '',
    mode: 'general'
  })

  const streamRef = useRef<MediaStream | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const workletNodeRef = useRef<AudioWorkletNode | null>(null)
  const websocketRef = useRef<WebSocket | null>(null)
  const liveReadyRef = useRef(false)
  const pendingPCMRef = useRef<ArrayBuffer[]>([])
  const finalTranscriptRef = useRef('')
  const finalResolveRef = useRef<((text: string) => void) | null>(null)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const soundEnabledRef = useRef(true)
  const cancelledRef = useRef(false)

  async function getMicrophoneStream(microphoneId: string): Promise<MediaStream> {
    const baseOptions = {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    }

    if (microphoneId) {
      try {
        return await navigator.mediaDevices.getUserMedia({
          audio: {
            ...baseOptions,
            deviceId: {
              exact: microphoneId
            }
          },
          video: false
        })
      } catch (error) {
        console.warn('Selected microphone unavailable, using default.', error)
      }
    }

    return navigator.mediaDevices.getUserMedia({
      audio: baseOptions,
      video: false
    })
  }

  function playTone(frequency: number, duration = 70): void {
    if (!soundEnabledRef.current) {
      return
    }

    try {
      const context = new AudioContext()
      const oscillator = context.createOscillator()
      const gain = context.createGain()

      oscillator.frequency.value = frequency
      gain.gain.value = 0.035
      oscillator.connect(gain)
      gain.connect(context.destination)
      oscillator.start()
      oscillator.stop(context.currentTime + duration / 1000)

      setTimeout(() => {
        void context.close()
      }, duration + 80)
    } catch {
      // Sound feedback is optional.
    }
  }

  function waitForFinalTranscript(timeout = 3500): Promise<string> {
    if (finalTranscriptRef.current) {
      return Promise.resolve(finalTranscriptRef.current)
    }

    return new Promise((resolve) => {
      let completed = false

      const finish = (text: string): void => {
        if (completed) {
          return
        }

        completed = true
        finalResolveRef.current = null
        resolve(text)
      }

      finalResolveRef.current = finish

      setTimeout(() => {
        finish(finalTranscriptRef.current)
      }, timeout)
    })
  }

  function startFallbackRecorder(stream: MediaStream): void {
    chunksRef.current = []

    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : ''
    const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream)

    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        chunksRef.current.push(event.data)
      }
    }

    recorder.start(250)
    mediaRecorderRef.current = recorder
  }

  function stopFallbackRecorder(): Promise<ArrayBuffer | null> {
    return new Promise((resolve) => {
      const recorder = mediaRecorderRef.current

      if (!recorder || recorder.state === 'inactive') {
        resolve(null)
        return
      }

      recorder.onstop = async () => {
        const blob = new Blob(chunksRef.current, {
          type: recorder.mimeType || 'audio/webm'
        })

        resolve(await blob.arrayBuffer())
      }

      recorder.stop()
    })
  }

  async function startRecording(): Promise<void> {
    try {
      if (streamRef.current) {
        return
      }

      setStatus('listening')
      setLiveTranscript('')

      cancelledRef.current = false
      finalTranscriptRef.current = ''
      finalResolveRef.current = null
      pendingPCMRef.current = []
      liveReadyRef.current = false

      const store = await window.voiceAPI.getStore()

      soundEnabledRef.current = store.settings.soundFeedback
      setShortcutLabel(getShortcutLabel(store.settings.shortcut))
      playTone(760)

      const stream = await getMicrophoneStream(store.settings.microphoneId)

      if (cancelledRef.current) {
        stream.getTracks().forEach((track) => track.stop())
        return
      }

      streamRef.current = stream
      startFallbackRecorder(stream)

      const ws = new WebSocket('ws://127.0.0.1:4000/ws/transcribe')
      websocketRef.current = ws
      ws.binaryType = 'arraybuffer'

      ws.onopen = () => {
        ws.send(
          JSON.stringify({
            type: 'start',
            dictionary: store.dictionary,
            language: store.settings.language
          })
        )
      }

      ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data as string) as {
            type?: string
            text?: string
            message?: string
          }

          if (message.type === 'ready') {
            liveReadyRef.current = true

            for (const chunk of pendingPCMRef.current) {
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(chunk)
              }
            }

            pendingPCMRef.current = []
            return
          }

          if (message.type === 'interim' && message.text) {
            setLiveTranscript(message.text)
            return
          }

          if (message.type === 'final' && message.text) {
            const text = message.text.trim()

            finalTranscriptRef.current = text
            setLiveTranscript(text)
            finalResolveRef.current?.(text)
            return
          }

          if (message.type === 'error') {
            console.error('Live transcription:', message.message)
          }
        } catch (error) {
          console.error('WebSocket parsing failed:', error)
        }
      }

      ws.onerror = (error) => {
        console.error('Live websocket error:', error)
      }

      const audioContext = new AudioContext()
      audioContextRef.current = audioContext

      await audioContext.audioWorklet.addModule('/pcm-worklet.js')

      const source = audioContext.createMediaStreamSource(stream)
      const worklet = new AudioWorkletNode(audioContext, 'voiceflow-pcm')
      const gain = audioContext.createGain()

      workletNodeRef.current = worklet
      gain.gain.value = 0

      worklet.port.onmessage = (event) => {
        const pcmChunk = event.data as ArrayBuffer
        const socket = websocketRef.current

        if (socket && liveReadyRef.current && socket.readyState === WebSocket.OPEN) {
          socket.send(pcmChunk)
        } else {
          pendingPCMRef.current.push(pcmChunk)

          if (pendingPCMRef.current.length > 100) {
            pendingPCMRef.current.shift()
          }
        }
      }

      source.connect(worklet)
      worklet.connect(gain)
      gain.connect(audioContext.destination)

      console.log('🎙 Live streaming started')
    } catch (error) {
      console.error('Unable to start live dictation:', error)
      setStatus('error')
    }
  }

  async function stopRecording(): Promise<void> {
    try {
      setStatus('processing')

      workletNodeRef.current?.disconnect()
      workletNodeRef.current = null

      if (audioContextRef.current) {
        await audioContextRef.current.close().catch(() => undefined)
      }

      audioContextRef.current = null

      const fallbackAudioPromise = stopFallbackRecorder()
      const socket = websocketRef.current

      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'stop' }))
      }

      const liveText = await waitForFinalTranscript(3500)
      const fallbackAudio = await fallbackAudioPromise

      if (liveText.trim()) {
        console.log('📝 LIVE TRANSCRIPT:', liveText)

        const result = await window.voiceAPI.finalizeLiveTranscript(liveText)

        console.log('✨ FINAL:', result.cleanedText)
        setLiveTranscript(result.cleanedText)
        setStatus('done')
      } else if (fallbackAudio) {
        console.log('⚠ Live transcription unavailable. Using WebM fallback...')

        const result = await window.voiceAPI.processRecording(fallbackAudio)

        setLiveTranscript(result.cleanedText)
        setStatus('done')
      } else {
        throw new Error('No transcript or recording available')
      }
    } catch (error) {
      console.error('Dictation processing failed:', error)
      setStatus('error')
    } finally {
      streamRef.current?.getTracks().forEach((track) => {
        track.stop()
      })

      streamRef.current = null
      mediaRecorderRef.current = null
      chunksRef.current = []
      pendingPCMRef.current = []
      liveReadyRef.current = false

      setTimeout(() => {
        websocketRef.current?.close()
        websocketRef.current = null
      }, 300)
    }
  }

  async function cancelRecording(): Promise<void> {
    console.log('❌ Cancelling dictation...')

    cancelledRef.current = true
    playTone(260, 100)
    setLiveTranscript('')
    setStatus('idle')

    try {
      workletNodeRef.current?.disconnect()
      workletNodeRef.current = null

      if (audioContextRef.current) {
        await audioContextRef.current.close().catch(() => undefined)
      }

      audioContextRef.current = null

      const recorder = mediaRecorderRef.current

      if (recorder && recorder.state !== 'inactive') {
        recorder.stop()
      }

      mediaRecorderRef.current = null
      websocketRef.current?.close()
      websocketRef.current = null

      streamRef.current?.getTracks().forEach((track) => track.stop())
      streamRef.current = null
      chunksRef.current = []
      pendingPCMRef.current = []
      finalTranscriptRef.current = ''
      finalResolveRef.current = null
      liveReadyRef.current = false
    } catch (error) {
      console.error('Cancel cleanup:', error)
    }
  }

  /* ============================================
     ELECTRON EVENTS
  ============================================ */

  useEffect(() => {
    const removeStart = window.voiceAPI.onStartRecording(startRecording)

    const removeStop = window.voiceAPI.onStopRecording(stopRecording)

    const removeCancel = window.voiceAPI.onCancelRecording(() => {
      void cancelRecording()
    })

    const removeContext = window.voiceAPI.onContext((context) => {
      setAppContext(context)
    })

    return () => {
      removeStart()

      removeStop()

      removeCancel()

      removeContext()

      websocketRef.current?.close()

      streamRef.current?.getTracks().forEach((track) => {
        track.stop()
      })

      void audioContextRef.current?.close()
    }
  }, [])

  const modeName =
    appContext.mode === 'developer'
      ? 'Developer'
      : appContext.mode === 'email'
        ? 'Email'
        : appContext.mode === 'chat'
          ? 'Chat'
          : appContext.mode === 'writing'
            ? 'Writing'
            : 'Smart'

  return (
    <div className="overlay-container">
      <div className="voice-bar live-voice-bar">
        <div className="overlay-mic">
          {status === 'processing' ? '✨' : status === 'done' ? '✓' : '🎙️'}
        </div>

        <div className="voice-info live-info">
          <div className="live-header">
            <strong>
              {status === 'listening'
                ? 'Listening...'
                : status === 'processing'
                  ? 'Polishing...'
                  : status === 'done'
                    ? 'Inserted'
                    : status === 'error'
                      ? 'Something went wrong'
                      : 'Ready'}
            </strong>

            <div className="app-context">
              <span className={`mode-dot ${appContext.mode}`} />
              {modeName} Mode
            </div>
          </div>

          {status === 'listening' && (
            <div className="wave">
              <span />
              <span />
              <span />
              <span />
              <span />
              <span />
              <span />
              <span />
              <span />
            </div>
          )}

          <div className="live-transcript">
            {liveTranscript ||
              (status === 'listening' ? 'Start speaking...' : 'Processing your dictation...')}
          </div>
        </div>

        <kbd>{shortcutLabel}</kbd>
      </div>
    </div>
  )
}

function App(): JSX.Element {
  const params = new URLSearchParams(window.location.search)

  const mode = params.get('mode')

  if (mode === 'overlay') {
    return <VoiceOverlay />
  }

  return <MainApp />
}

export default App
