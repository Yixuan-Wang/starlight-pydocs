import { describe, expect, test } from 'vitest';

import type { DocstringMarkdownItem, DocstringRenderResult } from '../lib/docstrings.ts';
import {
  assembleRenderedDocstrings,
  collectDocstringMarkdown,
  docstringHeadings,
  mergeDocstringHeadings,
  renderedDeprecation,
  renderedSectionBlock,
  renderedSectionBody,
  renderedSectionEntry,
} from '../lib/docstrings.ts';
import type { PageHeading, PageModel } from '../lib/model.ts';
import type { GriffeDump } from '../lib/types.ts';
import { loadFixtureDump } from './helpers.ts';

function itemsFor(items: DocstringMarkdownItem[], objectPath: string): DocstringMarkdownItem[] {
  return items.filter((item) => item.objectPath === objectPath);
}

describe('collectDocstringMarkdown', () => {
  test('collects every prose string of the fixture package', async () => {
    const items = collectDocstringMarkdown(await loadFixtureDump('demopkg'));
    expect(items.length).toBeGreaterThan(20);
    // Private members are in the dump too: `<Autodoc>` may name anything, so
    // collection is deliberately unfiltered.
    expect(items.some((item) => item.objectPath.startsWith('demopkg._internal'))).toBe(true);
  });

  test('collects the text body of a section', async () => {
    const items = collectDocstringMarkdown(await loadFixtureDump('demopkg'));
    const body = itemsFor(items, 'demopkg.report.Report.generate').find((item) => item.slot === 'body');
    expect(body?.markdown).toContain('Render the report');
  });

  test('collects parameter descriptions as entries, indexed in order', async () => {
    const items = collectDocstringMarkdown(await loadFixtureDump('demopkg'));
    const entries = itemsFor(items, 'demopkg.report.generate_report').filter((item) => item.slot === 'entry');
    expect(entries.length).toBeGreaterThanOrEqual(4);
    // Indices are per section, so `parameters` numbers its own entries 0, 1, 2.
    const parameters = entries.filter((entry) => entry.sectionIndex === entries[0]?.sectionIndex);
    expect(parameters.map((entry) => entry.index)).toEqual([...parameters.keys()]);
  });

  test('fences doctest example blocks and leaves prose pairs alone', async () => {
    const items = collectDocstringMarkdown(await loadFixtureDump('demopkg'));
    const blocks = itemsFor(items, 'demopkg').filter((item) => item.slot === 'block');
    expect(blocks.length).toBeGreaterThan(0);
    expect(blocks.some((block) => block.markdown.startsWith('```python\n>>>'))).toBe(true);
    expect(blocks.some((block) => !block.markdown.startsWith('```'))).toBe(true);
  });

  test('routes a Deprecated admonition to the deprecation slot', async () => {
    const items = collectDocstringMarkdown(await loadFixtureDump('demopkg'));
    const deprecated = itemsFor(items, 'demopkg.report.old_generate').filter((item) => item.slot === 'deprecated');
    expect(deprecated).toHaveLength(1);
    expect(deprecated[0]?.sectionIndex).toBe(-1);
    expect(deprecated[0]?.markdown).toContain('Since 0.3');
  });

  test('keeps admonition prose as a body', async () => {
    const items = collectDocstringMarkdown(await loadFixtureDump('demopkg'));
    const note = itemsFor(items, 'demopkg.report.Report.generate').filter((item) => item.slot === 'body');
    expect(note.length).toBeGreaterThan(1);
  });

  test('skips blank strings', () => {
    const dump: GriffeDump = {
      pkg: {
        kind: 'module',
        name: 'pkg',
        path: 'pkg',
        docstring: { value: '', parsed: [{ kind: 'text', value: '   ' }] },
      },
    };
    expect(collectDocstringMarkdown(dump)).toEqual([]);
  });

  test('visits each object once', () => {
    const dump: GriffeDump = {
      pkg: {
        kind: 'module',
        name: 'pkg',
        path: 'pkg',
        docstring: { value: 'x', parsed: [{ kind: 'text', value: 'one' }] },
        members: {
          child: {
            kind: 'attribute',
            name: 'child',
            path: 'pkg.child',
            docstring: { value: 'y', parsed: [{ kind: 'text', value: 'two' }] },
          },
        },
      },
      'pkg.child': {
        kind: 'attribute',
        name: 'child',
        path: 'pkg.child',
        docstring: { value: 'y', parsed: [{ kind: 'text', value: 'two' }] },
      },
    };
    expect(collectDocstringMarkdown(dump)).toHaveLength(2);
  });
});

/** A render result with no headings, for items that never ask for them. */
function html(value: string): DocstringRenderResult {
  return { html: value, headings: [] };
}

describe('assembleRenderedDocstrings', () => {
  const items: DocstringMarkdownItem[] = [
    { objectPath: 'pkg.f', sectionIndex: 0, slot: 'body', index: 0, markdown: 'a', wantsHeadings: true },
    { objectPath: 'pkg.f', sectionIndex: 1, slot: 'entry', index: 0, markdown: 'b', wantsHeadings: false },
    { objectPath: 'pkg.f', sectionIndex: 1, slot: 'entry', index: 2, markdown: 'c', wantsHeadings: false },
    { objectPath: 'pkg.f', sectionIndex: 2, slot: 'block', index: 1, markdown: 'd', wantsHeadings: false },
    { objectPath: 'pkg.f', sectionIndex: -1, slot: 'deprecated', index: 0, markdown: 'e', wantsHeadings: false },
  ];
  const rendered = assembleRenderedDocstrings(items, [
    html('<p>a</p>'),
    html('<p>b</p>'),
    html('<p>c</p>'),
    html('<pre>d</pre>'),
    html('<p>e</p>'),
  ]);

  test('puts each piece where the accessors look for it', () => {
    expect(renderedSectionBody(rendered, 'pkg.f', 0)).toBe('<p>a</p>');
    expect(renderedSectionEntry(rendered, 'pkg.f', 1, 0)).toBe('<p>b</p>');
    expect(renderedSectionEntry(rendered, 'pkg.f', 1, 2)).toBe('<p>c</p>');
    expect(renderedSectionBlock(rendered, 'pkg.f', 2, 1)).toBe('<pre>d</pre>');
    expect(renderedDeprecation(rendered, 'pkg.f')).toBe('<p>e</p>');
  });

  test('missing pieces read as empty strings', () => {
    expect(renderedSectionBody(rendered, 'pkg.f', 9)).toBe('');
    expect(renderedSectionEntry(rendered, 'pkg.f', 1, 5)).toBe('');
    expect(renderedSectionBlock(rendered, 'pkg.missing', 0, 0)).toBe('');
    expect(renderedDeprecation(rendered, 'pkg.missing')).toBe('');
  });

  test('drops empty renders instead of storing them', () => {
    const sparse = assembleRenderedDocstrings(items, [html(''), html('<p>b</p>')]);
    expect(renderedSectionBody(sparse, 'pkg.f', 0)).toBe('');
    expect(renderedSectionEntry(sparse, 'pkg.f', 1, 0)).toBe('<p>b</p>');
  });

  test('survives a round trip through JSON', () => {
    const parsed = JSON.parse(JSON.stringify(rendered)) as typeof rendered;
    expect(renderedSectionEntry(parsed, 'pkg.f', 1, 2)).toBe('<p>c</p>');
  });

  test('collects headings only from items that asked for them', () => {
    const withHeading: DocstringMarkdownItem[] = [
      { objectPath: 'pkg.g', sectionIndex: 0, slot: 'body', index: 0, markdown: 'text', wantsHeadings: true },
      // An admonition shares the `body` slot but never contributes to the page ToC.
      { objectPath: 'pkg.g', sectionIndex: 1, slot: 'body', index: 0, markdown: 'note', wantsHeadings: false },
    ];
    const heading: PageHeading = { depth: 2, slug: 'overview', text: 'Overview' };
    const asideHeading: PageHeading = { depth: 2, slug: 'inside-the-aside', text: 'Inside the aside' };
    const result = assembleRenderedDocstrings(withHeading, [
      { html: '<h2 id="overview">Overview</h2>', headings: [heading] },
      { html: '<h2 id="inside-the-aside">Inside the aside</h2>', headings: [asideHeading] },
    ]);
    expect(docstringHeadings(result, 'pkg.g')).toEqual([heading]);
  });

  test('concatenates headings from several text sections in docstring order', () => {
    const twoTextSections: DocstringMarkdownItem[] = [
      { objectPath: 'pkg.h', sectionIndex: 0, slot: 'body', index: 0, markdown: 'first', wantsHeadings: true },
      { objectPath: 'pkg.h', sectionIndex: 2, slot: 'body', index: 0, markdown: 'second', wantsHeadings: true },
    ];
    const first: PageHeading = { depth: 2, slug: 'first', text: 'First' };
    const second: PageHeading = { depth: 2, slug: 'second', text: 'Second' };
    const result = assembleRenderedDocstrings(twoTextSections, [
      { html: '<h2 id="first">First</h2>', headings: [first] },
      { html: '<h2 id="second">Second</h2>', headings: [second] },
    ]);
    expect(docstringHeadings(result, 'pkg.h')).toEqual([first, second]);
  });
});

describe('docstringHeadings', () => {
  test('reads back an empty array when the object has none', () => {
    expect(docstringHeadings({ objects: {} }, 'pkg.missing')).toEqual([]);
  });
});

describe('mergeDocstringHeadings', () => {
  const memberHeadings: PageHeading[] = [{ depth: 2, slug: 'pkg.thing', text: 'thing' }];

  function pageFor(canonicalPath: string): PageModel {
    return {
      slug: 'api/pkg',
      title: 'pkg',
      modulePath: 'pkg',
      object: { canonicalPath } as unknown as PageModel['object'],
      headings: memberHeadings,
      children: [],
      parent: undefined,
    };
  }

  test('prepends the module docstring headings ahead of the member headings', () => {
    const proseHeading: PageHeading = { depth: 2, slug: 'overview', text: 'Overview' };
    const rendered = assembleRenderedDocstrings(
      [{ objectPath: 'pkg', sectionIndex: 0, slot: 'body', index: 0, markdown: 'x', wantsHeadings: true }],
      [{ html: '<h2 id="overview">Overview</h2>', headings: [proseHeading] }],
    );
    expect(mergeDocstringHeadings(pageFor('pkg'), rendered)).toEqual([proseHeading, ...memberHeadings]);
  });

  test('is just the member headings when the docstring introduced none', () => {
    expect(mergeDocstringHeadings(pageFor('pkg'), { objects: {} })).toBe(memberHeadings);
  });
});
