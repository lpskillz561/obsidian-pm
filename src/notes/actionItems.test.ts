import { describe, expect, it } from 'vitest'
import { extractActionItems, stripFrontmatter } from './actionItems'

const texts = (md: string) => extractActionItems(md).map((i) => i.text)

describe('extractActionItems', () => {
  it('finds unchecked task list items', () => {
    expect(texts('- [ ] Chase the escalation\n- [ ] Draft the runbook')).toEqual([
      'Chase the escalation',
      'Draft the runbook'
    ])
  })

  it('ignores checked items', () => {
    expect(texts('- [x] Done already\n- [ ] Still open\n- [X] Also done')).toEqual(['Still open'])
  })

  it('treats any non-space checkbox marker as complete', () => {
    // Obsidian themes use [-] [/] [>] for cancelled / in-progress / deferred.
    expect(texts('- [-] Cancelled\n- [/] In progress\n- [ ] Open')).toEqual(['Open'])
  })

  it('accepts the other bullet markers', () => {
    expect(texts('* [ ] Star bullet\n+ [ ] Plus bullet')).toEqual(['Star bullet', 'Plus bullet'])
  })

  it('keeps indented items but does not nest them', () => {
    expect(texts('- [ ] Parent\n    - [ ] Child')).toEqual(['Parent', 'Child'])
  })

  it('skips items inside a fenced code block', () => {
    const md = [
      '- [ ] Real item',
      '```bash',
      '- [ ] not a task, just shell output',
      '```',
      '- [ ] Another real one'
    ].join('\n')
    expect(texts(md)).toEqual(['Real item', 'Another real one'])
  })

  it('skips tilde-fenced blocks too', () => {
    expect(texts('~~~\n- [ ] fenced\n~~~\n- [ ] real')).toEqual(['real'])
  })

  it('ignores an empty checkbox line', () => {
    expect(texts('- [ ]   \n- [ ] Real')).toEqual(['Real'])
  })

  it('strips a trailing block reference from the title', () => {
    expect(texts('- [ ] Ship the fix ^abc123')).toEqual(['Ship the fix'])
  })

  it('collapses runs of whitespace', () => {
    expect(texts('- [ ] Too    many     spaces')).toEqual(['Too many spaces'])
  })

  it('records the source line number', () => {
    expect(extractActionItems('intro\n\n- [ ] First\ntext\n- [ ] Second')).toEqual([
      { text: 'First', line: 2 },
      { text: 'Second', line: 4 }
    ])
  })

  it('returns nothing for a note with no task list', () => {
    expect(texts('# Heading\n\nJust prose, and a - dash list.')).toEqual([])
  })

  it('does not treat a plain list item as a task', () => {
    expect(texts('- Not a checkbox\n- [ ] But this is')).toEqual(['But this is'])
  })
})

describe('stripFrontmatter', () => {
  it('removes a leading YAML block', () => {
    expect(stripFrontmatter('---\ntitle: "x"\n---\n- [ ] Body item')).toBe('- [ ] Body item')
  })

  it('leaves a note without frontmatter alone', () => {
    expect(stripFrontmatter('- [ ] Body item')).toBe('- [ ] Body item')
  })

  it('does not eat a horizontal rule further down the note', () => {
    const md = '# Title\n\n---\n\n- [ ] Item'
    expect(stripFrontmatter(md)).toBe(md)
  })
})
