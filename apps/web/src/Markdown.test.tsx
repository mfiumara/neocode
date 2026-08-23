import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown, safeMarkdownUrl } from "./Markdown";

test("renders common markdown constructs", () => {
  const html = renderToStaticMarkup(
    <Markdown>{"**strong**\n\n- one\n- two\n\n`inline`\n\n```ts\nconst value = 1;\n```"}</Markdown>,
  );

  assert.match(html, /<strong>strong<\/strong>/);
  assert.match(html, /<ul>/);
  assert.match(html, /<code>inline<\/code>/);
  assert.match(html, /class="language-ts"/);
});

test("does not interpret transcript HTML", () => {
  const html = renderToStaticMarkup(
    <Markdown>{"<img src=x onerror=alert(1)> <script>alert(2)</script>"}</Markdown>,
  );

  assert.doesNotMatch(html, /<script>|<img/);
  assert.match(html, /&lt;script&gt;/);
});

test("filters unsafe URLs and hardens safe links", () => {
  const html = renderToStaticMarkup(
    <Markdown>{"[bad](javascript:alert(1)) [good](https://example.com/docs)"}</Markdown>,
  );

  assert.doesNotMatch(html, /javascript:/);
  assert.match(html, /href="https:\/\/example.com\/docs"/);
  assert.match(html, /target="_blank"/);
  assert.match(html, /rel="noopener noreferrer"/);
  assert.doesNotMatch(html, / node=/);
  assert.equal(safeMarkdownUrl("data:text/html,boom"), "");
  assert.equal(safeMarkdownUrl("#details"), "#details");
});

test("does not load remote markdown images", () => {
  const html = renderToStaticMarkup(<Markdown>{"![tracking](https://example.com/pixel.gif)"}</Markdown>);
  assert.doesNotMatch(html, /<img|pixel\.gif/);
  assert.match(html, /\[image: tracking\]/);
});
