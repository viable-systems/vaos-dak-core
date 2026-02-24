import type { AutonomyEvent, AutonomyStream } from './types'

const STOP_WORDS = new Set([
  'and', 'the', 'for', 'with', 'that', 'this', 'from', 'into', 'your', 'you',
  'are', 'was', 'were', 'will', 'have', 'has', 'had', 'not', 'null', 'true',
  'false', 'then', 'when', 'where', 'while', 'about', 'after', 'before', 'over',
  'under', 'only', 'just', 'than', 'been', 'also', 'each', 'other', 'some', 'more',
  // Event-type boilerplate tokens that create noise for concept ranking.
  'stream', 'step', 'started', 'succeeded', 'retry', 'scheduled', 'completed',
  'failed', 'terminal', 'marked', 'inconsistent', 'manual', 'requested'
])

const TOKEN_PATTERN = /[a-z0-9]+/g
const MAX_TOKEN_LENGTH = 40
const MAX_TOKENS_PER_EVENT = 24
const MAX_SOURCE_DEPTH = 4

export interface ConceptNode {
  concept: string
  frequency: number
  lastSeenSeqNo: number
}

export type ThreadEdgeReason = 'adjacent' | 'shared_concept'

export interface ThreadEdge {
  fromSeqNo: number
  toSeqNo: number
  reasons: ThreadEdgeReason[]
  sharedConcepts: string[]
  weight: number
}

export interface EventConceptProjection {
  seqNo: number
  eventType: string
  concepts: string[]
  excerpt: string
}

export interface ConceptThreadGraph {
  events: EventConceptProjection[]
  concepts: ConceptNode[]
  edges: ThreadEdge[]
}

export interface RetrievedMemoryItem {
  seqNo: number
  eventType: string
  concepts: string[]
  overlapConcepts: string[]
  score: number
  excerpt: string
}

export interface RetrievedMemoryContext {
  query: string
  queryTokens: string[]
  graph: {
    eventCount: number
    conceptCount: number
    edgeCount: number
    topConcepts: string[]
  }
  items: RetrievedMemoryItem[]
  threadEdges: ThreadEdge[]
}

export interface RetrieveAutonomyMemoryInput {
  stream: AutonomyStream
  events: AutonomyEvent[]
  query?: string
  limit?: number
}

function collectStringFragments(
  value: unknown,
  sink: string[],
  depth: number = 0
): void {
  if (depth > MAX_SOURCE_DEPTH || value === null || value === undefined) {
    return
  }

  if (typeof value === 'string') {
    if (value.trim().length > 0) {
      sink.push(value.trim())
    }
    return
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    sink.push(String(value))
    return
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      collectStringFragments(entry, sink, depth + 1)
    }
    return
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))

    for (const [, nested] of entries) {
      collectStringFragments(nested, sink, depth + 1)
    }
  }
}

function normalizeToken(rawToken: string): string | null {
  const token = rawToken.toLowerCase()

  if (token.length < 3 || token.length > MAX_TOKEN_LENGTH) {
    return null
  }

  if (STOP_WORDS.has(token)) {
    return null
  }

  return token
}

export function extractConceptTokens(
  input: string,
  maxTokens: number = MAX_TOKENS_PER_EVENT
): string[] {
  const matches = input.toLowerCase().match(TOKEN_PATTERN) || []
  const concepts: string[] = []
  const seen = new Set<string>()

  for (const rawToken of matches) {
    const token = normalizeToken(rawToken)
    if (!token || seen.has(token)) {
      continue
    }

    seen.add(token)
    concepts.push(token)

    if (concepts.length >= maxTokens) {
      break
    }
  }

  return concepts
}

function eventToProjection(event: AutonomyEvent): EventConceptProjection {
  const fragments: string[] = [event.event_type.replace(/[._]+/g, ' ')]
  collectStringFragments(event.payload_json, fragments)
  collectStringFragments(event.metadata_json, fragments)

  const sourceText = fragments.join(' ').replace(/\s+/g, ' ').trim()
  return {
    seqNo: event.seq_no,
    eventType: event.event_type,
    concepts: extractConceptTokens(sourceText),
    excerpt: sourceText.slice(0, 220)
  }
}

function upsertEdge(
  edgeMap: Map<string, ThreadEdge>,
  input: {
    fromSeqNo: number
    toSeqNo: number
    reason: ThreadEdgeReason
    sharedConcepts: string[]
    weight: number
  }
): void {
  if (input.fromSeqNo === input.toSeqNo) {
    return
  }

  const key = `${input.fromSeqNo}->${input.toSeqNo}`
  const existing = edgeMap.get(key)

  if (!existing) {
    edgeMap.set(key, {
      fromSeqNo: input.fromSeqNo,
      toSeqNo: input.toSeqNo,
      reasons: [input.reason],
      sharedConcepts: [...input.sharedConcepts].sort(),
      weight: input.weight
    })
    return
  }

  if (!existing.reasons.includes(input.reason)) {
    existing.reasons.push(input.reason)
    existing.reasons.sort()
  }

  if (input.sharedConcepts.length > 0) {
    const concepts = new Set([...existing.sharedConcepts, ...input.sharedConcepts])
    existing.sharedConcepts = [...concepts].sort()
  }

  existing.weight += input.weight
  edgeMap.set(key, existing)
}

function sortEvents(events: AutonomyEvent[]): AutonomyEvent[] {
  return [...events].sort((left, right) => left.seq_no - right.seq_no)
}

export function buildConceptThreadGraph(events: AutonomyEvent[]): ConceptThreadGraph {
  const orderedEvents = sortEvents(events)
  const projections = orderedEvents.map(eventToProjection)
  const conceptStats = new Map<string, ConceptNode>()
  const edgeMap = new Map<string, ThreadEdge>()
  const lastSeqByConcept = new Map<string, number>()

  for (let index = 0; index < projections.length; index++) {
    const projection = projections[index]
    const projectionConceptSet = new Set(projection.concepts)

    for (const concept of projection.concepts) {
      const existing = conceptStats.get(concept)
      conceptStats.set(concept, {
        concept,
        frequency: (existing?.frequency || 0) + 1,
        lastSeenSeqNo: projection.seqNo
      })

      const priorSeqNo = lastSeqByConcept.get(concept)
      if (priorSeqNo && priorSeqNo !== projection.seqNo) {
        upsertEdge(edgeMap, {
          fromSeqNo: priorSeqNo,
          toSeqNo: projection.seqNo,
          reason: 'shared_concept',
          sharedConcepts: [concept],
          weight: 2
        })
      }

      lastSeqByConcept.set(concept, projection.seqNo)
    }

    if (index > 0) {
      const previous = projections[index - 1]
      const sharedAdjacentConcepts = previous.concepts
        .filter(concept => projectionConceptSet.has(concept))
        .sort()

      upsertEdge(edgeMap, {
        fromSeqNo: previous.seqNo,
        toSeqNo: projection.seqNo,
        reason: 'adjacent',
        sharedConcepts: sharedAdjacentConcepts,
        weight: 1
      })
    }
  }

  const concepts = [...conceptStats.values()]
    .sort((left, right) => {
      if (right.frequency !== left.frequency) {
        return right.frequency - left.frequency
      }
      return left.concept.localeCompare(right.concept)
    })

  const sortedEdges = [...edgeMap.values()]
    .sort((left, right) => {
      if (left.toSeqNo !== right.toSeqNo) {
        return left.toSeqNo - right.toSeqNo
      }
      return left.fromSeqNo - right.fromSeqNo
    })

  return {
    events: projections,
    concepts,
    edges: sortedEdges
  }
}

function computeDefaultQuery(stream: AutonomyStream): string {
  const phase = typeof stream.current_state.phase === 'string' ? stream.current_state.phase : ''
  const lastError = typeof stream.last_error === 'string' ? stream.last_error : ''
  const status = stream.status
  return [stream.workflow_type, status, phase, lastError]
    .filter(Boolean)
    .join(' ')
}

function rankMemoryCandidates(
  graph: ConceptThreadGraph,
  queryTokens: string[],
  limit: number
): RetrievedMemoryItem[] {
  const conceptFrequency = new Map(graph.concepts.map(node => [node.concept, node.frequency]))
  const maxSeqNo = graph.events.length > 0 ? graph.events[graph.events.length - 1].seqNo : 0

  const scored = graph.events.map(eventProjection => {
    const overlapConcepts = eventProjection.concepts
      .filter(concept => queryTokens.includes(concept))
      .sort()
    const overlapCount = overlapConcepts.length

    const specificityScore = overlapConcepts
      .reduce((sum, concept) => sum + (1 / (conceptFrequency.get(concept) || 1)), 0)

    const recencyDistance = maxSeqNo > 0 ? maxSeqNo - eventProjection.seqNo : 0
    const recencyScore = 1 / (1 + recencyDistance)
    const score = (overlapCount * 3) + specificityScore + recencyScore

    return {
      seqNo: eventProjection.seqNo,
      eventType: eventProjection.eventType,
      concepts: eventProjection.concepts,
      overlapConcepts,
      score,
      excerpt: eventProjection.excerpt
    }
  })

  const hasOverlap = scored.some(item => item.overlapConcepts.length > 0)
  const filtered = hasOverlap
    ? scored.filter(item => item.overlapConcepts.length > 0)
    : scored

  return filtered
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score
      }
      return right.seqNo - left.seqNo
    })
    .slice(0, limit)
}

function collectThreadEdges(graph: ConceptThreadGraph, memoryItems: RetrievedMemoryItem[]): ThreadEdge[] {
  const focusSeqs = new Set(memoryItems.map(item => item.seqNo))
  return graph.edges
    .filter(edge => focusSeqs.has(edge.fromSeqNo) || focusSeqs.has(edge.toSeqNo))
    .slice(0, 16)
}

export function retrieveAutonomyMemory(input: RetrieveAutonomyMemoryInput): RetrievedMemoryContext {
  const graph = buildConceptThreadGraph(input.events)
  const query = (input.query || computeDefaultQuery(input.stream)).trim()
  const queryTokens = extractConceptTokens(query, 12)
  const limit = Math.max(1, Math.min(input.limit || 5, 20))
  const items = rankMemoryCandidates(graph, queryTokens, limit)
  const threadEdges = collectThreadEdges(graph, items)

  return {
    query,
    queryTokens,
    graph: {
      eventCount: graph.events.length,
      conceptCount: graph.concepts.length,
      edgeCount: graph.edges.length,
      topConcepts: graph.concepts.slice(0, 8).map(node => node.concept)
    },
    items,
    threadEdges
  }
}
