// The data Rearview keeps, and the session state its pane draws from.

/** A place in the project a finding points at. Lines are 1-based, in the file as it is now. */
export type Evidence = { file: string; line?: number }

/** One file changed during a turn. `shell` means a shell command changed it (found through git status). */
export type ChangedFile = {
  path: string
  change: 'edited' | 'new' | 'deleted' | 'shell'
  diff: string
  added: number
  removed: number
  /** True for files that look like they hold secrets (.env, keys): listed by name, contents never read or sent. */
  isSecret?: true
}

/** Where a reason comes from: Claude said it, the reviewer worked it out, or nothing explains it. */
export type Source = 'stated' | 'inferred' | 'none'

/** One part of the person's request, and whether the turn did it. */
export type Requirement = {
  id: string
  text: string
  quote: string
  status: 'done' | 'partly' | 'missed'
  finding: string
  evidence: Evidence[]
}

/** A plain-English reason for one changed line. `symbols` are names in that line worth tracing. */
export type WhyNote = { file: string; line: number; why: string; source: Source; symbols: string[] }

/** One step of Claude's reasoning, rebuilt from what it said, read and changed. */
export type ReasoningStep = {
  id: string
  kind: 'plan' | 'explored' | 'decision' | 'shortcut' | 'unrequested' | 'skipped'
  title: string
  why: string
  source: Source
  evidence: Evidence[]
}

/** A principle the turn's changes go against. */
export type Violation = { principleId: string; finding: string }

/** What the reviewer model returns for one turn. */
export type Review = {
  requirements: Requirement[]
  notes: WhyNote[]
  steps: ReasoningStep[]
  violations: Violation[]
}

export type ReviewState =
  | { state: 'pending' }
  | { state: 'skipped'; reason: string }
  | { state: 'failed'; reason: string }
  | { state: 'done'; result: Review }

/** One finished turn: what was asked, what changed, and the review of it. */
export type Turn = {
  id: string
  request: string
  answer: string
  /** Everything Claude wrote during this turn, the source of "Claude said so" reasons. */
  agentMessages: string
  /** How the turn ended: Claude answered, the person interrupted it, the model refused, or an error stopped it. */
  endReason: 'answer' | 'aborted' | 'refusal' | 'error'
  /** Where the prompt came from, when it was not the person (a task notification, another session). Absent for the person's own. */
  origin?: string
  finishedAt: number
  filesRead: string[]
  files: ChangedFile[]
  /** Files that import a changed file but were not changed themselves. */
  affected: string[]
  review: ReviewState
}

/** The turn being recorded right now. */
export type ActiveTurn = {
  id: string
  request: string
  filesRead: string[]
  /** Each file Claude's tools edited, with its content from before the first edit (null: it did not exist). */
  before: Record<string, string | null>
  /** Secret-looking files Claude's tools edited; their contents are never read. */
  secretFiles: string[]
  /** A git commit holding the working tree as it was when the turn started; null outside git. */
  gitBase: string | null
  /** Untracked files that existed when the turn started. */
  untrackedBefore: string[]
  /** How many conversation rows existed when the turn started, so the turn's own messages can be picked out. */
  messageCount: number
  /** Where the turn's prompt came from, as prompt.submit named it (`composer`, `task-notification`, ...); `unknown` when unseen. */
  origin: string
}

/** Which models Rearview calls, from the plugin's settings. */
export type Models = { review: string; check: string }

/** A lasting rule for how the person wants Claude to work, kept in .claude/rearview/principles.md. */
export type Principle = {
  id: string
  rule: string
  scope: string
  enforce: 'guide' | 'warn' | 'block'
  /** Optional glob of files Claude may not edit while the principle blocks, e.g. `package.json`. */
  files: string
  status: 'active' | 'retired'
  signals: number
}

/**
 * The project's principles and whether they may be used. A principles file is trusted only when its
 * exact contents were written or approved by the person on this machine; untrusted ones are shown, never used.
 */
export type PrincipleSet = { list: Principle[]; isTrusted: boolean }

/** One approval or steer the person gave, kept in .claude/rearview/signals.jsonl. */
export type Signal = { at: number; kind: 'approve' | 'steer'; step: string; text: string }

/** Where a name is defined and used, found with git grep. */
export type TraceResult = {
  symbol: string
  definitions: TraceHit[]
  uses: TraceHit[]
}
export type TraceHit = { file: string; line: number; text: string }

/** A rule suggested from repeated steers, waiting for the person to approve it. */
export type ProposedRule = { rule: string; steers: number }

/** A prompt held back because it goes against a principle, waiting for the person's answer. */
export type DriftQuestion = { prompt: string; principleId: string; rule: string }

export type Tab = 'check' | 'changes' | 'files' | 'reasoning' | 'principles'

/** What the pane is showing right now. */
export type View = {
  tab: Tab
  /** Which finished turn is shown; null means the latest. */
  shownTurnId: string | null
  selectedFile: string | null
  /** The selected file's imports, and the files that import it. */
  connections: { file: string; uses: string[]; usedBy: string[] } | null
  trace: TraceResult | null
  /** The steer box that is open, as `<turn id>:<step id>`. */
  steeringStepId: string | null
  /** The turn whose "send the gaps" message is shown for checking before it is sent. */
  previewingGapsFor: string | null
}

declare module 'claude-code' {
  interface PluginState {
    rearview: {
      active: ActiveTurn | null
      turns: Turn[]
      view: View
      principles: PrincipleSet
      proposedRule: ProposedRule | null
      drift: DriftQuestion | null
    }
  }
}
