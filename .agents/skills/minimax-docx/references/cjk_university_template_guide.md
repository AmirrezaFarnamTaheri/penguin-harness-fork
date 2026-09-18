# Chinese University Thesis Template Guide (Chinese university thesis template guide)

## Why This Guide Exists

Chinese university thesis templates (.docx) have structural patterns that differ significantly
from Western templates. Agents that assume Western conventions (Heading1/Heading2/Normal) will
fail repeatedly. This guide documents the ACTUAL patterns found in Chinese templates.

## Common StyleId Patterns

### Pattern A: Numeric IDs (most common in Chinese Word templates)

| Style Purpose | styleId | w:name | w:basedOn |
|--------------|---------|--------|-----------|
| Normal body | `a` | "Normal" | — |
| Default paragraph font | `a0` | "Default Paragraph Font" | — |
| Heading 1 (chapter title) | `1` | "heading 1" | `a` |
| Heading 2 (section title) | `2` | "heading 2" | `a` |
| Heading 3 (subsection title) | `3` | "heading 3" | `a` |
| TOC 1 | `11` | "toc 1" | `a` |
| TOC 2 | `21` | "toc 2" | `a` |
| TOC 3 | `31` | "toc 3" | `a` |
| Header | `a3` | "header" | `a` |
| Footer | `a4` | "footer" | `a` |
| Table of Contents heading | `10` | "TOC Heading" | `1` |

### Pattern B: English IDs (less common, usually from international templates)
Standard Heading1/Heading2/Heading3/Normal — these follow the Western pattern.

### Pattern C: Mixed (some Chinese, some English)
Some templates define custom styles with Chinese names:
| Style Purpose | styleId | w:name |
|--------------|---------|--------|
| thesis title | `lunwenbiaoti` | "thesis title" |
| chapter title | `zhangbiaoti` | "chapter title" |
| body text | `zhengwen` | "body text" |

### How to Identify Which Pattern

```bash
# Extract all styleIds from the template
$CLI analyze --input template.docx --styles-only

# Or manually:
# unzip template.docx word/styles.xml
# Search for w:styleId= in the extracted file
```

Look at the first few styleIds. If you see `1`, `2`, `3`, `a`, `a0` → Pattern A.
If you see `Heading1`, `Normal` → Pattern B.

## Standard Thesis Structure

Chinese university theses follow a highly standardized structure:

```
┌─────────────────────────────────────┐
│ cover page (Cover Page)                    │  ← Usually 1-2 pages
│   - university name and emblem                       │
│   - thesis topic (title)                  │
│   - author, supervisor, department, date             │
├─────────────────────────────────────┤
│ academic integrity pledge / originality declaration            │  ← 1 page
│   (Academic Integrity Declaration)   │
├─────────────────────────────────────┤
│ Chinese abstract (Chinese Abstract)          │  ← 1-2 pages
│   - "abstract need" heading                  │
│   - Abstract body                    │
│   - "keywords:" line                  │
├─────────────────────────────────────┤
│ English abstract (English Abstract)          │  ← 1-2 pages
│   - "ABSTRACT" heading              │
│   - Abstract body                    │
│   - "Keywords:" line                 │
├─────────────────────────────────────┤
│ table of contents (Table of Contents)             │  ← 1-3 pages
│   - Often inside SDT block           │
│   - Static example entries           │
│   - TOC field code                   │
├─────────────────────────────────────┤
│ body text (Body)                          │  ← Main content
│   1chapter introduction                          │
│   1.1 research background                        │
│   1.2 research purpose and significance                   │
│   2chapter literature review                       │
│   ...                                │
│   Nchapter conclusions and outlook                     │
├─────────────────────────────────────┤
│ references (References)                │  ← Styled differently
├─────────────────────────────────────┤
│ acknowledgements (Acknowledgments)              │  ← Optional
├─────────────────────────────────────┤
│ appendix (Appendices)                    │  ← Optional
└─────────────────────────────────────┘
```

## Identifying Zone Boundaries in Templates

Templates contain EXAMPLE content that must be replaced. Here's how to find the zones:

### Zone A (Front matter) — KEEP from template
- Starts at: paragraph 0
- Ends at: the paragraph BEFORE the first chapter heading
- Contains: cover, declaration, abstracts, TOC
- How to detect end: search for first paragraph with style `1` (or Heading1) containing "1chapter" or "introduction"

### Zone B (Body content) — REPLACE with user content
- Starts at: first chapter heading ("1chapter...")
- Ends at: "references" heading (inclusive) or last body paragraph before acknowledgments
- How to detect:
  ```python
  for i, el in enumerate(body_elements):
      text = get_text(el)
      style = get_style(el)
      if style in ('1', 'Heading1') and ('1chapter' in text or 'introduction' in text):
          zone_b_start = i
      if 'references' in text:
          zone_b_end = i
  ```

### Zone C (Back matter) — KEEP from template (or remove)
- Starts after: references
- Contains: acknowledgements, appendix, final sectPr

## Font Expectations in Chinese Thesis Templates

| Element | Font | Size (font size) | Size (pt) | w:sz |
|---------|------|------------|-----------|------|
| thesis title | STZhongsong or SimHei | size 2 or small size 2 | 22pt or 18pt | 44 or 36 |
| chapter title (H1) | SimHei | size 3 | 16pt | 32 |
| section title (H2) | SimHei | size 4 | 14pt | 28 |
| subsection title (H3) | SimHei | small size 4 | 12pt | 24 |
| body text | SimSun | small size 4 | 12pt | 24 |
| header | SimSun | size 5 | 10.5pt | 21 |
| footer/page number | SimSun | size 5 | 10.5pt | 21 |
| table content | SimSun | size 5 | 10.5pt | 21 |
| references | SimSun | size 5 | 10.5pt | 21 |

## RunFonts for CJK Body Text

```xml
<w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman"
          w:eastAsia="SimSun" w:cs="Times New Roman"/>
```

For headings:
```xml
<w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman"
          w:eastAsia="SimHei" w:cs="Times New Roman"/>
```

IMPORTANT: When cleaning direct formatting, ALWAYS preserve w:eastAsia.
Removing it causes Chinese text to fall back to the wrong font.

## Common Mistakes with Chinese Templates

1. **Searching for `Heading1`** — Chinese templates use `1`, not `Heading1`
2. **Clearing all rFonts** — Must keep eastAsia font declarations
3. **Assuming "1chapter" is the first paragraph** — It's typically paragraph 100+ after cover/abstract/TOC
4. **Ignoring SDT blocks in TOC** — The TOC is wrapped in an SDT, not just field codes
5. **Wrong line spacing** — Chinese theses typically use fixed 20pt (line="400") or 22pt (line="440"), not the 28pt used in government documents
6. **Missing section breaks** — Each zone (abstract, TOC, body) usually has its own sectPr for different headers/footers

## Style Mapping Quick Reference

When source document uses Western IDs and template uses Chinese numeric IDs:

```json
{
  "Heading1": "1",
  "Heading2": "2",
  "Heading3": "3",
  "Heading4": "3",
  "Normal": "a",
  "BodyText": "a",
  "ListParagraph": "a",
  "Caption": "a",
  "TOC1": "11",
  "TOC2": "21",
  "TOC3": "31"
}
```

When source uses Chinese numeric IDs and template uses Western IDs — reverse the mapping.
