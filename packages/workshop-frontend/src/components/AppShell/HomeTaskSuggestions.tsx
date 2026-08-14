import { useMemo } from 'react'

type TaskSuggestion = {
  id: string
  label: string
  prompt: string
}

const SUGGESTIONS: TaskSuggestion[] = [
  {
    id: 'one-on-one',
    label: 'Write a 1:1 pre-read',
    prompt:
      'Create a document to prepare for my next 1:1 with a direct report: a current snapshot, a coaching frame, things to inspect, carryover items from last time, and one clear ask.',
  },
  {
    id: 'team-meeting',
    label: 'Build a team meeting deck',
    prompt:
      'Create a slide deck for my next team meeting: where things stand, what shipped, risks and blockers, and the decisions I need from the room. Ask me what the team is working on first.',
  },
  {
    id: 'insights',
    label: 'Find insights in my data',
    prompt:
      'Turn a dataset I will share (a spreadsheet, CSV, or pasted table) into a narrative analysis: key trends, anomalies, the "so what", and concrete recommendations.',
  },
  {
    id: 'workflow',
    label: 'Automate a workflow',
    prompt:
      'Create an agent workflow that runs automatically when a new email arrives: read the message, decide what to do, and take action or draft a reply. Ask me which inbox to watch and what it should handle.',
  },
  {
    id: 'app',
    label: 'Build a quick tool',
    prompt:
      'Build a small interactive tool I can use right here — a calculator, dashboard, or explorer. Ask me what it should do, then create it.',
  },
]

const VISIBLE_SUGGESTIONS = 3

function pickSuggestions(): TaskSuggestion[] {
  let shuffled = [...SUGGESTIONS]
  for (let i = shuffled.length - 1; i > 0; i--) {
    let j = Math.floor(Math.random() * (i + 1))
    ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
  }
  return shuffled.slice(0, VISIBLE_SUGGESTIONS)
}

export default function HomeTaskSuggestions({
  onPick,
}: {
  onPick: (prompt: string) => void
}) {
  const visible = useMemo(pickSuggestions, [])

  return (
    <section aria-label="Example tasks" className="flex flex-col">
      <ul className="flex flex-col">
        {visible.map((suggestion) => (
          <li key={suggestion.id}>
            <button
              type="button"
              onClick={() => onPick(suggestion.prompt)}
              className="press flex w-full cursor-pointer items-center rounded-md px-1 py-1.5 text-left text-[13px] leading-[18px] tracking-[-0.25px] text-kumo-inactive transition-colors hover:text-kumo-default"
            >
              {suggestion.label}
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}
