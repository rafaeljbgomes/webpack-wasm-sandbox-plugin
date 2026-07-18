# Compat Test Results

| Library    | Results                                 | Notes                                                                                                           |
| ---------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| strip-ansi | 8/8                                     |                                                                                                                 |
| marked     | Lexer tests fail, most other tests pass | Problem with objects changed inside the sandbox not being reflected in the host environment cause lexer to fail |

|------------------------------------------------------------|
| CommonMark |
| |
| Tabs 11 of 11 100% |
| Backslash escapes 13 of 13 100% |
| Entity and numeric character references 15 of 17 88% |
| Precedence 1 of 1 100% |
| Thematic breaks 19 of 19 100% |
| ATX headings 18 of 18 100% |
| Setext headings 27 of 27 100% |
| Indented code blocks 12 of 12 100% |
| Fenced code blocks 29 of 29 100% |
| HTML blocks 44 of 44 100% |
| Link reference definitions 27 of 27 100% |
| Paragraphs 8 of 8 100% |
| Blank lines 1 of 1 100% |
| Block quotes 25 of 25 100% |
| List items 48 of 48 100% |
| Lists 26 of 26 100% |
| Inlines 1 of 1 100% |
| Code spans 22 of 22 100% |
| Emphasis and strong emphasis 132 of 132 100% |
| Links 77 of 90 86% |
| Images 22 of 22 100% |
| Autolinks 19 of 19 100% |
| Raw HTML 20 of 20 100% |
| Hard line breaks 15 of 15 100% |
| Soft line breaks 2 of 2 100% |
| Textual content 3 of 3 100% |

---

---

| GFM |
| |
| Tabs 11 of 11 100% |
| Backslash escapes 13 of 13 100% |
| Entity and numeric character references 15 of 17 88% |
| Precedence 1 of 1 100% |
| Thematic breaks 19 of 19 100% |
| ATX headings 18 of 18 100% |
| Setext headings 27 of 27 100% |
| Indented code blocks 12 of 12 100% |
| Fenced code blocks 29 of 29 100% |
| HTML blocks 44 of 44 100% |
| Link reference definitions 27 of 27 100% |
| Paragraphs 8 of 8 100% |
| Blank lines 1 of 1 100% |
| Block quotes 25 of 25 100% |
| List items 48 of 48 100% |
| Lists 26 of 26 100% |
| Inlines 1 of 1 100% |
| Code spans 22 of 22 100% |
| Emphasis and strong emphasis 132 of 132 100% |
| Links 77 of 90 86% |
| Images 22 of 22 100% |
| Autolinks 15 of 19 79% |
| Raw HTML 20 of 20 100% |
| Hard line breaks 15 of 15 100% |
| Soft line breaks 2 of 2 100% |
| Textual content 3 of 3 100% |
| [extension] Tables 8 of 8 100% |
| [extension] Task list items 2 of 2 100% |
| [extension] Strikethrough 3 of 3 100% |
| [extension] Autolinks 11 of 14 79% |
| [extension] Disallowed Raw HTML 0 of 1 0% |

---

| image-js | 37/40 | Error with readSync only available in node causes 3 tests to fail |

## Luxon: normalização ESM do harness

A suite upstream da Luxon combina módulos ES (`import`) com CommonJS
(`require` e `exports`) no helper `test/helpers.js`. O Jest do modo sandbox tem de
executar os testes como ES modules, porque o proxy gerado usa top-level `await`.
Nesse contexto, `require` não existe e várias suites falhavam durante o
carregamento, antes de registarem os respetivos testes.

Para tornar essas suites executáveis, o fixture do Compatibility Harness aplica
uma adaptação exclusivamente sintática:

- `require("../helpers")` é substituído por `import Helpers from "../helpers"`;
- `test/helpers.js` publica por ESM os mesmos helpers e o mesmo objeto default;
- os corpos dos testes, dados de entrada, chamadas a Luxon e assertions não são
  alterados;
- a mesma versão adaptada da suite é executada nos modos nativo e sandbox.

Esta normalização não representa uma funcionalidade adicional da sandbox nem
uma correção da Luxon. Remove apenas uma incompatibilidade entre formatos de
módulos no runner, pelo que os resultados continuam a comparar a mesma lógica
de teste. A alteração deve, contudo, ser declarada na metodologia e os resultados
devem identificar a suite como `harness-adapted`, em vez de a apresentar como
uma execução byte a byte inalterada da suite upstream.

### Normalização dos reports Jest

Os valores devolvidos pela sandbox podem ser proxies com referências internas
cíclicas ou com uma superfície que não pode ser enumerada integralmente. Quando
uma assertion falhava, o Jest tentava copiar e serializar esses valores através
de `failureDetails`. Essa operação podia lançar `RangeError: Too many properties
to enumerate` antes de o resultado da suite ser entregue ao reporter, ou
`TypeError: Converting circular structure to JSON` durante a escrita do report.

O modo sandbox usa, por isso, um runner e um test environment específicos do
harness que tornam a cópia dos eventos tolerante a proxies e substituem apenas
valores de diagnóstico não enumeráveis por um marcador textual. Um
`testResultsProcessor`, partilhado pelos modos native e sandbox, remove
`failureDetails` antes da serialização final. O Compatibility Harness não usa
esse campo: as falhas continuam a ser obtidas através de `failureMessages`.

Esta normalização ocorre depois de cada assertion ter sido avaliada. Não altera
o valor recebido pelo teste, o valor esperado, o matcher, o estado pass/fail ou
a execução da biblioteca. Permanecem no report o nome do teste, o estado, a
duração, a mensagem e a stack. Num ensaio focado sobre as três suites antes
afetadas (`datetime/tokenParse`, `datetime/format` e `info/listers`), os 177
testes foram contabilizados: 133 passaram e 44 falharam funcionalmente.
