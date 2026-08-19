/**
 * Pulls unchecked task-list items out of a note.
 *
 * Scoped deliberately: only `- [ ]` style list items count, checked boxes are left alone,
 * and fenced code blocks are skipped so a shell snippet containing `- [ ]` never becomes a
 * card. Nesting is preserved as text only — a board card has no place to put a subtree,
 * and silently flattening children into separate cards would double-count the work.
 */

export interface ActionItem {
  /** Cleaned title: marker, checkbox and surrounding whitespace removed. */
  text: string
  /** 0-based line number in the source note, for reporting. */
  line: number
}

const FENCE = /^\s*(?:```|~~~)/
const UNCHECKED = /^(\s*)[-*+]\s+\[ \]\s+(.*)$/
const CHECKED = /^(\s*)[-*+]\s+\[[^ \]]\]\s+(.*)$/

/** Strip trailing wiki/markdown link decoration and tags that add nothing to a card title. */
function cleanTitle(raw: string): string {
  return raw
    .replace(/\s+/g, ' ')
    .replace(/\s*\^[A-Za-z0-9-]+$/, '') // block reference
    .trim()
}

export function extractActionItems(markdown: string): ActionItem[] {
  const out: ActionItem[] = []
  let inFence = false

  markdown.split(/\r\n|\n|\r/).forEach((line, index) => {
    if (FENCE.test(line)) {
      inFence = !inFence
      return
    }
    if (inFence) return
    if (CHECKED.test(line)) return

    const match = UNCHECKED.exec(line)
    if (!match) return
    const text = cleanTitle(match[2])
    if (text) out.push({ text, line: index })
  })

  return out
}

/** Note body with the frontmatter block removed, so scanning never reads YAML as content. */
export function stripFrontmatter(markdown: string): string {
  return markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '')
}
