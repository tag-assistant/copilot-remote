import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { markdownToHtml, markdownToText } from '../format.js';

describe('markdownToHtml', () => {
  it('converts headers to bold', () => {
    assert.equal(markdownToHtml('# Hello'), '<b>Hello</b>');
    assert.equal(markdownToHtml('## Sub'), '<b>Sub</b>');
  });

  it('converts bold text', () => {
    assert.equal(markdownToHtml('**bold**'), '<b>bold</b>');
    assert.equal(markdownToHtml('__bold__'), '<b>bold</b>');
  });

  it('converts italic text', () => {
    assert.equal(markdownToHtml('*italic*'), '<i>italic</i>');
    assert.equal(markdownToHtml('_italic_'), '<i>italic</i>');
  });

  it('converts bold+italic', () => {
    assert.equal(markdownToHtml('***both***'), '<b><i>both</i></b>');
  });

  it('converts inline code', () => {
    assert.equal(markdownToHtml('use `npm install`'), 'use <code>npm install</code>');
  });

  it('converts code blocks', () => {
    const input = '```js\nconst x = 1;\n```';
    const expected = '<pre><code class="language-js">const x = 1;</code></pre>';
    assert.equal(markdownToHtml(input), expected);
  });

  it('handles unclosed code blocks', () => {
    const input = '```\nsome code';
    assert.ok(markdownToHtml(input).includes('<pre>'));
  });

  it('converts links', () => {
    assert.equal(markdownToHtml('[foo](https://bar.com)'), '<a href="https://bar.com">foo</a>');
  });

  it('converts strikethrough', () => {
    assert.equal(markdownToHtml('~~gone~~'), '<s>gone</s>');
  });

  it('converts blockquotes', () => {
    assert.equal(markdownToHtml('> quoted'), '<blockquote>quoted</blockquote>');
  });

  it('converts unordered lists', () => {
    assert.equal(markdownToHtml('- item'), '• item');
    assert.equal(markdownToHtml('* item'), '• item');
  });

  it('converts ordered lists', () => {
    assert.equal(markdownToHtml('1. first'), 'first');
  });

  it('converts horizontal rules', () => {
    assert.equal(markdownToHtml('---'), '———');
  });

  it('escapes HTML entities', () => {
    assert.equal(markdownToHtml('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('handles mixed content', () => {
    const input = '# Title\n\nSome **bold** and `code`\n\n- item 1\n- item 2';
    const result = markdownToHtml(input);
    assert.ok(result.includes('<b>Title</b>'));
    assert.ok(result.includes('<b>bold</b>'));
    assert.ok(result.includes('<code>code</code>'));
    assert.ok(result.includes('• item 1'));
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
    assert.equal(markdownToText('- item'), '• item');
  });
});
