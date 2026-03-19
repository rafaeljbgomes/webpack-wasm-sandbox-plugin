import { marked, Lexer } from "marked";

function expectTokens({ md, options, tokens = [], links = {}, log = false }) {
  const lexer = new Lexer(options);
  const actual = lexer.lex(md);
  const expected = tokens;
  expected.links = links;
  if (log) {
    console.log(
      JSON.stringify(actual, (k, v) => (v === undefined ? null : v), 2),
    );
  }
  console.log(actual);
  console.log(expected);
}

try {
  marked.use({
    hooks: {
      preprocess(markdown) {
        return `# preprocess\n\n${markdown}`;
      },
    },
  });
  const html = marked.parse("*text*");
  console.log(html.trim());

  expectTokens({
    md: "    code",
    tokens: [
      {
        type: "code",
        raw: "    code",
        text: "code",
        codeBlockStyle: "indented",
      },
    ],
  });
} catch (err) {
  console.error("Error in marked hooks test:", err);
}

try {
  const underline = {
    name: "underline",
    level: "block",
    tokenizer(src) {
      const rule = /^:([^\n]*)(?:\n|$)/;
      const match = rule.exec(src);
      if (match) {
        return {
          type: "underline",
          raw: match[0], // This is the text that you want your token to consume from the source
          text: match[1].trim(), // You can add additional properties to your tokens to pass along to the renderer
        };
      }
    },
    renderer(token) {
      return `<u>${token.text}</u>\n`;
    },
  };
  marked.use({ extensions: [underline] });
  let html = marked.parse("Not Underlined\n:Underlined\nNot Underlined");
  console.log(html);
} catch (error) {
  console.error("Error in marked custom extension test:", error);
}
