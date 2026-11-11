import { InvalidMigrationPlan, NodeNotFoundError } from './errors'
import type { Migration, MigrationKey } from './migration'
import { ProjectState } from './state'

export function keyOf(k: MigrationKey): string {
  return `${k[0]}.${k[1]}`
}

/** Directed graph of migrations: edges point from a migration to its dependencies (Django's MigrationGraph). */
export class MigrationGraph {
  readonly nodes = new Map<string, Migration>()
  readonly keys = new Map<string, MigrationKey>()
  readonly parents = new Map<string, Set<string>>()
  readonly children = new Map<string, Set<string>>()

  addNode(key: MigrationKey, migration: Migration): void {
    const k = keyOf(key)
    this.nodes.set(k, migration)
    this.keys.set(k, [key[0], key[1]])
    if (!this.parents.has(k)) this.parents.set(k, new Set())
    if (!this.children.has(k)) this.children.set(k, new Set())
  }

  removeNode(key: MigrationKey): void {
    const k = keyOf(key)
    for (const p of this.parents.get(k) ?? []) this.children.get(p)?.delete(k)
    for (const c of this.children.get(k) ?? []) this.parents.get(c)?.delete(k)
    this.nodes.delete(k)
    this.keys.delete(k)
    this.parents.delete(k)
    this.children.delete(k)
  }

  has(key: MigrationKey): boolean {
    return this.nodes.has(keyOf(key))
  }

  get(key: MigrationKey): Migration {
    const m = this.nodes.get(keyOf(key))
    if (!m) throw new NodeNotFoundError(`Migration ${keyOf(key)} not found.`)
    return m
  }

  addDependency(origin: string, child: MigrationKey, parent: MigrationKey): void {
    const c = keyOf(child)
    const p = keyOf(parent)
    if (!this.nodes.has(c))
      throw new NodeNotFoundError(`Migration ${origin} dependencies reference nonexistent child node ${c}.`)
    if (!this.nodes.has(p))
      throw new NodeNotFoundError(`Migration ${origin} dependencies reference nonexistent parent node ${p}.`)
    this.parents.get(c)!.add(p)
    this.children.get(p)!.add(c)
  }

  /**
   * Replace `replaced` nodes by `replacement` (squashed migration in use): dependencies on any replaced node
   * point at the replacement instead.
   */
  remapReplaced(replacement: MigrationKey, replaced: MigrationKey[]): void {
    const r = keyOf(replacement)
    const replacedKeys = new Set(replaced.map(keyOf))
    for (const k of replacedKeys) {
      for (const child of this.children.get(k) ?? []) {
        if (replacedKeys.has(child) || child === r) continue
        this.parents.get(child)?.delete(k)
        this.parents.get(child)?.add(r)
        this.children.get(r)?.add(child)
      }
      for (const parent of this.parents.get(k) ?? []) {
        if (replacedKeys.has(parent) || parent === r) continue
        this.children.get(parent)?.delete(k)
        this.children.get(parent)?.add(r)
        this.parents.get(r)?.add(parent)
      }
    }
    for (const k of replacedKeys) if (this.nodes.has(k)) this.removeNode(this.keys.get(k)!)
  }

  private sorted(set: Iterable<string>): string[] {
    return [...set].sort()
  }

  /** The node and every ancestor, dependencies first. */
  forwardsPlan(target: MigrationKey): MigrationKey[] {
    const t = keyOf(target)
    if (!this.nodes.has(t)) throw new NodeNotFoundError(`Node ${t} not a valid node`)
    const out: string[] = []
    const done = new Set<string>()
    const visiting = new Set<string>()
    const visit = (k: string) => {
      if (done.has(k)) return
      if (visiting.has(k)) throw new InvalidMigrationPlan(`Circular dependency involving migration ${k}.`)
      visiting.add(k)
      for (const p of this.sorted(this.parents.get(k) ?? [])) visit(p)
      visiting.delete(k)
      done.add(k)
      out.push(k)
    }
    visit(t)
    return out.map((k) => this.keys.get(k)!)
  }

  /** The node and every descendant, descendants first. */
  backwardsPlan(target: MigrationKey): MigrationKey[] {
    const t = keyOf(target)
    if (!this.nodes.has(t)) throw new NodeNotFoundError(`Node ${t} not a valid node`)
    const out: string[] = []
    const done = new Set<string>()
    const visit = (k: string) => {
      if (done.has(k)) return
      done.add(k)
      for (const c of this.sorted(this.children.get(k) ?? [])) visit(c)
      out.push(k)
    }
    visit(t)
    return out.map((k) => this.keys.get(k)!)
  }

  /** Nodes without children in the same app, per app, sorted. */
  leafNodes(app?: string): MigrationKey[] {
    const out: MigrationKey[] = []
    for (const [k, key] of this.keys) {
      if (app && key[0] !== app) continue
      const sameAppChildren = [...(this.children.get(k) ?? [])].filter((c) => this.keys.get(c)![0] === key[0])
      if (!sameAppChildren.length) out.push(key)
    }
    return out.sort((a, b) => keyOf(a).localeCompare(keyOf(b)))
  }

  /** Nodes without parents in the same app. */
  rootNodes(app?: string): MigrationKey[] {
    const out: MigrationKey[] = []
    for (const [k, key] of this.keys) {
      if (app && key[0] !== app) continue
      const sameAppParents = [...(this.parents.get(k) ?? [])].filter((p) => this.keys.get(p)![0] === key[0])
      if (!sameAppParents.length) out.push(key)
    }
    return out.sort((a, b) => keyOf(a).localeCompare(keyOf(b)))
  }

  /** Every node in dependency order (deterministic). */
  fullPlan(): MigrationKey[] {
    const seen = new Set<string>()
    const out: MigrationKey[] = []
    for (const leaf of this.leafNodes()) {
      for (const k of this.forwardsPlan(leaf)) {
        const s = keyOf(k)
        if (!seen.has(s)) {
          seen.add(s)
          out.push(k)
        }
      }
    }
    return out
  }

  /** Raise if the graph has cycles. */
  ensureNotCyclic(): void {
    for (const leaf of this.leafNodes()) this.forwardsPlan(leaf)
    const leaves = new Set(this.leafNodes().map(keyOf))
    for (const k of this.keys.values()) if (!leaves.has(keyOf(k))) this.forwardsPlan(k)
  }

  /**
   * Project state after applying `nodes` (and their ancestors), or the whole graph. With `atEnd = false`
   * the nodes themselves are not applied (state just before them).
   */
  makeState(
    nodes?: MigrationKey | MigrationKey[],
    opts: { atEnd?: boolean; realApps?: Iterable<string>; base?: ProjectState } = {},
  ): ProjectState {
    const atEnd = opts.atEnd ?? true
    const targets = nodes === undefined ? this.leafNodes() : isKey(nodes) ? [nodes] : nodes
    const targetKeys = new Set(targets.map(keyOf))
    const plan: MigrationKey[] = []
    const seen = new Set<string>()
    for (const t of targets) {
      for (const k of this.forwardsPlan(t)) {
        const s = keyOf(k)
        if (seen.has(s)) continue
        if (!atEnd && targetKeys.has(s)) continue
        seen.add(s)
        plan.push(k)
      }
    }
    const state = opts.base ? opts.base.clone() : new ProjectState([], opts.realApps ?? [])
    for (const k of plan) this.get(k).mutateState(state, false)
    state.invalidate()
    return state
  }
}

function isKey(v: MigrationKey | MigrationKey[]): v is MigrationKey {
  return typeof v[0] === 'string'
}
