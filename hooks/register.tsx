// Rearview's entry point: connects Claude Code's events to the parts that handle them.
//
//   session.start  -> load saved turns and principles, add /rearview, start the reviewer
//   session.attach -> open the pane when a desktop or VS Code window attaches
//   prompt.submit  -> drift check: hold a prompt that goes against a principle
//   turn.start     -> start recording a turn
//   tool.call      -> refuse edits a blocking principle forbids; note files read and changed
//   turn.complete  -> finish the turn (diffs, affected files); the reviewer picks it up
//   prompt.compose -> add active principles to Claude's system prompt
//   ui.render      -> draw the pane and the drift question

import type { EngineInterface, PromptSubmitInput, Register } from 'claude-code'

import { drawDriftBand, drawPane, PANE_ID } from './pane'
import { projectPath } from './paths'
import { blockingPrinciple, findDrift, loadPrinciples, principlesPromptSection, usablePrinciples } from './principles'
import { reviewNextPendingTurn } from './review'
import { getPrinciples, setDrift, setPrinciples, updateActiveTurn } from './state'
import { editedPath, finishTurn, loadTurns, noteToolCall, startTurn } from './turn'
import type { Models } from '../types'

/** How often the reviewer looks for a finished turn to review. */
const REVIEW_POLL_MS = 2000

/**
 * Whether a prompt is the person's own typing and can be held and resent whole.
 * Prompts from plugins (Rearview's own resends), tasks and other sessions pass straight through,
 * and so do prompts with attachments or @file mentions, which a resend could not carry.
 */
function isHoldablePrompt(e: PromptSubmitInput): boolean {
  if (e.command || e.isMeta || e.attachments) return false
  const isPersonsOwn = e.origin === undefined || ['composer', 'bridge', 'sdk'].includes(e.origin.kind)
  return isPersonsOwn && !/(^|\s)@\S/.test(e.text)
}

async function openPane($: EngineInterface): Promise<void> {
  await $.ui.open({ id: PANE_ID, title: 'Rearview' })
}

export const register: Register = (on, options) => {
  const models: Models = {
    review: String(options.reviewModel ?? 'sonnet'),
    check: String(options.checkModel ?? 'haiku'),
  }

  on('session.start', async ($, e, next) => {
    await loadTurns($)
    const principles = await loadPrinciples($)
    await setPrinciples($, principles)
    if (!principles.isTrusted) $.ui.toast('Rearview: this project has a principles file you have not approved. See the Principles tab.')
    await $.command.register({ name: 'rearview', description: 'Open Rearview: did Claude do what you asked, and why' })
    // Reviews run from a timer so they never hold up the end of a turn.
    $.clock.every(REVIEW_POLL_MS, () => {
      reviewNextPendingTurn($, models.review).catch(error => $.ui.log(`Rearview reviewer: ${String(error)}`))
    })
    // A window that attached before Rearview loaded raises no session.attach, so check now too.
    const surfaces = await $.session.surfaces()
    if (surfaces.includes('desktop') || surfaces.includes('vscode')) void openPane($)
    return next(e)
  })

  // Open the pane by itself only where it sits beside the chat as a sidebar.
  on('session.attach', async ($, e, next) => {
    const result = await next(e)
    if (e.surface === 'desktop' || e.surface === 'vscode') void openPane($)
    return result
  })

  on('command.run', { command: 'rearview' }, async $ => {
    await openPane($)
    return { text: 'Rearview pane opened.' }
  })

  on('prompt.submit', async ($, e, next) => {
    if (!isHoldablePrompt(e)) return next(e)
    await setDrift($, null) // a new prompt replaces any question still waiting
    const principles = await loadPrinciples($) // picks up edits made to principles.md since the last prompt
    await setPrinciples($, principles)
    const conflict = await findDrift($, e.text, usablePrinciples(principles), models.check)
    if (!conflict) return next(e)
    await setDrift($, { prompt: e.text, principleId: conflict.id, rule: conflict.rule })
    return { drop: `Rearview held this prompt: it goes against your principle "${conflict.rule}". Choose above the prompt.` }
  }).catch(($, e, next) => next(e)) // If the check itself fails, the prompt goes through.

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined && e.text !== '') {
      await startTurn($, e.text).catch(error => $.ui.log(`Rearview could not start recording: ${String(error)}`))
    }
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const input = e as unknown as Record<string, unknown>
    const path = editedPath(String(e.tool), input)
    if (path !== null) {
      const rule = blockingPrinciple(usablePrinciples(await getPrinciples($)), await projectPath($, path))
      if (rule) return { deny: `Rearview: your principle "${rule.rule}" blocks edits to ${rule.files}.` }
    }
    await noteToolCall($, String(e.tool), input)
    return next(e)
  }).catch(($, e, next) => next(e)) // If this hook fails, the tool runs anyway: recording and blocking both fail open.

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined) {
      await finishTurn($, e.answer, e.reason).catch(async error => {
        $.ui.log(`Rearview could not record the turn: ${String(error)}`)
        await updateActiveTurn($, () => null)
      })
    }
    return result
  })

  on('prompt.compose', async ($, e, next) => {
    const result = await next(e)
    const text = principlesPromptSection(usablePrinciples(await getPrinciples($)))
    if (!text) return result
    return { sections: [...result.sections, { id: 'rearview:principles', text, scope: 'session' as const }] }
  })

  on('ui.render', { component: 'Pane', requestId: 'rearview' }, ($, e) => drawPane($, e, models))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => (await drawDriftBand($, e)) ?? next(e))
}
