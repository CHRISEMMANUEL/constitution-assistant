# ConstIntell: Constitution Assistant

Read, search and compare the constitutions of the world, and ask an AI assistant questions that are answered only from the constitutional text, with every claim cited back to the article it came from.

Live: https://constitution-assistant.netlify.app

## Features

- **Explorer**: browse constitutions by continent, on a world map or by country.
- **Assistant**: ask questions in plain language. Retrieval finds the most relevant articles, then a language model writes a short answer citing them as `[Source N]`. If no model is reachable, it falls back to quoting the best-matching article directly.
- **Comparisons**: name two or more countries ("compare freedom of expression in Kenya and Ghana") to get evidence from each.
- **Voice**: speak your question and have answers read aloud (Web Speech API).
- **Bookmarks**: save articles to your account.
- **Offline**: installable PWA, with a bundled set of 29 constitutions for use without a connection.
- **Languages**: English, Spanish and French.

The assistant is a research tool, not legal advice.

## Tech stack

- React 19, TypeScript, Vite, Tailwind CSS 4, Framer Motion
- Supabase (Postgres, Auth, Edge Functions)
- OpenRouter for model access (free-tier models by default)
- vite-plugin-pwa, i18next, Sentry (optional)

## How the assistant works

1. All articles are loaded from Supabase and indexed in the browser (TF-IDF).
2. For each question, the top matching articles are selected, with at least one per country named in the question.
3. The articles and the question are sent through the `openrouter` Supabase Edge Function, which holds the API key, to a free OpenRouter model. The answer streams back.
4. If the model is rate-limited, the next free model is tried; if all fail, the app shows a direct quotation instead.

A multi-agent version (planner, per-country researchers, writer and citation verifier running server-side, with support for OpenAI, Anthropic, Google Gemini and Groq using your own API key) is in progress. See [docs/architecture.html](docs/architecture.html).

## Running locally

Requirements: Node.js 22+, a Supabase project, and optionally an OpenRouter account.

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
| `VITE_OPENROUTER_PROXY_URL` | app | URL of the deployed `openrouter` Edge Function |
| `VITE_OPENROUTER_MODEL` | app | Optional. Preferred model; must be a `:free` model when using the proxy |
| `VITE_OPENROUTER_API_KEY` | app | Local development only. Calls OpenRouter directly from the browser, which exposes the key in the bundle. Never set this in production |
| `VITE_SENTRY_DSN`, `VITE_SENTRY_ENV` | app | Optional error reporting |
| `SUPABASE_URL` | seed script | Optional alternative to `VITE_SUPABASE_URL` |
| `SUPABASE_SERVICE_ROLE_KEY` | seed script | Service role key for writing data. Keep it out of the frontend |

### Database

1. In the Supabase SQL editor, run [supabase/schema.sql](supabase/schema.sql). It creates the `constitutions`, `articles` and `bookmarks` tables with row-level security.
2. Load data, either:
   - the small starter set in [supabase/seed.sql](supabase/seed.sql), or
   - the full corpus: `npm run seed:supabase` (needs `SUPABASE_SERVICE_ROLE_KEY` in `.env`).

Existing databases created before November 2026 also need [supabase/migrations/20261114_source_provenance.sql](supabase/migrations/20261114_source_provenance.sql). It adds source and licence columns, an `articles.active` flag, and changes bookmarks so deleting a bookmarked article is refused instead of silently removing the bookmark. Apply it before deploying a frontend that filters on `active`.

Every article row records its `source` (`official`, `constitute`, `wikipedia`, `generated`, `manual`). The seed never replaces a higher-ranked source and never deletes rows; rows it supersedes get `active = false`.

Back up the data before any bulk change: `npm run backup:supabase` writes JSON copies of every table to `backups/` (gitignored).

#### Official texts

[scripts/sources.json](scripts/sources.json) lists, per country code, where the official text comes from, its licence, and checks the parsed result must pass (article count range, required articles, no gaps in numbering). Countries marked `blocked` give the reason and keep their current source.

```bash
npm run import:official -- us au ke          # dry run: fetch, parse, validate, write official-out/<id>.json
npm run import:official -- us au ke --write  # save to Supabase as source 'official'
```

With no country codes it runs every `ready` entry. A country that fails validation is never written. On `--write` the official rows are saved first, then the older rows for that country are set to `active = false` (never deleted), and the constitution's source, licence and summary are updated. Official row ids are `<code>-of-<article-slug>`, for example `us-of-amendment-xiv-section-1`. Each source has its own parser in [scripts/official/adapters.mjs](scripts/official/adapters.mjs).

The GitHub Actions workflow [.github/workflows/seed.yml](.github/workflows/seed.yml) runs the full seed on demand from the Actions tab. It needs the repository secrets `VITE_SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`.

### AI proxy (Supabase Edge Function)

```bash
npx supabase functions deploy openrouter --no-verify-jwt
npx supabase secrets set OPENROUTER_API_KEY=sk-or-v1-...
```

Then set `VITE_OPENROUTER_PROXY_URL=https://<project-ref>.supabase.co/functions/v1/openrouter`.

The function only accepts requests from the origins listed in `ALLOWED_ORIGINS` at the top of [supabase/functions/openrouter/index.ts](supabase/functions/openrouter/index.ts), only forwards `:free` models, and caps output at 800 tokens. If you deploy your own copy, add your domain to that list.

## Deployment

The frontend is a static build (`npm run build`, output in `dist/`) deployed on Netlify. `public/_redirects` routes all paths to `index.html` for client-side routing.

## Data sources and attribution

- **Official constitution texts**: for the countries marked `ready` in [scripts/sources.json](scripts/sources.json), taken from official publications (for example the U.S. National Archives, and official prints transcribed on [Wikisource](https://en.wikisource.org)). Each country page in the Explorer shows its source and licence.
- **Other constitution texts**: [Constitute](https://www.constituteproject.org). Elkins, Zachary, Tom Ginsburg, James Melton. *Constitute: The World's Constitutions to Read, Search, and Compare.* Online at constituteproject.org. Licensed under [CC BY-NC 3.0](https://creativecommons.org/licenses/by-nc/3.0/); commercial use of this content is not permitted. Some English translations are provided to Constitute by HeinOnline and Oxford Constitutions of the World.
- **Country summaries**: [Wikipedia](https://en.wikipedia.org), under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/).
- **Country metadata**: [REST Countries](https://restcountries.com).
- **Bundled offline set**: excerpts from official public-domain constitutional texts.

The licence below covers this project's source code only. It does not cover the data above, which stays under its own terms.

## Contributing

Issues and pull requests are welcome. Please run `npm run build` before opening a pull request, and keep secrets out of commits (`.env` is git-ignored; use `.env.example` for new variable names).

## License

Source code: [GNU Affero General Public License v3.0](LICENSE). If you run a modified version of this project as a network service, you must make your modified source code available to its users.
