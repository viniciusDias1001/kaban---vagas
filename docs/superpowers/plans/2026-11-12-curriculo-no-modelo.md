# Currículo no Modelo do Dono Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Todo PDF que o app gera sai no modelo do dono (nome e título profissional no cabeçalho, competências por grupo, experiências principais e complementares, rodapé com nome e página, em Noto Serif), em português e em inglês, a partir de um perfil que passa a guardar o título profissional, o grupo de cada competência e a seção e a nota de cada experiência.

**Architecture:** Quatro campos entram no perfil: opcionais no que está gravado, obrigatórios no "fio" (o que o modelo e o editor enviam), com um helper sem Zod que preenche os padrões para quem lê. A leitura do currículo e a tradução os preenchem; o currículo adaptado os copia do perfil, e o verificador os conta como vocabulário. O renderer de `@kv/resume` é refeito em três partes: o texto de cada linha (`pdf-content.ts`), a posição de cada linha (`pdf-layout.ts`, puro, testado sem gerar PDF) e o desenho (`pdf.ts`).

**Tech Stack:** o do repositório (Node 24+, pnpm 10, TypeScript, Vitest, Zod 4, pdfkit 0.20.2, fontkit 2.0.4, React + Tailwind 4, Playwright 1.65). Uma troca de dependência, só em `@kv/resume`: `@fontsource/noto-serif` 5.3.0 (OFL-1.1) no lugar de `@fontsource/noto-sans`.

**Spec:** `docs/superpowers/specs/2026-11-12-candidatura-automatica-design.md`: seção "Parte A — Currículo no modelo do dono", critério de aceite 9, "Decisões do autor" 8 e 21 e a linha "PDF" de "Testes". Este plano não muda nenhuma decisão do spec e não implementa nada da Parte B.

**Planos irmãos:** `2026-11-12-candidatura-base.md` e `2026-11-12-candidatura-sites.md` (Parte B). Este é independente dos dois e pode rodar antes ou em paralelo. A Task 10 do plano base cria `baseResume` no worker; este plano não cria nada com esse nome.

**Branch:** `feat/candidatura-automatica`. Primeiro passo de quem executa: `pnpm install && pnpm typecheck && pnpm test`, tudo verde antes de mexer.

## Global Constraints

- Página A4, margens de 50 pt, **uma coluna**, fonte **Noto Serif** (Regular e Bold). Texto selecionável, sem tabelas nem imagens.
- Nenhum caractere some do PDF em silêncio: sem glifo, a geração falha com `ResumePdfError` (`unsupported_characters`) dizendo quais. O teto `PDF_LIMITS.maxChars` (`100_000`) continua.
- Os quatro campos (`headline`, `skills[].group`, `experiences[].section`, `experiences[].note`) são **opcionais no perfil gravado**. O banco não é reescrito, não há migration, e quem lê trata a ausência como vazio (`section` ausente vale `principal`).
- Título profissional, grupos, seção e nota são **copiados do perfil**; o modelo nunca os escreve por vaga. `TailoredDraftSchema` e `TailoredEditSchema` não mudam.
- Schemas de fio (regra em `packages/shared/src/ai.ts:53-58`): só campos obrigatórios e strings simples. Nada de `.optional()`, `.default()` ou `z.enum` em `ProfileWireSchema`.
- O navegador não carrega Zod: o que o web usa em tempo de execução fica em `ai-constants.ts` e chega por `@kv/shared/client` (guardado por `apps/web/src/bundle.test.ts`).
- **Dados de teste são fictícios** ("Maria Exemplo da Silva", "João Conceição Exemplo"). Os arquivos do dono em `C:\Users\Vinicius\Documents\Curriculos\` nunca são abertos por teste, copiados para fixture ou commitados. Quem executa não cola em commit, log ou mensagem o conteúdo de um PDF gerado do perfil real.
- Títulos de seção, tamanhos, cores e distâncias: exatamente os das tabelas do spec, reunidos em "Constantes do layout".
- Texto de interface em pt-BR; identificadores e mensagens de commit em inglês, no estilo convencional. Toda mensagem de commit termina com a linha `Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>`.
- Um arquivo de teste roda com `pnpm vitest run <caminho>`, a partir da raiz. Cada task termina com `pnpm typecheck` e os testes dos pacotes tocados verdes.

## Review Focus

Entradas que o spec implica e que mais provavelmente atingem o dono. Cada uma tem o teste na task indicada.

1. **Perfil gravado antes desta mudança** (sem os quatro campos; é o caso do perfil do dono hoje). Esperado: abre no editor sem "alterações não salvas" e sem aviso de conflito, salva, traduz, é adaptado e vira PDF sem "undefined", com as competências em uma linha só. Tasks 1, 2, 3, 7 e 8.
2. **Nome gravado todo em maiúsculas.** Esperado: cabeçalho em caixa alta e rodapé "Maria Exemplo da Silva". Tasks 7 e 8.
3. **Experiência com vinte realizações atravessando a quebra de página.** Esperado: nada é cortado, toda página tem rodapé com o número certo, e nem título de seção nem "Cargo - Empresa" ficam sozinhos no pé da página. Task 8.
4. **Grupo de competências cuja tradução vem diferente em cada competência.** Esperado: um rótulo só no outro idioma, e o grupo não se divide em dois no PDF em inglês. Task 4.
5. **Caractere que a fonte serifada não tem**, inclusive nos campos novos e no nome depois de ir para caixa alta. Esperado: erro que nomeia o caractere; os dois sinais que o próprio layout escreve ("•" e "·") têm glifo. Tasks 6 e 8.

---

## Decisões tomadas no plano

O spec e quem encomendou o plano já fixaram as escolhas abaixo. Não reabrir.

1. **Perfil gravado e fio.** No schema gravado os quatro campos são `.optional()`; no fio são strings obrigatórias; `normalizeProfile` sempre os emite. `section` é `'principal' | 'complementar'` (padrão `'principal'`); os outros três têm padrão `''`. No fio, `section` é string e é convertida em código: só `complementar` (aparado, sem diferenciar maiúsculas) vira `'complementar'`.
2. **Um helper para quem lê.** `withProfileDefaults`, em `ai-constants.ts`, serve ao editor, ao renderer e à tradução. Aceita perfil e currículo adaptado.
3. **`TailoredResume.headline`** é opcional no tipo (currículos adaptados já gravados não o têm) e `resolveTailored` sempre o emite, copiado do perfil.
4. **Verificador.** A única mudança é contar `headline`, cada `group` e cada `note` como vocabulário do perfil, no índice de termos e no de números.
5. **Tradução.** Cada grupo distinto é traduzido uma vez: vale o que o modelo devolveu na primeira competência daquele grupo, e o resultado é reaproveitado nas demais. Tradução de grupo que muda algo verificável é descartada em favor do rótulo de origem, sem derrubar a tradução inteira.
6. **Fixtures.** `SAMPLE_PROFILE` e `REALISTIC_PROFILE` ganham os campos com valores neutros (nenhuma asserção existente muda). `LAYOUT_PROFILE` é o perfil com os campos preenchidos; `legacyProfile()` devolve a forma antiga.
7. **Teto de saída do perfil.** Os campos novos somam até cerca de 2 900 caracteres de JSON num perfil no limite de itens. Para o limite do currículo enviado continuar em 19 200 caracteres ("cerca de 6 páginas" no README e nas mensagens), `PROFILE_OUTPUT_TOKENS` sobe de `8_000` para `9_000` e a conta reserva `3_000` caracteres para eles.
8. **`condenseProfile` (camada 1) não muda.** A nota do card continua vindo dos mesmos dados.
9. **Fontes.** Noto Serif Regular e Bold, nos mesmos sete subconjuntos e com o mesmo mecanismo de troca por trecho.
10. **Nome.** Caixa alta no cabeçalho, feita antes do saneamento e da conferência de glifos ("ß" vira "SS"). No rodapé sai como está no perfil; se o perfil o guarda todo em maiúsculas, sai com só as iniciais maiúsculas, mantendo "da", "de", "do", "das", "dos" e "e" em minúsculas.
11. **Datas.** `AAAA-MM` sai "Fev 2026" (pt-BR) ou "Feb 2026" (en); `AAAA` sai como está; qualquer outro texto sai como foi digitado. Fim vazio sai "Atual" ou "Present".
12. **Links** vão na linha de contato, só o endereço (sem esquema e sem barra final); o rótulo do link não é impresso e não existe seção de links. Certificações: uma por linha, "Nome - Emissor | data".
13. **O que o spec não mede** e este plano fixa: o fio fica 8,6 pt abaixo da última linha do cabeçalho (116,6 no modelo, que tem duas linhas de contato); sem título profissional, o contato ocupa o lugar dele; a linha de contato só quebra entre duas partes; linha quebrada de nome, título, seção, cargo ou período avança 1,3 vez o tamanho da fonte; a primeira linha de uma página nova fica com a linha de base em `50 + tamanho da fonte`; competências sem grupo vão em uma última linha sem rótulo; certificações usam a distância dos itens de formação; uma seção de experiências sempre termina com a distância "depois de realizações".
14. **Prévia.** `pnpm resume:preview` gera o PDF do perfil gravado no banco local em uma pasta fora do repositório. A comparação lado a lado com o arquivo do dono é o aceite manual dele.

## File Structure

```
packages/shared/src/ai.ts            (muda) campos opcionais no schema gravado; campos no fio; normalizeProfile
packages/shared/src/ai-constants.ts  (muda) EXPERIENCE_SECTIONS, withProfileDefaults, TailoredResume.headline
packages/ai/src/testing.ts           (muda) fixtures completas, LAYOUT_PROFILE, legacyProfile
packages/ai/src/verify.ts            (muda) vocabulário; resolveTailored copia headline
packages/ai/src/prompts.ts, translation.ts, fake.ts (muda) leitura e tradução dos campos; grupo traduzido uma vez
packages/ai/src/tasks.ts, limits.ts  (muda) origem com padrões na tradução; teto de saída do perfil
apps/web/src/lib/ai.ts               (muda) blankItem, editableProfile, profileDirty, SECTION_OPTIONS, skillGroupOptions
apps/web/src/components/ProfileEditor.tsx (muda) dados normalizados; campos novos
packages/resume/src/pdf-text.ts      (muda) Noto Serif (com package.json, README e Dockerfile)
packages/resume/src/pdf-content.ts   (novo) o texto de cada linha: títulos, datas, grupos, contato, rodapé
packages/resume/src/pdf-layout.ts    (novo) constantes do modelo, blocos, quebra de linha e de página
packages/resume/src/pdf.ts           (muda) limites, glifos e desenho
packages/resume/src/preview.ts       (novo) pasta de saída da prévia
packages/resume/src/testing.ts       (muda) SAMPLE_TAILORED
scripts/resume-preview.ts            (novo) `pnpm resume:preview`
```

## Constantes do layout

Copiadas das duas tabelas do spec. Ficam em `packages/resume/src/pdf-layout.ts` (Task 8), o único lugar do código onde esses números aparecem.

```ts
export const PAGE = { width: 595.28, height: 841.89, margin: 50 } as const; // A4, em pontos
export const COLOR = { ink: '#1f2a44', muted: '#6b7280', rule: '#c9ced6', body: '#222222' } as const;
export const TYPE = {
  name:       { weight: 'bold',    size: 20,   color: COLOR.ink },   // em caixa alta
  headline:   { weight: 'bold',    size: 10.5, color: COLOR.ink },   // em caixa alta
  contact:    { weight: 'regular', size: 8,    color: COLOR.muted },
  section:    { weight: 'bold',    size: 10.5, color: COLOR.ink },   // em caixa alta
  role:       { weight: 'bold',    size: 9,    color: COLOR.ink },   // "Cargo - Empresa"
  meta:       { weight: 'regular', size: 8,    color: COLOR.muted }, // período, local e nota
  groupLabel: { weight: 'bold',    size: 8.5,  color: COLOR.ink },
  body:       { weight: 'regular', size: 8.5,  color: COLOR.body },  // corpo e realizações
  footer:     { weight: 'regular', size: 7,    color: COLOR.muted },
} as const;
/** Distâncias entre linhas de base, em pontos. */
export const GEOMETRY = {
  nameBaseline: 66.4, nameToHeadline: 17.1, headlineToContact: 13.6, contactLine: 10.9,
  ruleBelowHeader: 8.6,                              // o fio fica a 116,6 no modelo: 66,4 + 17,1 + 13,6 + 10,9 + 8,6
  ruleX1: 50, ruleX2: 545, ruleWidth: 0.5,
  headerToSection: 30.1,                             // última linha do cabeçalho até o primeiro título de seção
  sectionToFirst: 16.6, bodyLine: 13.2,
  skillGroups: 15.2, listItems: 14.7,                // entre grupos; entre itens de formação e entre certificações
  roleToMeta: 13.7, metaToAchievement: 14.7,
  achievementLine: 12.6, achievements: 14.1,         // dentro de uma realização; entre realizações
  bulletX: 54.1, achievementX: 63.1,
  experiences: 27.2,                                 // última realização até a experiência seguinte
  bodyToSection: 23.9, achievementsToSection: 36.9,  // último texto até o título da seção seguinte
  footerFromBottom: 38,
  wrapLeading: 1.3,                                  // linha quebrada de nome, título, seção, cargo e período: 1,3 x tamanho
} as const;
```

---

### Task 1: Campos opcionais no perfil gravado, `withProfileDefaults` e `TailoredResume.headline`

Só acrescenta: nada que existe muda de comportamento.

**Files:**
- Modify: `packages/shared/src/ai.ts:19-29` (`ExperienceSchema`), `:31` (`SkillSchema`), `:41-50` (`CandidateProfileSchema`)
- Modify: `packages/shared/src/ai-constants.ts:18-20` (constante de seção, junto de `RESUME_LANGS`), `:45-58` (`TailoredResume`); o helper entra depois de `draftOf` (`:60-74`)
- Test: `packages/shared/src/ai.test.ts`

**Interfaces:**
- Consumes: nada.
- Produces:

```ts
// ai-constants.ts
export const EXPERIENCE_SECTIONS = ['principal', 'complementar'] as const;
export type ExperienceSection = (typeof EXPERIENCE_SECTIONS)[number];
/** O que o modelo do currículo usa e o perfil antigo não tinha. */
export interface LayoutFields { headline?: string; experiences: { section?: ExperienceSection; note?: string }[]; skills: { group?: string }[] }
export type WithLayout<T extends LayoutFields> = Omit<T, 'headline' | 'experiences' | 'skills'> & {
  headline: string;
  experiences: (T['experiences'][number] & { section: ExperienceSection; note: string })[];
  skills: (T['skills'][number] & { group: string })[];
};
/** Preenche o que falta (`''`; `section` vira `'principal'`). Não altera a entrada. Serve a perfil e a currículo adaptado. */
export function withProfileDefaults<T extends LayoutFields>(value: T): WithLayout<T>;
export interface TailoredResume { /* campos atuais */ headline?: string } // ausente nos currículos adaptados já gravados
// ai.ts, todos `.optional()`:
// ExperienceSchema: section: z.enum(EXPERIENCE_SECTIONS), note: short | SkillSchema: group: short | CandidateProfileSchema: headline: short
```

- [ ] **Step 1: Write the failing tests** em `packages/shared/src/ai.test.ts`

```ts
/** Como um perfil gravado antes desta mudança. */
const legacy: CandidateProfile = {
  contact: { name: 'Maria Exemplo da Silva', email: 'maria@exemplo.test', phone: '', location: 'São Paulo, SP' }, summary: 'Pessoa fictícia.',
  experiences: [{ id: 'exp_aaaaaaa1', company: 'Empresa Fictícia Ltda', title: 'Desenvolvedora', start: '2021-03', end: '', location: '', achievements: [] }],
  education: [], skills: [{ id: 'skill_aaaaaaa1', name: 'React' }], languages: [], certifications: [], links: [],
};
it('keeps a profile stored before the change valid and stores the four fields', () => {
  expect(CandidateProfileSchema.safeParse(legacy).success).toBe(true);
  const full = { ...legacy, headline: 'Desenvolvedora Front-end', skills: [{ ...legacy.skills[0], group: 'Front-end' }],
    experiences: [{ ...legacy.experiences[0], section: 'complementar', note: 'Antes: Estagiária' }] };
  expect(CandidateProfileSchema.parse(full)).toEqual(full); // nada é descartado
  expect(CandidateProfileSchema.safeParse({ ...full, experiences: [{ ...full.experiences[0], section: 'outra' }] }).success).toBe(false);
});
it('withProfileDefaults fills what is missing, keeps what is there and leaves its input alone', () => {
  const before = structuredClone(legacy);
  const filled = withProfileDefaults(legacy);
  expect(filled).toMatchObject({ headline: '', skills: [{ group: '' }], experiences: [{ section: 'principal', note: '' }] });
  expect(legacy).toEqual(before);
  expect(withProfileDefaults({ ...filled, headline: 'Tech Lead' })).toEqual({ ...filled, headline: 'Tech Lead' });
  const oldResume: TailoredResume = { ...legacy, lang: 'pt-BR', experiences: [] }; // currículo adaptado gravado antes da mudança
  expect(withProfileDefaults(oldResume)).toMatchObject({ lang: 'pt-BR', headline: '', skills: [{ group: '' }] });
});
```

- [ ] **Step 2: Run** `pnpm vitest run packages/shared/src/ai.test.ts`. Expected: FAIL, `withProfileDefaults` não é exportado.
- [ ] **Step 3: Implement** as três mudanças de schema, as constantes, o tipo e o helper.
- [ ] **Step 4: Run** `pnpm vitest run packages/shared && pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `git add packages/shared && git commit -m "feat(shared): optional layout fields on the stored profile and a defaults helper" -m "Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>"`

### Task 2: Campos no fio; perfis antigos continuam lidos, editados e traduzidos

Um campo obrigatório no fio quebra todo lugar que monta um perfil de fio. Esta task muda o fio e conserta esses lugares do jeito mais simples (os campos passam adiante sem tratamento); o comportamento novo vem nas Tasks 3 a 5.

**Files:**
- Modify: `packages/shared/src/ai.ts:63-79` (`ProfileWireSchema`), `:92-138` (`normalizeProfile`)
- Modify: `packages/shared/src/ai.test.ts:16-31` (fixture `wire`), `:53-56` (habilidades novas com `group: ''`)
- Modify: `packages/ai/src/testing.ts:21-45`, `:52-82` (fixtures completas) e fim do arquivo (`LAYOUT_PROFILE`, `legacyProfile`)
- Modify: `packages/ai/src/fake.ts:163-198` (literais de `extract`: `:165-169`, `:183`, `:189`)
- Modify: `packages/ai/src/translation.ts:69-70`, `:124-149`; `packages/ai/src/tasks.ts:163-186` (`translateProfile`)
- Modify: `packages/ai/src/tasks-guards.test.ts:201-204`, `:220-223` (respostas de fio escritas à mão ganham `headline: ''`)
- Modify: `apps/web/src/lib/ai.ts:309-318` (`blankItem` e as duas funções novas)
- Modify: `apps/web/src/components/ProfileEditor.tsx:37-39`, `:102`, `:107`, `:112-114`, `:154`, `:172`
- Test: `packages/shared/src/ai.test.ts`, `packages/ai/src/tasks.test.ts`, `apps/web/src/lib/ai.test.ts`, `apps/api/src/ai.test.ts:156-178`

**Interfaces:**
- Consumes: `withProfileDefaults`, `WithLayout`, `EXPERIENCE_SECTIONS` (Task 1).
- Produces:

```ts
// packages/shared/src/ai.ts
// ProfileWireSchema ganha: headline: s | experiences[]: section: s, note: s | skills[]: group: s
export function normalizeProfile(wire: ProfileWire, opts: NormalizeOptions): WithLayout<CandidateProfile>; // sempre emite os quatro

// packages/ai/src/testing.ts
/** SAMPLE_PROFILE com os campos do modelo preenchidos. */
export const LAYOUT_PROFILE: CandidateProfile = {
  ...SAMPLE_PROFILE,
  headline: 'Desenvolvedora Front-end Sênior',
  experiences: [
    { ...SAMPLE_PROFILE.experiences[0], section: 'principal', note: 'Promovida após 18 meses' },
    { id: 'exp_aaaaaaa2', company: 'Outra Fictícia SA', title: 'Monitora de Programação', start: '2018', end: '2019', location: '',
      section: 'complementar', note: '', achievements: [{ id: 'ach_aaaaaaa3', text: 'Atendi 40 estudantes por semestre' }] },
  ],
  skills: [
    { id: 'skill_aaaaaaa1', name: 'React', group: 'Front-end' }, { id: 'skill_aaaaaaa2', name: 'TypeScript', group: 'Front-end' },
    { id: 'skill_aaaaaaa3', name: 'Node', group: 'Back-end & APIs' }, { id: 'skill_aaaaaaa4', name: 'PostgreSQL', group: 'Banco de dados' },
    { id: 'skill_aaaaaaa5', name: 'MySQL', group: 'Banco de dados' }, { id: 'skill_aaaaaaa6', name: 'Docker', group: 'DevOps & Kubernetes' },
  ],
};
/** O mesmo perfil como era gravado antes: sem headline, group, section e note. */
export function legacyProfile(profile: CandidateProfile): CandidateProfile;

// apps/web/src/lib/ai.ts
/** O perfil do servidor como o editor o edita: cópia profunda de `withProfileDefaults(data)`. */
export function editableProfile(data: CandidateProfile): ProfileWire;
/** Há alteração não salva? Compara o rascunho com `editableProfile(server)`, nunca com o dado cru do servidor. */
export function profileDirty(draft: ProfileWire, server: CandidateProfile): boolean;
```

`SAMPLE_PROFILE` e `REALISTIC_PROFILE` ganham `headline: ''`, `section: 'principal'` e `note: ''` em cada experiência e `group: ''` em cada habilidade. `blankItem.experience()` e `blankItem.skill()` ganham os mesmos padrões.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/shared/src/ai.test.ts (a fixture `wire` ganha headline: '', section: 'principal', note: '' e group: '')
it('always emits the four layout fields and coerces the section', () => {
  const profile = normalizeProfile({
    ...wire, headline: '  Tech Lead  ', skills: [{ id: '', name: 'React', group: 'Front-end' }],
    experiences: [{ ...wire.experiences[0], section: 'Complementar ', note: 'Antes: Estagiária' }, { ...wire.experiences[0], section: 'qualquer', note: '' }],
  }, { clamp: true, newId: counterIds() });
  expect(profile.headline).toBe('Tech Lead');
  expect(profile.experiences.map((e) => [e.section, e.note])).toEqual([['complementar', 'Antes: Estagiária'], ['principal', '']]);
  expect(profile.skills[0].group).toBe('Front-end');
  const { headline: _headline, ...old } = wire;
  expect(ProfileWireSchema.safeParse(old).success).toBe(false); // o fio não aceita mais o perfil sem os campos
});

// packages/ai/src/tasks.test.ts
it('translates a profile stored before the layout fields and returns it complete', async () => {
  const { data } = await translateProfile(fake, legacyProfile(SAMPLE_PROFILE), 'en');
  expect(data).toMatchObject({ headline: '', skills: [{ group: '' }, { group: '' }, { group: '' }], experiences: [{ section: 'principal', note: '' }] });
});
it('extracts the sample résumé with the four fields present', async () => { /* extractProfile(fake, SAMPLE_RESUME_TEXT): headline '', section 'principal', note '' e group '' em todos */ });

// apps/web/src/lib/ai.test.ts. `old` é um literal local igual ao `legacy` da Task 1 (o web não depende de `@kv/ai`).
// O teste de `blankItem` (`:220-231`) continua valendo, agora contra o ProfileWireSchema novo.
it('opens a profile stored before the change without marking it as edited', () => {
  const draft = editableProfile(old);
  expect(ProfileWireSchema.safeParse(draft).success).toBe(true);
  expect(old).not.toHaveProperty('headline'); // a entrada não foi tocada
  expect(profileDirty(draft, old)).toBe(false);
  expect(profileDirty(draft, withProfileDefaults(old))).toBe(false); // a versão completa do mesmo perfil não conta como edição
  expect(profileDirty({ ...draft, headline: 'Tech Lead' }, old)).toBe(true);
});

// apps/api/src/ai.test.ts, em "profile editing and translation"
it('reads a profile stored before the layout fields as it is, and saves it complete', async () => {
  await saveProfile(db, 'pt-BR', legacyProfile(SAMPLE_PROFILE), 'extraido');
  const [before] = (await app.inject({ method: 'GET', url: '/ai/profile' })).json().profiles;
  expect(before.data).not.toHaveProperty('headline'); // o banco não é reescrito na leitura
  const res = await put('pt-BR', { ...withProfileDefaults(before.data), headline: 'Desenvolvedora Front-end' });
  expect(res.statusCode).toBe(200);
  expect(res.json().data).toMatchObject({ headline: 'Desenvolvedora Front-end', skills: [{ group: '' }, { group: '' }, { group: '' }], experiences: [{ section: 'principal', note: '' }] });
});
it('refuses a body without the new fields and coerces an unknown section', async () => {
  await saveProfile(db, 'pt-BR', SAMPLE_PROFILE, 'extraido');
  expect((await put('pt-BR', legacyProfile(SAMPLE_PROFILE))).statusCode).toBe(400);
  const odd = { ...SAMPLE_PROFILE, experiences: [{ ...SAMPLE_PROFILE.experiences[0], section: 'Complementar ' }] };
  expect((await put('pt-BR', odd)).json().data.experiences[0].section).toBe('complementar');
});
```

No teste existente `saves an edit with a new version...` (`apps/api/src/ai.test.ts:159-170`), a habilidade nova enviada e a esperada ganham `group: ''`.

- [ ] **Step 2: Run** `pnpm vitest run packages/shared packages/ai/src/tasks.test.ts apps/web/src/lib/ai.test.ts apps/api/src/ai.test.ts`. Expected: FAIL (`legacyProfile` e `editableProfile` não existem; `headline` é descartado no PUT).
- [ ] **Step 3: Implement**, nesta ordem:
  - `ProfileWireSchema` e `normalizeProfile`. `headline`, `note` e `group` passam por `sh()`, como os outros textos curtos.
  - Fixtures, `LAYOUT_PROFILE` e `legacyProfile`; os três literais de `fake.ts` e os dois de `tasks-guards.test.ts`.
  - `translateProfile` (`tasks.ts`): a origem passa por `withProfileDefaults` antes de tudo; é essa versão que tem o tamanho medido, vai no prompt e entra em `mergeTranslation`. Em `mergeTranslation`, por enquanto, `headline`, `section`, `note` e `group` são copiados da origem.
  - `blankItem`, `editableProfile` e `profileDirty`. No `ProfileEditor`, `copyOf(x)` vira `editableProfile(x)` e `same(data, x)` vira `!profileDirty(data, x)` nos seis pontos listados; `copyOf` e `same` saem.
- [ ] **Step 4: Run** `pnpm test && pnpm typecheck`. Expected: PASS, inclusive `wire schemas are accepted by the three providers` (`packages/shared/src/ai.test.ts:73-100`).
- [ ] **Step 5: Commit** `git add packages apps && git commit -m "feat(shared,ai,web): layout fields on the wire profile; old profiles keep loading, saving and translating" -m "Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>"`

### Task 3: A adaptação copia o título; o verificador conhece título, grupos e notas

**Files:**
- Modify: `packages/ai/src/verify.ts:56-67` (`profileTexts`), `:69-82` (`numericTexts`), `:267-277` (o currículo resolvido)
- Test: `packages/ai/src/verify.test.ts`

**Interfaces:**
- Consumes: `LAYOUT_PROFILE`, `legacyProfile` (Task 2).
- Produces: `resolveTailored(...).resume.headline: string`, sempre presente (`''` quando o perfil não tem). `profileTexts(p)` passa a incluir `p.headline`, cada `note` e cada `group`; `mergeTranslation` usa a mesma função (`translation.ts:71`) e herda o vocabulário.

- [ ] **Step 1: Write the failing tests**

```ts
const draftFor = (p: CandidateProfile): TailoredDraft => ({
  summary: p.summary,
  experiences: p.experiences.map((e) => ({ id: e.id, achievements: e.achievements.map((a) => ({ sourceId: a.id, text: a.text })) })),
  educationIds: p.education.map((e) => e.id), skillIds: p.skills.map((k) => k.id), languageIds: p.languages.map((l) => l.id),
  certificationIds: [], linkIds: p.links.map((l) => l.id),
});
it('copies headline, section, note and group from the profile, never from the draft', () => {
  const { resume, violations } = resolveTailored(draftFor(LAYOUT_PROFILE), LAYOUT_PROFILE, 'pt-BR');
  expect(violations).toEqual([]);
  expect(resume.headline).toBe('Desenvolvedora Front-end Sênior');
  expect(resume.experiences.map((e) => [e.section, e.note])).toEqual([['principal', 'Promovida após 18 meses'], ['complementar', '']]);
  expect(resume.skills.map((k) => k.group)).toEqual(['Front-end', 'Front-end', 'Back-end & APIs', 'Banco de dados', 'Banco de dados', 'DevOps & Kubernetes']);
  const smuggled = { ...draftFor(LAYOUT_PROFILE), headline: 'CTO' };
  expect(TailoredDraftSchema.safeParse(smuggled).success).toBe(false);
  expect(resolveTailored(smuggled as TailoredDraft, LAYOUT_PROFILE, 'pt-BR').resume.headline).toBe('Desenvolvedora Front-end Sênior');
});
it('emits an empty headline for a profile stored before the change', () => {
  expect(resolveTailored(honest(), legacyProfile(SAMPLE_PROFILE), 'pt-BR')).toMatchObject({ violations: [], resume: { headline: '' } });
});
it('counts headline, groups and notes as profile vocabulary, for terms and for numbers', () => {
  const draft = { ...draftFor(LAYOUT_PROFILE), summary: 'Desenvolvedora Front-end Sênior com Kubernetes. Promovida após 18 meses.' };
  expect(resolveTailored(draft, LAYOUT_PROFILE, 'pt-BR').violations).toEqual([]);
  const bare = { ...LAYOUT_PROFILE, headline: '', skills: LAYOUT_PROFILE.skills.map((k) => ({ ...k, group: '' })),
    experiences: LAYOUT_PROFILE.experiences.map((e) => ({ ...e, note: '' })) };
  const blocked = resolveTailored(draft, bare, 'pt-BR').violations.map((v) => `${v.code}:${v.detail}`).join(' ');
  for (const expected of [/new_number:18/, /novel_term:s[eê]nior/i, /novel_term:kubernetes/i]) expect(blocked).toMatch(expected);
});
```

- [ ] **Step 2: Run** `pnpm vitest run packages/ai/src/verify.test.ts`. Expected: FAIL (`headline` indefinido; "Sênior", "Kubernetes" e "18" barrados com `LAYOUT_PROFILE`).
- [ ] **Step 3: Implement.** `headline`, `note` e `group` entram em `profileTexts` e em `numericTexts` (ausente conta como `''`); o currículo resolvido ganha `headline: profile.headline ?? ''`. Seção, nota e grupo já são copiados pelo espalhamento (`:263-264`) e por `pick` (`:273`).
- [ ] **Step 4: Run** `pnpm vitest run packages/ai apps/api apps/worker && pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `git add packages/ai && git commit -m "feat(ai): tailored résumé copies the headline; headline, groups and notes count as profile vocabulary" -m "Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>"`

### Task 4: A leitura e a tradução preenchem os campos

**Files:**
- Modify: `packages/ai/src/prompts.ts:43-49` (`TRANSLATION_RULES`), `:52-61` (instruções de `profile_extract` e `profile_translate`)
- Modify: `packages/ai/src/translation.ts:58-68` (comentário), `:104-149`; `packages/ai/src/fake.ts:144-156` (`translate` marca o título)
- Modify: `packages/ai/src/tasks.ts:49-60` (constantes e a conta do comentário), `packages/ai/src/limits.ts:3-14`, `:19-26` (tabela e conta do tempo limite)
- Test: `packages/ai/src/prompts.test.ts`, `packages/ai/src/tasks.test.ts`, `packages/ai/src/tasks-guards.test.ts` (`:181-186` e `:264-266` mudam de valor)

**Interfaces:**
- Consumes: vocabulário da Task 3; fixtures da Task 2.
- Produces:

```ts
// tasks.ts
export const PROFILE_OUTPUT_TOKENS = 9_000;
/** Folga em caracteres de JSON para `group` em até 60 competências, `section` e `note` por experiência e `headline`. */
export const PROFILE_LAYOUT_FIELDS_CHARS = 3_000;
export const PROFILE_JSON_MAX_CHARS = PROFILE_OUTPUT_TOKENS * 3; // 27 000
export const RESUME_TEXT_MAX_CHARS = Math.floor((PROFILE_JSON_MAX_CHARS - PROFILE_LAYOUT_FIELDS_CHARS) / 1.25); // 19 200, como antes
```

Texto acrescentado às instruções (exato; os testes procuram estes trechos):

- `profile_extract`, ao fim: `"headline" é o título profissional escrito logo abaixo do nome. Em cada item de "skills", "group" é o rótulo do grupo sob o qual a competência aparece no currículo, copiado como está e idêntico em todas as competências do mesmo grupo. Em cada experiência, "section" é "complementar" quando ela está sob um título de experiências complementares ou adicionais e "principal" nos demais casos; "note" é a linha, junto do período, que cita cargos anteriores na mesma empresa (não é uma realização). O que o currículo não trouxer fica como string vazia.`
- `profile_translate`: a frase de tradução passa a ser `Traduza resumo, cargos, realizações, cursos, níveis, rótulos, "headline", "note" e "group". O mesmo "group" recebe sempre a mesma tradução, em todas as competências. Copie "section" sem alterar.`
- `TRANSLATION_RULES`: em "Traduza só a prosa", a lista ganha `título profissional, notas e grupos`.

Regras de `mergeTranslation` para os campos novos:

- `headline`: `field(origem, tradução, 'rank', 'headline')`. `note`: `field(..., 'rank', 'experiences[i].note')`. `section`: copiada da origem.
- `group`: para cada grupo de origem distinto e não vazio (texto aparado), vale a tradução devolvida na **primeira** competência daquele grupo. Ela é aceita se for igual à origem ou se `problems(origem, tradução, 'label')` vier vazio; senão fica o rótulo de origem, sem violação. Todas as competências do grupo recebem o mesmo resultado. Grupo não passa por `name()`, que trataria "Back-end & APIs" como nome próprio e como lista.

- [ ] **Step 1: Write the failing tests**

```ts
// tasks-guards.test.ts: `violationsOf` ganha o segundo parâmetro `source`, como `translate` já tem
it('translates each skill group once and reuses it for every skill of the group', async () => { // Review Focus 4
  const { data } = await translate((p) => {
    p.skills[3].group = 'Databases';             // PostgreSQL, a primeira do grupo
    p.skills[4].group = 'Database';              // MySQL: outra tradução para o mesmo grupo
    p.skills[5].group = 'DevOps and Kubernetes'; // termos que só o grupo traz
  }, LAYOUT_PROFILE);
  expect(data.skills.map((k) => k.group)).toEqual(['Front-end', 'Front-end', 'Back-end & APIs', 'Databases', 'Databases', 'DevOps and Kubernetes']);
});
it('keeps the source group when its translation adds a number or a term, without failing', async () => {
  const { data } = await translate((p) => { p.skills[3].group = 'Databases (Oracle, 10 years)'; }, LAYOUT_PROFILE);
  expect(data.skills.slice(3, 5).map((k) => k.group)).toEqual(['Banco de dados', 'Banco de dados']);
});
it('translates headline and note under the title rules and copies the section', async () => {
  const { data } = await translate((p) => {
    p.headline = 'Senior Front-end Developer'; p.experiences[0].note = 'Promoted after 18 months'; p.experiences[1].section = 'principal';
  }, LAYOUT_PROFILE);
  expect([data.headline, data.experiences[0].note, data.experiences[1].section]).toEqual(['Senior Front-end Developer', 'Promoted after 18 months', 'complementar']);
  expect(await violationsOf((p) => { p.headline = 'Lead Front-end Developer'; }, LAYOUT_PROFILE)).toEqual(['novel_term@headline:lead']);
  expect(await violationsOf((p) => { p.experiences[0].note = 'Promoted after 24 months'; }, LAYOUT_PROFILE))
    .toEqual(['new_number@experiences[0].note:24', 'new_number@experiences[0].note:18']);
});
it('reserves room in the output for the layout fields of a profile at the item limits', () => {
  const skills = Array.from({ length: LIMITS.profileItems }, (_, i) => ({ id: '', name: `s${i}` }));
  const experiences = Array.from({ length: 12 }, () => ({ id: '', company: 'c', title: 't', start: '', end: '', location: '', achievements: [] }));
  const withFields = { headline: '', skills: skills.map((k) => ({ ...k, group: 'g'.repeat(30) })), experiences: experiences.map((e) => ({ ...e, section: 'complementar', note: '' })) };
  expect(JSON.stringify(withFields).length - JSON.stringify({ skills, experiences }).length).toBeLessThanOrEqual(PROFILE_LAYOUT_FIELDS_CHARS);
});
// Valores que mudam: `:183-185` passam a 9_000, 27_000 e 19_200. Em `:264-266`, `estimateInterruptedUsage` passa a dar
// tier2 { inputTokens: 14_300, outputTokens: 16_000 }, tier3 { 16_967, 14_000 } e profile_translate { 10_000, 17_000 }.

// tasks.test.ts
it('the fake provider marks the translated headline', async () => {
  expect((await translateProfile(fake, LAYOUT_PROFILE, 'en')).data.headline).toBe('[en] Desenvolvedora Front-end Sênior');
});

// prompts.test.ts
it('asks for the new fields when extracting and for one translation per group when translating', () => {
  const extract = buildPrompt('profile_extract', null, { text: 'x' }).system;
  for (const part of ['"headline"', '"group"', '"section"', '"note"', '"complementar"', '"principal"', 'idêntico em todas as competências']) expect(extract).toContain(part);
  const translate = buildPrompt('profile_translate', null, { target: 'en', profile: LAYOUT_PROFILE }).system;
  expect(translate).toContain('O mesmo "group" recebe sempre a mesma tradução');
  expect(translate).toContain('Copie "section" sem alterar');
});
```

- [ ] **Step 2: Run** `pnpm vitest run packages/ai`. Expected: FAIL nos testes novos e nos valores trocados.
- [ ] **Step 3: Implement** os prompts, as regras de `mergeTranslation`, `headline: tag(profile.headline)` no `translate` falso e as constantes. Em `limits.ts`, a linha "perfil (ler/traduzir)" da tabela passa a `9 000 | 8 000 | 17 000`, e a conta do tempo limite, a "17 000 tokens (425 s)".
- [ ] **Step 4: Run** `pnpm vitest run packages/ai apps/api apps/worker && pnpm typecheck`. Expected: PASS; `apps/api/src/ai-hardening.test.ts:64` continua achando "cerca de 6 páginas".
- [ ] **Step 5: Commit** `git add packages/ai && git commit -m "feat(ai): extraction and translation fill headline, groups, section and note; each group is translated once" -m "Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>"`

### Task 5: Editor de "Meu perfil"

**Files:**
- Modify: `apps/web/src/components/ProfileEditor.tsx:217-235` (título, entre o contato e o resumo), `:245-251` (grade da experiência), `:302-322` (habilidades)
- Modify: `apps/web/src/lib/ai.ts` (junto de `editableProfile`), `apps/web/e2e/profile-ai.spec.ts:154-159`
- Test: `apps/web/src/lib/ai.test.ts`

**Interfaces:**
- Consumes: `editableProfile`, `profileDirty` (Task 2); `EXPERIENCE_SECTIONS` (Task 1); `Segmented` de `components/ui/segmented.tsx`.
- Produces:

```ts
// apps/web/src/lib/ai.ts
export const SECTION_OPTIONS: readonly { value: ExperienceSection; label: string }[]; // 'Principal', 'Complementar'
/** Grupos já usados, aparados, sem vazios e sem repetição, na ordem em que aparecem: as sugestões do campo de grupo. */
export function skillGroupOptions(skills: readonly { group: string }[]): string[];
```

Campos, com estes rótulos:

- `Field` **"Título profissional"**, com a dica "Aparece abaixo do nome no PDF.", entre o bloco de contato e o resumo.
- Em cada experiência: `Segmented` **"Seção"** com `SECTION_OPTIONS` (valor que não for `complementar` conta como `principal`) e `Field` **"Nota"**, com a dica "Cargos anteriores na mesma empresa.", ocupando a largura inteira da grade.
- Em cada habilidade, abaixo do nome: `Input` com `aria-label="Grupo da habilidade N"`, `placeholder="Grupo"`, `maxLength={LIMITS.profileShort}` e `list` apontando para um `<datalist>` com `skillGroupOptions(data.skills)`. A grade passa a `@md:grid-cols-2 @3xl:grid-cols-3`.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/web/src/lib/ai.test.ts
it('suggests the groups in use once, in order, skipping empty ones', () => {
  expect(skillGroupOptions([{ group: 'Front-end' }, { group: '' }, { group: 'Dados' }, { group: 'Front-end' }, { group: ' Dados ' }])).toEqual(['Front-end', 'Dados']);
  expect(SECTION_OPTIONS.map((o) => o.value)).toEqual([...EXPERIENCE_SECTIONS]);
});

// apps/web/e2e/profile-ai.spec.ts, depois de conferir a origem "extraído" (linha 158)
await editor.getByLabel('Título profissional').fill('Desenvolvedora Front-end');
await editor.getByLabel('Grupo da habilidade 1').fill('Front-end');
await page.getByTestId('profile-save-pt-BR').click();
await expect(page.getByTestId('profile-origin-pt-BR')).toContainText('editado');
await expect(editor.getByLabel('Título profissional')).toHaveValue('Desenvolvedora Front-end');
await expect(page.getByTestId('profile-save-pt-BR')).toBeDisabled(); // salvo: nada pendente
```

- [ ] **Step 2: Run** `pnpm vitest run apps/web/src/lib/ai.test.ts`. Expected: FAIL, `skillGroupOptions` não é exportado.
- [ ] **Step 3: Implement** as duas exportações e os campos, com as classes dos campos vizinhos.
- [ ] **Step 4: Run** `pnpm vitest run apps/web && pnpm typecheck`, depois `pnpm e2e` (precisa de `docker compose up -d` e do Chromium do Playwright, como no README). Expected: PASS nos dois.
- [ ] **Step 5: Commit** `git add apps/web && git commit -m "feat(web): headline, skill group, experience section and note in the profile editor" -m "Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>"`

### Task 6: Fontes do PDF: Noto Serif

**Files:**
- Modify: `packages/resume/package.json:11`, `pnpm-lock.yaml` (gerado)
- Modify: `packages/resume/src/pdf-text.ts:9-14` (comentário), `:32`, `:63`, `:83-87` (comentário do `ASCII_FALLBACK`); `packages/resume/src/pdf.ts:166`
- Modify: `README.md:165`, `:345`, `:369`; `Dockerfile:10`
- Test: Create `packages/resume/src/pdf-text.test.ts`

**Interfaces:**
- Consumes: nada.
- Produces: `allFaces()`, `layoutLine()` e `sanitizePdfText()` com as mesmas assinaturas, lendo `@fontsource/noto-serif/files/noto-serif-<subconjunto>-<400|700>-normal.woff`. Os nomes de fonte (`regular-latin`, `bold-greek`...) não mudam.

- [ ] **Step 1: Write the failing tests** em `packages/resume/src/pdf-text.test.ts`

```ts
it('loads Noto Serif, regular and bold, in the seven subsets', () => {
  const faces = allFaces();
  expect(faces).toHaveLength(14);
  expect(faces.every((f) => f.path.includes('noto-serif-'))).toBe(true);
});
it('draws the signs the layout itself writes, in both weights', () => { // Review Focus 5
  for (const weight of ['regular', 'bold'] as const) {
    const missing = new Set<string>();
    expect(layoutLine('• · | -', weight, missing).map((r) => r.text).join('')).toBe('• · | -');
    expect([...missing]).toEqual([]);
  }
  expect(sanitizePdfText('• ·')).toBe('• ·'); // não caem no "-" de ASCII_FALLBACK
});
it('never loses a typographic sign: each one is drawn or replaced', () => {
  const missing = new Set<string>();
  for (const sign of ['→', '⇒', '≥', '…', '“', '”', '–', '—', '‣', '€']) layoutLine(sanitizePdfText(sign), 'regular', missing);
  expect([...missing]).toEqual([]);
});
```

- [ ] **Step 2: Run** `pnpm vitest run packages/resume/src/pdf-text.test.ts`. Expected: FAIL no primeiro teste (os caminhos são de `noto-sans`).
- [ ] **Step 3: Implement.** `pnpm --filter @kv/resume remove @fontsource/noto-sans` e `pnpm --filter @kv/resume add "@fontsource/noto-serif@^5.3.0"` (o lockfile fica em 5.3.0); troque os dois caminhos e os textos que citam a fonte (README: "Noto Serif" e o pacote novo, licença OFL-1.1).
- [ ] **Step 4: Run** `pnpm vitest run packages/resume && pnpm typecheck`, e `git grep -n -i "noto[- ]sans" -- . ":!pnpm-lock.yaml" ":!docs"`. Expected: PASS e nenhuma linha no grep. Se o segundo teste falhar ("•" ou "·" sem glifo limpo), **pare e avise**: o layout depende dos dois sinais, e trocar o marcador é decisão do dono. Se só `writes an ascii equivalent...` (`pdf.test.ts:129-137`) falhar porque a Noto Serif desenha um sinal que a Noto Sans substituía, ajuste a string esperada para o que `sanitizePdfText` devolve e diga qual sinal mudou no corpo do commit.
- [ ] **Step 5: Commit** `git add packages/resume pnpm-lock.yaml README.md Dockerfile && git commit -m "feat(resume): embed Noto Serif in generated PDFs" -m "Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>"`

### Task 7: O texto do currículo (`pdf-content.ts`)

Decide o que está escrito em cada linha e em que ordem, sem fonte nem posição. O renderer antigo continua em uso até a Task 8.

**Files:**
- Create: `packages/resume/src/pdf-content.ts`
- Modify: `packages/resume/src/testing.ts` (fim do arquivo: `SAMPLE_TAILORED`)
- Test: Create `packages/resume/src/pdf-content.test.ts`

**Interfaces:**
- Consumes: `withProfileDefaults` (Task 1).
- Produces:

```ts
export type SectionKey = 'summary' | 'skills' | 'experience' | 'additional' | 'education' | 'languages' | 'certifications';
export const SECTION_ORDER: readonly SectionKey[]; // a ordem do tipo acima, que é a do modelo
export const SECTION_TITLES: Record<ResumeLang, Record<SectionKey, string>>;
export type ContentSection =
  | { key: 'summary'; title: string; text: string }
  | { key: 'skills'; title: string; groups: { label: string; items: string }[] } // label 'Front-end:' ou ''
  | { key: 'experience' | 'additional'; title: string; items: { role: string; meta: string; achievements: string[] }[] }
  | { key: 'education' | 'certifications'; title: string; lines: string[] }
  | { key: 'languages'; title: string; line: string };
export interface ResumeContent {
  name: string;               // em caixa alta
  headline: string;           // em caixa alta; '' quando não há
  contact: string[];          // partes, na ordem: local, telefone, e-mail, links
  footerName: string;
  sections: ContentSection[]; // só as que têm conteúdo, na ordem do modelo, com o título em caixa alta
}
export function resumeContent(resume: TailoredResume): ResumeContent;
export function formatResumeDate(value: string, lang: ResumeLang): string;
export function formatPeriod(start: string, end: string, lang: ResumeLang): string;
export function footerName(name: string): string;
export function bareUrl(url: string): string;
```

Títulos (`SECTION_TITLES`), na ordem: pt-BR "Resumo profissional", "Competências técnicas", "Experiência profissional", "Experiências complementares", "Formação acadêmica", "Idiomas", "Certificações"; en "Professional summary", "Technical skills", "Professional experience", "Additional experience", "Education", "Languages", "Certifications".

Regras:

- Caixa alta com `toUpperCase()`, sobre o texto cru. Meses: `Jan Fev Mar Abr Mai Jun Jul Ago Set Out Nov Dez` e `Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec`.
- `formatResumeDate`: apara; `AAAA-MM` com mês de 01 a 12 vira "Mês AAAA"; o resto sai como veio. `formatPeriod`: os dois vazios dão `''`; senão, início e fim formatados e unidos por `' - '`, com "Atual" ou "Present" no lugar do fim vazio (só o fim preenchido sai sozinho).
- `footerName`: uma linha só (quebras de linha viram espaço). Nome "todo em maiúsculas" é o que tem letra e é igual ao próprio `toUpperCase()`: nesse caso cada palavra (separada por espaço ou hífen) fica com só a inicial maiúscula, e "da", "de", "do", "das", "dos" e "e" ficam em minúsculas quando não são a primeira palavra. Qualquer outro nome sai como está.
- `bareUrl`: tira `http://` ou `https://` (sem diferenciar maiúsculas) e a barra final. Contato: partes aparadas; as vazias ficam de fora.
- Competências: um grupo por rótulo (aparado), na ordem em que cada rótulo aparece pela primeira vez; itens unidos por `', '`; as sem grupo vão por último com `label: ''`.
- Experiências: `section === 'complementar'` vai para `additional`; todo o resto, para `experience`. `role` = cargo e empresa unidos por `' - '`. `meta` = período e local unidos por `' | '`, e a nota depois de `' · '`. Parte vazia some junto com o separador.
- Formação: `"Curso - Instituição | período"`. Idiomas: `"Nome: nível"` (só o nome quando não há nível), unidos por `' | '`. Certificações: `"Nome - Emissor | data"`, com a data formatada.

- [ ] **Step 1: Write the fixture and the failing tests**

```ts
// packages/resume/src/testing.ts
export const SAMPLE_TAILORED: TailoredResume = {
  lang: 'pt-BR',
  contact: { name: 'Maria Exemplo da Silva', email: 'maria@exemplo.test', phone: '+55 11 90000-0000', location: 'São Paulo, SP' },
  headline: 'Desenvolvedora Front-end Sênior',
  summary: 'Pessoa fictícia para testes: desenvolvedora front-end com foco em React.',
  experiences: [
    { id: 'exp_ccccccc1', company: 'Empresa Fictícia Ltda', title: 'Desenvolvedora Front-end Sênior', start: '2021-03', end: '', location: 'Remoto',
      section: 'principal', note: 'Antes: Desenvolvedora Pleno (2019-2021)',
      achievements: [{ sourceId: 'ach_ccccccc1', text: 'Reduzi o tempo de build em 40% com a migração para Vite' }, { sourceId: 'ach_ccccccc2', text: 'Liderei 3 pessoas no redesenho do checkout' }] },
    { id: 'exp_ccccccc2', company: 'Outra Fictícia SA', title: 'Monitora de Programação', start: '2018', end: '2019-12', location: '',
      section: 'complementar', note: '', achievements: [{ sourceId: 'ach_ccccccc3', text: 'Atendi 40 estudantes por semestre' }] },
  ],
  education: [{ id: 'edu_ccccccc1', institution: 'Universidade Exemplo', degree: 'Ciência da Computação', start: '2015', end: '2019' }],
  skills: [
    { id: 'skill_ccccccc1', name: 'React', group: 'Front-end' }, { id: 'skill_ccccccc2', name: 'Node.js', group: 'Back-end & APIs' },
    { id: 'skill_ccccccc3', name: 'TypeScript', group: 'Front-end' }, { id: 'skill_ccccccc4', name: 'Git', group: '' },
  ],
  languages: [{ id: 'lang_ccccccc1', name: 'Inglês', level: 'avançado' }, { id: 'lang_ccccccc2', name: 'Espanhol', level: '' }],
  certifications: [{ id: 'cert_ccccccc1', name: 'Certificação Fictícia', issuer: 'Instituto Exemplo', date: '2022-05' }],
  links: [{ id: 'link_ccccccc1', label: 'Portfólio', url: 'https://exemplo.test/maria/' }, { id: 'link_ccccccc2', label: 'Rede', url: 'https://www.rede.exemplo.test/in/maria' }],
};

// packages/resume/src/pdf-content.test.ts
it('formats dates, periods, links and the footer name', () => {
  expect([formatResumeDate('2026-02', 'pt-BR'), formatResumeDate('2026-02', 'en'), formatResumeDate(' 2019 ', 'en')]).toEqual(['Fev 2026', 'Feb 2026', '2019']);
  expect([formatResumeDate('mar/2021', 'pt-BR'), formatResumeDate('2021-13', 'pt-BR'), formatResumeDate('', 'en')]).toEqual(['mar/2021', '2021-13', '']);
  expect([formatPeriod('2021-03', '', 'pt-BR'), formatPeriod('2021-03', '', 'en'), formatPeriod('', '', 'en'), formatPeriod('', '2019', 'en')])
    .toEqual(['Mar 2021 - Atual', 'Mar 2021 - Present', '', '2019']);
  expect([bareUrl('https://exemplo.test/maria/'), bareUrl('HTTP://Exemplo.test')]).toEqual(['exemplo.test/maria', 'Exemplo.test']);
  expect(footerName('JOÃO CONCEIÇÃO E SOUZA-LIMA')).toBe('João Conceição e Souza-Lima');
  expect(footerName('Maria exemplo da SILVA')).toBe('Maria exemplo da SILVA'); // não está toda em maiúsculas: sai como está
});
it('writes the header, the sections in the order of the model and every line', () => {
  const c = resumeContent(SAMPLE_TAILORED);
  expect(c).toMatchObject({ name: 'MARIA EXEMPLO DA SILVA', headline: 'DESENVOLVEDORA FRONT-END SÊNIOR', footerName: 'Maria Exemplo da Silva' });
  expect(c.contact).toEqual(['São Paulo, SP', '+55 11 90000-0000', 'maria@exemplo.test', 'exemplo.test/maria', 'www.rede.exemplo.test/in/maria']);
  expect(c.sections.map((s) => s.title)).toEqual(['RESUMO PROFISSIONAL', 'COMPETÊNCIAS TÉCNICAS', 'EXPERIÊNCIA PROFISSIONAL', 'EXPERIÊNCIAS COMPLEMENTARES', 'FORMAÇÃO ACADÊMICA', 'IDIOMAS', 'CERTIFICAÇÕES']);
  expect(c.sections.slice(1)).toMatchObject([
    { groups: [{ label: 'Front-end:', items: 'React, TypeScript' }, { label: 'Back-end & APIs:', items: 'Node.js' }, { label: '', items: 'Git' }] },
    { items: [{ role: 'Desenvolvedora Front-end Sênior - Empresa Fictícia Ltda', meta: 'Mar 2021 - Atual | Remoto · Antes: Desenvolvedora Pleno (2019-2021)' }] },
    { items: [{ role: 'Monitora de Programação - Outra Fictícia SA', meta: '2018 - Dez 2019', achievements: ['Atendi 40 estudantes por semestre'] }] },
    { lines: ['Ciência da Computação - Universidade Exemplo | 2015 - 2019'] }, { line: 'Inglês: avançado | Espanhol' }, { lines: ['Certificação Fictícia - Instituto Exemplo | Mai 2022'] },
  ]);
});
it('uses the english titles, months and "Present", and skips empty sections', () => {
  const c = resumeContent({ ...SAMPLE_TAILORED, lang: 'en' });
  expect(c.sections.map((s) => s.title)).toEqual(['PROFESSIONAL SUMMARY', 'TECHNICAL SKILLS', 'PROFESSIONAL EXPERIENCE', 'ADDITIONAL EXPERIENCE', 'EDUCATION', 'LANGUAGES', 'CERTIFICATIONS']);
  for (const part of ['Mar 2021 - Present', '2018 - Dec 2019', '| May 2022']) expect(JSON.stringify(c)).toContain(part);
  expect(resumeContent({ ...SAMPLE_TAILORED, summary: '', experiences: [], certifications: [] }).sections.map((s) => s.key)).toEqual(['skills', 'education', 'languages']);
});
it('renders a résumé stored before the layout fields', () => { // Review Focus 1
  const { headline: _headline, ...rest } = SAMPLE_TAILORED;
  const old = { ...rest, skills: rest.skills.map(({ group: _g, ...k }) => k), experiences: rest.experiences.map(({ section: _s, note: _n, ...e }) => e) };
  const c = resumeContent(old);
  expect(c.headline).toBe('');
  expect(c.sections.map((s) => s.key)).toEqual(['summary', 'skills', 'experience', 'education', 'languages', 'certifications']);
  expect(c.sections[1]).toMatchObject({ groups: [{ label: '', items: 'React, Node.js, TypeScript, Git' }] });
  expect(c.sections[2]).toMatchObject({ items: [{ meta: 'Mar 2021 - Atual | Remoto' }, { meta: '2018 - Dez 2019' }] });
  expect(JSON.stringify(c)).not.toContain('undefined');
});
it('upper-cases the raw name and keeps the footer readable', () => { // Review Focus 2
  const named = (name: string) => resumeContent({ ...SAMPLE_TAILORED, contact: { ...SAMPLE_TAILORED.contact, name } });
  expect(named('MARIA EXEMPLO DA SILVA')).toMatchObject({ name: 'MARIA EXEMPLO DA SILVA', footerName: 'Maria Exemplo da Silva' });
  expect(named('Jörg Straße')).toMatchObject({ name: 'JÖRG STRASSE', footerName: 'Jörg Straße' });
});
```

- [ ] **Step 2: Run** `pnpm vitest run packages/resume/src/pdf-content.test.ts`. Expected: FAIL, o módulo não existe.
- [ ] **Step 3: Implement** `pdf-content.ts`. `resumeContent` começa por `withProfileDefaults(resume)`.
- [ ] **Step 4: Run** `pnpm vitest run packages/resume && pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `git add packages/resume && git commit -m "feat(resume): text of every résumé line in the owner's layout, in both languages" -m "Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>"`

### Task 8: Geometria e desenho: o renderer no modelo

**Files:**
- Create: `packages/resume/src/pdf-layout.ts`, `packages/resume/src/pdf-layout.test.ts`
- Modify: `packages/resume/src/pdf.ts:1-18` (saem `LABELS`, `INK`, `MUTED`), `:49-139` (`plan` e `prepare`), `:154-201` (comentários e desenho)
- Modify: `packages/resume/src/pdf.test.ts:8-28` (fixture), `:42-91`, `:93-107`, `:114-127`, `:152-160`; `apps/api/src/tailored.test.ts:134-148`
- Test: `packages/resume/src/pdf-layout.test.ts`, `packages/resume/src/pdf.test.ts`, `apps/api/src/tailored.test.ts`

**Interfaces:**
- Consumes: `resumeContent`, `ResumeContent`, `SAMPLE_TAILORED` (Task 7); `sanitizePdfText`, `layoutLine`, `allFaces` com Noto Serif (Task 6); as constantes de "Constantes do layout".
- Produces (as assinaturas públicas de `pdf.ts` não mudam: `renderResumePdf`, `unsupportedPdfCharacters`, `ResumePdfError`, `PDF_LIMITS`):

```ts
// pdf-layout.ts (além de PAGE, COLOR, TYPE e GEOMETRY)
export type StyleName = keyof typeof TYPE;
/** Uma linha lógica do documento; quebra sozinha quando não cabe. */
export interface Block {
  segments: { text: string; style: StyleName }[];
  gapBefore: number;    // da linha de base anterior até a primeira linha deste bloco
  lineGap: number;      // entre as linhas do próprio bloco
  x: number;
  bullet?: true;        // "• " em GEOMETRY.bulletX, na primeira linha
  keepWithNext?: true;  // nunca é a última coisa de uma página
  wrap?: 'parts';       // linha de contato: segmentos pares são partes; ímpares, o separador ' • '
  ruleAfter?: number;   // fio a esta distância abaixo da última linha do bloco
}
export function blocksOf(content: ResumeContent): Block[];
export interface PlacedRun { text: string; font: string; size: number; color: string }
export interface PlacedLine { x: number; y: number; runs: PlacedRun[] } // y = linha de base, a partir do topo
export interface PageLayout { lines: PlacedLine[]; ruleY: number | null; footer: PlacedLine }
/** Uma entrada de `lines` por linha forçada ("\n"); no contato, uma por segmento. */
export type ShapedBlock = Omit<Block, 'segments'> & { lines: PlacedRun[][] };
/** Saneia cada texto e o divide em trechos de uma fonte só; o que não tem glifo vai para `missing`. Não mede nada. */
export function shapeBlocks(blocks: Block[], missing: Set<string>): ShapedBlock[];
export type Measure = (text: string, font: string, size: number) => number;
export function layoutPages(blocks: ShapedBlock[], footerName: string, measure: Measure): PageLayout[];
```

`blocksOf` aplica as tabelas do spec:

| Bloco | Estilo | x | `gapBefore` | `lineGap` | Marcas |
|---|---|---|---|---|---|
| Nome | `name` | 50 | `nameBaseline` | 1,3 x 20 | |
| Título profissional | `headline` | 50 | `nameToHeadline` | 1,3 x 10,5 | |
| Contato | `contact` | 50 | `headlineToContact`; sem título, `nameToHeadline` | `contactLine` | `wrap: 'parts'` |
| Título de seção | `section` | 50 | a primeira, `headerToSection`; depois de uma seção de experiências, `achievementsToSection`; nas demais, `bodyToSection` | 1,3 x 10,5 | `keepWithNext` |
| Resumo, idiomas | `body` | 50 | `sectionToFirst` | `bodyLine` | |
| Grupo de competências | `groupLabel` ("Rótulo: ") + `body` | 50 | o primeiro, `sectionToFirst`; os demais, `skillGroups` | `bodyLine` | |
| "Cargo - Empresa" | `role` | 50 | o primeiro, `sectionToFirst`; os demais, `experiences` | 1,3 x 9 | `keepWithNext` |
| Período, local e nota | `meta` | 50 | `roleToMeta` | 1,3 x 8 | `keepWithNext` |
| Realização | `body` | `achievementX` | a primeira, `metaToAchievement`; as demais, `achievements` | `achievementLine` | `bullet` |
| Formação, certificação | `body` | 50 | a primeira, `sectionToFirst`; as demais, `listItems` | `bodyLine` | |

O último bloco do cabeçalho (contato, ou título, ou nome) leva `ruleAfter: GEOMETRY.ruleBelowHeader`. Bloco de texto vazio não é criado.

`layoutPages`, na ordem:

1. **Quebra de linha.** Cada linha forçada é preenchida palavra a palavra enquanto a soma de `measure` couber em `PAGE.width - PAGE.margin - x`. Pode quebrar depois de um espaço ou entre dois trechos vizinhos; o espaço do fim da linha não é desenhado; uma palavra mais larga que a linha fica sozinha nela. Trechos vizinhos de mesma fonte, tamanho e cor viram um só. Linha forçada vazia no meio do bloco ocupa uma linha; no fim, nada.
2. **Contato (`wrap: 'parts'`).** Cada parte é medida inteira. A que não cabe abre a linha seguinte, e o separador antes dela não é desenhado. Uma parte mais larga que a linha quebra como texto comum.
3. **Posição.** A página 1 começa em `y = 0`. A primeira linha do bloco fica `gapBefore` abaixo da linha de base anterior; as seguintes, `lineGap` abaixo.
4. **Página.** Nenhuma linha de base passa de `PAGE.height - PAGE.margin`. A linha que passaria abre outra página em `y = PAGE.margin + tamanho do primeiro trecho`, sem `gapBefore`.
5. **`keepWithNext`.** Antes de posicionar um bloco marcado, soma-se a altura dele e dos blocos seguintes até a primeira linha do primeiro bloco sem a marca. Se essa linha não couber, o bloco marcado já abre a página nova. Em página vazia não há quebra.
6. **Marcador e fio.** `bullet` acrescenta, na mesma linha de base da primeira linha, uma `PlacedLine` em `GEOMETRY.bulletX` com o trecho `"• "` no estilo `body` (o espaço garante "• texto" no texto copiado). `ruleAfter` define `ruleY` da página em que o bloco termina.
7. **Rodapé.** Em toda página: `"<footerName> • <número>"`, estilo `footer`, centralizado em `PAGE.width / 2`, com a linha de base em `PAGE.height - GEOMETRY.footerFromBottom`.

Em `pdf.ts`: `prepare` passa a ser `resumeContent` -> `blocksOf` -> `shapeBlocks`. O total para `too_long` é a soma dos textos dos blocos; os caracteres sem glifo saem de `missing`, incluído o nome do rodapé. `renderResumePdf` cria o documento com `margin: 50`, chama `layoutPages` com `measure = doc.font(fonte).fontSize(tamanho).widthOfString(texto)` (com memória por chave, para o teste de tempo) e desenha página por página, na ordem de leitura: cada trecho com `doc.text(texto, x, y, { lineBreak: false, baseline: 'alphabetic' })`, o fio com `moveTo`/`lineTo`/`stroke` de `ruleX1` a `ruleX2`, espessura `ruleWidth` e cor `COLOR.rule`, e o rodapé por último. `lineBreak: false` impede o pdfkit de abrir páginas por conta própria. O comentário de `renderResumePdf` (`:162-170`) passa a descrever o modelo.

- [ ] **Step 1: Write the failing layout tests** em `packages/resume/src/pdf-layout.test.ts`

```ts
const narrow: Measure = (text, _font, size) => text.length * size * 0.1; // nada quebra
const wide: Measure = (text, _font, size) => text.length * size * 0.6;   // o contato passa de uma linha
const pagesOf = (resume: TailoredResume, measure: Measure) => {
  const content = resumeContent(resume);
  return layoutPages(shapeBlocks(blocksOf(content), new Set()), content.footerName, measure);
};
const textOf = (line: PlacedLine) => line.runs.map((r) => r.text).join('');
const textLines = (page: PageLayout) => page.lines.filter((l) => l.x !== GEOMETRY.bulletX);
const ys = (page: PageLayout) => textLines(page).map((l) => Math.round(l.y * 10) / 10);

it('places every baseline of the sample résumé at the distances of the model', () => {
  const [page] = pagesOf(SAMPLE_TAILORED, narrow);
  expect(ys(page)).toEqual([
    66.4, 83.5, 97.1,                  // nome, título, contato
    127.2, 143.8,                      // RESUMO PROFISSIONAL e o resumo
    167.7, 184.3, 199.5, 214.7,        // COMPETÊNCIAS TÉCNICAS e três linhas de grupo
    238.6, 255.2, 268.9, 283.6, 297.7, // EXPERIÊNCIA PROFISSIONAL: cargo, período, duas realizações
    334.6, 351.2, 364.9, 379.6,        // EXPERIÊNCIAS COMPLEMENTARES
    416.5, 433.1, 457, 473.6, 497.5, 514.1, // FORMAÇÃO ACADÊMICA, IDIOMAS e CERTIFICAÇÕES, cada uma com uma linha
  ]);
  expect(page.ruleY).toBeCloseTo(105.7, 1);
});
it('reproduces the header of the model when the contact takes two lines', () => {
  const [page] = pagesOf(SAMPLE_TAILORED, wide);
  expect(ys(page).slice(0, 5)).toEqual([66.4, 83.5, 97.1, 108, 138.1]);
  expect(page.ruleY).toBeCloseTo(116.6, 1);
  expect(page.lines.slice(2, 4).map(textOf)).toEqual(['São Paulo, SP • +55 11 90000-0000 • maria@exemplo.test • exemplo.test/maria', 'www.rede.exemplo.test/in/maria']);
});
it('closes up the header when there is no headline and centres the footer', () => {
  const [page] = pagesOf({ ...SAMPLE_TAILORED, headline: '' }, narrow);
  expect(ys(page).slice(0, 3)).toEqual([66.4, 83.5, 113.6]); // nome, contato, primeira seção
  expect(page.ruleY).toBeCloseTo(92.1, 1);
  expect(page.footer.x + narrow(textOf(page.footer), '', 7) / 2).toBeCloseTo(PAGE.width / 2, 1);
});
it('uses the type scale of the model', () => {
  const [page] = pagesOf(SAMPLE_TAILORED, narrow);
  const style = (i: number) => { const [r] = textLines(page)[i].runs; return [r.font.split('-')[0], r.size, r.color]; };
  expect([0, 2, 4, 10].map(style)).toEqual([['bold', 20, '#1f2a44'], ['regular', 8, '#6b7280'], ['regular', 8.5, '#222222'], ['bold', 9, '#1f2a44']]); // nome, contato, corpo, cargo
  const group = page.lines.find((l) => textOf(l).startsWith('Front-end:'))!;
  expect(group.runs.map((r) => [r.text, r.font.split('-')[0], r.color])).toEqual([['Front-end: ', 'bold', '#1f2a44'], ['React, TypeScript', 'regular', '#222222']]);
  expect(page.footer.runs[0]).toMatchObject({ size: 7, color: '#6b7280' });
});
it('hangs the achievements: bullet at 54.1, every text line at 63.1', () => {
  const long = { ...SAMPLE_TAILORED.experiences[0], achievements: [{ sourceId: 'ach_ccccccc1', text: 'palavra '.repeat(30).trim() }, { sourceId: 'ach_ccccccc2', text: 'curta' }] };
  const [page] = pagesOf({ ...SAMPLE_TAILORED, experiences: [long] }, (t, _f, size) => t.length * size * 0.5);
  const body = page.lines.filter((l) => l.x === GEOMETRY.achievementX);
  expect(body).toHaveLength(4); // a primeira realização ocupa três linhas; a segunda, uma
  expect([body[1].y - body[0].y, body[3].y - body[2].y].map((d) => Math.round(d * 10) / 10)).toEqual([12.6, 14.1]); // dentro e entre
  const bullets = page.lines.filter((l) => l.x === GEOMETRY.bulletX);
  expect(bullets.map(textOf)).toEqual(['• ', '• ']);
  expect(bullets.map((l) => l.y)).toEqual([body[0].y, body[3].y]); // na primeira linha de cada uma
});
it('breaks twenty achievements across pages without orphans, with a numbered footer on every page', () => { // Review Focus 3
  const many = { ...SAMPLE_TAILORED.experiences[0], achievements: Array.from({ length: 20 }, (_, i) => ({ sourceId: 'ach_ccccccc1', text: `Realização número ${i + 1}` })) };
  for (let extra = 0; extra < 60; extra++) { // desloca o conteúdo linha a linha, para toda posição cair no pé da página
    const summary = Array.from({ length: extra + 1 }, () => 'linha').join('\n');
    const pages = pagesOf({ ...SAMPLE_TAILORED, summary, experiences: [many, many, many, many] }, narrow);
    expect(pages.length).toBeGreaterThan(1);
    pages.forEach((page, i) => {
      expect(Math.max(...page.lines.map((l) => l.y))).toBeLessThanOrEqual(PAGE.height - PAGE.margin);
      expect(textOf(page.footer)).toBe(`Maria Exemplo da Silva • ${i + 1}`);
      expect(page.footer.y).toBeCloseTo(PAGE.height - 38, 1);
      if (i > 0) expect(page.lines[0].y).toBeCloseTo(PAGE.margin + page.lines[0].runs[0].size, 1);
      if (i < pages.length - 1) expect(page.lines.at(-1)!.runs[0].size, `página ${i + 1}, ${extra} linhas a mais`).toBe(8.5); // corpo: nunca título, cargo ou período
    });
    expect(pages.flatMap((p) => p.lines).filter((l) => textOf(l) === 'Realização número 20')).toHaveLength(4);
  }
});
```

- [ ] **Step 2: Run** `pnpm vitest run packages/resume/src/pdf-layout.test.ts`. Expected: FAIL, o módulo não existe.
- [ ] **Step 3: Implement** `pdf-layout.ts`.
- [ ] **Step 4: Run** `pnpm vitest run packages/resume/src/pdf-layout.test.ts`. Expected: PASS.
- [ ] **Step 5: Rewrite the PDF tests** em `packages/resume/src/pdf.test.ts`. A fixture `resume` ganha `headline: 'Engenheiro de Software'`; na primeira experiência, `section: 'principal'` e `note: 'Antes: Estagiário'`; na segunda, `section: 'complementar'` e `note: ''`; nas duas habilidades, `group: 'Front-end'`.

```ts
// 'produces real, selectable text...': a lista esperada passa a ser
['JOÃO CONCEIÇÃO EXEMPLO', 'ENGENHEIRO DE SOFTWARE', 'São Paulo, SP • +55 11 90000-0000 • joao@exemplo.test • exemplo.test/joao',
 'ã õ á é í ó ú â ê ô à ç ü Ã Õ Ç É', 'Front-end: React, TypeScript', 'Desenvolvedora Sênior - Empresa Fictícia Ltda',
 'Mar 2021 - Atual | Remoto · Antes: Estagiário', 'Reduzi o tempo de build em 40% com a migração para Vite',
 'Economia de R$ 1.000,00 por mês: "infra" mais simples', 'Estagiário - Outra Fictícia S.A.', '2019 - 2020',
 'Ciência da Computação - Universidade Exemplo | 2015 - 2019', 'Inglês: avançado', 'Certificação Fictícia - Instituto Exemplo | 2022',
 'João Conceição Exemplo • 1']
expect(text).toMatch(/•\s?Reduzi o tempo de build/);
for (const absent of ['Portfólio', 'https://']) expect(text).not.toContain(absent); // rótulo de link e esquema não são impressos
// 'is a single column...': os marcadores passam a ser
['JOÃO CONCEIÇÃO EXEMPLO', 'RESUMO PROFISSIONAL', 'COMPETÊNCIAS TÉCNICAS', 'EXPERIÊNCIA PROFISSIONAL', 'Desenvolvedora Sênior -', 'Reduzi o tempo',
 'EXPERIÊNCIAS COMPLEMENTARES', 'Estagiário -', 'FORMAÇÃO ACADÊMICA', 'IDIOMAS', 'CERTIFICAÇÕES', 'João Conceição Exemplo • 1']
// 'uses english headings...', com { ...resume, lang: 'en', certifications: [], summary: '' }
for (const expected of ['TECHNICAL SKILLS', 'PROFESSIONAL EXPERIENCE', 'ADDITIONAL EXPERIENCE', 'Mar 2021 - Present']) expect(text).toContain(expected);
for (const absent of ['CERTIFICATIONS', 'PROFESSIONAL SUMMARY', 'EXPERIÊNCIA']) expect(text).not.toContain(absent);
// 'breaks a long resume into pages...': além das quatro "Realização número 20 "
const footers = text.match(/João Conceição Exemplo • \d+/g) ?? [];
expect(footers.length).toBeGreaterThan(1);
expect(footers).toEqual(footers.map((_, i) => `João Conceição Exemplo • ${i + 1}`));
// 'keeps polish, czech...': além do nome como foi gravado (rodapé), o texto contém `names.toUpperCase()` (cabeçalho)
// 'renders a pathological unbroken token...': a URL esperada perde o `https://`
// 'refuses characters...': os campos novos também são conferidos (Review Focus 5)
expect(unsupportedPdfCharacters({ ...resume, headline: '日本' })).toEqual(['日', '本']);
expect(unsupportedPdfCharacters({ ...resume, experiences: [{ ...resume.experiences[0], note: 'ok ✓' }] })).toEqual(['✓']);
expect(unsupportedPdfCharacters({ ...resume, skills: [{ id: 'skill_aaaaaaa1', name: 'React', group: '語' }] })).toEqual(['語']);

it('prints a name stored in capitals in title case in the footer, and upper-cases before checking glyphs', async () => { // Review Focus 2 e 5
  expect(await textOf({ ...resume, contact: { ...resume.contact, name: 'JOÃO CONCEIÇÃO EXEMPLO' } })).toContain('João Conceição Exemplo • 1');
  const german = { ...resume, contact: { ...resume.contact, name: 'Jörg Straße' } };
  expect(unsupportedPdfCharacters(german)).toEqual([]);
  const text = await textOf(german);
  for (const expected of ['JÖRG STRASSE', 'Jörg Straße • 1']) expect(text).toContain(expected);
});
it('renders a résumé stored before the layout fields', async () => { // Review Focus 1
  const { headline: _headline, ...rest } = resume;
  const old = { ...rest, skills: rest.skills.map(({ group: _g, ...k }) => k), experiences: rest.experiences.map(({ section: _s, note: _n, ...e }) => e) };
  const text = await textOf(old);
  for (const expected of ['React, TypeScript', 'Estagiário - Outra Fictícia S.A.']) expect(text).toContain(expected);
  for (const absent of ['undefined', 'Front-end:', 'EXPERIÊNCIAS COMPLEMENTARES']) expect(text).not.toContain(absent);
});

// apps/api/src/tailored.test.ts, em 'GET /jobs/:id/tailored.pdf'
it('still renders a tailored résumé stored before the layout fields', async () => { // Review Focus 1
  const old = legacyProfile(SAMPLE_PROFILE);
  const profile = await saveProfile(db, 'pt-BR', old, 'extraido');
  const job = await seedJob(db);
  const { headline: _headline, ...content } = resolveTailored(fullDraft(), old, 'pt-BR').resume; // como o worker gravava antes
  await db.insert(tailoredResumes).values({ jobId: job.id, lang: 'pt-BR', content, profileVersion: profile.version, createdAt: 1 });
  const res = await app.inject({ method: 'GET', url: `/jobs/${job.id}/tailored.pdf` });
  expect(res.statusCode).toBe(200);
  const text = await extractResumeText(res.rawPayload, 'pdf');
  for (const expected of ['MARIA EXEMPLO DA SILVA', 'Maria Exemplo da Silva • 1']) expect(text.ok && text.text).toContain(expected);
  expect(text.ok && text.text).not.toContain('undefined');
});
```

- [ ] **Step 6: Run** `pnpm vitest run packages/resume/src/pdf.test.ts apps/api/src/tailored.test.ts`. Expected: FAIL (seções, datas e rodapé ainda são os do layout antigo).
- [ ] **Step 7: Implement** `prepare` e o desenho em `pdf.ts`.
- [ ] **Step 8: Run** `pnpm test && pnpm typecheck`. Expected: PASS, inclusive `embeds the font and carries no image` e os dois testes de tempo (`pdf.test.ts:152-177`).
- [ ] **Step 9: Commit** `git add packages/resume apps/api && git commit -m "feat(resume): render every PDF in the owner's layout, with header, grouped skills and page footer" -m "Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>"`

### Task 9: Prévia para o dono, teste de ponta a ponta e README

**Files:**
- Create: `packages/resume/src/preview.ts`, `packages/resume/src/preview.test.ts`, `scripts/resume-preview.ts`
- Modify: `packages/resume/src/index.ts:1-4` (exporta `./preview`), `package.json:14` (script `resume:preview`)
- Modify: `apps/web/e2e/profile-ai.spec.ts:211-220`; `README.md:165` (parágrafo "PDF gerado"), `:284-292` (lista de comandos), `:312`

**Interfaces:**
- Consumes: `renderResumePdf` (Task 8); `resolveTailored` (Task 3); `profileFor`, `createDb`, `closeDb` de `@kv/db`.
- Produces:

```ts
// packages/resume/src/preview.ts
export const PREVIEW_FILES: Record<ResumeLang, string>; // 'curriculo-pt-BR.pdf', 'resume-en.pdf'
/** Pasta de saída: `requested`, ou `<tmp>/kanban-vagas-preview`. Lança se o resultado cair dentro de `repoRoot`. */
export function previewDir(requested: string | undefined, repoRoot: string, tmp: string): string;
```

`scripts/resume-preview.ts` (`pnpm resume:preview`, ou `pnpm resume:preview -- --out "<pasta>"`), no molde de `scripts/ai-smoke.ts`:

1. Lê o `.env`, se existir, e exige `DATABASE_URL`.
2. Resolve a pasta com `previewDir(--out, process.cwd(), os.tmpdir())` e a cria.
3. Para cada idioma com perfil gravado: monta o rascunho com todos os itens do perfil, passa por `resolveTailored(rascunho, perfil, idioma)`, gera com `renderResumePdf` e grava `PREVIEW_FILES[idioma]`.
4. Imprime só o caminho de cada arquivo gravado. Nunca imprime texto do perfil. Sem perfil nenhum: "Nenhum perfil gravado. Envie o currículo em Meu perfil." e saída 1. `ResumePdfError`: imprime `message` e sai com 1.

- [ ] **Step 1: Write the failing tests** em `packages/resume/src/preview.test.ts`

```ts
it('defaults to a folder under the temp dir and accepts a folder outside the repository', () => {
  expect(previewDir(undefined, '/repo', '/tmp')).toBe(resolve('/tmp', 'kanban-vagas-preview'));
  expect(previewDir('/home/eu/saida', '/repo', '/tmp')).toBe(resolve('/home/eu/saida'));
  expect(previewDir('/repo-vizinho', '/repo', '/tmp')).toBe(resolve('/repo-vizinho')); // prefixo parecido não é "dentro"
});
it('refuses any folder inside the repository', () => {
  for (const inside of ['/repo', '/repo/out', '/repo/docs/../out']) expect(() => previewDir(inside, '/repo', '/tmp')).toThrow(/fora do repositório/);
  expect(() => previewDir(undefined, '/repo', '/repo/tmp')).toThrow(/fora do repositório/);
});
```

- [ ] **Step 2: Run** `pnpm vitest run packages/resume/src/preview.test.ts`. Expected: FAIL, o módulo não existe.
- [ ] **Step 3: Implement** `preview.ts` (compare com `path.relative(repoRoot, pasta)`, que também resolve a diferença de caixa no Windows), o script e a entrada em `package.json`.
- [ ] **Step 4: Update the e2e** em `apps/web/e2e/profile-ai.spec.ts`, junto das asserções do texto do PDF (o título e o grupo foram gravados na Task 5):

```ts
expect(text).toContain('MARIA EXEMPLO DA SILVA');     // cabeçalho
expect(text).toContain('DESENVOLVEDORA FRONT-END');   // título profissional, copiado do perfil
expect(text).toContain('Front-end: React');           // competência no grupo
expect(text).toContain('Maria Exemplo da Silva • 1'); // rodapé
expect(text).toContain('EXPERIÊNCIA PROFISSIONAL');
```

- [ ] **Step 5: Write the docs.** README: o parágrafo "PDF gerado" descreve o modelo (cabeçalho, seções e ordem, rodapé, Noto Serif) e diz que um perfil antigo ganha título, grupos e nota pelo reenvio do currículo ou pela edição em "Meu perfil"; a lista de comandos ganha `pnpm resume:preview   # gera o PDF do seu perfil em uma pasta fora do repositório`; a linha de `scripts/` cita a prévia.
- [ ] **Step 6: Run** `pnpm typecheck && pnpm test && pnpm e2e`. Expected: tudo verde. Depois, com o banco local no ar, `pnpm resume:preview`. Expected: um caminho por idioma com perfil, fora do repositório, ou a frase de "nenhum perfil". Não abra nem copie o PDF gerado: ele é do dono.
- [ ] **Step 7: Commit** `git add packages/resume scripts package.json apps/web/e2e README.md && git commit -m "feat(resume): preview command for the owner's side-by-side check; e2e and docs for the new layout" -m "Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>"`

---

## Aceite manual do dono (critério 9)

Nenhum teste automatizado compara o PDF com os arquivos do dono, porque eles não entram no repositório. Depois da Task 9, o dono:

1. Em "Meu perfil", reenvia o currículo de cada idioma (a releitura preenche título, grupos, seção e nota) ou preenche os campos à mão, e salva.
2. Roda `pnpm resume:preview`.
3. Abre `curriculo-pt-BR.pdf` ao lado de `Curriculo_..._PTBR_Nov2026.pdf`, e `resume-en.pdf` ao lado de `Resume_..._EN_Nov2026.pdf`, e confere: estrutura e ordem das seções, tipografia, cores, fio, rodapé e texto selecionável.
4. Diferença de medida se corrige em uma constante de `GEOMETRY` ou `TYPE`. Os itens da decisão 13 são os candidatos mais prováveis, porque o spec não os mediu.

## Cobertura do spec (autorrevisão)

| Requisito da Parte A | Onde |
|---|---|
| Vale para todo PDF; o layout atual deixa de existir | Task 8 (um renderer só, usado pelo download e, na Parte B, pela candidatura) |
| Tabelas de tipografia e de geometria | "Constantes do layout"; Task 8 (`pdf-layout.test.ts`) |
| Arquivos do dono fora do repositório; perfil fictício nos testes (decisão 21) | Global Constraints; fixtures das Tasks 2 e 7; Task 9 (`previewDir`) |
| Cabeçalho; ordem e títulos das seções; grupos; linhas de formação, idiomas e certificações; sem seção de links; datas | Task 7 |
| Experiência com período, local e nota; realizações com marcador e recuo | Tasks 7 e 8 |
| Rodapé em toda página; seção vazia não aparece; título de seção nunca sozinho; nome em caixa alta | Tasks 7 e 8 |
| Texto selecionável, sem tabelas nem imagens, aviso de caractere sem glifo | Tasks 6 e 8 |
| Campos opcionais; perfis gravados continuam válidos; o modelo e o editor os enviam sempre | Tasks 1, 2 e 5 |
| Leitura e tradução preenchem os campos; grupo traduzido uma vez | Task 4 |
| Currículo adaptado copia e o modelo nunca reescreve (decisão 8); verificador com o vocabulário novo | Task 3 |
| Editor de "Meu perfil" ganha os campos | Task 5 |
| Perfil existente: releitura do currículo ou edição à mão | Fluxos que já existem; README na Task 9; passo 1 do aceite manual |
| Currículo adaptado já gravado fica "desatualizado" e não ganha os campos sozinho | Comportamento que já existe (`stale`); a Task 8 testa que ele ainda vira PDF. Gerar de novo ao usar na candidatura é a Task 10 do plano base |
| Testes de PDF: ordem, conteúdo, grupos, rodapé, quebras, dois idiomas, perfil antigo | Tasks 7 e 8 |
| Critério 9 | Task 8, Task 9 (e2e) e o aceite manual |
