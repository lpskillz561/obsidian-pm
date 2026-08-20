import { Notice, setIcon } from 'obsidian'
import type PMPlugin from '../main'

/** How long a button shows its checkmark after a successful copy. */
const COPIED_FLASH_MS = 1200

/** Grace period before the floating button disappears, so the pointer can travel to it. */
const OVERLAY_HIDE_DELAY_MS = 180

const BUTTON_CLASS = 'pm-copy-code'

async function copyToClipboard(text: string, button: HTMLElement): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    new Notice('Could not copy to the clipboard')
    return
  }
  button.addClass('is-copied')
  setIcon(button, 'check')
  window.setTimeout(() => {
    if (!button.isConnected) return
    button.removeClass('is-copied')
    setIcon(button, 'copy')
  }, COPIED_FLASH_MS)
}

function makeCopyButton(doc: Document, extraClass: string): HTMLButtonElement {
  const button = doc.createElement('button')
  button.addClasses([BUTTON_CLASS, extraClass])
  button.type = 'button'
  button.setAttribute('aria-label', 'Copy')
  setIcon(button, 'copy')
  return button
}

/**
 * CodeMirror gives every inline-code token the `cm-inline-code` class, including the
 * backticks it reveals when the cursor sits on the line. Those carry `cm-formatting-code`
 * as well, and we only ever want the content between them.
 */
function isLiveCodeContent(el: Element | null): el is HTMLElement {
  return (
    el instanceof HTMLElement && el.classList.contains('cm-inline-code') && !el.classList.contains('cm-formatting-code')
  )
}

/**
 * Puts a copy button beside every piece of inline code — anything written between
 * backticks — so values parked in notes (API keys, tokens, ids) come out in one click.
 *
 * Reading view gets a real button appended after each `<code>`. Live Preview is
 * CodeMirror's own document and injecting into it corrupts the editor's view state, so
 * there the button floats over whichever inline code the pointer is on.
 *
 * Fenced code blocks are left alone: Obsidian already puts a copy button on those.
 */
export class InlineCodeCopy {
  /** One floating button per window — popouts get their own document. */
  private overlays = new Map<Document, HTMLButtonElement>()
  private overlayText = ''
  private hideTimer: number | null = null

  constructor(private plugin: PMPlugin) {}

  register(): void {
    this.plugin.registerMarkdownPostProcessor((el) => {
      this.decorateRendered(el)
    })

    this.listenTo(activeDocument)
    this.plugin.registerEvent(
      this.plugin.app.workspace.on('window-open', (_workspaceWindow, win) => {
        this.listenTo(win.document)
      })
    )

    this.plugin.register(() => {
      this.cancelHide()
      for (const button of this.overlays.values()) button.remove()
      this.overlays.clear()
    })
  }

  /** Strip the buttons back out of open views — used when the setting is turned off. */
  removeAll(): void {
    this.hideOverlay()
    for (const doc of this.documents()) {
      for (const button of Array.from(doc.querySelectorAll(`.${BUTTON_CLASS}--inline`))) button.remove()
    }
  }

  private listenTo(doc: Document): void {
    this.plugin.registerDomEvent(doc, 'pointerover', (event) => {
      this.onPointerOver(event)
    })
    this.plugin.registerDomEvent(doc, 'scroll', () => this.hideOverlay(), { capture: true })
    const win = doc.defaultView
    if (win) this.plugin.registerDomEvent(win, 'resize', () => this.hideOverlay())
  }

  /** Every document we might have decorated: the main window plus any open popouts. */
  private documents(): Document[] {
    const docs = new Set<Document>([activeDocument, ...this.overlays.keys()])
    return Array.from(docs)
  }

  // ── Reading view ───────────────────────────────────────────────────────────

  private decorateRendered(el: HTMLElement): void {
    if (!this.plugin.settings.inlineCodeCopyButton) return
    // The post-processor fires for every MarkdownRenderer.render call, including
    // the ones the plugin makes in its own modals. An agent comment is dense
    // with `file.ts:211` and `--flag` spans, and a copy button after each one
    // turns it into confetti. This feature is for notes, not our own chrome.
    if (el.closest('.pm-modal')) return

    for (const code of Array.from(el.querySelectorAll('code'))) {
      if (code.closest('pre')) continue // fenced block — Obsidian already covers these
      if (code.nextElementSibling?.hasClass(BUTTON_CLASS)) continue
      if (!code.textContent?.trim()) continue

      const button = makeCopyButton(code.doc, `${BUTTON_CLASS}--inline`)
      button.addEventListener('click', (event) => {
        event.preventDefault()
        event.stopPropagation()
        void copyToClipboard(code.textContent ?? '', button)
      })
      code.insertAdjacentElement('afterend', button)
    }
  }

  // ── Live Preview / source mode ─────────────────────────────────────────────

  private onPointerOver(event: Event): void {
    if (!this.plugin.settings.inlineCodeCopyButton) {
      this.hideOverlay()
      return
    }

    const target = event.target
    if (!(target instanceof HTMLElement)) return

    // Pointer moved onto the floating button itself — keep it alive.
    if (target.closest(`.${BUTTON_CLASS}--floating`)) {
      this.cancelHide()
      return
    }

    const span = target.closest('.cm-inline-code')
    if (!isLiveCodeContent(span)) {
      this.scheduleHide()
      return
    }

    const run = this.runFor(span)
    const text = run.map((el) => el.textContent ?? '').join('')
    if (!text.trim()) {
      this.scheduleHide()
      return
    }

    this.cancelHide()
    this.showOverlay(run[run.length - 1], text)
  }

  /**
   * CodeMirror can split one inline-code token across several sibling spans — a search
   * match or a nested decoration inside the backticks is enough to do it. Walk out to
   * both ends so the button copies the whole value rather than the fragment hovered.
   */
  private runFor(span: HTMLElement): HTMLElement[] {
    let first = span
    while (isLiveCodeContent(first.previousElementSibling)) first = first.previousElementSibling

    const run: HTMLElement[] = []
    for (let el: Element | null = first; isLiveCodeContent(el); el = el.nextElementSibling) run.push(el)
    return run
  }

  private showOverlay(anchor: HTMLElement, text: string): void {
    const rects = anchor.getClientRects()
    const rect = rects.length ? rects[rects.length - 1] : anchor.getBoundingClientRect()
    if (!rect.width && !rect.height) {
      this.hideOverlay()
      return
    }

    // A popout's button belongs to that popout's document; hide any others first.
    this.hideOverlay()
    const button = this.ensureOverlay(anchor.doc)
    this.overlayText = text
    button.removeClass('is-copied')
    setIcon(button, 'copy')
    button.style.left = `${rect.right + 4}px`
    button.style.top = `${rect.top + rect.height / 2}px`
    button.show()
  }

  private ensureOverlay(doc: Document): HTMLButtonElement {
    const existing = this.overlays.get(doc)
    if (existing) return existing

    const button = makeCopyButton(doc, `${BUTTON_CLASS}--floating`)
    button.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      void copyToClipboard(this.overlayText, button)
    })
    // The editor grabs focus back on mousedown, which can scroll the button out from
    // under the pointer before the click lands.
    button.addEventListener('mousedown', (event) => event.preventDefault())
    doc.body.appendChild(button)
    this.overlays.set(doc, button)
    return button
  }

  private scheduleHide(): void {
    if (!this.overlays.size || this.hideTimer !== null) return
    this.hideTimer = window.setTimeout(() => {
      this.hideTimer = null
      this.hideOverlay()
    }, OVERLAY_HIDE_DELAY_MS)
  }

  private cancelHide(): void {
    if (this.hideTimer === null) return
    window.clearTimeout(this.hideTimer)
    this.hideTimer = null
  }

  private hideOverlay(): void {
    this.cancelHide()
    for (const button of this.overlays.values()) button.hide()
  }
}
