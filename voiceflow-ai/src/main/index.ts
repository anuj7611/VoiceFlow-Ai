import { app, BrowserWindow, clipboard, ipcMain, Menu, screen, session, Tray } from 'electron'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

import {
  readVoiceFlowStore,
  writeVoiceFlowStore,
  type ShortcutPreset,
  type Snippet,
  type VoiceFlowSettings,
  type WritingStyle
} from './store'
import { uIOhook, UiohookKey, type UiohookKeyboardEvent } from 'uiohook-napi'

const API_URL = 'http://127.0.0.1:4000'

type ActiveAppContext = {
  processName: string
  title: string
  mode: 'developer' | 'email' | 'chat' | 'writing' | 'browser' | 'general'
}

let mainWindow: BrowserWindow | null = null
let overlayWindow: BrowserWindow | null = null
let tray: Tray | null = null

let isQuitting = false
let isPushToTalkActive = false
let currentShortcut: ShortcutPreset = 'ctrl-space'
let activeDictationId = 0
const cancelledDictationIds = new Set<number>()
let activeAppContext: ActiveAppContext = {
  processName: 'unknown',
  title: '',
  mode: 'general'
}

/* ======================================================
   LOAD REACT
====================================================== */

function loadRenderer(window: BrowserWindow, mode: 'main' | 'overlay'): void {
  const rendererUrl = process.env['ELECTRON_RENDERER_URL']

  if (rendererUrl) {
    window.loadURL(`${rendererUrl}?mode=${mode}`)
  } else {
    window.loadFile(join(__dirname, '../renderer/index.html'), {
      query: {
        mode
      }
    })
  }
}

function applyLaunchAtStartup(enabled: boolean): void {
  if (process.platform !== 'win32') {
    return
  }

  if (!app.isPackaged) {
    console.log(`Startup preference saved: ${enabled}`)
    return
  }

  app.setLoginItemSettings({
    openAtLogin: enabled,
    path: process.execPath,
    args: ['--background']
  })
}

/* ======================================================
   MAIN WINDOW
====================================================== */

function createMainWindow(): void {
  const startedInBackground = process.argv.includes('--background')

  mainWindow = new BrowserWindow({
    width: 1100,
    height: 720,

    show: false,

    minWidth: 900,
    minHeight: 600,

    title: 'VoiceFlow AI',

    backgroundColor: '#09090b',

    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),

      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.once('ready-to-show', () => {
    if (!startedInBackground) {
      mainWindow?.show()
    }
  })

  loadRenderer(mainWindow, 'main')

  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault()

      mainWindow?.hide()
    }
  })
}

/* ======================================================
   FLOATING VOICE OVERLAY
====================================================== */

function createOverlayWindow(): void {
  overlayWindow = new BrowserWindow({
    width: 560,
    height: 150,

    frame: false,

    transparent: true,

    alwaysOnTop: true,

    resizable: false,

    movable: false,

    skipTaskbar: true,

    focusable: false,

    show: false,

    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),

      contextIsolation: true,
      nodeIntegration: false
    }
  })

  overlayWindow.setAlwaysOnTop(true, 'screen-saver')

  overlayWindow.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: true
  })

  // User can continue using the app
  // underneath the floating bar.
  overlayWindow.setIgnoreMouseEvents(true)

  loadRenderer(overlayWindow, 'overlay')

  positionOverlay()
}

/* ======================================================
   POSITION OVERLAY
====================================================== */

function positionOverlay(): void {
  if (!overlayWindow) return

  const display = screen.getPrimaryDisplay()

  const { x, y, width, height } = display.workArea

  const [overlayWidth, overlayHeight] = overlayWindow.getSize()

  const positionX = Math.round(x + width / 2 - overlayWidth / 2)

  const positionY = Math.round(y + height - overlayHeight - 35)

  overlayWindow.setPosition(positionX, positionY, false)
}

/* ======================================================
   WINDOWS AUTO PASTE
====================================================== */

async function pasteIntoActiveApp(text: string): Promise<void> {
  if (!text.trim()) {
    return
  }

  /*
   * The overlay uses showInactive()
   * and focusable:false, therefore
   * the user's original application
   * should still have focus.
   */

  clipboard.writeText(text)

  await new Promise((resolve) => setTimeout(resolve, 100))

  return new Promise<void>((resolve, reject) => {
    const command = `
Add-Type -AssemblyName System.Windows.Forms;
[System.Windows.Forms.SendKeys]::SendWait('^v');
    `.trim()

    execFile(
      'powershell.exe',

      ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', command],

      {
        windowsHide: true
      },

      (error) => {
        if (error) {
          reject(error)

          return
        }

        resolve()
      }
    )
  })
}

/* ======================================================
   MICROPHONE PERMISSIONS
====================================================== */

function setupPermissions(): void {
  session.defaultSession.setPermissionCheckHandler((_webContents, permission) => {
    return permission === 'media'
  })

  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === 'media')
  })
}

function normalizeSnippetTrigger(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[.!?,]+$/g, '')
    .replace(/\s+/g, ' ')
}

function applySnippet(text: string, snippets: Snippet[]): string {
  const normalizedText = normalizeSnippetTrigger(text)
  const snippet = snippets.find((item) => normalizeSnippetTrigger(item.trigger) === normalizedText)

  if (!snippet) {
    return text
  }

  console.log(`⚡ Snippet matched: ${snippet.trigger}`)

  return snippet.expansion
}

/* ======================================================
   IPC
====================================================== */

function setupIPC(): void {
  ipcMain.handle('store:get', async () => {
    return readVoiceFlowStore()
  })

  /* =====================================================
     DICTIONARY
  ===================================================== */

  ipcMain.handle('dictionary:add', async (_event, word: string) => {
    const cleanWord = word.trim()
    const store = await readVoiceFlowStore()

    if (!cleanWord) {
      return store
    }

    const exists = store.dictionary.some(
      (item) => item.toLowerCase() === cleanWord.toLowerCase()
    )

    if (!exists) {
      store.dictionary.push(cleanWord)
      store.dictionary.sort((a, b) => a.localeCompare(b))
      await writeVoiceFlowStore(store)
    }

    return store
  })

  ipcMain.handle('dictionary:remove', async (_event, word: string) => {
    const store = await readVoiceFlowStore()

    store.dictionary = store.dictionary.filter((item) => item !== word)

    await writeVoiceFlowStore(store)

    return store
  })

  /* =====================================================
     SNIPPETS
  ===================================================== */

  ipcMain.handle(
    'snippets:add',
    async (_event, data: { trigger: string; expansion: string }) => {
      const store = await readVoiceFlowStore()
      const trigger = data.trigger.trim()
      const expansion = data.expansion.trim()

      if (!trigger || !expansion) {
        return store
      }

      store.snippets.unshift({
        id: randomUUID(),
        trigger,
        expansion
      })

      await writeVoiceFlowStore(store)

      return store
    }
  )

  ipcMain.handle('snippets:remove', async (_event, id: string) => {
    const store = await readVoiceFlowStore()

    store.snippets = store.snippets.filter((snippet) => snippet.id !== id)

    await writeVoiceFlowStore(store)

    return store
  })

  /* =====================================================
     WRITING STYLE
  ===================================================== */

  ipcMain.handle(
    'settings:update',
    async (_event, patch: Partial<VoiceFlowSettings>) => {
      const store = await readVoiceFlowStore()

      if (patch.writingStyle) {
        store.settings.writingStyle = patch.writingStyle
      }

      if (typeof patch.microphoneId === 'string') {
        store.settings.microphoneId = patch.microphoneId
      }

      if (patch.language && ['auto', 'en-IN', 'hi-IN'].includes(patch.language)) {
        store.settings.language = patch.language
      }

      if (
        patch.shortcut &&
        ['ctrl-space', 'alt-space', 'ctrl-shift-space'].includes(patch.shortcut)
      ) {
        store.settings.shortcut = patch.shortcut
        currentShortcut = patch.shortcut
      }

      if (typeof patch.soundFeedback === 'boolean') {
        store.settings.soundFeedback = patch.soundFeedback
      }

      if (typeof patch.launchAtStartup === 'boolean') {
        store.settings.launchAtStartup = patch.launchAtStartup
        applyLaunchAtStartup(patch.launchAtStartup)
      }

      await writeVoiceFlowStore(store)

      return store
    }
  )

  ipcMain.handle('settings:set-writing-style', async (_event, style: WritingStyle) => {
    const store = await readVoiceFlowStore()

    store.settings.writingStyle = style

    await writeVoiceFlowStore(store)

    return store
  })

  /* =====================================================
     HISTORY
  ===================================================== */

  ipcMain.handle('history:clear', async () => {
    const store = await readVoiceFlowStore()

    store.history = []

    await writeVoiceFlowStore(store)

    return store
  })

  ipcMain.handle('voice:finalize-live', async (_event, rawTranscript: string) => {
    const dictationId = activeDictationId

    try {
      const rawText = rawTranscript.trim()

      if (!rawText) {
        throw new Error('Live transcript is empty')
      }

      const store = await readVoiceFlowStore()

      console.log('\n✨ Finalizing live transcript...')
      console.log('RAW:', rawText)

      const response = await fetch(`${API_URL}/api/finalize-text`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          text: rawText,
          processName: activeAppContext.processName,
          windowTitle: activeAppContext.title,
          mode: activeAppContext.mode,
          writingStyle: store.settings.writingStyle,
          dictionary: store.dictionary.slice(0, 100)
        })
      })

      const result = (await response.json()) as {
        success: boolean
        cleanedText?: string
        message?: string
      }

      if (!response.ok || !result.success || !result.cleanedText) {
        throw new Error(result.message || 'Final cleanup failed')
      }

      if (cancelledDictationIds.has(dictationId)) {
        throw new Error('Dictation cancelled')
      }

      const finalText = applySnippet(result.cleanedText, store.snippets)

      console.log('FINAL:', finalText)

      await pasteIntoActiveApp(finalText)

      if (cancelledDictationIds.has(dictationId)) {
        throw new Error('Dictation cancelled')
      }

      const historyItem = {
        id: randomUUID(),
        rawText,
        finalText,
        processName: activeAppContext.processName,
        windowTitle: activeAppContext.title,
        mode: activeAppContext.mode,
        createdAt: new Date().toISOString()
      }

      store.history.unshift(historyItem)
      store.history = store.history.slice(0, 500)

      await writeVoiceFlowStore(store)

      mainWindow?.webContents.send('history:updated', historyItem)

      setTimeout(() => {
        overlayWindow?.hide()
      }, 500)

      return {
        rawText,
        cleanedText: finalText
      }
    } catch (error) {
      console.error('❌ Finalize live failed:', error)

      setTimeout(() => {
        overlayWindow?.hide()
      }, 2000)

      throw error
    }
  })

  ipcMain.handle(
    'voice:process-recording',

    async (_event, audioBuffer: ArrayBuffer) => {
      const dictationId = activeDictationId

      try {
        console.log('\n📤 Sending voice to AI...')

        console.log(`🎯 Dictation mode: ${activeAppContext.mode}`)

        const store = await readVoiceFlowStore()
        const dictionary = store.dictionary.slice(0, 200)
        const writingStyle = store.settings.writingStyle

        console.log(`📖 Custom words: ${dictionary.length}`)
        console.log(`✍ Writing style: ${writingStyle}`)

        const response = await fetch(`${API_URL}/api/dictation`, {
          method: 'POST',

          headers: {
            'Content-Type': 'audio/webm',
            'X-VoiceFlow-Process': encodeURIComponent(activeAppContext.processName),
            'X-VoiceFlow-Title': encodeURIComponent(activeAppContext.title),
            'X-VoiceFlow-Mode': activeAppContext.mode,
            'X-VoiceFlow-Style': writingStyle,
            'X-VoiceFlow-Dictionary': encodeURIComponent(JSON.stringify(dictionary))
          },

          body: new Uint8Array(audioBuffer)
        })

        const result = (await response.json()) as {
          success: boolean

          rawText?: string

          cleanedText?: string

          message?: string
        }

        if (!response.ok || !result.success || !result.cleanedText) {
          throw new Error(result.message || 'AI processing failed')
        }

        if (cancelledDictationIds.has(dictationId)) {
          throw new Error('Dictation cancelled')
        }

        console.log('\n✅ FINAL TEXT:')

        console.log(result.cleanedText)

        /* ----------------------------------------
           TYPE INTO CURRENT APPLICATION
        ---------------------------------------- */

        const finalText = applySnippet(result.cleanedText, store.snippets)

        await pasteIntoActiveApp(finalText)

        if (cancelledDictationIds.has(dictationId)) {
          throw new Error('Dictation cancelled')
        }

        const historyItem = {
          id: randomUUID(),
          rawText: result.rawText || '',
          finalText,
          processName: activeAppContext.processName,
          windowTitle: activeAppContext.title,
          mode: activeAppContext.mode,
          createdAt: new Date().toISOString()
        }

        store.history.unshift(historyItem)

        /*
         * Prevent unlimited local growth.
         */
        store.history = store.history.slice(0, 500)

        await writeVoiceFlowStore(store)

        mainWindow?.webContents.send('history:updated', historyItem)

        console.log('⌨ Text inserted')

        setTimeout(() => {
          overlayWindow?.hide()
        }, 450)

        return {
          rawText: result.rawText || '',

          cleanedText: finalText
        }
      } catch (error: unknown) {
        const details = error as
          | {
              message?: string
              cause?: unknown
              stack?: string
            }
          | null
          | undefined

        console.error('\n================================')

        console.error('❌ DESKTOP DICTATION ERROR')

        console.error('================================')

        console.error('Message:', details?.message)

        console.error('Cause:', details?.cause)

        console.error('Stack:', details?.stack)

        overlayWindow?.webContents.send('voice:error', details?.message || 'AI processing failed')

        setTimeout(() => {
          overlayWindow?.hide()
        }, 3000)

        throw error
      }
    }
  )
}

/* ======================================================
   DETERMINE ACTIVE APP MODE
====================================================== */

function determineAppMode(processName: string, title: string): ActiveAppContext['mode'] {
  const value = `${processName} ${title}`.toLowerCase()

  if (
    value.includes('code') ||
    value.includes('cursor') ||
    value.includes('visual studio') ||
    value.includes('webstorm') ||
    value.includes('pycharm') ||
    value.includes('intellij')
  ) {
    return 'developer'
  }

  if (value.includes('gmail') || value.includes('outlook') || value.includes('mail')) {
    return 'email'
  }

  if (
    value.includes('whatsapp') ||
    value.includes('discord') ||
    value.includes('slack') ||
    value.includes('teams') ||
    value.includes('telegram')
  ) {
    return 'chat'
  }

  if (
    value.includes('notepad') ||
    value.includes('word') ||
    value.includes('notion') ||
    value.includes('google docs') ||
    value.includes('docs')
  ) {
    return 'writing'
  }

  if (
    value.includes('chrome') ||
    value.includes('msedge') ||
    value.includes('firefox') ||
    value.includes('brave')
  ) {
    return 'browser'
  }

  return 'general'
}

/* ======================================================
   DETECT ACTIVE WINDOWS APPLICATION
====================================================== */

function detectActiveApplication(): Promise<ActiveAppContext> {
  return new Promise((resolve) => {
    const script = `
Add-Type @"
using System;
using System.Runtime.InteropServices;

public class VoiceFlowWindow {
    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(
        IntPtr hWnd,
        out uint processId
    );
}
"@

$handle = [VoiceFlowWindow]::GetForegroundWindow()
$processId = [uint32]0
[VoiceFlowWindow]::GetWindowThreadProcessId($handle, [ref]$processId) | Out-Null
$process = Get-Process -Id $processId -ErrorAction SilentlyContinue

$result = [PSCustomObject]@{
    processName = $process.ProcessName
    title = $process.MainWindowTitle
}

$result | ConvertTo-Json -Compress
    `.trim()

    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script],
      { windowsHide: true },
      (error, stdout) => {
        if (error) {
          console.error('Active app detection failed:', error)
          resolve({ processName: 'unknown', title: '', mode: 'general' })
          return
        }

        try {
          const parsed = JSON.parse(stdout.trim()) as {
            processName?: string
            title?: string
          }
          const processName = parsed.processName || 'unknown'
          const title = parsed.title || ''

          resolve({
            processName,
            title,
            mode: determineAppMode(processName, title)
          })
        } catch (error) {
          console.error('Active app parsing failed:', error)
          resolve({ processName: 'unknown', title: '', mode: 'general' })
        }
      }
    )
  })
}

/* ======================================================
   START RECORDING
====================================================== */

function matchesPushToTalkShortcut(event: UiohookKeyboardEvent): boolean {
  if (event.keycode !== UiohookKey.Space) {
    return false
  }

  switch (currentShortcut) {
    case 'alt-space':
      return event.altKey && !event.ctrlKey && !event.shiftKey

    case 'ctrl-shift-space':
      return event.ctrlKey && event.shiftKey && !event.altKey

    case 'ctrl-space':
    default:
      return event.ctrlKey && !event.altKey && !event.shiftKey
  }
}

function startPushToTalk(): void {
  if (isPushToTalkActive) {
    return
  }

  isPushToTalkActive = true
  activeDictationId += 1

  console.log('\n🎙 VoiceFlow recording started')

  void detectActiveApplication().then((context) => {
    activeAppContext = context

    console.log('🪟 Active application:')
    console.log(`Process: ${context.processName}`)
    console.log(`Title: ${context.title}`)
    console.log(`Mode: ${context.mode}`)

    overlayWindow?.webContents.send('voice:context', context)
  })

  positionOverlay()

  overlayWindow?.showInactive()

  overlayWindow?.webContents.send('voice:start')
}

/* ======================================================
   STOP RECORDING
====================================================== */

function stopPushToTalk(): void {
  if (!isPushToTalkActive) {
    return
  }

  isPushToTalkActive = false

  console.log('⏹ VoiceFlow recording stopped')

  overlayWindow?.webContents.send('voice:stop')

  /*
   * DO NOT hide here.
   * Overlay remains visible
   * while AI processes speech.
  */
}

function cancelPushToTalk(): void {
  isPushToTalkActive = false
  const dictationId = activeDictationId
  cancelledDictationIds.add(dictationId)

  console.log('❌ Dictation cancelled')

  overlayWindow?.webContents.send('voice:cancel')
  overlayWindow?.hide()

  setTimeout(() => {
    cancelledDictationIds.delete(dictationId)
  }, 60_000)
}

/* ======================================================
   GLOBAL HOLD-TO-TALK
====================================================== */

function setupKeyboardHook(): void {
  uIOhook.on('keydown', (event) => {
    if (
      event.keycode === UiohookKey.Escape &&
      (isPushToTalkActive || overlayWindow?.isVisible())
    ) {
      cancelPushToTalk()
      return
    }

    if (matchesPushToTalkShortcut(event) && !isPushToTalkActive) {
      startPushToTalk()
    }
  })

  uIOhook.on('keyup', (event) => {
    if (event.keycode === UiohookKey.Space && isPushToTalkActive) {
      stopPushToTalk()
    }
  })

  uIOhook.start()

  console.log('✅ VoiceFlow keyboard listener ready')
}

/* ======================================================
   SYSTEM TRAY
====================================================== */

function createTray(): void {
  tray = new Tray(join(__dirname, '../../resources/icon.png'))

  const menu = Menu.buildFromTemplate([
    {
      label: 'Open VoiceFlow AI',

      click: () => {
        mainWindow?.show()
      }
    },

    {
      type: 'separator'
    },

    {
      label: 'Quit VoiceFlow',

      click: () => {
        isQuitting = true

        app.quit()
      }
    }
  ])

  tray.setToolTip('VoiceFlow AI')

  tray.setContextMenu(menu)

  tray.on('double-click', () => {
    mainWindow?.show()
  })
}

/* ======================================================
   APP START
====================================================== */

app.whenReady().then(async () => {
  const store = await readVoiceFlowStore()

  currentShortcut = store.settings.shortcut
  applyLaunchAtStartup(store.settings.launchAtStartup)

  setupPermissions()

  setupIPC()

  createMainWindow()

  createOverlayWindow()

  createTray()

  setupKeyboardHook()
})

/* ======================================================
   APP CLEANUP
====================================================== */

app.on('will-quit', () => {
  try {
    uIOhook.stop()
  } catch (error) {
    console.error('Keyboard hook shutdown error:', error)
  }
})

app.on('window-all-closed', () => {
  // Do nothing.
  // VoiceFlow keeps running
  // in the Windows tray.
})
