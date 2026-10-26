// The session state Rearview keeps, and the only file that reads or writes it.
// Each value is declared in types/index.d.ts under PluginState['rearview'].
// Writing a value redraws the pane, so nothing calls a redraw by hand.

import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { ActiveTurn, DriftQuestion, PrincipleSet, ProposedRule, Turn, View } from '../types'

const EMPTY_VIEW: View = {
  tab: 'check',
  shownTurnId: null,
  selectedFile: null,
  connections: null,
  trace: null,
  steeringStepId: null,
  previewingGapsFor: null,
}

/** The turn being recorded, from the prompt until Claude finishes. */
const activeTurn = atom({ plugin: 'rearview', key: 'active' } as const, null as ActiveTurn | null)
/** Finished turns, oldest first. */
const turns = atom({ plugin: 'rearview', key: 'turns' } as const, [] as Turn[])
const view = atom({ plugin: 'rearview', key: 'view' } as const, EMPTY_VIEW)
const principles = atom({ plugin: 'rearview', key: 'principles' } as const, { list: [], isTrusted: true } as PrincipleSet)
/** A rule suggested from repeated steers, waiting for the person to approve it. */
const proposedRule = atom({ plugin: 'rearview', key: 'proposedRule' } as const, null as ProposedRule | null)
/** A held prompt waiting for the person's answer. */
const drift = atom({ plugin: 'rearview', key: 'drift' } as const, null as DriftQuestion | null)

export async function getActiveTurn($: EngineInterface): Promise<ActiveTurn | null> {
  return read($, activeTurn)
}
export async function updateActiveTurn($: EngineInterface, change: (turn: ActiveTurn | null) => ActiveTurn | null): Promise<void> {
  await update($, activeTurn, change)
}

export async function getTurns($: EngineInterface): Promise<Turn[]> {
  return read($, turns)
}
export async function updateTurns($: EngineInterface, change: (list: Turn[]) => Turn[]): Promise<void> {
  await update($, turns, change)
}

export async function getView($: EngineInterface): Promise<View> {
  return read($, view)
}
/** Changes some fields of the view and keeps the rest. */
export async function updateView($: EngineInterface, change: (current: View) => Partial<View>): Promise<void> {
  await update($, view, current => ({ ...current, ...change(current) }))
}

export async function getPrinciples($: EngineInterface): Promise<PrincipleSet> {
  return read($, principles)
}
export async function setPrinciples($: EngineInterface, set: PrincipleSet): Promise<void> {
  await update($, principles, () => set)
}

export async function getProposedRule($: EngineInterface): Promise<ProposedRule | null> {
  return read($, proposedRule)
}
export async function setProposedRule($: EngineInterface, proposal: ProposedRule | null): Promise<void> {
  await update($, proposedRule, () => proposal)
}

export async function getDrift($: EngineInterface): Promise<DriftQuestion | null> {
  return read($, drift)
}
export async function setDrift($: EngineInterface, question: DriftQuestion | null): Promise<void> {
  await update($, drift, () => question)
}
