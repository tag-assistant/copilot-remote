import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { markdownToHtml, markdownToText, markdownToTelegramChunks } from '../format.js';

describe('markdownToHtml', () => {
  it('converts headers to plain text (no bold wrapping)', () => {
    // The new markdown-it parser renders headings without bold by default
    const result = markdownToHtml('# Hello');
    assert.ok(result.includes('Hello'));
  });

  it('converts bold text', () => {
    assert.ok(markdownToHtml('**bold**').includes('<b>bold</b>'));
  });

  it('converts italic text', () => {
    assert.ok(markdownToHtml('*italic*').includes('<i>italic</i>'));
  });

  it('converts bold+italic', () => {
    const result = markdownToHtml('***both***');
    assert.ok(result.includes('<b>'));
    assert.ok(result.includes('<i>'));
    assert.ok(result.includes('both'));
  });

  it('converts inline code', () => {
    assert.ok(markdownToHtml('use `npm install`').includes('<code>npm install</code>'));
  });

  it('converts code blocks', () => {
    const input = '```js\nconst x = 1;\n```';
    const result = markdownToHtml(input);
    assert.ok(result.includes('<pre><code>'));
    assert.ok(result.includes('const x = 1;'));
    assert.ok(result.includes('</code></pre>'));
  });

  it('handles unclosed code blocks', () => {
    const input = '```\nsome code';
    assert.ok(markdownToHtml(input).includes('<pre>'));
  });

  it('converts links', () => {
    const result = markdownToHtml('[foo](https://bar.com)');
    assert.ok(result.includes('<a href="https://bar.com">foo</a>'));
  });

  it('converts strikethrough', () => {
    assert.ok(markdownToHtml('~~gone~~').includes('<s>gone</s>'));
  });

  it('converts blockquotes', () => {
    assert.ok(markdownToHtml('> quoted').includes('<blockquote>'));
    assert.ok(markdownToHtml('> quoted').includes('quoted'));
  });

  it('converts unordered lists', () => {
    assert.ok(markdownToHtml('- item').includes('• item'));
    assert.ok(markdownToHtml('* item').includes('• item'));
  });

  it('converts ordered lists', () => {
    const result = markdownToHtml('1. first');
    assert.ok(result.includes('1. first'));
  });

  it('converts horizontal rules', () => {
    assert.ok(markdownToHtml('---').includes('───'));
  });

  it('escapes HTML entities', () => {
    const result = markdownToHtml('<script>alert(1)</script>');
    assert.ok(result.includes('&lt;script&gt;'));
    assert.ok(!result.includes('<script>'));
  });

  it('handles mixed content', () => {
    const input = '# Title\n\nSome **bold** and `code`\n\n- item 1\n- item 2';
    const result = markdownToHtml(input);
    assert.ok(result.includes('Title'));
    assert.ok(result.includes('<b>bold</b>'));
    assert.ok(result.includes('<code>code</code>'));
    assert.ok(result.includes('• item 1'));
  });

  it('converts spoilers', () => {
    const result = markdownToHtml('this is ||hidden|| text');
    assert.ok(result.includes('<tg-spoiler>hidden</tg-spoiler>'));
  });

  it('wraps file references in code tags', () => {
    const result = markdownToHtml('check README.md for details');
    assert.ok(result.includes('<code>'));
    assert.ok(result.includes('README.md'));
  });
});

describe('markdownToText', () => {
  it('strips bold markers', () => {
    assert.equal(markdownToText('**bold**'), 'bold');
  });

  it('strips headers', () => {
    assert.equal(markdownToText('## Header'), 'Header');
  });

  it('strips links but keeps text', () => {
    assert.equal(markdownToText('[click](http://x.com)'), 'click');
  });

  it('strips inline code backticks', () => {
    assert.equal(markdownToText('use `npm`'), 'use npm');
  });

  it('converts list markers to bullets', () => {
    assert.ok(markdownToText('- item').includes('• item'));
  });
});

describe('markdownToTelegramChunks', () => {
  it('returns single chunk for short text', () => {
    const chunks = markdownToTelegramChunks('hello **world**', 4096);
    assert.equal(chunks.length, 1);
    assert.ok(chunks[0].html.includes('<b>world</b>'));
  });

  it('splits long text into multiple chunks', () => {
    const long = 'word '.repeat(2000);
    const chunks = markdownToTelegramChunks(long, 4096);
    assert.ok(chunks.length > 1);
  });
});
