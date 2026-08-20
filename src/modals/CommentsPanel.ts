import { Component, MarkdownRenderer, Notice, setIcon } from 'obsidian'
import type PMPlugin from '../main'
import type { Task, TaskComment } from '../types'
import { Avatar } from '../ui/primitives/Avatar'
import { safeAsync } from '../utils'

export interface CommentsPanelHandle {
  destroy(): void
}

/**
 * Renders the task's comments — the agent writes here, and so can you.
 *
 * Comments live in the note body, not in frontmatter, and are only present once
 * the body has been read. Callers must have awaited `loadTaskBody` first or the
 * panel will honestly report none.
 */
export function renderCommentsPanel(
  container: HTMLElement,
  task: Task,
  plugin: PMPlugin,
  sourcePath: string
): CommentsPanelHandle {
  const section = container.createDiv('pm-modal-section')
  const header = section.createDiv('pm-modal-section-header')
  const title = header.createEl('h4', { cls: 'pm-modal-section-title' })

  const list = section.createDiv('pm-comment-list')
  // One component owns every rendered comment body, so unloading it tears down
  // all of their markdown post-processors at once.
  let markdown = new Component()
  markdown.load()

  const renderList = (): void => {
    const comments = task.comments ?? []
    title.setText(comments.length ? `Comments (${comments.length})` : 'Comments')

    markdown.unload()
    markdown = new Component()
    markdown.load()
    list.empty()

    if (!comments.length) {
      list.createDiv({ cls: 'pm-comment-empty', text: 'No comments yet.' })
      return
    }
    for (const comment of comments) renderComment(list, comment, plugin, sourcePath, markdown)
  }

  renderList()
  renderComposer(section, task, plugin, renderList)

  return {
    destroy() {
      markdown.unload()
    }
  }
}

function renderComment(
  list: HTMLElement,
  comment: TaskComment,
  plugin: PMPlugin,
  sourcePath: string,
  markdown: Component
): void {
  const row = list.createDiv('pm-comment')
  if (comment.author === plugin.settings.claude.assignee) row.addClass('pm-comment--agent')

  const head = row.createDiv('pm-comment-head')
  new Avatar(head).setName(comment.author).setSize('sm')
  head.createSpan({ text: comment.author, cls: 'pm-comment-author' })
  head.createSpan({ text: formatWhen(comment.at), cls: 'pm-comment-when' })

  const bodyEl = row.createDiv('pm-comment-body')
  void MarkdownRenderer.render(plugin.app, comment.body, bodyEl, sourcePath, markdown)
}

function renderComposer(section: HTMLElement, task: Task, plugin: PMPlugin, onAdded: () => void): void {
  const composer = section.createDiv('pm-comment-composer')
  const input = composer.createEl('textarea', { cls: 'pm-comment-input' })
  input.placeholder = 'Add a comment…'
  input.rows = 2

  const actions = composer.createDiv('pm-comment-actions')
  const button = actions.createEl('button', { cls: 'pm-comment-submit' })
  const icon = button.createSpan()
  setIcon(icon, 'message-square')
  button.createSpan({ text: 'Comment' })

  const submit = safeAsync(async () => {
    const text = input.value.trim()
    if (!text) return
    button.disabled = true
    try {
      await plugin.store.appendComment(task, commentAuthor(plugin), text)
      input.value = ''
      onAdded()
    } catch (e) {
      new Notice(e instanceof Error ? e.message : 'Could not save the comment')
    } finally {
      button.disabled = false
    }
  })

  button.addEventListener('click', submit)
  input.addEventListener('keydown', (e) => {
    // Enter is a newline here; comments are prose and often multi-line.
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      submit()
    }
  })
}

/** Who a human-authored comment is attributed to. */
function commentAuthor(plugin: PMPlugin): string {
  return plugin.settings.homeGreetingName.trim() || 'me'
}

/** "3m ago" / "yesterday" for recent comments, an absolute date beyond a week. */
function formatWhen(iso: string): string {
  const then = new Date(iso)
  if (isNaN(then.getTime())) return iso
  const minutes = Math.round((Date.now() - then.getTime()) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  if (days === 1) return 'yesterday'
  if (days < 7) return `${days}d ago`
  return then.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}
