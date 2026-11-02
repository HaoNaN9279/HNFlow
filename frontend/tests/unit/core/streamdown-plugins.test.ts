import { expect, test } from "@rstest/core";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { SafeStreamdown, streamdownPlugins } from "@/core/streamdown";

function renderSharedMarkdown(content: string) {
  return renderToStaticMarkup(
    createElement(SafeStreamdown, streamdownPlugins, content),
  );
}

test("does not add heading anchors to the shared streamdown plugin config", () => {
  const html = [
    renderSharedMarkdown("## Summary"),
    renderSharedMarkdown("## Summary"),
  ].join("");

  expect(html).not.toContain('id="summary"');
});
