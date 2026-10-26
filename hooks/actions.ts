// What the pane's buttons do. The pane only draws; every change it asks for happens here.

import type { EngineInterface } from 'claude-code'

import {
  loadPrinciples,
  loadSignals,
  principleId,
  recordSignal,
  savePrinciples,
  suggestRule,
  trustPrinciples,
  usablePrinciples,
} from './principles'
import { getDrift, getPrinciples, getProposedRule, setDrift, setPrinciples, setProposedRule, updateView } from './state'
import { findImporters, findImports, traceSymbol } from './trace'
import type { Models, Principle, ReasoningStep, Tab, Turn } from '../types'

export async function showTab($: EngineInterface, tab: Tab): Promise<void> {
  await updateView($, () => ({ tab }))
}

/** Shows one finished turn; null follows the latest turn as new ones arrive. */
export async function showTurn($: EngineInterface, turnId: string | null): Promise<void> {
  await updateView($, () => ({ shownTurnId: turnId }))
}

export async function openTrace($: EngineInterface, symbol: string): Promise<void> {
  const trace = await traceSymbol($, symbol)
  await updateView($, () => ({ trace }))
}

export async function closeTrace($: EngineInterface): Promise<void> {
  await updateView($, () => ({ trace: null }))
}

export async function selectFile($: EngineInterface, file: string): Promise<void> {
  await updateView($, () => ({ selectedFile: file }))
  const [uses, usedBy] = await Promise.all([findImports($, file), findImporters($, file)])
  await updateView($, () => ({ connections: { file, uses, usedBy } }))
}

/**
 * The follow-up message listing what the review found missing, partly done or against a principle,
 * or null when there are no gaps. The review read project files, so the message says it can be wrong
 * and the pane shows it to the person before anything is sent.
 */
export function gapsMessage(turn: Turn): string | null {
  if (turn.review.state !== 'done') return null
  const { requirements, steps, violations } = turn.review.result
  const gaps = [
    ...requirements.filter(r => r.status !== 'done').map(r => `${r.text} (${r.status}): ${r.finding}`),
    ...steps.filter(s => s.kind === 'unrequested').map(s => `Not requested: ${s.title}. Revert it unless it is needed.`),
    ...violations.map(v => `Goes against principle "${v.principleId}": ${v.finding}`),
  ]
  if (gaps.length === 0) return null
  return (
    'An automated review of your last turn flagged these gaps. It can be wrong, so check each one ' +
    `against the code and fix only the real ones:\n${gaps.map((g, i) => `${i + 1}. ${g}`).join('\n')}`
  )
}

/** Shows the gaps message in the pane for checking; nothing is sent yet. */
export async function previewGaps($: EngineInterface, turnId: string | null): Promise<void> {
  await updateView($, () => ({ previewingGapsFor: turnId }))
}

/** Sends the gaps message the person just checked. */
export async function sendGaps($: EngineInterface, turn: Turn): Promise<void> {
  const text = gapsMessage(turn)
  await updateView($, () => ({ previewingGapsFor: null }))
  if (text) await $.prompt.submit({ text })
}

export async function approveStep($: EngineInterface, step: ReasoningStep): Promise<void> {
  await recordSignal($, { at: Date.now(), kind: 'approve', step: step.title, text: step.why })
  $.ui.toast(`Noted: "${step.title}" looks right.`)
}

/** Opens a step's steer box (`<turn id>:<step id>`), or closes it when it is already open. */
export async function toggleSteer($: EngineInterface, steerKey: string): Promise<void> {
  await updateView($, view => ({ steeringStepId: view.steeringStepId === steerKey ? null : steerKey }))
}

/** Sends the person's correction to Claude, records it, and checks whether it repeats an earlier one. */
export async function steerStep($: EngineInterface, step: ReasoningStep, text: string, models: Models): Promise<void> {
  const correction = text.trim()
  if (correction === '') return
  await updateView($, () => ({ steeringStepId: null }))
  await $.prompt.submit({ text: `A correction about your step "${step.title}": ${correction}` })
  await recordSignal($, { at: Date.now(), kind: 'steer', step: step.title, text: correction })

  const suggestion = await suggestRule($, await loadSignals($), usablePrinciples(await getPrinciples($)), models.check)
  if (suggestion) {
    await setProposedRule($, suggestion)
    $.ui.toast('Rearview suggests a new principle. See the Principles tab.')
  }
}

export async function approveProposedRule($: EngineInterface): Promise<void> {
  const proposal = await getProposedRule($)
  if (!proposal) return
  await changePrinciples($, list => [
    ...list,
    {
      id: principleId(proposal.rule, list),
      rule: proposal.rule,
      scope: 'everywhere',
      enforce: 'guide',
      files: '',
      status: 'active',
      signals: proposal.steers,
    },
  ])
  await setProposedRule($, null)
}

export async function dismissProposedRule($: EngineInterface): Promise<void> {
  await setProposedRule($, null)
}

export async function retirePrinciple($: EngineInterface, id: string): Promise<void> {
  await changePrinciples($, list => list.map(p => (p.id === id ? { ...p, status: 'retired' } : p)))
}

/**
 * Changes principles starting from the file on disk, so edits the person made by hand are kept.
 * An unapproved file is never rewritten, since saving would approve rules the person has not read.
 */
async function changePrinciples($: EngineInterface, change: (list: Principle[]) => Principle[]): Promise<void> {
  const current = await loadPrinciples($)
  if (!current.isTrusted) {
    $.ui.toast('Rearview: approve the principles file in the Principles tab first.')
    return
  }
  await setPrinciples($, await savePrinciples($, change(current.list)))
}

/** The person read principles.md in the pane and approved it as it is now. */
export async function approvePrinciplesFile($: EngineInterface): Promise<void> {
  await setPrinciples($, await trustPrinciples($))
}

/** The person's answer to a drift question: send the held prompt as an exception, retire the principle, or drop the prompt. */
export async function answerDrift($: EngineInterface, choice: 'once' | 'retire' | 'cancel'): Promise<void> {
  const question = await getDrift($)
  if (!question) return
  await setDrift($, null)
  if (choice === 'cancel') return

  if (choice === 'retire') await retirePrinciple($, question.principleId)
  const note = choice === 'once'
    ? `\n\n(The person confirmed this is a one-time exception to their principle: "${question.rule}".)`
    : ''
  await $.prompt.submit({ text: question.prompt + note, asUser: true })
}
