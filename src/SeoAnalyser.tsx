import { useClient } from 'sanity'
import { useEffect, useState, useMemo } from 'react'
import imageUrlBuilder from '@sanity/image-url'

// ── public config ─────────────────────────────────────────────────────────────

/** @public */
export interface SeoAnalyserConfig {
  /** Your site's hostname, e.g. "example.com". Used to classify internal vs outbound links. */
  siteHost: string
  /** Sanity document types to check for duplicate keyphrases, e.g. ["post","article"]. */
  documentTypes?: string[]
  /** Field name on the document that holds the seo object. Default: "seo" */
  seoFieldName?: string
  /** Field name on the document that holds the Portable Text content array. Default: "content" */
  contentFieldName?: string
  /** Field name on the document that holds the title string. Default: "title" */
  titleFieldName?: string
  /** Field name on the document that holds the slug object. Default: "slug" */
  slugFieldName?: string
  /** Minimum recommended word count. Default: 300 */
  minWords?: number
  /** Extra text field names to extract from custom block types (merged with defaults). */
  extraTextKeys?: string[]
  /** Extra string-array field names to extract from custom block types (merged with defaults). */
  extraStringArrayKeys?: string[]
}

// ── types ─────────────────────────────────────────────────────────────────────

type Severity = 'problem' | 'improvement' | 'good'
type Tab = 'seo' | 'readability' | 'social'

interface Check {
  id: string
  label: string
  detail: string
  severity: Severity
}

// ── constants ─────────────────────────────────────────────────────────────────

const TITLE_MAX = 60
const DESC_MAX = 160
const DENSITY_MIN = 0.5
const DENSITY_MAX = 3.0
const MAX_SENTENCE_WORDS = 20
const MAX_PARA_WORDS = 150
const MAX_SECTION_WORDS_WITHOUT_HEADING = 300
const MAX_LONG_SENTENCE_PCT = 25
const MAX_CONSECUTIVE_SAME_START = 3

const DEFAULT_TEXT_KEYS = new Set([
  'heading', 'subheading', 'title', 'description', 'text', 'quote',
  'question', 'answer', 'label', 'value', 'leftHeading', 'rightHeading',
  'heading2', 'caption', 'authorName', 'authorTitle', 'authorOrg',
])

const DEFAULT_STRING_ARRAY_KEYS = new Set(['checklistItems', 'participants', 'items'])

const TRANSITION_WORDS = [
  'also','although','and','as','because','before','besides','but','consequently',
  'despite','due to','even if','even so','even though','finally','first','for example',
  'for instance','furthermore','hence','however','if','in addition','in conclusion',
  'in contrast','in fact','in other words','in particular','in short','in summary',
  'in the end','indeed','instead','likewise','meanwhile','moreover','nevertheless',
  'next','nonetheless','on the contrary','on the other hand','otherwise','overall',
  'rather','similarly','since','so','still','such as','then','thereafter','therefore',
  'though','thus','to conclude','to illustrate','to summarize','ultimately',
  'whereas','while','yet',
]

// ── helpers ───────────────────────────────────────────────────────────────────

function blockText(block: any): string {
  return (block.children ?? []).map((s: any) => s.text ?? '').join('')
}

function extractBlocks(nodes: unknown[]): any[] {
  if (!Array.isArray(nodes)) return []
  const result: any[] = []
  for (const node of nodes) {
    const b = node as any
    if (!b || typeof b !== 'object') continue
    if (b._type === 'block' && Array.isArray(b.children)) {
      result.push(b)
    } else {
      for (const val of Object.values(b)) {
        if (Array.isArray(val)) result.push(...extractBlocks(val))
      }
    }
  }
  return result
}

function extractPlainText(nodes: unknown[], textKeys: Set<string>, stringArrayKeys: Set<string>): string {
  if (!Array.isArray(nodes)) return ''
  const parts: string[] = []
  for (const node of nodes) {
    const b = node as any
    if (!b || typeof b !== 'object') continue
    if (b._type === 'block' && Array.isArray(b.children)) {
      parts.push(blockText(b))
      continue
    }
    if (b._type === 'image' || b._type === 'divider' || b._type === 'youtubeEmbed') continue
    for (const [key, val] of Object.entries(b)) {
      if (key === '_type' || key === '_key' || key === 'style' || key === 'background') continue
      if (typeof val === 'string' && val && textKeys.has(key)) {
        parts.push(val)
      } else if (Array.isArray(val)) {
        if (stringArrayKeys.has(key) && val.length > 0 && typeof val[0] === 'string') {
          parts.push(...val.filter((v) => typeof v === 'string'))
        } else {
          parts.push(extractPlainText(val, textKeys, stringArrayKeys))
        }
      } else if (val && typeof val === 'object' && textKeys.has(key)) {
        parts.push(extractPlainText([val], textKeys, stringArrayKeys))
      }
    }
  }
  return parts.filter(Boolean).join(' ')
}

function collectImages(val: unknown, result: any[]): void {
  if (!val || typeof val !== 'object') return
  const b = val as any
  if (b._type === 'image' && b.asset) { result.push(b); return }
  for (const v of Object.values(b)) {
    if (Array.isArray(v)) { for (const item of v) collectImages(item, result) }
    else if (v && typeof v === 'object') collectImages(v, result)
  }
}

function extractLinks(content: unknown[], siteHost: string): { internal: number; outbound: number } {
  let internal = 0; let outbound = 0
  for (const block of extractBlocks(content)) {
    const seenKeys = new Set<string>()
    for (const span of block.children ?? []) {
      for (const mark of span.marks ?? []) {
        if (seenKeys.has(mark)) continue
        const def = (block.markDefs ?? []).find((m: any) => m._key === mark)
        if (def?._type === 'link' && def.href) {
          seenKeys.add(mark)
          if (def.href.includes(siteHost) || def.href.startsWith('/')) internal++
          else outbound++
        }
      }
    }
  }
  return { internal, outbound }
}

function countKw(text: string, kw: string): number {
  if (!kw || !text) return 0
  const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return (text.match(new RegExp(escaped, 'gi')) ?? []).length
}

function hasKw(text: string, kw: string): boolean { return countKw(text, kw) > 0 }

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length
}

function startsWithKw(text: string, kw: string): boolean {
  if (!kw || !text) return false
  return text.trim().toLowerCase().startsWith(kw.toLowerCase())
}

function splitSentences(text: string): string[] {
  return text.match(/[^.!?]+[.!?]+/g)?.map((s) => s.trim()).filter(Boolean) ?? []
}

function firstWord(sentence: string): string {
  return sentence.trim().split(/\s+/)[0]?.toLowerCase() ?? ''
}

// ── sub-components ────────────────────────────────────────────────────────────

function ScoreFace({ score }: { score: number }) {
  const good = score >= 70; const ok = score >= 40
  const color = good ? '#7ad03a' : ok ? '#f0b849' : '#dc3232'
  const mouth = good ? 'M 6 13 Q 10 17 14 13' : ok ? 'M 6 14 L 14 14' : 'M 6 15 Q 10 11 14 15'
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" style={{ verticalAlign: 'middle', marginRight: 4 }}>
      <circle cx="10" cy="10" r="9" fill={color} />
      <circle cx="7" cy="8" r="1.4" fill="#fff" />
      <circle cx="13" cy="8" r="1.4" fill="#fff" />
      <path d={mouth} stroke="#fff" strokeWidth="1.8" fill="none" strokeLinecap="round" />
    </svg>
  )
}

const DOT: Record<Severity, string> = { problem: '#ef4444', improvement: '#f59e0b', good: '#22c55e' }

function CheckRow({ check }: { check: Check }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '6px 0', borderBottom: '1px solid #f3f4f6' }}>
      <span style={{ width: 10, height: 10, minWidth: 10, borderRadius: '50%', background: DOT[check.severity], marginTop: 4 }} />
      <div style={{ fontSize: 12.5, lineHeight: 1.5, color: '#111827' }}>
        <strong>{check.label}:</strong>{' '}
        <span style={{ color: '#4b5563' }}>{check.detail}</span>
      </div>
    </div>
  )
}

function Group({ title, checks, defaultOpen }: { title: string; checks: Check[]; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  if (checks.length === 0) return null
  const color = checks[0].severity === 'problem' ? '#ef4444' : checks[0].severity === 'improvement' ? '#f59e0b' : '#22c55e'
  return (
    <div style={{ marginBottom: 10 }}>
      <button onClick={() => setOpen((o) => !o)} style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'none', border: 'none', cursor: 'pointer', padding: '4px 0', width: '100%', textAlign: 'left' }}>
        <span style={{ fontSize: 13, fontWeight: 700, color }}>{open ? '▼' : '▶'}</span>
        <span style={{ fontSize: 13, fontWeight: 700, color: '#111827' }}>{title} ({checks.length})</span>
      </button>
      {open && <div style={{ paddingLeft: 4 }}>{checks.map((c) => <CheckRow key={c.id} check={c} />)}</div>}
    </div>
  )
}

function Bar({ value, max, okColor }: { value: number; max: number; okColor: string }) {
  const pct = Math.min((value / max) * 100, 100); const over = value > max
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
      <div style={{ flex: 1, height: 6, background: '#e5e7eb', borderRadius: 3, overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', background: over ? '#ef4444' : okColor, borderRadius: 3, transition: 'width 0.2s' }} />
      </div>
      <span style={{ fontSize: 11, color: over ? '#ef4444' : '#6b7280', minWidth: 52, textAlign: 'right' }}>{value} / {max}</span>
    </div>
  )
}

// ── props ─────────────────────────────────────────────────────────────────────

/** @public */
export interface SeoAnalyserProps {
  document: { displayed: Record<string, any> }
  config: SeoAnalyserConfig
}

// ── factory: creates a view component pre-bound to config ─────────────────────

/** @public */
export function createSeoAnalyser(config: SeoAnalyserConfig) {
  return function SeoAnalyserView({ document: sanityDoc }: { document: { displayed: Record<string, any> } }) {
    return <SeoAnalyser document={sanityDoc} config={config} />
  }
}

// ── main component ────────────────────────────────────────────────────────────

/** @public */
export function SeoAnalyser({ document: sanityDoc, config }: SeoAnalyserProps) {
  const {
    siteHost,
    documentTypes = ['post', 'article'],
    seoFieldName = 'seo',
    contentFieldName = 'content',
    titleFieldName = 'title',
    slugFieldName = 'slug',
    minWords = 300,
    extraTextKeys = [],
    extraStringArrayKeys = [],
  } = config

  const textKeys = useMemo(() => new Set([...DEFAULT_TEXT_KEYS, ...extraTextKeys]), [extraTextKeys])
  const stringArrayKeys = useMemo(() => new Set([...DEFAULT_STRING_ARRAY_KEYS, ...extraStringArrayKeys]), [extraStringArrayKeys])

  const [activeTab, setActiveTab] = useState<Tab>('seo')
  const displayed   = sanityDoc?.displayed ?? {}
  const seoField    = displayed[seoFieldName] ?? {}
  const metaTitle   = seoField.metaTitle       ?? ''
  const metaDesc    = seoField.metaDescription ?? ''
  const keyword     = (seoField.focusKeyword   ?? '').trim()
  const synonymsRaw = seoField.synonyms        ?? ''
  const postTitle   = displayed[titleFieldName] ?? ''
  const slug        = displayed[slugFieldName]?.current ?? ''
  const content     = displayed[contentFieldName] ?? []
  const docId       = displayed._id ?? ''
  const ogImage     = seoField.ogImage
  const socialTitle = seoField.socialTitle       ?? ''
  const socialDesc  = seoField.socialDescription ?? ''
  const docForImages = useMemo(() => { const d = { ...displayed }; delete d[seoFieldName]; return d }, [displayed, seoFieldName])

  const [duplicates, setDuplicates] = useState<string[]>([])
  const client = useClient({ apiVersion: '2024-01-01' })
  const builder = useMemo(() => imageUrlBuilder(client), [client])
  const ogImageUrl = ogImage?.asset ? builder.image(ogImage).width(1200).url() : null

  useEffect(() => {
    if (!keyword || keyword.length < 3) { setDuplicates([]); return }
    const t = setTimeout(async () => {
      try {
        const cleanId = docId.replace(/^drafts\./, '')
        const typeList = documentTypes.map((t) => `"${t}"`).join(',')
        const res: { title: string }[] = await client.fetch(
          `*[_type in [${typeList}] && ${seoFieldName}.focusKeyword == $kw && _id != $id && _id != $draftId]{ title }`,
          { kw: keyword, id: cleanId, draftId: 'drafts.' + cleanId }
        )
        setDuplicates(res.map((r) => r.title))
      } catch { setDuplicates([]) }
    }, 700)
    return () => clearTimeout(t)
  }, [keyword, docId, client, documentTypes, seoFieldName])

  // ── derived ───────────────────────────────────────────────────────────────

  const kw         = keyword.toLowerCase()
  const synonyms   = synonymsRaw.split(',').map((s: string) => s.trim().toLowerCase()).filter(Boolean)
  const allPhrases = kw ? [kw, ...synonyms] : synonyms

  const effectiveTitle    = metaTitle || postTitle
  const effectiveSocTitle = socialTitle || metaTitle || postTitle
  const effectiveSocDesc  = socialDesc || metaDesc

  const bodyText = useMemo(() => extractPlainText(content, textKeys, stringArrayKeys), [content, textKeys, stringArrayKeys])
  const blocks   = useMemo(() => extractBlocks(content), [content])
  const images   = useMemo(() => { const r: any[] = []; collectImages(docForImages, r); return r }, [docForImages])
  const words    = wordCount(bodyText)
  const { internal, outbound } = useMemo(() => extractLinks(content, siteHost), [content, siteHost])

  const h1Blocks   = blocks.filter((b: any) => b.style === 'h1')
  const headings   = blocks.filter((b: any) => ['h2', 'h3'].includes(b.style)).map(blockText)
  const introBlock = blocks.find((b: any) => !b.style || b.style === 'normal')
  const introText  = introBlock ? blockText(introBlock) : ''
  const imageAlts  = images.map((img: any) => img.alt ?? '')

  const kwCount   = allPhrases.reduce((sum: number, p: string) => sum + countKw(bodyText, p), 0)
  const density   = words > 0 && allPhrases.length > 0 ? (kwCount / words) * 100 : 0
  const altWithKw = allPhrases.length > 0 ? imageAlts.filter((a: string) => allPhrases.some((p: string) => hasKw(a, p))).length : 0
  const altOveruse = images.length > 0 && altWithKw > 0 && altWithKw === images.length && images.length >= 3

  const third = Math.floor(bodyText.length / 3)
  const inFirst  = allPhrases.some((p: string) => hasKw(bodyText.slice(0, third), p))
  const inMiddle = allPhrases.some((p: string) => hasKw(bodyText.slice(third, third * 2), p))
  const inLast   = allPhrases.some((p: string) => hasKw(bodyText.slice(third * 2), p))
  const distributionParts = [inFirst, inMiddle, inLast].filter(Boolean).length

  const kwWordCount   = kw ? kw.split(/\s+/).filter(Boolean).length : 0
  const slugWords     = slug.split('-').filter(Boolean)
  const kwWords       = kw.split(/\s+/).filter(Boolean)
  const kwWordsInSlug = kwWords.filter((w: string) => slugWords.includes(w)).length
  const slugHasKw     = kw ? kwWordsInSlug >= Math.ceil(kwWords.length / 2) : false
  const h1Count       = h1Blocks.length

  let competingLinks = 0
  if (kw) {
    for (const block of blocks) {
      for (const span of block.children ?? []) {
        const hasMark = (span.marks ?? []).some((mark: string) =>
          (block.markDefs ?? []).find((m: any) => m._key === mark && m._type === 'link')
        )
        if (hasMark && allPhrases.some((p: string) => hasKw(span.text ?? '', p))) competingLinks++
      }
    }
  }

  // ── readability derived ───────────────────────────────────────────────────

  const allSentences    = useMemo(() => splitSentences(bodyText), [bodyText])
  const longSentences   = allSentences.filter((s) => wordCount(s) > MAX_SENTENCE_WORDS)
  const longSentencePct = allSentences.length > 0 ? Math.round((longSentences.length / allSentences.length) * 100) : 0
  const normalBlocks    = blocks.filter((b: any) => !b.style || b.style === 'normal')
  const longParas       = normalBlocks.filter((b: any) => wordCount(blockText(b)) > MAX_PARA_WORDS)

  const sectionWordCounts: number[] = []
  let currentSectionWords = 0
  for (const block of blocks) {
    if (['h2', 'h3', 'h4'].includes(block.style)) {
      if (currentSectionWords > 0) sectionWordCounts.push(currentSectionWords)
      currentSectionWords = 0
    } else { currentSectionWords += wordCount(blockText(block)) }
  }
  if (currentSectionWords > 0) sectionWordCounts.push(currentSectionWords)
  const longSections = sectionWordCounts.filter((w) => w > MAX_SECTION_WORDS_WITHOUT_HEADING)

  let maxConsecutive = 0; let currentConsecutive = 1
  for (let i = 1; i < allSentences.length; i++) {
    if (firstWord(allSentences[i]) === firstWord(allSentences[i - 1]) && firstWord(allSentences[i]) !== '') {
      currentConsecutive++; maxConsecutive = Math.max(maxConsecutive, currentConsecutive)
    } else { currentConsecutive = 1 }
  }

  const sentencesWithTransition = allSentences.filter((s) => {
    const lower = s.toLowerCase()
    return TRANSITION_WORDS.some((tw) => lower.includes(tw))
  })
  const transitionPct = allSentences.length > 0 ? Math.round((sentencesWithTransition.length / allSentences.length) * 100) : 0

  // ── SEO checks ────────────────────────────────────────────────────────────

  const seoChecks: Check[] = []

  if (kw) {
    if (kwWordCount > 6) {
      seoChecks.push({ id: 'kw-length', label: 'Keyphrase length', detail: 'Your keyphrase is ' + kwWordCount + ' words — that\'s too long. Use 1–4 words for best results.', severity: 'improvement' })
    } else {
      seoChecks.push({ id: 'kw-length', label: 'Keyphrase length', detail: 'Good keyphrase length (' + kwWordCount + ' word' + (kwWordCount > 1 ? 's' : '') + ').', severity: 'good' })
    }

    const kwInTitle = allPhrases.some((p: string) => hasKw(effectiveTitle, p))
    const kwAtStart = startsWithKw(effectiveTitle, kw)
    if (!kwInTitle) {
      seoChecks.push({ id: 'kw-title', label: 'Keyphrase in SEO title', detail: 'The focus keyphrase does not appear in the SEO title. Add it.', severity: 'problem' })
    } else if (!kwAtStart) {
      seoChecks.push({ id: 'kw-title', label: 'Keyphrase in SEO title', detail: 'The keyphrase appears in the title but not at the beginning. Move it to the start for best results.', severity: 'improvement' })
    } else {
      seoChecks.push({ id: 'kw-title', label: 'Keyphrase in SEO title', detail: 'The exact match of the focus keyphrase appears at the beginning of the SEO title. Good job!', severity: 'good' })
    }

    const kwInDesc = allPhrases.some((p: string) => hasKw(metaDesc, p))
    seoChecks.push({ id: 'kw-desc', label: 'Keyphrase in meta description', detail: kwInDesc ? 'Keyphrase or synonym found in meta description. Well done!' : 'Add the keyphrase to the meta description.', severity: kwInDesc ? 'good' : 'problem' })

    const kwInIntro = allPhrases.some((p: string) => hasKw(introText, p))
    seoChecks.push({ id: 'kw-intro', label: 'Keyphrase in introduction', detail: kwInIntro ? 'Well done! Keyphrase found in the opening paragraph.' : 'Your keyphrase or its synonyms do not appear in the first paragraph. Make sure the topic is clear immediately.', severity: kwInIntro ? 'good' : 'problem' })

    const kwInHeading = headings.some((h: string) => allPhrases.some((p: string) => hasKw(h, p)))
    seoChecks.push({ id: 'kw-heading', label: 'Keyphrase in subheadings', detail: kwInHeading ? 'Keyphrase or synonym found in at least one H2 or H3.' : 'Use the keyphrase or a synonym in your H2/H3 subheadings.', severity: kwInHeading ? 'good' : 'improvement' })

    if (images.length === 0) {
      seoChecks.push({ id: 'kw-alt', label: 'Keyphrase in image alt attributes', detail: 'No images found in content.', severity: 'improvement' })
    } else if (altOveruse) {
      seoChecks.push({ id: 'kw-alt', label: 'Keyphrase in image alt attributes', detail: altWithKw + ' of ' + images.length + ' images use the keyphrase in alt text — that\'s too many. Only include it where it truly fits.', severity: 'improvement' })
    } else if (altWithKw === 0) {
      seoChecks.push({ id: 'kw-alt', label: 'Keyphrase in image alt attributes', detail: 'None of the ' + images.length + ' image' + (images.length > 1 ? 's' : '') + ' use the keyphrase in alt text. Add it to the most relevant image.', severity: 'improvement' })
    } else {
      seoChecks.push({ id: 'kw-alt', label: 'Keyphrase in image alt attributes', detail: altWithKw + ' of ' + images.length + ' image' + (images.length > 1 ? 's' : '') + ' include the keyphrase in alt text. Good job!', severity: 'good' })
    }

    if (kwCount === 0) {
      seoChecks.push({ id: 'kw-density', label: 'Keyphrase density', detail: 'The keyphrase was not found in the body text. That\'s less than the recommended minimum.', severity: 'problem' })
    } else if (density < DENSITY_MIN) {
      seoChecks.push({ id: 'kw-density', label: 'Keyphrase density', detail: 'Found ' + kwCount + ' time' + (kwCount > 1 ? 's' : '') + ' (' + density.toFixed(1) + '%) — less than the recommended minimum. Focus on your keyphrase!', severity: 'problem' })
    } else if (density > DENSITY_MAX) {
      seoChecks.push({ id: 'kw-density', label: 'Keyphrase density', detail: 'Found ' + kwCount + ' times (' + density.toFixed(1) + '%) — too high. Reduce to ' + DENSITY_MIN + '–' + DENSITY_MAX + '% to avoid keyword stuffing.', severity: 'improvement' })
    } else {
      seoChecks.push({ id: 'kw-density', label: 'Keyphrase density', detail: 'Found ' + kwCount + ' times (' + density.toFixed(1) + '%). This is great!', severity: 'good' })
    }

    if (kwCount === 0) {
      seoChecks.push({ id: 'kw-dist', label: 'Keyphrase distribution', detail: 'Keyphrase not found — cannot check distribution.', severity: 'problem' })
    } else if (distributionParts === 1) {
      seoChecks.push({ id: 'kw-dist', label: 'Keyphrase distribution', detail: 'Keyphrase is concentrated in one section. Spread it more evenly throughout the content.', severity: 'improvement' })
    } else if (distributionParts === 2) {
      seoChecks.push({ id: 'kw-dist', label: 'Keyphrase distribution', detail: 'Keyphrase appears in 2 of 3 sections. Good, but try to cover all three.', severity: 'improvement' })
    } else {
      seoChecks.push({ id: 'kw-dist', label: 'Keyphrase distribution', detail: 'Keyphrase is well distributed throughout the content. Good job!', severity: 'good' })
    }

    seoChecks.push({ id: 'kw-slug', label: 'Keyphrase in slug', detail: slugHasKw ? 'More than half of your keyphrase appears in the slug. That\'s great!' : 'The slug does not contain enough keyphrase words. Consider editing the slug to include "' + kwWords.slice(0, 3).join('-') + '".', severity: slugHasKw ? 'good' : 'improvement' })
    seoChecks.push({ id: 'competing-links', label: 'Competing links', detail: competingLinks === 0 ? 'There are no links which use your keyphrase as their anchor text. Nice!' : competingLinks + ' link' + (competingLinks > 1 ? 's' : '') + ' use the keyphrase as anchor text — change the anchor text to avoid diluting its SEO value.', severity: competingLinks === 0 ? 'good' : 'improvement' })

    if (duplicates.length > 0) {
      seoChecks.push({ id: 'kw-duplicate', label: 'Previously used keyphrase', detail: 'This keyphrase is already used in: "' + duplicates.slice(0, 2).join('", "') + '"' + (duplicates.length > 2 ? ' and ' + (duplicates.length - 2) + ' more' : '') + '. Your pages will compete against each other in search results.', severity: 'problem' })
    } else {
      seoChecks.push({ id: 'kw-duplicate', label: 'Previously used keyphrase', detail: 'You\'ve not used this keyphrase before. Very good!', severity: 'good' })
    }
  }

  if (h1Count === 0 || h1Count === 1) {
    seoChecks.push({ id: 'single-h1', label: 'Single title', detail: 'You don\'t have multiple H1 headings. Well done!', severity: 'good' })
  } else {
    seoChecks.push({ id: 'single-h1', label: 'Single title', detail: 'Multiple H1 headings found (' + h1Count + '). Use only one H1 — use H2/H3 for subheadings.', severity: 'problem' })
  }

  seoChecks.push({ id: 'internal-links', label: 'Internal links', detail: internal > 0 ? internal + ' internal link' + (internal > 1 ? 's' : '') + ' found. Good job!' : 'No internal links found. Add links to other pages on ' + siteHost + '.', severity: internal > 0 ? 'good' : 'problem' })
  seoChecks.push({ id: 'outbound-links', label: 'Outbound links', detail: outbound > 0 ? outbound + ' outbound link' + (outbound > 1 ? 's' : '') + ' found. Good job!' : 'No outbound links found. Consider linking to a credible external source.', severity: outbound > 0 ? 'good' : 'problem' })
  seoChecks.push({ id: 'images', label: 'Images', detail: images.length > 0 ? images.length + ' image' + (images.length > 1 ? 's' : '') + ' found in content. Good job!' : 'No images found. Add at least one image to improve engagement.', severity: images.length > 0 ? 'good' : 'improvement' })
  seoChecks.push({ id: 'word-count', label: 'Text length', detail: words >= minWords ? 'The text contains ' + words + ' words. Good job!' : words + ' words — aim for at least ' + minWords + ' for better search visibility.', severity: words >= minWords ? 'good' : words >= 150 ? 'improvement' : 'problem' })

  // ── readability checks ────────────────────────────────────────────────────

  const readChecks: Check[] = []

  if (allSentences.length === 0) {
    readChecks.push({ id: 'sentence-length', label: 'Sentence length', detail: 'No sentences found.', severity: 'improvement' })
  } else if (longSentencePct > MAX_LONG_SENTENCE_PCT) {
    readChecks.push({ id: 'sentence-length', label: 'Sentence length', detail: longSentencePct + '% of sentences contain more than ' + MAX_SENTENCE_WORDS + ' words, which is more than the recommended maximum of ' + MAX_LONG_SENTENCE_PCT + '%. Try to shorten them.', severity: 'improvement' })
  } else {
    readChecks.push({ id: 'sentence-length', label: 'Sentence length', detail: longSentencePct + '% of sentences are longer than ' + MAX_SENTENCE_WORDS + ' words. Good job!', severity: 'good' })
  }

  if (longParas.length > 0) {
    readChecks.push({ id: 'para-length', label: 'Paragraph length', detail: longParas.length + ' paragraph' + (longParas.length > 1 ? 's are' : ' is') + ' too long (over ' + MAX_PARA_WORDS + ' words). Break them up to improve readability.', severity: 'improvement' })
  } else {
    readChecks.push({ id: 'para-length', label: 'Paragraph length', detail: 'None of your paragraphs are too long. Great job!', severity: 'good' })
  }

  if (longSections.length > 0) {
    readChecks.push({ id: 'subheading-dist', label: 'Subheading distribution', detail: longSections.length + ' section' + (longSections.length > 1 ? 's are' : ' is') + ' longer than ' + MAX_SECTION_WORDS_WITHOUT_HEADING + ' words without a subheading. Add subheadings to break it up.', severity: 'problem' })
  } else {
    readChecks.push({ id: 'subheading-dist', label: 'Subheading distribution', detail: 'Subheadings are well distributed throughout the text. Good job!', severity: 'good' })
  }

  if (maxConsecutive >= MAX_CONSECUTIVE_SAME_START) {
    readChecks.push({ id: 'consecutive', label: 'Consecutive sentences', detail: 'The text contains ' + maxConsecutive + ' or more consecutive sentences starting with the same word. Try to mix things up.', severity: 'problem' })
  } else {
    readChecks.push({ id: 'consecutive', label: 'Consecutive sentences', detail: 'No problematic consecutive sentences found. Good job!', severity: 'good' })
  }

  if (transitionPct < 20) {
    readChecks.push({ id: 'transition-words', label: 'Transition words', detail: 'Only ' + transitionPct + '% of sentences contain a transition word. Aim for at least 20% to improve flow.', severity: transitionPct < 10 ? 'problem' : 'improvement' })
  } else {
    readChecks.push({ id: 'transition-words', label: 'Transition words', detail: transitionPct + '% of sentences use transition words. Well done!', severity: 'good' })
  }

  // ── scoring ───────────────────────────────────────────────────────────────

  function groupChecks(checks: Check[]) {
    return {
      problems:     checks.filter((c) => c.severity === 'problem'),
      improvements: checks.filter((c) => c.severity === 'improvement'),
      good:         checks.filter((c) => c.severity === 'good'),
    }
  }

  function score(checks: Check[]) {
    const max = checks.length
    if (max === 0) return 0
    const raw = checks.filter((c) => c.severity === 'good').length + checks.filter((c) => c.severity === 'improvement').length * 0.5
    return Math.round((raw / max) * 100)
  }

  const seoGroups  = groupChecks(seoChecks)
  const readGroups = groupChecks(readChecks)
  const seoScore   = score(seoChecks)
  const readScore  = score(readChecks)
  const seoColor   = seoScore  >= 70 ? '#22c55e' : seoScore  >= 40 ? '#f59e0b' : '#ef4444'
  const readColor  = readScore >= 70 ? '#22c55e' : readScore >= 40 ? '#f59e0b' : '#ef4444'
  const displayTitle = metaTitle || postTitle || 'Page Title'
  const displayDesc  = metaDesc || 'No meta description set.'

  // ── render ────────────────────────────────────────────────────────────────

  const tabStyle = (t: Tab): React.CSSProperties => ({
    padding: '8px 16px', fontSize: 13,
    fontWeight: activeTab === t ? 700 : 400,
    color: activeTab === t ? '#111827' : '#6b7280',
    background: 'none', border: 'none',
    borderBottom: activeTab === t ? '2px solid #111827' : '2px solid transparent',
    cursor: 'pointer', marginBottom: -1,
  })

  return (
    <div style={{ fontFamily: 'sans-serif', padding: '16px', maxWidth: 660 }}>

      {/* Tab bar */}
      <div style={{ display: 'flex', borderBottom: '1px solid #e5e7eb', marginBottom: 20, gap: 4 }}>
        <button style={tabStyle('seo')} onClick={() => setActiveTab('seo')}>
          <ScoreFace score={seoScore} /> SEO
        </button>
        <button style={tabStyle('readability')} onClick={() => setActiveTab('readability')}>
          <ScoreFace score={readScore} /> Readability
        </button>
        <button style={tabStyle('social')} onClick={() => setActiveTab('social')}>
          <svg width="16" height="16" viewBox="0 0 24 24" style={{ verticalAlign: 'middle', marginRight: 4 }} fill="none" stroke={activeTab === 'social' ? '#111827' : '#6b7280'} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="18" cy="5" r="3" /><circle cx="6" cy="12" r="3" /><circle cx="18" cy="19" r="3" />
            <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" /><line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
          </svg>
          Social
        </button>
      </div>

      {/* ── SEO TAB ── */}
      {activeTab === 'seo' && (
        <>
          <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: 16, background: '#fff', marginBottom: 20 }}>
            <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 4 }}>{siteHost}</div>
            <div style={{ fontSize: 18, color: '#1a0dab', fontWeight: 400, lineHeight: 1.3, marginBottom: 4, overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 1, WebkitBoxOrient: 'vertical' }}>
              {displayTitle}
            </div>
            <div style={{ fontSize: 13, color: '#4d5156', lineHeight: 1.5, overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>
              {displayDesc}
            </div>
          </div>

          <div style={{ marginBottom: 20 }}>
            <div style={{ fontSize: 12, color: '#374151', marginBottom: 8 }}>
              <strong>Meta Title</strong>
              {metaTitle.length === 0 && <span style={{ color: '#f59e0b', marginLeft: 6 }}>(using post title as fallback)</span>}
              <Bar value={metaTitle.length} max={TITLE_MAX} okColor="#22c55e" />
            </div>
            <div style={{ fontSize: 12, color: '#374151' }}>
              <strong>Meta Description</strong>
              {metaDesc.length === 0 && <span style={{ color: '#f59e0b', marginLeft: 6 }}>(empty — Google will auto-generate)</span>}
              <Bar value={metaDesc.length} max={DESC_MAX} okColor="#22c55e" />
            </div>
          </div>

          {!kw && (
            <div style={{ padding: '10px 14px', background: '#fef9c3', borderRadius: 6, fontSize: 12.5, color: '#92400e', marginBottom: 16 }}>
              Enter a <strong>Focus Keyphrase</strong> in the SEO fields to enable full analysis.
            </div>
          )}

          {kw && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16, padding: '10px 14px', background: '#f9fafb', borderRadius: 8, border: '1px solid #e5e7eb' }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 4 }}>
                  SEO Analysis — <strong style={{ color: '#111827' }}>{keyword}</strong>
                  {synonyms.length > 0 && <span style={{ color: '#9ca3af' }}> + {synonyms.length} synonym{synonyms.length > 1 ? 's' : ''}</span>}
                </div>
                <div style={{ height: 8, background: '#e5e7eb', borderRadius: 4, overflow: 'hidden' }}>
                  <div style={{ width: seoScore + '%', height: '100%', background: seoColor, borderRadius: 4, transition: 'width 0.3s' }} />
                </div>
              </div>
              <span style={{ fontSize: 18, fontWeight: 700, color: seoColor }}>{seoScore}</span>
            </div>
          )}

          <Group title="Problems" checks={seoGroups.problems} defaultOpen={true} />
          <Group title="Improvements" checks={seoGroups.improvements} defaultOpen={true} />
          <Group title="Good results" checks={seoGroups.good} defaultOpen={false} />
        </>
      )}

      {/* ── READABILITY TAB ── */}
      {activeTab === 'readability' && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16, padding: '10px 14px', background: '#f9fafb', borderRadius: 8, border: '1px solid #e5e7eb' }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 4 }}>Readability Analysis</div>
              <div style={{ height: 8, background: '#e5e7eb', borderRadius: 4, overflow: 'hidden' }}>
                <div style={{ width: readScore + '%', height: '100%', background: readColor, borderRadius: 4, transition: 'width 0.3s' }} />
              </div>
            </div>
            <span style={{ fontSize: 18, fontWeight: 700, color: readColor }}>{readScore}</span>
          </div>
          <Group title="Problems" checks={readGroups.problems} defaultOpen={true} />
          <Group title="Improvements" checks={readGroups.improvements} defaultOpen={true} />
          <Group title="Good results" checks={readGroups.good} defaultOpen={false} />
        </>
      )}

      {/* ── SOCIAL TAB ── */}
      {activeTab === 'social' && (
        <>
          <div style={{ marginBottom: 24 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: '#374151', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 10 }}>Facebook / LinkedIn preview</div>
            <div style={{ border: '1px solid #ddd', borderRadius: 8, overflow: 'hidden', maxWidth: 500 }}>
              {ogImageUrl
                ? <img src={ogImageUrl} alt="OG preview" style={{ width: '100%', display: 'block', maxHeight: 260, objectFit: 'cover' }} />
                : <div style={{ background: '#f3f4f6', height: 160, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, color: '#9ca3af' }}>No OG image set — upload one in the SEO fields</div>
              }
              <div style={{ padding: '10px 14px', background: '#f0f2f5' }}>
                <div style={{ fontSize: 11, color: '#6b7280', textTransform: 'uppercase', marginBottom: 2 }}>{siteHost.toUpperCase()}</div>
                <div style={{ fontSize: 15, fontWeight: 700, color: '#1c1e21', lineHeight: 1.3, marginBottom: 4, overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>
                  {effectiveSocTitle || 'No title set'}
                </div>
                <div style={{ fontSize: 13, color: '#606770', overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>
                  {effectiveSocDesc || 'No description set'}
                </div>
              </div>
            </div>
            {!socialTitle && <p style={{ fontSize: 11, color: '#9ca3af', marginTop: 6 }}>Using meta title as fallback. Set a Social Title to override.</p>}
            {!socialDesc && <p style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>Using meta description as fallback. Set a Social Description to override.</p>}
          </div>

          <div>
            <div style={{ fontSize: 12, fontWeight: 700, color: '#374151', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 10 }}>X (Twitter) preview</div>
            <div style={{ border: '1px solid #e1e8ed', borderRadius: 14, overflow: 'hidden', maxWidth: 500, position: 'relative' }}>
              {ogImageUrl
                ? (
                  <>
                    <img src={ogImageUrl} alt="Twitter card preview" style={{ width: '100%', display: 'block', maxHeight: 260, objectFit: 'cover', objectPosition: 'top' }} />
                    <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, background: 'rgba(0,0,0,0.55)', padding: '8px 12px' }}>
                      <div style={{ fontSize: 14, fontWeight: 700, color: '#fff', lineHeight: 1.3, overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 1, WebkitBoxOrient: 'vertical' }}>
                        {effectiveSocTitle || 'No title set'}
                      </div>
                      <div style={{ fontSize: 12, color: '#d1d5db', marginTop: 2 }}>From {siteHost}</div>
                    </div>
                  </>
                )
                : (
                  <>
                    <div style={{ background: '#f7f9fa', height: 140, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, color: '#9ca3af' }}>No image set</div>
                    <div style={{ padding: '10px 14px' }}>
                      <div style={{ fontSize: 14, fontWeight: 700, color: '#14171a', lineHeight: 1.3, marginBottom: 2 }}>{effectiveSocTitle || 'No title set'}</div>
                      <div style={{ fontSize: 12, color: '#657786' }}>{siteHost}</div>
                    </div>
                  </>
                )
              }
            </div>
          </div>
        </>
      )}

    </div>
  )
}
