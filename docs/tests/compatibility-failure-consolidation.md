# Consolidação das Falhas de Compatibilidade

## Objetivo e Critério de Leitura

Este documento consolida os resultados de compatibilidade das dez bibliotecas avaliadas e identifica as limitações mais relevantes da fronteira entre o host e o contexto QuickJS. Serve como base factual para a secção de compatibilidade do capítulo de avaliação; não pretende substituir a descrição metodológica nem constituir texto final da dissertação.

A análise compara primeiro cada execução sandbox com o respetivo baseline nativo. Uma falha presente nos dois modos não é atribuída à sandbox. Nas execuções completas, o rácio de compatibilidade corresponde a `testes sandbox com sucesso / testes nativos com sucesso`, de acordo com o Compatibility Harness. Date-fns e Yup exigem um tratamento conservador porque a execução sandbox terminou por esgotamento do heap antes de completar todos os ficheiros. Nestes dois casos, o valor apresentado é um limite inferior calculado por `testes sandbox com sucesso / total de testes executados no modo nativo`. Os testes não executados não são considerados sucessos.

Os valores de Lodash estão ao nível de assertions QUnit, enquanto os restantes resultados são maioritariamente contagens de testes. Por esta razão, não se calcula um rácio global ponderado entre bibliotecas: somar unidades de granularidade diferente daria um resultado enganador.

## Análise por Biblioteca

| Biblioteca | Evidência quantitativa | Principais falhas observadas | Interpretação |
|---|---:|---|---|
| Strip-ansi | 8/8 (100%) | Nenhuma falha adicional no modo sandbox. | API baseada em strings e funções puras, sem dependência relevante de identidade ou tipos nativos complexos. |
| Image.js | 37/40 (92,50%) | Três testes dependem de `readSync`, uma API exclusiva de Node que não está exposta na sandbox orientada ao browser. | A limitação é de ambiente e não do processamento binário no browser. O marshaller de `TypedArray` permite copiar os dados binários entre os dois runtimes. |
| Mime | 12/13 testes nativos com sucesso (92,31%) | `getAllExtensions()` devolve um `Set` cujo método `values()` rejeita o proxy com `Set object expected`. | O estado das instâncias e os campos privados são preservados pela reverse membrane, mas um proxy genérico não contém os *internal slots* de um `Set`. As duas falhas de CLI ocorrem também nativamente no Windows e são excluídas da diferença sandbox. |
| TweetNaCl | 8868/8914 (99,48%) | As 46 falhas verificam que entradas inválidas lançam exatamente o `TypeError` esperado. A operação rejeita corretamente, mas o host observa um `QuickJSUnwrapError`/erro da ponte. | A elevada taxa de sucesso, incluindo operações criptográficas e `Uint8Array`, mostra que o marshalling binário e a exposição controlada de `crypto.getRandomValues` funcionam. A divergência restante é de identidade do construtor da exceção. |
| Luxon | 957/1079 testes nativos com sucesso (88,69%); 1196 testes executados em ambos os modos | Diferenças de formatação, locale, fuso horário e `Intl`; comparações de objetos e classes; exceções e objetos de diagnóstico. | A reverse membrane preserva o `this`, os campos privados e os getters de objetos `DateTime`, mas não reproduz integralmente semântica *same-realm*. O baseline nativo já falha 117 testes, sobretudo dependentes do ambiente. A suite foi normalizada de CommonJS/ESM e o report Jest foi tornado tolerante a proxies sem alterar assertions. |
| Zod | 1808/1981 testes nativos com sucesso (91,27%); os 74 ficheiros foram completados | Erros Zod e snapshots atravessam a fronteira com forma ou protótipo diferente; 36 falhas apresentam `cannot set property 'ref' of undefined` na geração de JSON Schema; existem ainda divergências com `BigInt`, congelamento, `RegExp`, mapas/conjuntos e metadados. | As APIs encadeadas funcionam na maioria dos casos, mas criam muitos objetos intermédios. Os testes mais sensíveis a referências, metadados mutáveis, tipos especiais e erros ricos concentram as falhas. Uma falha do baseline (`redos checker`) não é atribuída à sandbox. |
| Lodash | 5397/6734 assertions (80,14%) | 384 falhas em resultados booleanos, identidade e `instanceof`; 305 em comparação profunda e identidade de referência; 232 divergências heterogéneas de arrays, números e valores; 205 exceções; 101 falhas secundárias de contagem após exceção. | É a evidência mais extensa sobre a fronteira. A reverse membrane conserva o receiver QuickJS necessário a objetos stateful, mas não garante identidade canónica em travessias repetidas. Símbolos, funções, protótipos, tipos nativos e callables encadeados continuam sensíveis à representação por wrappers. |
| Marked | Suite unitária: 165/165 no modo nativo; 88 sucessos e 71 falhas entre 159 testes sandbox registados. Limite conservador: 88/165 (53,33%). Conformance complementar: 637/652 CommonMark (97,70%) e 657/680 GFM (96,62%). | A maioria das falhas unitárias está no Lexer: arrays de tokens chegam ao host vazios ou as alterações efetuadas por callbacks no host não regressam ao objeto original na VM. Hooks, defaults globais e edição de tokens mostram o mesmo problema de aliasing. Seis testes do `bin` não chegaram a ser registados porque o proxy público não exporta o `main` do módulo interno. | A diferença entre a suite unitária e os testes de conformance é importante: a geração final de HTML preserva elevada compatibilidade, enquanto testes que inspecionam ou modificam estruturas intermédias expõem a perda de mutação partilhada através da fronteira. |
| Date-fns | Nativo: 3160 executados, 3081 sucessos, 78 falhas e 1 ignorado. Sandbox: 2504 executados, 1888 sucessos, 589 falhas e 1 ignorado. Limite inferior: 1888/3160 (59,75%). Foram completados 247/250 ficheiros. | Perda do subtipo de `Date` (`UTCDate`/`TZDate`) e consequentes falhas de `instanceof`; objetos de contexto e fuso horário não conservam integralmente protótipo e comportamento; diferenças em datas históricas; imports de `_lib` redirecionados para uma API pública que não exporta esses helpers. `format`, `interval` e `parse` esgotaram o heap mesmo quando executados isoladamente. | O tratamento especializado de `Date` preserva o instante, mas converte subclasses em `Date` nativo e perde informação nominal. As 78 falhas nativas são sobretudo de locale (`pt` no ambiente, `en` esperado). O resultado sandbox é um limite inferior, não uma estimativa da suite completa. |
| Yup | Nativo: 869 executados, 867 sucessos e 2 ignorados. Sandbox: 478 executados, 436 sucessos e 42 falhas. Limite inferior: 436/869 (50,17%). Foram completados 9/14 ficheiros. | Comparações por referência de arrays, objetos e schemas; mutações de metadados, opções e locale não refletidas; acesso a `_cast`/superfície de protótipo; diferenças em `ValidationError` e snapshots. Os ficheiros `bool`, `date`, `mixed`, `number` e `string` esgotaram o heap. | Nos ficheiros concluídos, 436/478 testes passaram (91,21%). O limite inferior global é penalizado pelos cinco ficheiros sem resultado e não deve ser apresentado como compatibilidade estimada para os testes que faltam. A criação intensiva de schemas e objetos intermédios pressiona o mecanismo de retenção da reverse membrane. |

## Causas Transversais Mais Relevantes

### 1. Identidade de Referência e Protótipos entre Runtimes

Esta é a causa mais recorrente. Um valor QuickJS e o seu wrapper no host pertencem a runtimes diferentes. A implementação usa caches e mantém o objeto original dentro de `__SANDBOX_TEMP__` para que métodos posteriores conservem o receiver e os campos privados. Contudo, não existe um mapeamento canónico completo para todas as travessias host–VM–host. Assim, valores logicamente iguais podem ter wrappers distintos, `a === b` pode falhar e o protótipo observado no host pode não corresponder ao construtor original.

O efeito aparece de forma explícita em Lodash e Yup, nos subtipos `UTCDate`/`TZDate` de Date-fns, em classes e zonas customizadas de Luxon, e em erros e schemas de Zod. Símbolos e aliases de funções são casos especialmente sensíveis, porque a sua semântica depende da identidade e não apenas do conteúdo.

O compromisso é coerente com o objetivo de isolamento: devolver diretamente o objeto do host ou partilhar o mesmo heap eliminaria parte destas diferenças, mas também enfraqueceria a fronteira de segurança. Ainda assim, estas falhas podem ser observáveis numa aplicação que use chaves por referência, `instanceof` ou caches de objetos e não devem ser classificadas como irrelevantes.

### 2. Perda de Aliasing e de Mutações Partilhadas

Arrays, objetos simples, `TypedArray` e alguns valores especiais atravessam a fronteira por cópia, dump ou reconstrução. Este comportamento transmite o valor num dado instante, mas não cria memória partilhada. Uma mutação efetuada num callback do host pode, por isso, alterar apenas a cópia recebida e não o objeto que continua dentro da VM. A mesma limitação afeta objetos do host passados para a biblioteca e posteriormente devolvidos.

Esta causa explica diretamente os arrays de tokens vazios ou não atualizados do Lexer da Marked, as alterações a tokens em hooks, os metadados e opções de Yup, parte das registries e referências de JSON Schema da Zod e uma fração das divergências de valor da Lodash. O marshaller de `TypedArray` assume deliberadamente semântica de cópia; a capacidade de `crypto.getRandomValues` contém lógica específica para copiar os bytes de volta para o array QuickJS, mas essa solução não generaliza automaticamente para todos os callbacks e tipos.

### 3. Tipos Nativos, *Internal Slots* e Tipos Especiais

Objetos como `Set`, `Map`, `DataView`, `ArrayBuffer`, `RegExp`, `Date`, `Intl.*` e subclasses de tipos nativos possuem estado interno gerido pelo motor JavaScript. Um proxy estrutural pode expor propriedades e métodos, mas não consegue fabricar os *internal slots* que os métodos nativos validam.

A solução reduz este problema com mecanismos dirigidos: a forward membrane liga os métodos Web API ao objeto real do host; existem marshallers para `TypedArray` e `RegExp`; a ponte Arena converte `Date` pelo timestamp; e a reverse membrane evita envolver novamente alguns tipos de valor. A cobertura não é, porém, total. O `Set object expected` da Mime, os subtipos de `Date` em Date-fns, vários casos de Map/Set/BigInt/RegExp em Zod e parte das diferenças de `Intl` em Luxon mostram os limites restantes. A implementação ativa não inclui um marshaller genérico de coleções, pois uma tentativa desse tipo introduziu instabilidade e perda adicional de semântica.

### 4. Fidelidade de Exceções e Objetos de Erro

Uma exceção lançada dentro de QuickJS tem de ser convertida numa exceção do host. A mensagem e a intenção da rejeição podem ser preservadas sem que o valor final seja uma instância do mesmo construtor. Foi o que aconteceu nas 46 falhas da TweetNaCl: os inputs inválidos foram rejeitados, mas o matcher recebeu um erro da ponte em vez do `TypeError` host esperado.

Zod e Yup tornam o problema mais visível porque os seus erros transportam arrays de issues, erros internos, parâmetros, stacks e snapshots. O marshaller de erros preserva os construtores nativos mais comuns e copia campos selecionados, mas erros lançados pelo caminho de `unwrapResult`, subclasses específicas da biblioteca, grafos cíclicos e stacks entre runtimes continuam sem fidelidade total. Lodash apresenta o mesmo padrão em menor escala.

### 5. Retenção de Objetos e Esgotamento do Heap

Para preservar o receiver de objetos stateful, a reverse membrane fixa objetos QuickJS num `Map` global, `__SANDBOX_TEMP__`. As referências são libertadas quando a sandbox é destruída, mas não existe ainda uma associação com `FinalizationRegistry` que remova individualmente os objetos quando o wrapper do host deixa de ser necessário. Esta retenção é uma limitação conhecida da implementação.

Os logs de Date-fns e Yup confirmam `JavaScript heap out of memory`. A retenção de objetos fornece uma explicação técnica consistente para o crescimento observado em ficheiros extensos ou com criação intensiva de schemas, embora não tenha sido produzido um perfil de heap que demonstre que é a única causa. Para Date-fns, três ficheiros permaneceram incompletos; para Yup, cinco. O batching e a execução por ficheiro reduziram a dimensão de cada processo, mas não resolveram os ficheiros que individualmente excederam o limite.

## Fatores Metodológicos que Não Devem Ser Confundidos com Falhas da Sandbox

- Diferenças de locale, fuso horário, versão de ICU ou sistema operativo que também falham no modo nativo devem ser tratadas como baseline do ambiente. É o caso de parte substancial das falhas nativas de Luxon e Date-fns.
- Testes de CLI da Mime falham nos dois modos devido ao comando Unix usado no Windows. Os três testes `readSync` da Image.js exercitam uma API exclusiva de Node e não o alvo browser da solução.
- Suites upstream que importam módulos internos não medem apenas a API pública. Os helpers `_lib` de Date-fns e o `bin/main.js` da Marked mostram que um único proxy público não substitui todos os submódulos internos.
- A normalização ESM da Luxon e a sanitização dos campos de diagnóstico do Jest são adaptações do harness. Foram aplicadas aos dois modos e depois da avaliação das assertions; devem ser declaradas, mas não contam como funcionalidade da sandbox.
- Os rácios de Date-fns e Yup são limites inferiores. Não existe evidência para classificar como sucesso ou falha os testes que não produziram resultado.

## Síntese para a Discussão da Dissertação

Os resultados mostram que a solução preserva uma parte elevada do comportamento funcional em bibliotecas com perfis distintos, desde transformação de strings e parsing até criptografia, datas, validação e APIs orientadas a objetos. As falhas não estão distribuídas aleatoriamente: concentram-se em semântica que depende de um único runtime JavaScript, nomeadamente identidade, protótipos, memória mutável partilhada, *internal slots* e identidade de exceções. A própria reverse membrane foi introduzida para recuperar estado, `this`, campos privados e getters sem romper o isolamento, mas essa decisão exige fixar objetos dentro da VM e não elimina todas as diferenças observáveis no host.

Este compromisso é aceitável para o protótipo enquanto demonstra isolamento granular com compatibilidade substancial, sobretudo porque funções puras, transformações de dados e fluxos que consomem resultados por valor apresentam os melhores resultados. A conclusão deve, contudo, ser delimitada: APIs que dependem de igualdade referencial, subclasses nativas, mutação bidirecional de objetos intermédios ou criação intensiva de wrappers exigem validação específica da aplicação. A execução incompleta de Date-fns e Yup e a ausência de libertação incremental dos objetos fixados permanecem limitações materiais e devem ser apresentadas como trabalho futuro, não diluídas no rácio de sucesso.

## Fontes de Evidência no Repositório

- `compatibility-results/strip-ansi/2026-06-15T19-47-56-293Z/`;
- `compatibility-results/mime/2026-06-15T19-48-10-959Z/`;
- `compatibility-results/marked/2026-06-15T19-48-36-461Z/`;
- `compatibility-results/date-fns/2026-06-16T12-57-08-075Z/`;
- `compatibility-results/yup/2026-06-17T20-42-17-855Z/`;
- `compatibility-results/tweetnacl/2026-06-18T20-39-05-660Z/`;
- `compatibility-results/luxon/2026-06-20T12-18-39-403Z/`;
- `compatibility-results/zod/2026-06-17T20-04-07-121Z/` (sandbox) e `compatibility-results/zod/2026-06-22T11-04-59-184Z/` (nativo);
- `docs/tests/lodash-compatibility-failure-analysis.md`;
- `docs/tests/compat-test-results.md`;
- `docs/architecture/architectural-decisions.md`;
- `docs/architecture/sandbox-plugin-spec-v2.md`;
- `.sandbox/membrane/reverse-membrane.js`, `.sandbox/membrane/forward-membrane.js` e `.sandbox/marshallers/`.
