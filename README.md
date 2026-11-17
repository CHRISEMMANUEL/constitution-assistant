# ConstIntell: Constitution Assistant

Read, search and compare the constitutions of the world, and ask an AI assistant questions that are answered only from the constitutional text, with every claim cited back to the article it came from.

Live: https://constitution-assistant.netlify.app

The app is free and non-commercial: no paid plans, no ads. AI answers use each person's own API key.

## Features

- **Explorer**: browse constitutions by continent, on a world map or by country.
- **Assistant**: ask questions in plain language. Retrieval finds the most relevant articles, then a language model writes a short answer citing them as `[Source N]`, using your own API key from OpenRouter, OpenAI, Anthropic (Claude), Google Gemini, Groq or xAI (Grok). Without a key, or if no model is reachable, it quotes the best-matching article directly.
- **Comparisons**: name two or more countries ("compare freedom of expression in Kenya and Ghana") to get evidence from each.
- **Voice**: speak your question and have answers read aloud (Web Speech API).
- **Bookmarks**: save articles to your account. The Bookmarks page fetches only the articles you saved, by id.
- **Offline**: installable PWA, with a bundled set of 29 constitutions for use without a connection.
- **Languages**: English, Spanish and French.

The assistant is a research tool, not legal advice.

## Tech stack

- React 19, TypeScript, Vite, Tailwind CSS 4, Framer Motion
- Supabase (Postgres, Auth, Edge Functions)
- Model access through each user's own key: OpenRouter (free models by default), OpenAI, Anthropic via `@anthropic-ai/sdk`, Google Gemini, Groq, xAI
- vite-plugin-pwa, i18next, Sentry (optional)

## How the assistant works

With an API key saved, each question goes through these agents, all run in the browser ([src/services/agents.ts](src/services/agents.ts)), so the key is only ever sent to the chosen provider:

1. **Planner** (one model call): reads the question and the recent conversation and returns up to four keyword searches, each tied to the countries it is about. A comparison gets one search per country, and a follow-up such as "what about Kenya?" is resolved from the earlier turns. If the reply can't be used, the question as typed becomes the search.
2. **Researchers** (no model call): run the searches in parallel through the `search_articles` Postgres full-text function, then merge the results in turn, up to eight articles. Articles that contain every search term rank first.
3. **Analysts** (comparisons only, one model call per country, in parallel): when the searches cover two or more countries, each analyst reads only its country's articles and writes short notes for the Writer, keeping the same [Source N] numbers. A country with no matching article gets a "no source found" note instead of a call. If one analyst fails, the Writer goes without its notes.
4. **Writer** (one streamed model call): answers from those articles only, cites them as [Source N], and sees the last few turns of the conversation so follow-ups read naturally.
5. **Verifier** (code, no model call; [src/services/verifier.ts](src/services/verifier.ts)): checks that every [Source N] exists, that every quote appears word for word in a source (ignoring case and punctuation, allowing `…` and `[bracketed]` edits), and that the answer cites something unless it opens with "The provided sources do not contain a direct answer". If anything fails, the Writer is asked once to rewrite the answer with the problems listed. Citations that still point past the source list are removed, and a quote that still doesn't match shows a warning under the answer.

On OpenRouter, if a free model is rate-limited, the next free model is tried. If the key is rejected or the provider fails, the app shows a direct quotation instead. If the search function isn't installed yet, the Researchers use the in-browser TF-IDF index (all articles, loaded from Supabase the first time a local search needs them). With no key saved, the app quotes the best-matching articles from the same `search_articles` function, so nothing large is downloaded: country names and demonyms in the question (Nigeria, Nigerian, the US) become a country filter, and a comparison question gets the best article from each country. Only if that function fails does it fall back to the in-browser index.

### Your own AI key

There is no shared key. In the Assistant, open **AI key**, choose a provider, paste your key and, optionally, a model id. Leaving the model blank uses the default below.

| Provider | Get a key | Default model | Cost |
| --- | --- | --- | --- |
| OpenRouter | https://openrouter.ai/keys | `google/gemma-4-31b-it:free`, with other free models as fallbacks | Free models are free; others are billed by OpenRouter |
| OpenAI | https://platform.openai.com/api-keys | `gpt-4.1-mini` | Billed by OpenAI |
| Claude (Anthropic) | https://console.anthropic.com/settings/keys | `claude-opus-5-5` | Billed by Anthropic |
| Google Gemini | https://aistudio.google.com/apikey | `gemini-2.5-flash` | Free tier available, then billed by Google |
| Groq | https://console.groq.com/keys | `llama-3.3-70b-versatile` | Free tier available, then billed by Groq |
| xAI Grok | https://console.x.ai | `grok-3-mini` | Billed by xAI |

The providers are listed in [src/services/aiKey.ts](src/services/aiKey.ts) and called in [src/services/llm.ts](src/services/llm.ts). Claude goes through the official Anthropic SDK, loaded only when Claude is selected; the others use their OpenAI-compatible chat endpoints. Each provider's domain must stay in `connect-src` in [public/_headers](public/_headers).

The key is stored in the browser's `localStorage` and is only ever sent to the provider you chose. It is never saved to Supabase or sent to any server run by this project. **Remove key** deletes it from the browser.

The agent design and the remaining phase (Tutor/quiz agent, agent timeline in the chat) are in [docs/architecture.html](docs/architecture.html).

## Running locally

Requirements: Node.js 22+ and a Supabase project. For AI answers, add your own provider key in the app (not in `.env`).

```bash
git clone https://github.com/CHRISEMMANUEL/constitution-assistant.git
cd constitution-assistant
npm install
cp .env.example .env
npm run dev
```

Without Supabase credentials the app runs on the bundled constitutions only.

### Environment variables

| Variable | Used by | Purpose |
| --- | --- | --- |
| `VITE_SUPABASE_URL` | app, seed script | Supabase project URL |
| `VITE_SUPABASE_ANON_KEY` | app | Supabase anon (public) key |
| `VITE_SENTRY_DSN`, `VITE_SENTRY_ENV` | app | Optional error reporting |
| `SUPABASE_URL` | seed script | Optional alternative to `VITE_SUPABASE_URL` |
| `SUPABASE_SERVICE_ROLE_KEY` | seed script | Service role key for writing data. Keep it out of the frontend |

### Database

1. In the Supabase SQL editor, run [supabase/schema.sql](supabase/schema.sql). It creates the `constitutions`, `articles` and `bookmarks` tables with row-level security.
2. Load data, either:
   - the small starter set in [supabase/seed.sql](supabase/seed.sql), or
   - the full corpus: `npm run seed:supabase` (needs `SUPABASE_SERVICE_ROLE_KEY` in `.env`).

Existing databases created before November 2026 also need [supabase/migrations/20261114_source_provenance.sql](supabase/migrations/20261114_source_provenance.sql). It adds source and licence columns, an `articles.active` flag, and changes bookmarks so deleting a bookmarked article is refused instead of silently removing the bookmark. Apply it before deploying a frontend that filters on `active`.

The assistant's search needs [supabase/migrations/20261116_article_search.sql](supabase/migrations/20261116_article_search.sql) (already part of `schema.sql` for new databases). It adds a generated full-text column `articles.fts` (article number and title weighted highest, then chapter, then text), a GIN index, and the `search_articles(query, country_ids, k)` function that anonymous users may call. It returns active articles only, best matches first, at most 50. Until it is applied, the assistant falls back to the in-browser index. The frontend selects article columns by name, so the `fts` column is never downloaded, and `npm run backup:supabase` leaves it out.

Every article row records its `source` (`official`, `constitute`, `wikipedia`, `generated`, `manual`). The seed never replaces a higher-ranked source and never deletes rows; rows it supersedes get `active = false`.

Back up the data before any bulk change: `npm run backup:supabase` writes JSON copies of every table to `backups/` (gitignored).

#### Official texts

[scripts/sources.json](scripts/sources.json) lists, per country code, where the official text comes from, its licence, and checks the parsed result must pass (article count range, required articles, no gaps in numbering). Countries marked `blocked` give the reason and keep their current source.

```bash
npm run import:official -- us au ke in za gh          # dry run: fetch, parse, validate, write official-out/<id>.json
npm run import:official -- us au ke in za gh --write  # save to Supabase as source 'official'
```

India (legislative.gov.in), the South African schedules (justice.gov.za) and Ghana (osp.gov.gh) are published as PDF, so these need `pdftotext` from Poppler. Git for Windows ships it, and on Windows the importer finds it in Git's `mingw64\bin` even from PowerShell or cmd; elsewhere it must be on the PATH (on Debian or Ubuntu install `poppler-utils`). The India adapter looks up the current PDF through the Legislative Department's site API rather than a fixed link. The India and Ghana adapters print the subheadings they leave out so you can check none of them is text.

Ghana's text is Oceana's consolidation of the 1992 Constitution with the 1996 Amendment Act (Act 527). The adapter removes Oceana's amendment markers and endnotes. Its 11 amended passages were checked against the enacted Act 527; the one that differs (article 199(4), "sixty-five" for "sixty") is corrected in `GH_CORRECTIONS`, and the import stops if that correction no longer applies.

Nigeria (adapter `ng-justice`, [scripts/official/nigeria.mjs](scripts/official/nigeria.mjs)) has no consolidated official text. The Federal Ministry of Justice PDF is the 1999 text followed by the First, Second and Third Alteration Acts (2010), printed as amending instructions. The adapter reads the PDF with pdf.js (`pdfjs-dist`, because pdftotext rejects the file and runs margin notes into the text). It parses sections 1 to 320 and the seven Schedules, then applies the Acts in order from the `ALTERATIONS` list. Text longer than a phrase is copied from the Act itself, every short inserted phrase must appear in its Act, and every edit must match exactly once, so a changed PDF stops the import rather than altering the wrong place. Corrections for misprints in the PDF (`MISNUMBERED`, `TITLE_FIXES`, `TEXT_FIXES`, `HEADING_FIXES`) are checked the same way. Nigeria stays `blocked` and keeps the Constitute text, by decision: the PDF's 1999 text differs from the enacted wording in places and Constitute's is closer (see the reason in `sources.json`). The adapter is kept so `npm run import:official -- ng` can still dry-run it if a better source appears.

With no country codes it runs every `ready` entry. Naming a country that is not `ready` but has an adapter runs it as a dry run only (`npm run import:official -- ng`); `--write` still skips it. A country that fails validation is never written. On `--write` the official rows are saved first, then the older rows for that country are set to `active = false` (never deleted), and the constitution's source, licence and summary are updated. Official row ids are `<code>-of-<article-slug>`, for example `us-of-amendment-xiv-section-1`. Each source has its own parser in [scripts/official/adapters.mjs](scripts/official/adapters.mjs).

The GitHub Actions workflow [.github/workflows/seed.yml](.github/workflows/seed.yml) runs the full seed on demand from the Actions tab. It needs the repository secrets `VITE_SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`.

## Deployment

The frontend is a static build (`npm run build`, output in `dist/`) deployed on Netlify. `public/_redirects` routes all paths to `index.html` for client-side routing.

## Data sources and attribution

- **Official constitution texts**: for the countries marked `ready` in [scripts/sources.json](scripts/sources.json), taken from official publications (for example the U.S. National Archives, India's Legislative Department, South Africa's Department of Justice and Constitutional Development, and official prints transcribed on [Wikisource](https://en.wikisource.org)). Each country page in the Explorer shows its source and licence.
- **Other constitution texts**: [Constitute](https://www.constituteproject.org). Elkins, Zachary, Tom Ginsburg, James Melton. *Constitute: The World's Constitutions to Read, Search, and Compare.* Online at constituteproject.org. Licensed under [CC BY-NC 3.0](https://creativecommons.org/licenses/by-nc/3.0/); commercial use of this content is not permitted, which is one reason this app stays free and non-commercial. Some English translations are provided to Constitute by HeinOnline and Oxford Constitutions of the World.
- **Country summaries**: [Wikipedia](https://en.wikipedia.org), under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/).
- **Country metadata**: [REST Countries](https://restcountries.com).
- **Bundled offline set**: excerpts from official public-domain constitutional texts.

The licence below covers this project's source code only. It does not cover the data above, which stays under its own terms.

## Contributing

Issues and pull requests are welcome. Please run `npm run build` before opening a pull request, and keep secrets out of commits (`.env` is git-ignored; use `.env.example` for new variable names).

## License

Source code: [GNU Affero General Public License v3.0](LICENSE). If you run a modified version of this project as a network service, you must make your modified source code available to its users.
