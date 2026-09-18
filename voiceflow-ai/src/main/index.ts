import {
  app,
  BrowserWindow,
  clipboard,
  globalShortcut,
  ipcMain,
  Menu,
  screen,
  session,
  Tray
} from 'electron'
import dotenv from 'dotenv'
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
// The server entry is outside the TypeScript project files list; ignore type-checking here
// @ts-ignore: Imported module is not listed in tsconfig file list
import { startVoiceFlowServer } from '../../server/src/index'

if (process.platform === 'win32') {
  app.setAppUserModelId('com.voiceflow.ai')
}

const API_URL = 'http://127.0.0.1:4000'
   
type ActiveAppContext = {
  processName: string
  title: string
  windowHandle: string
  mode: 'developer' | 'email' | 'chat' | 'writing' | 'browser' | 'general'
}

let mainWindow: BrowserWindow | null = null
let overlayWindow: BrowserWindow | null = null
let tray: Tray | null = null

let isQuitting = false
let isPushToTalkActive = false
let isInjectingText = false
let currentShortcut: ShortcutPreset = 'ctrl-space'
let registeredPushToTalkAccelerator: string | null = null
let isPushToTalkShortcutRegistered = false
let activeDictationId = 0
const cancelledDictationIds = new Set<number>()
let activeAppContext: ActiveAppContext = {
  processName: 'unknown',
  title: '',
  windowHandle: '0',
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

function unregisterEscapeShortcut(): void {
  if (globalShortcut.isRegistered('Escape')) {
    globalShortcut.unregister('Escape')
  }
}

function hideOverlay(): void {
  unregisterEscapeShortcut()
  overlayWindow?.hide()
}

function registerEscapeShortcut(): void {
  unregisterEscapeShortcut()

  const registered = globalShortcut.register('Escape', () => {
    if (overlayWindow?.isVisible()) {
      cancelPushToTalk()
    }
  })

  if (!registered) {
    console.error('Unable to register Escape shortcut')
  }
}

function getPushToTalkAccelerator(shortcut: ShortcutPreset): string {
  switch (shortcut) {
    case 'ctrl-shift-space':
      return 'CommandOrControl+Shift+Space'

    case 'ctrl-space':
    default:
      return 'CommandOrControl+Space'
  }
}

function registerPushToTalkShortcut(): void {
  if (registeredPushToTalkAccelerator) {
    globalShortcut.unregister(registeredPushToTalkAccelerator)
  }

  const accelerator = getPushToTalkAccelerator(currentShortcut)

  isPushToTalkShortcutRegistered = globalShortcut.register(accelerator, () => {
    startPushToTalk()
  })

  registeredPushToTalkAccelerator = isPushToTalkShortcutRegistered ? accelerator : null

  if (isPushToTalkShortcutRegistered) {
    console.log(`✅ Push-to-talk shortcut registered: ${accelerator}`)
  } else {
    console.error(`❌ Unable to register push-to-talk shortcut: ${accelerator}`)
  }
}

/* ======================================================
   WINDOWS AUTO PASTE
====================================================== */

async function pasteIntoFocusedApp(text: string): Promise<void> {
  if (!text.trim()) {
    return
  }

  clipboard.writeText(text)
  unregisterEscapeShortcut()

  await new Promise((resolve) => setTimeout(resolve, 40))

  isInjectingText = true

  try {
    // The overlay never takes focus, so paste directly into the application
    // the user is already using. This does not alter its window state.
    uIOhook.keyTap(UiohookKey.V, [UiohookKey.Ctrl])

    await new Promise((resolve) => setTimeout(resolve, 25))
  } catch (error) {
    console.error('Direct paste failed, using focused-control fallback:', error)
    await pasteIntoActiveApp(text, activeAppContext.windowHandle)
  } finally {
    isInjectingText = false
  }
}

async function pasteIntoActiveApp(text: string, windowHandle: string): Promise<void> {
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

  // Alt+Space opens the Windows system menu in apps such as Notepad.
  // Stop consuming Escape before using it to dismiss that menu.
  unregisterEscapeShortcut()

  await new Promise((resolve) => setTimeout(resolve, 100))

  return new Promise<void>((resolve, reject) => {
    const safeWindowHandle = /^\d+$/.test(windowHandle) ? windowHandle : '0'
    const command = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public class VoiceFlowPasteTarget {
    private const byte VK_CONTROL = 0x11;
    private const byte VK_MENU = 0x12;
    private const byte VK_V = 0x56;
    private const uint KEYEVENTF_KEYUP = 0x0002;

    [StructLayout(LayoutKind.Sequential)]
    private struct RECT {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct GUITHREADINFO {
        public uint cbSize;
        public uint flags;
        public IntPtr hwndActive;
        public IntPtr hwndFocus;
        public IntPtr hwndCapture;
        public IntPtr hwndMenuOwner;
        public IntPtr hwndMoveSize;
        public IntPtr hwndCaret;
        public RECT rcCaret;
    }

    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    [DllImport("kernel32.dll")]
    private static extern uint GetCurrentThreadId();

    [DllImport("user32.dll")]
    private static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool attach);

    [DllImport("user32.dll")]
    private static extern bool GetGUIThreadInfo(uint idThread, ref GUITHREADINFO info);

    [DllImport("user32.dll")]
    private static extern IntPtr SetFocus(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern void keybd_event(byte virtualKey, byte scanCode, uint flags, UIntPtr extraInfo);

    [DllImport("user32.dll")]
    private static extern bool EnumChildWindows(IntPtr parent, EnumWindowsProc callback, IntPtr lParam);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassName(IntPtr hWnd, StringBuilder className, int maxCount);

    private static IntPtr FindEditControl(IntPtr parent) {
        IntPtr result = IntPtr.Zero;

        EnumChildWindows(parent, delegate(IntPtr child, IntPtr _) {
            StringBuilder className = new StringBuilder(256);
            GetClassName(child, className, className.Capacity);
            string value = className.ToString();

            if (value.IndexOf("edit", StringComparison.OrdinalIgnoreCase) >= 0) {
                result = child;
                return false;
            }

            return true;
        }, IntPtr.Zero);

        return result;
    }

    private static void KeyDown(byte key) {
        keybd_event(key, 0, 0, UIntPtr.Zero);
    }

    private static void KeyUp(byte key) {
        keybd_event(key, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
    }

    private static void Tap(byte key) {
        KeyDown(key);
        KeyUp(key);
    }

    public static bool Paste(IntPtr target) {
        if (target == IntPtr.Zero) {
            return false;
        }

        uint ignoredProcessId;
        uint currentThread = GetCurrentThreadId();
        uint targetThread = GetWindowThreadProcessId(target, out ignoredProcessId);
        IntPtr previousForeground = GetForegroundWindow();
        uint foregroundThread = GetWindowThreadProcessId(previousForeground, out ignoredProcessId);
        bool attachedToTarget = false;
        bool attachedToForeground = false;

        try {
            if (targetThread != 0 && targetThread != currentThread) {
                attachedToTarget = AttachThreadInput(currentThread, targetThread, true);
            }

            if (foregroundThread != 0 && foregroundThread != currentThread && foregroundThread != targetThread) {
                attachedToForeground = AttachThreadInput(currentThread, foregroundThread, true);
            }

            Thread.Sleep(120);

            GUITHREADINFO info = new GUITHREADINFO();
            info.cbSize = (uint)Marshal.SizeOf(typeof(GUITHREADINFO));
            GetGUIThreadInfo(targetThread, ref info);

            IntPtr editControl = FindEditControl(target);
            IntPtr focusTarget = editControl != IntPtr.Zero
                ? editControl
                : (info.hwndFocus != IntPtr.Zero ? info.hwndFocus : info.hwndCaret);

            if (focusTarget != IntPtr.Zero) {
                SetFocus(focusTarget);
            }

            // Clear modifiers that may still be logically held by Alt+Space.
            KeyUp(VK_MENU);
            KeyUp(VK_CONTROL);

            KeyDown(VK_CONTROL);
            Tap(VK_V);
            KeyUp(VK_CONTROL);

            Thread.Sleep(80);

            return GetForegroundWindow() == target;
        }
        finally {
            if (attachedToForeground) {
                AttachThreadInput(currentThread, foregroundThread, false);
            }

            if (attachedToTarget) {
                AttachThreadInput(currentThread, targetThread, false);
            }
        }
    }
}
"@;

$target = [IntPtr]::new([Int64]::Parse('${safeWindowHandle}'));
$inserted = [VoiceFlowPasteTarget]::Paste($target);

if (-not $inserted) {
    throw 'Could not activate the target application for text insertion.';
}
    `.trim()

    isInjectingText = true

    execFile(
      'powershell.exe',

      ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', command],

      {
        windowsHide: true
      },

      (error) => {
        isInjectingText = false

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

    const exists = store.dictionary.some((item) => item.toLowerCase() === cleanWord.toLowerCase())

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

  ipcMain.handle('snippets:add', async (_event, data: { trigger: string; expansion: string }) => {
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
  })

  ipcMain.handle('snippets:remove', async (_event, id: string) => {
    const store = await readVoiceFlowStore()

    store.snippets = store.snippets.filter((snippet) => snippet.id !== id)

    await writeVoiceFlowStore(store)

    return store
  })

  /* =====================================================
     WRITING STYLE
  ===================================================== */

  ipcMain.handle('settings:update', async (_event, patch: Partial<VoiceFlowSettings>) => {
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

    if (patch.shortcut && ['ctrl-space', 'ctrl-shift-space'].includes(patch.shortcut)) {
      store.settings.shortcut = patch.shortcut
      currentShortcut = patch.shortcut
      registerPushToTalkShortcut()
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
  })

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

      console.log('\n⚡ Using fast live transcript...')
      console.log('RAW:', rawText)

      if (cancelledDictationIds.has(dictationId)) {
        throw new Error('Dictation cancelled')
      }

      const finalText = applySnippet(rawText, store.snippets)

      console.log('FINAL:', finalText)

      await pasteIntoFocusedApp(finalText)

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
        hideOverlay()
      }, 150)

      return {
        rawText,
        cleanedText: finalText
      }
    } catch (error) {
      console.error('❌ Finalize live failed:', error)

      setTimeout(() => {
        hideOverlay()
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

        await pasteIntoFocusedApp(finalText)

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
          hideOverlay()
        }, 150)

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
          hideOverlay()
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
    windowHandle = $handle.ToInt64().ToString()
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
          resolve({ processName: 'unknown', title: '', windowHandle: '0', mode: 'general' })
          return
        }

        try {
          const parsed = JSON.parse(stdout.trim()) as {
            processName?: string
            title?: string
            windowHandle?: string
          }
          const processName = parsed.processName || 'unknown'
          const title = parsed.title || ''
          const windowHandle = parsed.windowHandle || '0'

          resolve({
            processName,
            title,
            windowHandle,
            mode: determineAppMode(processName, title)
          })
        } catch (error) {
          console.error('Active app parsing failed:', error)
          resolve({ processName: 'unknown', title: '', windowHandle: '0', mode: 'general' })
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
    console.log(`Window handle: ${context.windowHandle}`)
    console.log(`Mode: ${context.mode}`)

    overlayWindow?.webContents.send('voice:context', context)
  })

  positionOverlay()

  registerEscapeShortcut()

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
  hideOverlay()

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
      !isInjectingText &&
      event.keycode === UiohookKey.Escape &&
      (isPushToTalkActive || overlayWindow?.isVisible())
    ) {
      cancelPushToTalk()
      return
    }

    if (
      !isPushToTalkShortcutRegistered &&
      matchesPushToTalkShortcut(event) &&
      !isPushToTalkActive
    ) {
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
  tray = new Tray(getTrayIconPath())

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

function getTrayIconPath(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'icon.png')
  }

  return join(process.cwd(), 'resources', 'icon.png')
}

/* ======================================================
   APP START
====================================================== */

const hasSingleInstanceLock = app.requestSingleInstanceLock()

if (!hasSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow?.isMinimized()) {
      mainWindow.restore()
    }

    mainWindow?.show()
    mainWindow?.focus()
  })

  app.whenReady().then(async () => {
    if (app.isPackaged) {
      dotenv.config({
        path: join(app.getPath('userData'), '.env')
      })

      startVoiceFlowServer()
    }

    const store = await readVoiceFlowStore()

    currentShortcut = store.settings.shortcut
    applyLaunchAtStartup(store.settings.launchAtStartup)

    setupPermissions()

    setupIPC()

    createMainWindow()

    createOverlayWindow()

    createTray()

    registerPushToTalkShortcut()

    setupKeyboardHook()
  })
}

/* ======================================================
   APP CLEANUP
====================================================== */

app.on('will-quit', () => {
  globalShortcut.unregisterAll()

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
