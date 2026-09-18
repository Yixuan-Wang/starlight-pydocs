/**
 * Pre-rendered docstring prose: the sidecar structure, and the pure logic that
 * decides what goes into it.
 *
 * Docstring Markdown is rendered once, at `astro:config:done`, through the
 * host's configured markdown processor, because that processor only exists in
 * the config-time process (ARCHITECTURE.md decision 7). The HTML lands in a JSON sidecar
 * beside the cached dump, and components read strings out of it. Nothing here
 * imports a markdown engine: `collectDocstringMarkdown` says what needs
 * rendering, `assembleRenderedDocstrings` puts the results back in their places,
 * and the accessors read them at render time.
 *
 * Keys are **canonical** object paths, the paths griffe uses in the dump. A
 * re-exported or inherited member is documented at a different path but shares
 * the definition's prose, so components look up `doc.canonicalPath`.
 */

import { prepareDoctestMarkdown } from './markdown.ts';
import type { PageHeading, PageModel } from './model.ts';
import type {
  DocstringSection,
  DocstringSectionAdmonition,
  DocstringSectionDeprecated,
  DocstringSectionExamples,
  DocstringSectionNamedValues,
  DocstringSectionReferences,
  DocstringSectionText,
  DocstringSectionThrown,
  GriffeDump,
  GriffeObject,
} from './types.ts';
import { memberList } from './types.ts';

/** Where one rendered string belongs inside a section. */
export type DocstringSlot = 'body' | 'entry' | 'block' | 'deprecated';

/** One Markdown string to render, and where its HTML belongs. */
export interface DocstringMarkdownItem {
  /** Canonical dotted path of the object the prose belongs to. */
  objectPath: string;
  /** Index into the object's parsed sections; -1 for a deprecation description. */
  sectionIndex: number;
  slot: DocstringSlot;
  /** Index inside the slot's collection: the entry or example block. */
  index: number;
  markdown: string;
  /**
   * Keep the heading metadata the renderer produced for this string. Only a
   * `text` section's own prose feeds the page's table of contents: an
   * admonition's body renders through the same `body` slot but its headings
   * are internal to the aside, not page structure.
   */
  wantsHeadings: boolean;
}

/** One string's rendered HTML, and the headings it introduced (if any were asked for). */
export interface DocstringRenderResult {
  html: string;
  headings: PageHeading[];
}

export interface RenderedSection {
  /** A text section's prose, or an admonition's contents. */
  body?: string;
  /** HTML per entry of a parameters/returns/raises-style section, keyed by index. */
  entries?: Record<string, string>;
  /** HTML per example block, keyed by index. */
  blocks?: Record<string, string>;
}

export interface RenderedObject {
  /** Rendered sections, keyed by their index in the parsed docstring. */
  sections?: Record<string, RenderedSection>;
  /** Rendered deprecation description. */
  deprecated?: string;
  /**
   * Headings the object's own docstring text introduced, in docstring order.
   * Only `mergeDocstringHeadings` reads this, for a module's own page ToC.
   */
  headings?: PageHeading[];
}

export interface RenderedDocstrings {
  objects: Record<string, RenderedObject>;
}

export const EMPTY_RENDERED_DOCSTRINGS: RenderedDocstrings = { objects: {} };

/** Section kinds whose `value` is a list of `{ description }` entries. */
const ENTRY_SECTION_KINDS = new Set([
  'parameters',
  'other parameters',
  'type parameters',
  'attributes',
  'returns',
  'yields',
  'receives',
  'raises',
  'warns',
  'functions',
  'classes',
  'modules',
  'type aliases',
]);

type EntrySection = DocstringSectionNamedValues | DocstringSectionThrown | DocstringSectionReferences;

/**
 * Every Markdown string in a dump that needs rendering.
 *
 * The whole dump, not the filtered model: `<Autodoc>` can name anything, and the
 * sidecar is built before any model options are known.
 */
export function collectDocstringMarkdown(dump: GriffeDump): DocstringMarkdownItem[] {
  const items: DocstringMarkdownItem[] = [];
  const seen = new Set<string>();

  const visit = (object: GriffeObject): void => {
    if (typeof object?.path !== 'string' || seen.has(object.path)) return;
    seen.add(object.path);

    const sections = object.docstring?.parsed ?? [];
    sections.forEach((section, sectionIndex) => {
      collectSection(object.path, section, sectionIndex, items);
    });

    for (const member of memberList(object)) visit(member);
  };

  for (const entry of Object.values(dump)) visit(entry);
  return items;
}

function push(items: DocstringMarkdownItem[], item: DocstringMarkdownItem): void {
  if (item.markdown.trim() !== '') items.push(item);
}

function collectSection(
  objectPath: string,
  section: DocstringSection,
  sectionIndex: number,
  items: DocstringMarkdownItem[],
): void {
  if (section.kind === 'text') {
    push(items, {
      objectPath,
      sectionIndex,
      slot: 'body',
      index: 0,
      markdown: (section as DocstringSectionText).value ?? '',
      wantsHeadings: true,
    });
    return;
  }

  if (ENTRY_SECTION_KINDS.has(section.kind)) {
    const entries = (section as EntrySection).value;
    if (!Array.isArray(entries)) return;
    entries.forEach((entry, index) => {
      push(items, {
        objectPath,
        sectionIndex,
        slot: 'entry',
        index,
        markdown: entry.description ?? '',
        wantsHeadings: false,
      });
    });
    return;
  }

  if (section.kind === 'examples') {
    const pairs = (section as DocstringSectionExamples).value;
    if (!Array.isArray(pairs)) return;
    pairs.forEach(([kind, value], index) => {
      if (typeof value !== 'string') return;
      // Prose arrives as `text`; a doctest transcript arrives unfenced.
      push(items, {
        objectPath,
        sectionIndex,
        slot: 'block',
        index,
        markdown: kind === 'text' ? value : prepareDoctestMarkdown(value),
        wantsHeadings: false,
      });
    });
    return;
  }

  if (section.kind === 'admonition') {
    const value = (section as DocstringSectionAdmonition).value;
    // A google-style `Deprecated:` block parses as an admonition
    // (ARCHITECTURE.md, griffe field notes); its prose belongs to the
    // deprecation notice, not to an aside.
    const slot: DocstringSlot = value?.annotation === 'deprecated' ? 'deprecated' : 'body';
    push(items, {
      objectPath,
      sectionIndex: slot === 'deprecated' ? -1 : sectionIndex,
      slot,
      index: 0,
      markdown: value?.description ?? '',
      // An admonition's own headings are internal to the aside, never page
      // structure, even though it shares the `body` slot with a text section.
      wantsHeadings: false,
    });
    return;
  }

  if (section.kind === 'deprecated') {
    const value = (section as DocstringSectionDeprecated).value;
    push(items, {
      objectPath,
      sectionIndex: -1,
      slot: 'deprecated',
      index: 0,
      markdown: value?.description ?? '',
      wantsHeadings: false,
    });
  }
}

/**
 * Put rendered HTML back where it belongs.
 *
 * @param items - What `collectDocstringMarkdown` returned.
 * @param renders - The rendered result of each item, in the same order.
 */
export function assembleRenderedDocstrings(
  items: DocstringMarkdownItem[],
  renders: DocstringRenderResult[],
): RenderedDocstrings {
  const objects: Record<string, RenderedObject> = {};

  items.forEach((item, index) => {
    const render = renders[index];
    if (render === undefined || render.html === '') return;

    const object = (objects[item.objectPath] ??= {});
    if (item.wantsHeadings && render.headings.length > 0) {
      // A docstring can carry several `text` sections (interleaved with
      // parameters, returns, …); their headings concatenate in docstring
      // order, matching the order `collectDocstringMarkdown` visited them in.
      object.headings = [...(object.headings ?? []), ...render.headings];
    }

    if (item.slot === 'deprecated') {
      object.deprecated = render.html;
      return;
    }

    const sections = (object.sections ??= {});
    const section = (sections[String(item.sectionIndex)] ??= {});
    if (item.slot === 'body') {
      section.body = render.html;
      return;
    }
    const bucket = item.slot === 'entry' ? (section.entries ??= {}) : (section.blocks ??= {});
    bucket[String(item.index)] = render.html;
  });

  return { objects };
}

// -- Accessors -------------------------------------------------------------

function sectionOf(
  rendered: RenderedDocstrings,
  objectPath: string,
  sectionIndex: number,
): RenderedSection | undefined {
  return rendered.objects[objectPath]?.sections?.[String(sectionIndex)];
}

/** Rendered prose of a text section or the contents of an admonition. */
export function renderedSectionBody(rendered: RenderedDocstrings, objectPath: string, sectionIndex: number): string {
  return sectionOf(rendered, objectPath, sectionIndex)?.body ?? '';
}

/** Rendered description of one entry of a parameters/returns/raises-style section. */
export function renderedSectionEntry(
  rendered: RenderedDocstrings,
  objectPath: string,
  sectionIndex: number,
  entryIndex: number,
): string {
  return sectionOf(rendered, objectPath, sectionIndex)?.entries?.[String(entryIndex)] ?? '';
}

/** Rendered HTML of one block of an examples section. */
export function renderedSectionBlock(
  rendered: RenderedDocstrings,
  objectPath: string,
  sectionIndex: number,
  blockIndex: number,
): string {
  return sectionOf(rendered, objectPath, sectionIndex)?.blocks?.[String(blockIndex)] ?? '';
}

/** Rendered deprecation description, from a `deprecated` section or admonition. */
export function renderedDeprecation(rendered: RenderedDocstrings, objectPath: string): string {
  return rendered.objects[objectPath]?.deprecated ?? '';
}

/** Headings an object's own docstring text introduced, in docstring order. */
export function docstringHeadings(rendered: RenderedDocstrings, objectPath: string): PageHeading[] {
  return rendered.objects[objectPath]?.headings ?? [];
}

/**
 * A page's table of contents, docstring headings first.
 *
 * `pageHeadings` (`lib/model.ts`) only ever saw the member surface: it is
 * computed in the model, before any docstring Markdown is rendered. This adds
 * whatever headings the module's own docstring prose introduced, ahead of the
 * member headings, matching the order `ModuleDoc` actually renders them in
 * (docstring first, then members). Nothing here re-slugs anything: the
 * headings came from the same render that produced the HTML `id`s, so the
 * slugs already agree with the page.
 */
export function mergeDocstringHeadings(page: PageModel, rendered: RenderedDocstrings): PageHeading[] {
  const prose = docstringHeadings(rendered, page.object.canonicalPath);
  return prose.length === 0 ? page.headings : [...prose, ...page.headings];
}
