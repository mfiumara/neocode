import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";

test("shared controls retain native accessible semantics", () => {
  const html = renderToStaticMarkup(<>
    <Button type="button" aria-label="Send prompt">Send</Button>
    <Textarea aria-label="Prompt" placeholder="Ask…" />
    <Badge role="status" variant="accent">INSERT</Badge>
    <Separator decorative={false} />
  </>);

  assert.match(html, /<button[^>]+aria-label="Send prompt"/);
  assert.match(html, /<textarea[^>]+aria-label="Prompt"/);
  assert.match(html, /<span[^>]+role="status"[^>]*>INSERT<\/span>/);
  assert.match(html, /role="separator"/);
  assert.match(html, /aria-orientation="horizontal"/);
});

test("consumer classes are merged without duplicate utility conflicts", () => {
  const html = renderToStaticMarkup(<Button className="h-12" size="sm">Tall</Button>);
  assert.match(html, /h-12/);
  assert.doesNotMatch(html, /h-7/);
});
