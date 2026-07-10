# sanity-plugin-seo-analyser

A Yoast-style SEO analyser view for Sanity Studio v3, v4, and v5. Adds a dedicated **SEO Analysis** tab to any document type with three panels: SEO, Readability, and Social preview.

## Features

- **SEO tab** — keyphrase checks (title, meta description, introduction, subheadings, image alts, density, distribution, slug, competing links), duplicate keyphrase detection across documents, internal/outbound link counts, word count, SERP preview
- **Readability tab** — sentence length, paragraph length, subheading distribution, consecutive sentences, transition word usage
- **Social tab** — Facebook/LinkedIn OG preview and X (Twitter) card preview with actual image rendering
- Fully recursive text extraction — works with standard Portable Text blocks and any custom block types
- Configurable field names, document types, word count threshold, and custom block text keys
- Works with Sanity v3, v4, and v5

---

## Installation

```bash
npm install sanity-plugin-seo-analyser
```

---

## Requirements

Your document schema needs an `seo` object field with these sub-fields (field names are configurable):

```ts
// Minimum required seo fields
{
  focusKeyword: string       // the keyphrase to analyse
  synonyms: string           // comma-separated synonyms (optional)
  metaTitle: string
  metaDescription: string
  ogImage: image
  socialTitle: string        // optional override for OG title
  socialDescription: string  // optional override for OG description
}
```

The document also needs:
- `title` — string
- `slug` — slug field (`{ current: string }`)
- `content` — Portable Text array

All field names are configurable if yours differ (see [Config options](#config-options)).

---

## Usage

In your `sanity.config.ts`, use `createSeoAnalyser` to create the view component, then add it as a Studio view:

```ts
import { defineConfig } from 'sanity'
import { structureTool } from 'sanity/structure'
import { createSeoAnalyser } from 'sanity-plugin-seo-analyser'

const SeoAnalyser = createSeoAnalyser({
  siteHost: 'yoursite.com',
  documentTypes: ['post', 'article'],
})

export default defineConfig({
  // ...
  plugins: [
    structureTool({
      structure: (S) =>
        S.list()
          .title('Content')
          .items([
            S.listItem().title('Blog Posts').schemaType('post').child(
              S.documentTypeList('post').child((id) =>
                S.document().documentId(id).schemaType('post').views([
                  S.view.form().title('Content'),
                  S.view.component(SeoAnalyser).title('SEO Analysis'),
                ])
              )
            ),
          ]),
    }),
  ],
})
```

---

## Config options

| Option | Type | Default | Description |
|---|---|---|---|
| `siteHost` | `string` | **required** | Your domain, e.g. `"example.com"`. Used to classify internal vs outbound links. |
| `documentTypes` | `string[]` | `[]` | Document types to search when checking for duplicate keyphrases, e.g. `["post", "article"]`. |
| `seoFieldName` | `string` | `"seo"` | Field name of the SEO object on your document. |
| `contentFieldName` | `string` | `"content"` | Field name of your Portable Text array. |
| `titleFieldName` | `string` | `"title"` | Field name of the document title. |
| `slugFieldName` | `string` | `"slug"` | Field name of the slug object. |
| `minWords` | `number` | `300` | Minimum recommended word count before a warning is shown. |
| `extraTextKeys` | `string[]` | `[]` | Additional string field names to extract text from inside custom block types (merged with built-in defaults). |
| `extraStringArrayKeys` | `string[]` | `[]` | Additional array-of-strings field names to extract from custom block types. |

### Example with all options

```ts
const SeoAnalyser = createSeoAnalyser({
  siteHost: 'example.com',
  documentTypes: ['post', 'caseStudy', 'article'],
  seoFieldName: 'seo',
  contentFieldName: 'body',
  titleFieldName: 'heading',
  slugFieldName: 'slug',
  minWords: 500,
  extraTextKeys: ['subtitle', 'pullQuote'],
  extraStringArrayKeys: ['bulletPoints'],
})
```

---

## Custom block types

The analyser recursively extracts text from any block type. By default it reads these field names: `heading`, `subheading`, `title`, `description`, `text`, `quote`, `question`, `answer`, `label`, `value`, `leftHeading`, `rightHeading`, `caption`, `authorName`, `authorTitle`, `authorOrg`.

If your custom blocks use different field names, pass them via `extraTextKeys`:

```ts
const SeoAnalyser = createSeoAnalyser({
  siteHost: 'example.com',
  extraTextKeys: ['summary', 'pullQuote', 'tagline'],
})
```

---

## SEO checks performed

| Check | Description |
|---|---|
| Keyphrase length | Warns if keyphrase is longer than 6 words |
| Keyphrase in SEO title | Checks presence and position (beginning = best) |
| Keyphrase in meta description | Checks keyphrase or synonym presence |
| Keyphrase in introduction | Checks first paragraph |
| Keyphrase in subheadings | Checks H2/H3 headings |
| Keyphrase in image alts | Checks alt text across all images |
| Keyphrase density | Flags if below 0.5% or above 3% |
| Keyphrase distribution | Checks if keyphrase appears in all thirds of the content |
| Keyphrase in slug | Checks if slug contains keyphrase words |
| Competing links | Flags anchor text that uses the keyphrase |
| Previously used keyphrase | Live GROQ query to detect keyword cannibalization |
| Single H1 | Warns if multiple H1 headings exist |
| Internal links | Counts links to your own domain |
| Outbound links | Counts links to external sites |
| Images | Checks at least one image exists |
| Text length | Warns if below minimum word count |

## Readability checks performed

| Check | Description |
|---|---|
| Sentence length | Flags if more than 25% of sentences exceed 20 words |
| Paragraph length | Flags paragraphs over 150 words |
| Subheading distribution | Flags sections over 300 words without a subheading |
| Consecutive sentences | Flags 3+ consecutive sentences starting with the same word |
| Transition words | Flags if fewer than 20% of sentences use transition words |

---

## License

MIT
