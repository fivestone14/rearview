// The Rearview pane beside the chat, and the drift question shown above the prompt.
// These functions only draw from state; button presses call into actions.ts.

import type { EngineInterface, RenderInput } from 'claude-code'

import {
  answerDrift,
  approvePrinciplesFile,
  approveProposedRule,
  approveStep,
  closeTrace,
  dismissProposedRule,
  gapsMessage,
  openTrace,
  previewGaps,
  retirePrinciple,
  selectFile,
  sendGaps,
  showTab,
  showTurn,
  steerStep,
  toggleSteer,
} from './actions'
import { getActiveTurn, getDrift, getPrinciples, getProposedRule, getTurns, getView } from './state'
import type { Evidence, Models, ReasoningStep, Source, Tab, Turn, View } from '../types'

export const PANE_ID = 'rearview'

const TABS: Array<[Tab, string]> = [
  ['check', 'Check'],
  ['changes', 'Changes'],
  ['files', 'Files'],
  ['reasoning', 'Reasoning'],
  ['principles', 'Principles'],
]
const SOURCE_LABEL: Record<Source, string> = { stated: 'Claude said so', inferred: 'inferred', none: 'no reason found' }
/** Reasoning steps shown first, under "Needs your eyes". */
const NEEDS_EYES: ReadonlyArray<ReasoningStep['kind']> = ['shortcut', 'unrequested', 'skipped']
const STATUS_LABEL = { done: 'Done', partly: 'Partly', missed: 'Missed' } as const
const STATUS_COLOR = { done: 'green', partly: 'yellow', missed: 'red' } as const
const END_NOTE = {
  answer: null,
  aborted: 'You interrupted this turn, so it may be unfinished.',
  refusal: 'The model refused this turn.',
  error: 'An error stopped this turn, so it may be unfinished.',
} as const

type Elements = ReturnType<EngineInterface['ui']['resolve']>

const where = (evidence: Evidence[]) => evidence.map(ev => (ev.line ? `${ev.file}:${ev.line}` : ev.file)).join(', ')

export async function drawPane($: EngineInterface, e: RenderInput, models: Models) {
  const elements = $.ui.resolve(e)
  const { Box, Text, Button } = elements
  const allTurns = await getTurns($)
  const view = await getView($)
  const isRecording = (await getActiveTurn($)) !== null

  const found = view.shownTurnId ? allTurns.findIndex(t => t.id === view.shownTurnId) : -1
  const index = found === -1 ? allTurns.length - 1 : found
  const turn = allTurns[index]

  if (!turn) {
    // Principles still show before the first turn, so an unapproved file can be reviewed right away.
    return (
      <Box flexDirection="column" gap={1}>
        <Text bold>Rearview</Text>
        <Text dimColor>{isRecording ? 'Recording this turn…' : 'No turns yet. Ask Claude to change something.'}</Text>
        {await drawPrinciples($, elements)}
      </Box>
    )
  }

  const previousId = allTurns[Math.max(0, index - 1)]!.id
  // Stepping onto the latest turn goes back to following new turns as they arrive.
  const nextId = index + 1 >= allTurns.length - 1 ? null : allTurns[index + 1]!.id
  const endNote = END_NOTE[turn.endReason]

  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="row" gap={1}>
        <Button key="prev-turn" label="‹" onPress={() => showTurn($, previousId)} />
        <Text bold>{`Turn ${index + 1} of ${allTurns.length}`}</Text>
        <Button key="next-turn" label="›" onPress={() => showTurn($, nextId)} />
        {isRecording && <Text dimColor>recording…</Text>}
      </Box>
      <Text dimColor wrap="truncate-end">{`“${turn.request}”`}</Text>
      {endNote && <Text color="yellow">{endNote}</Text>}

      <Box flexDirection="row" gap={1} flexWrap="wrap">
        {TABS.map(([id, label]) => (
          <Button key={`tab-${id}`} label={label} variant={id === view.tab ? 'primary' : 'secondary'} onPress={() => showTab($, id)} />
        ))}
      </Box>

      {view.trace && drawTrace($, elements, view.trace)}
      {view.tab === 'check' && drawCheck($, elements, turn, view)}
      {view.tab === 'changes' && drawChanges($, elements, turn)}
      {view.tab === 'files' && drawFiles($, elements, turn, view)}
      {view.tab === 'reasoning' && drawReasoning($, elements, turn, view, models, e.surface !== 'mobile')}
      {view.tab === 'principles' && (await drawPrinciples($, elements))}
    </Box>
  )
}

function drawTrace($: EngineInterface, elements: Elements, trace: NonNullable<View['trace']>) {
  const { Box, Text, Button } = elements
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Box flexDirection="row" gap={1}>
        <Text bold>Trace: {trace.symbol}</Text>
        <Button key="close-trace" label="Close" onPress={() => closeTrace($)} />
      </Box>
      <Text dimColor>Defined in</Text>
      {trace.definitions.length === 0 && <Text dimColor>  not found in this project</Text>}
      {trace.definitions.map(hit => (
        <Text wrap="truncate-end">
          {'  '}{hit.file}:{hit.line}  {hit.text}
        </Text>
      ))}
      <Text dimColor>Used in ({trace.uses.length})</Text>
      {trace.uses.map(hit => (
        <Text wrap="truncate-end">
          {'  '}{hit.file}:{hit.line}  {hit.text}
        </Text>
      ))}
    </Box>
  )
}

/** The line shown while a turn has no finished review. */
function drawReviewState(elements: Elements, turn: Turn) {
  const { Text } = elements
  if (turn.review.state === 'pending') return <Text dimColor>Reviewing this turn…</Text>
  if (turn.review.state === 'skipped') return <Text dimColor>{turn.review.reason}</Text>
  if (turn.review.state === 'failed') return <Text color="red">Review failed: {turn.review.reason}</Text>
  return null
}

/** Check: did Claude do what was asked? One row per part of the request. */
function drawCheck($: EngineInterface, elements: Elements, turn: Turn, view: View) {
  const { Box, Text, Button } = elements
  if (turn.review.state !== 'done') return drawReviewState(elements, turn)
  const { requirements, violations, steps } = turn.review.result
  const count = (status: keyof typeof STATUS_LABEL) => requirements.filter(r => r.status === status).length
  const unrequested = steps.filter(s => s.kind === 'unrequested')
  const gaps = gapsMessage(turn)

  return (
    <Box flexDirection="column" gap={1}>
      <Text bold>
        {count('done')} of {requirements.length} done · {count('partly')} partly · {count('missed')} missed
      </Text>
      {requirements.map(r => (
        <Box flexDirection="column">
          <Text>
            <Text bold color={STATUS_COLOR[r.status]}>{STATUS_LABEL[r.status]}</Text> {r.id} {r.text}
          </Text>
          {r.finding !== '' && <Text dimColor>{r.finding}</Text>}
          {r.evidence.length > 0 && <Text dimColor>{where(r.evidence)}</Text>}
        </Box>
      ))}
      {unrequested.map(s => (
        <Text color="magenta">Not requested: {s.title}</Text>
      ))}
      {violations.map(v => (
        <Text color="red">
          Against principle "{v.principleId}": {v.finding}
        </Text>
      ))}
      {gaps && view.previewingGapsFor !== turn.id && (
        <Button key="send-gaps" label="Send the gaps to Claude…" variant="primary" onPress={() => previewGaps($, turn.id)} />
      )}
      {gaps && view.previewingGapsFor === turn.id && (
        <Box flexDirection="column" borderStyle="round" paddingX={1}>
          <Text bold>Claude will receive exactly this. Check it first:</Text>
          <Text>{gaps}</Text>
          <Box flexDirection="row" gap={1}>
            <Button key="send-gaps-confirm" label="Send to Claude" variant="primary" onPress={() => sendGaps($, turn)} />
            <Button key="send-gaps-cancel" label="Cancel" onPress={() => previewGaps($, null)} />
          </Box>
        </Box>
      )}
    </Box>
  )
}

/** Changes: each file's diff, with a plain-English reason under it for each changed line. */
function drawChanges($: EngineInterface, elements: Elements, turn: Turn) {
  const { Box, Text, Button, Code } = elements
  const notes = turn.review.state === 'done' ? turn.review.result.notes : []
  return (
    <Box flexDirection="column" gap={1}>
      {turn.review.state !== 'done' && drawReviewState(elements, turn)}
      {turn.files.map(file => (
        <Box flexDirection="column">
          <Text bold>
            {file.path}{' '}
            <Text dimColor>
              {file.change === 'shell' ? 'changed by a shell command' : file.change} +{file.added} −{file.removed}
            </Text>
          </Text>
          {file.isSecret && <Text dimColor>Contents hidden: this looks like a secrets file, so Rearview never reads it.</Text>}
          {file.diff !== '' && <Code source={file.diff} format="diff" path={file.path} />}
          {notes
            .filter(note => note.file === file.path)
            .map((note, noteIndex) => (
              <Box flexDirection="column">
                <Text>
                  <Text bold>Why, line {note.line}:</Text> {note.why} <Text dimColor>({SOURCE_LABEL[note.source]})</Text>
                </Text>
                {note.symbols.length > 0 && (
                  <Box flexDirection="row" gap={1} flexWrap="wrap">
                    {note.symbols.map(symbol => (
                      <Button key={`trace-${file.path}-${noteIndex}-${symbol}`} label={`Trace ${symbol}`} onPress={() => openTrace($, symbol)} />
                    ))}
                  </Box>
                )}
              </Box>
            ))}
        </Box>
      ))}
    </Box>
  )
}

/** Files: what changed, what is affected through imports, and what Claude read. */
function drawFiles($: EngineInterface, elements: Elements, turn: Turn, view: View) {
  const { Box, Text, Button } = elements
  const groups: Array<[string, string[]]> = [
    ['Edited', turn.files.filter(f => f.change === 'edited').map(f => f.path)],
    ['New', turn.files.filter(f => f.change === 'new').map(f => f.path)],
    ['Deleted', turn.files.filter(f => f.change === 'deleted').map(f => f.path)],
    ['Changed by a shell command', turn.files.filter(f => f.change === 'shell').map(f => f.path)],
    ['Affected, not edited (imports a changed file)', turn.affected],
    ['Read by Claude', turn.filesRead],
  ]
  const links = view.connections

  return (
    <Box flexDirection="column" gap={1}>
      {groups
        .filter(([, paths]) => paths.length > 0)
        .map(([title, paths]) => (
          <Box flexDirection="column">
            <Text bold>
              {title} ({paths.length})
            </Text>
            {paths.map(path => (
              <Button
                key={`file-${title}-${path}`}
                plain
                label={path === view.selectedFile ? `▸ ${path}` : `  ${path}`}
                onPress={() => selectFile($, path)}
              />
            ))}
          </Box>
        ))}
      {links && links.file === view.selectedFile && (
        <Box flexDirection="column" borderStyle="round" paddingX={1}>
          <Text bold>{links.file}</Text>
          <Text dimColor>Uses: {links.uses.join(', ') || 'no project files'}</Text>
          <Text dimColor>Used by: {links.usedBy.join(', ') || 'no project files'}</Text>
        </Box>
      )}
    </Box>
  )
}

/** Reasoning: Claude's steps, problems first, each with Looks right / Steer. `canType`: the surface has text fields (mobile has none). */
function drawReasoning($: EngineInterface, elements: Elements, turn: Turn, view: View, models: Models, canType: boolean) {
  const { Box, Text, Button } = elements
  if (turn.review.state !== 'done') return drawReviewState(elements, turn)
  const steps = turn.review.result.steps
  const flagged = steps.filter(s => NEEDS_EYES.includes(s.kind))
  const routine = steps.filter(s => !NEEDS_EYES.includes(s.kind))

  const drawStep = (step: ReasoningStep) => {
    const steerKey = `${turn.id}:${step.id}`
    return (
    <Box flexDirection="column">
      <Text>
        <Text bold>{step.kind}</Text> {step.title} <Text dimColor>({SOURCE_LABEL[step.source]})</Text>
      </Text>
      {step.why !== '' && <Text dimColor>{step.why}</Text>}
      {step.evidence.length > 0 && <Text dimColor>{where(step.evidence)}</Text>}
      <Box flexDirection="row" gap={1}>
        <Button key={`ok-${step.id}`} label="Looks right" onPress={() => approveStep($, step)} />
        <Button key={`steer-${step.id}`} label="Steer" onPress={() => toggleSteer($, steerKey)} />
      </Box>
      {view.steeringStepId === steerKey &&
        (canType && 'Input' in elements ? (
          <elements.Input
            key={`steer-input-${step.id}`}
            label="Tell Claude what to do instead"
            submitLabel="Send to Claude"
            autoFocus
            onSubmit={text => steerStep($, step, text, models)}
          />
        ) : (
          <Text dimColor>Steering needs the desktop app or a terminal.</Text>
        ))}
    </Box>
    )
  }

  return (
    <Box flexDirection="column" gap={1}>
      <Text bold>Needs your eyes ({flagged.length})</Text>
      {flagged.length === 0 && <Text dimColor>Nothing flagged.</Text>}
      {flagged.map(drawStep)}
      <Text bold>Routine ({routine.length})</Text>
      {routine.map(drawStep)}
    </Box>
  )
}

/** Principles: the suggested rule waiting for approval, and the saved ones. */
async function drawPrinciples($: EngineInterface, elements: Elements) {
  const { Box, Text, Button } = elements
  const { list, isTrusted } = await getPrinciples($)
  const proposed = await getProposedRule($)

  return (
    <Box flexDirection="column" gap={1}>
      {!isTrusted && (
        <Box flexDirection="column" borderStyle="round" paddingX={1}>
          <Text bold color="yellow">These principles are not approved, so Claude does not see them.</Text>
          <Text>
            The principles file came with this project or was changed outside Rearview. A file like this could carry
            instructions you never wrote. Read every rule below, then approve it if they are yours.
          </Text>
          <Button key="approve-file" label="Approve these principles" onPress={() => approvePrinciplesFile($)} />
        </Box>
      )}
      {proposed && (
        <Box flexDirection="column" borderStyle="round" paddingX={1}>
          <Text bold>Suggested from your steers</Text>
          <Text>{proposed.rule}</Text>
          <Box flexDirection="row" gap={1}>
            <Button key="approve-rule" label="Save as principle" variant="primary" onPress={() => approveProposedRule($)} />
            <Button key="dismiss-rule" label="Dismiss" onPress={() => dismissProposedRule($)} />
          </Box>
        </Box>
      )}
      {list.length === 0 && <Text dimColor>No principles yet. One is suggested after you steer Claude the same way twice.</Text>}
      {list.map(p => (
        <Box flexDirection="column">
          <Text strikethrough={p.status === 'retired'}>{p.rule}</Text>
          <Text dimColor>
            {p.enforce} · applies: {p.scope}{p.files !== '' ? ` · files: ${p.files}` : ''} · {p.signals} signals · {p.status}
          </Text>
          {p.status === 'active' && <Button key={`retire-${p.id}`} label="Retire" onPress={() => retirePrinciple($, p.id)} />}
        </Box>
      ))}
      <Text dimColor>Stored in .claude/rearview/principles.md. You can edit that file directly.</Text>
    </Box>
  )
}

/** Above the prompt: the held prompt's drift question, or null when there is none. */
export async function drawDriftBand($: EngineInterface, e: RenderInput) {
  const question = await getDrift($)
  if (!question) return null
  const { Box, Text, Button } = $.ui.resolve(e)
  return (
    <Box flexDirection="column">
      <Text>
        <Text bold>Rearview:</Text> this request goes against your principle “{question.rule}”. Send it anyway?
      </Text>
      <Box flexDirection="row" gap={1}>
        <Button key="drift-once" label="Just this once" variant="primary" onPress={() => answerDrift($, 'once')} />
        <Button key="drift-retire" label="Retire the principle" onPress={() => answerDrift($, 'retire')} />
        <Button key="drift-cancel" label="Cancel" onPress={() => answerDrift($, 'cancel')} />
      </Box>
    </Box>
  )
}
