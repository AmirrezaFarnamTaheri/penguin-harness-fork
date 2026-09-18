# CJK Typography & Mixed-Script Guide

Rules for Chinese, Japanese, and Korean text in DOCX documents.

## Table of Contents

1. [Font Selection](#font-selection)
2. [Font Size Names (CJK)](#font-size-names)
3. [RunFonts Mapping](#runfonts-mapping)
4. [Punctuation & Line Breaking](#punctuation--line-breaking)
5. [Paragraph Indentation](#paragraph-indentation)
6. [Line Spacing for CJK](#line-spacing)
7. [Chinese Government Standard (GB/T 9704)](#gbt-9704)
8. [Mixed CJK + Latin Best Practices](#mixed-script)
9. [OpenXML Quick Reference](#openxml-quick-reference)

---

## Font Selection

### Recommended CJK Fonts

| Language | Serif (body text) | Sans (title) | Notes |
|----------|-------------|-------------|-------|
| **Simplified Chinese** | SimSun (SimSun) | Microsoft YaHei (Microsoft YaHei) | YaHei for screen, SimSun for print |
| **Simplified Chinese** | FangSong (FangSong) | SimHei (SimHei) | Government documents |
| **Traditional Chinese** | PMingLiU (PMingLiU) | Microsoft JhengHei (Microsoft JhengHei) | Taiwan standard |
| **Japanese** | MS Mincho (MS Mincho) | MS ゴシック (MS Gothic) | Classic pairing |
| **Japanese** | Yu Mincho (Yu Mincho) | gameゴシック (Yu Gothic) | Modern, Windows 10+ |
| **Korean** | 바탕 (Batang) | 맑은 고딕 (Malgun Gothic) | Standard pairing |

### Government Document Fonts ()

| Element | Font | Size |
|---------|------|------|
| title (title) | STSong small (FZXiaoBiaoSong-B05S) | size 2 (22pt) |
| level 1 heading | SimHei (SimHei) | size 3 (16pt) |
| level 2 heading | KaiTi_GB2312 (KaiTi_GB2312) | size 3 (16pt) |
| level 3 heading | FangSong_GB2312 bold | size 3 (16pt) |
| body text (body) | FangSong_GB2312 (FangSong_GB2312) | size 3 (16pt) |
| annotation/page number | SimSun (SimSun) | size 4 (14pt) |

---

## Font Size Names

CJK uses named sizes. Map to points and `w:sz` half-point values:

| font size | Points | `w:sz` | Common Use |
|------|--------|--------|------------|
| size 0 | 42pt | 84 | Display title |
| small size 0 | 36pt | 72 | Large title |
| size 1 | 26pt | 52 | Chapter heading |
| small size 1 | 24pt | 48 | Major heading |
| size 2 | 22pt | 44 | Document title () |
| small size 2 | 18pt | 36 | Western H1 equivalent |
| size 3 | 16pt | 32 | CJK heading /  body |
| small size 3 | 15pt | 30 | Sub-heading |
| size 4 | 14pt | 28 | CJK subheading |
| small size 4 | 12pt | 24 | Standard body (CJK) |
| size 5 | 10.5pt | 21 | Compact CJK body |
| small size 5 | 9pt | 18 | Footnotes |
| size 6 | 7.5pt | 15 | Fine print |

---

## RunFonts Mapping

OpenXML uses four font slots to handle multilingual text:

```xml
<w:rFonts
  w:ascii="Calibri"        <!-- Latin characters (U+0000–U+007F) -->
  w:hAnsi="Calibri"        <!-- Latin extended, Greek, Cyrillic -->
  w:eastAsia="SimSun"      <!-- CJK Unified Ideographs, Kana, Hangul -->
  w:cs="Arial"             <!-- Arabic, Hebrew, Thai, Devanagari -->
/>
```

**Word's character classification logic:**

1. Character is in CJK range → uses `w:eastAsia` font
2. Character is in complex script range → uses `w:cs` font
3. Character is basic Latin (ASCII) → uses `w:ascii` font
4. Everything else → uses `w:hAnsi` font

**Key**: `w:eastAsia` is the **only** way to set CJK fonts. Setting just `w:ascii` will NOT affect CJK characters. Mixed text within a single run auto-switches fonts at the character level — no need for separate runs.

### Document Defaults

```xml
<w:docDefaults>
  <w:rPrDefault>
    <w:rPr>
      <w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="SimSun" w:cs="Arial" />
      <w:sz w:val="22" />
      <w:szCs w:val="22" />
      <w:lang w:val="en-US" w:eastAsia="zh-CN" />
    </w:rPr>
  </w:rPrDefault>
</w:docDefaults>
```

`w:lang w:eastAsia` helps Word resolve ambiguous characters (e.g., punctuation shared between CJK and Latin).

---

## Punctuation & Line Breaking

### Full-Width vs Half-Width

CJK text uses full-width punctuation:

| Type | CJK | Latin |
|------|-----|-------|
| Period | .(U+3002) | . |
| Comma | ,(U+FF0C) ,(U+3001) | , |
| Colon | :(U+FF1A) | : |
| Semicolon | ;(U+FF1B) | ; |
| Quotes | ""'' or ""'' | "" '' |
| Parentheses | ()(U+FF08/09) | () |

In mixed text, use the punctuation style of the **surrounding language context**.

### OpenXML Controls

```xml
<w:pPr>
  <w:adjustRightInd w:val="true" />   <!-- Adjust right indent for CJK punctuation -->
  <w:snapToGrid w:val="true" />        <!-- Align to document grid -->
  <w:kinsoku w:val="true" />           <!-- Enable CJK line breaking rules -->
  <w:overflowPunct w:val="true" />     <!-- Allow punctuation to overflow margins -->
</w:pPr>
```

### Kinsoku Rules (line-breaking rules)

Prevents certain characters from appearing at the start or end of a line:
- **Cannot start a line**: `)"']>".,,!?;:` and closing brackets
- **Cannot end a line**: `("'[<"` and opening brackets

Word applies these automatically when `w:kinsoku` is enabled.

### Line Breaking

- CJK characters can break between **any two characters** (no word boundaries needed)
- Latin words within CJK text still follow word-boundary breaking
- `w:wordWrap w:val="false"` enables CJK-style breaking (break anywhere)

---

## Paragraph Indentation

### Chinese Standard: 2-Character Indent

Chinese body text conventionally uses a 2-character first-line indent:

```xml
<w:ind w:firstLineChars="200" />  <!-- 200 = 2 characters × 100 -->
```

Preferred over `w:firstLine` with fixed DXA because `firstLineChars` scales with font size.

| Indent | Value |
|--------|-------|
| 1 character | `w:firstLineChars="100"` |
| 2 characters | `w:firstLineChars="200"` |
| 3 characters | `w:firstLineChars="300"` |

---

## Line Spacing

- CJK characters are taller than Latin characters at the same point size
- Default `1.0` line spacing may feel cramped with CJK text
- Recommended: `1.15–1.5` for mixed CJK+Latin, `1.0` with fixed 28pt for 

### Auto Spacing

```xml
<w:pPr>
  <w:autoSpaceDE w:val="true"/>  <!-- auto space between CJK and Latin -->
  <w:autoSpaceDN w:val="true"/>  <!-- auto space between CJK and numbers -->
</w:pPr>
```

Adds ~¼ em spacing between CJK and non-CJK characters automatically. **Recommended: always enable.**

---

## GB/T 9704

Chinese government document standard (Party and government official document format). These are **strict requirements**, not suggestions.

### Page Setup

| Parameter | Value | OpenXML |
|-----------|-------|---------|
| Page size | A4 (210×297mm) | Width=11906, Height=16838 |
| Top margin | 37mm | 2098 DXA |
| Bottom margin | 35mm | 1984 DXA |
| Left margin | 28mm | 1588 DXA |
| Right margin | 26mm | 1474 DXA |
| Characters/line | 28 | |
| Lines/page | 22 | |
| Line spacing | Fixed 28pt | `line="560"` lineRule="exact" |

### Document Structure

```
┌─────────────────────────────────┐
│     issuing authority emblem (red header)           │  ← STSong small or large red text
│     ══════════════════ (red rule)    │  ← Red #FF0000, 2pt
├─────────────────────────────────┤
│  document dispatch number: Xdispatched by machine(2025)Xsize      │  ← FangSong size 3, centered
│                                 │
│  title (Title)                   │  ← STSong small size 2, centered
│                                 │     may span multiple lines,centered when wrapped
│  primary recipient authority:                      │  ← FangSong size 3
│                                 │
│  body text (Body)...                 │  ← FangSong_GB2312 size 3
│  1. level 1 heading                    │  ← SimHei size 3
│  (1)level 2 heading                  │  ← KaiTi size 3
│  1. level 3 heading                    │  ← FangSong size 3 bold
│  (1) level 4 heading                   │  ← FangSong size 3
│                                 │
│  appendix: 1. xxx                   │  ← FangSong size 3
│                                 │
│  issuing authority signature                    │  ← FangSong size 3
│  date of issuance                       │  ← FangSong size 3, lowercase Chinese numerals
├─────────────────────────────────┤
│  ══════════════════ (edition record rule)     │
│  carbon copy: xxx                      │  ← FangSong size 4
│  issuing authority and date                   │  ← FangSong size 4
└─────────────────────────────────┘
```

### Numbering System

```
1.         ← SimHei (SimHei), no indentation
(1)      ← KaiTi (KaiTi), indented 2 chars
1.          ← FangSong bold (FangSong Bold), indented 2 chars
(1)         ← FangSong (FangSong), indented 2 chars
```

### Colors

| Element | Color | Requirement |
|---------|-------|-------------|
| All body text | Black #000000 | Mandatory |
| red header (agency name) | Red #FF0000 | Mandatory |
| red rule (separator) | Red #FF0000 | Mandatory |
| official seal (official seal) | Red | Mandatory |

### Page Numbers

- Position: bottom center
- Format: `-X-` (dash-number-dash)
- Font: SimSun size 4 (SimSun 14pt, `sz="28"`)
- No page number on cover page if present

---

## Mixed Script

### Font Size Harmony

CJK characters appear larger than Latin characters at the same point size. Compensation:

- If body is Calibri 11pt, pair with CJK at 11pt (same size — CJK looks slightly larger but acceptable)
- If precise visual match needed, CJK can be set 0.5–1pt smaller
- In practice, same point size is standard — don't over-optimize

### Bold and Italic

- **Chinese/Japanese have no true italic.** Word synthesizes a slant which looks poor
- Use **bold** for emphasis in CJK text
- Use emphasis mark (emphasis dots) for traditional emphasis: `<w:em w:val="dot"/>` on RunProperties

---

## OpenXML Quick Reference

### Set EastAsia Font (C#)

```csharp
new Run(
    new RunProperties(
        new RunFonts { EastAsia = "SimSun", Ascii = "Calibri", HighAnsi = "Calibri" },
        new FontSize { Val = "32" }  // size 3 = 16pt = sz 32
    ),
    new Text("this is body content")
);
```

### Document Defaults (C#)

```csharp
new DocDefaults(new RunPropertiesDefault(new RunPropertiesBaseStyle(
    new RunFonts {
        Ascii = "Calibri", HighAnsi = "Calibri",
        EastAsia = "Microsoft YaHei"
    },
    new Languages { Val = "en-US", EastAsia = "zh-CN" }
)));
```

###  Style Definitions (C#)

```csharp
// Title style — STSong small size 2 centered
new Style(
    new StyleName { Val = "GongWen Title" },
    new BasedOn { Val = "Normal" },
    new StyleRunProperties(
        new RunFonts { EastAsia = "FZXiaoBiaoSong-B05S" },
        new FontSize { Val = "44" },  // size 2 = 22pt
        new Bold()
    ),
    new StyleParagraphProperties(
        new Justification { Val = JustificationValues.Center },
        new SpacingBetweenLines { Line = "560", LineRule = LineSpacingRuleValues.Exact }
    )
) { Type = StyleValues.Paragraph, StyleId = "GongWenTitle" };

// Body style — FangSong_GB2312 size 3
new Style(
    new StyleName { Val = "GongWen Body" },
    new StyleRunProperties(
        new RunFonts { EastAsia = "FangSong_GB2312", Ascii = "FangSong_GB2312" },
        new FontSize { Val = "32" }  // size 3 = 16pt
    ),
    new StyleParagraphProperties(
        new SpacingBetweenLines { Line = "560", LineRule = LineSpacingRuleValues.Exact }
    )
) { Type = StyleValues.Paragraph, StyleId = "GongWenBody" };
```

### Emphasis Dots (emphasis mark)

```csharp
new RunProperties(new Emphasis { Val = EmphasisMarkValues.Dot });
```

### East Asian Text Layout

```xml
<!-- Snap to grid (align CJK chars to character grid) -->
<w:snapToGrid w:val="true"/>

<!-- Two-lines-in-one (two lines merged into one) -->
<w:eastAsianLayout w:id="1" w:combine="true"/>

<!-- Vertical text in a cell -->
<w:textDirection w:val="tbRl"/>
```
