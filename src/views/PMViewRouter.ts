import { TFile } from 'obsidian'
import type PMPlugin from '../main'
import { PM_DASHBOARD_VIEW_TYPE } from './DashboardView'
import { PM_HOME_VIEW_TYPE } from './home/HomeView'
import { PM_PROJECT_VIEW_TYPE } from './ProjectView'

export class PMViewRouter {
  constructor(private plugin: PMPlugin) {}

  /**
   * Open the home page. With `onlyIfAbsent` (the startup path) an already-open home tab is
   * revealed rather than duplicated, so restoring a workspace never stacks copies.
   */
  async openHome(onlyIfAbsent = false): Promise<void> {
    const ws = this.plugin.app.workspace
    const existing = ws.getLeavesOfType(PM_HOME_VIEW_TYPE)
    if (existing.length > 0) {
      if (onlyIfAbsent) return
      await ws.revealLeaf(existing[0])
      return
    }
    const leaf = ws.getLeaf('tab')
    await leaf.setViewState({ type: PM_HOME_VIEW_TYPE, state: {} })
    await ws.revealLeaf(leaf)
  }

  async openDashboard(): Promise<void> {
    const ws = this.plugin.app.workspace
    const leaf = ws.getLeaf('tab')
    await leaf.setViewState({ type: PM_DASHBOARD_VIEW_TYPE, state: {} })
    await ws.revealLeaf(leaf)
  }

  async openProject(file: TFile): Promise<void> {
    const ws = this.plugin.app.workspace
    const leaf = ws.getLeaf('tab')
    await leaf.setViewState({ type: PM_PROJECT_VIEW_TYPE, state: { filePath: file.path } })
    await ws.revealLeaf(leaf)
  }

  async openProjectByPath(path: string): Promise<void> {
    const file = this.plugin.app.vault.getAbstractFileByPath(path)
    if (file instanceof TFile) await this.openProject(file)
  }
}
