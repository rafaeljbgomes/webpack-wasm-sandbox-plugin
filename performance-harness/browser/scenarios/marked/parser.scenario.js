import { Marked } from "marked";

const parser = new Marked({
  gfm: true,
  breaks: true,
});

function createMarkdownDocument() {
  return Array.from({ length: 40 }, (_, index) => {
    const section = index + 1;
    return [
      `# Section ${section}`,
      "",
      `Paragraph ${section} with **bold**, _italic_, and \`inline-code-${section}\`.`,
      "",
      "- item one",
      "- item two",
      "- item three",
      "",
      `> quoted text for section ${section}`,
      "",
      "```js",
      `const value${section} = ${section};`,
      `console.log(value${section});`,
      "```",
    ].join("\n");
  }).join("\n\n");
}

const markdown = createMarkdownDocument();

export default function run() {
  const html = parser.parse(markdown);
  if (typeof html !== "string" || !html.includes("<h1")) {
    throw new Error("Marked scenario produced invalid HTML output.");
  }
}
