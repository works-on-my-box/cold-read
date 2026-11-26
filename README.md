# Cold Read

Your handoff, read by someone who was not there.

Cold Read is a Forge app for Confluence. Before you hand over on-call, it checks what the next on-call engineer will understand from your handoff page. A fresh reader, the Cold Reader, answers the questions the next person would have from the page alone. Then Cold Read reads the Jira issues and pages the handoff links to and shows where the two disagree, with a quote from each. The same check works for runbooks, how-tos and other pages that people or AI agents act on. Agents outside Atlassian get it through MCP.

## Why

A handoff page reads fine to the person who wrote it. They know that Tuesday's incident ticket says not to restart the worker during a billing run, so the line "restart billing-worker" from last week's handoff stays on the page, and the next on-call restarts it.

Page reviews ask the owner: is this still true? Cold Read asks someone who was not there: what will you do?

## How it works

**Questions.** Up to 10 questions per page. A page without its own questions gets five default handoff questions: where the work stands, the next step and who does it, what is decided, what is done and must not be repeated, who is waiting on whom. Page editors can change the questions and add expected answers, or use *Suggest questions* in the Rovo chat, which proposes up to 7 for the kind of page.

**Run cold read.** Click **Cold Read** under the page title, then **Run cold read**. The app takes the steps itself, each with a fresh model call that gets only what that step needs (see Model):

1. The cold read: the Cold Reader gets the page text and the questions, never the expected answers, and answers from the page alone, each answer with the shortest supporting quote, or `NOT STATED`.
2. With the owner's expected answers, the compare: each saved answer is compared with its expected answer. Without them, the warm read (below) in two more steps.

The panel shows each step as it runs, then the answers and the findings. A run of the five default questions with a warm read takes about 30 seconds; a run with expected answers, up to about 20. If the panel is closed after the answers are saved, it offers **Continue**. A page with no expected answers that links to no Jira issue or page ends after the cold read: the panel shows the answers from the page alone and asks you to link the issues and pages the page depends on.

**In the Rovo chat.** **Run in Rovo chat** runs the same check with the Cold Reader as a Rovo agent. It calls four tools in this order; the backend enforces the order and takes each step only from someone who can view the page:

1. `get-cold-read-packet`: the page text and the questions, never the expected answers.
2. `submit-cold-read-answers`: the answers, saved once. Only then does the Cold Reader get the expected answers.
3. `get-warm-read-packet`: only when no question has an expected answer. It returns the Jira issues and pages the page links to.
4. `submit-cold-read-findings`: up to one verdict per compared question, saved once.

The chat asks you to confirm steps 2 and 4. In a test, the Cold Reader did not use a decoy page in the same space that held the missing facts; plain Rovo with search found it.

**Findings.** With the owner's expected answers, each compared question gets one class. The compare reads the answer together with the reader's other answers of the same run, so a fact the reader gave under another question is not counted as missing from the page.

- **A, would act wrongly:** a newcomer who follows the page would act differently, stop, or repeat something already done.
- **B, wrong or stale:** the page is wrong or out of date, but the next action would not change.
- **C, not covered:** the page leaves out something the owner expects.
- **Match:** no gap.

**Warm read.** Without expected answers, Cold Read compares the page with the Jira issues and Confluence pages the page itself links to: Jira macros, links and issue keys in the text. It does not search for other pages. A one-click run reads up to six of them, pages and issues in turn, 3,000 characters each; Cold Read's own issues (label `cold-read`) are left out. The Cold Reader answers the questions again from the page and these sources, naming the source each answer rests on. Then three checks side by side compare the two answers of each question. A finding is a conflict: a person who acts on the page alone would do what a linked issue or page forbids or calls already done, or would do it with another person, deadline, amount or addressee, or the two answers say opposite things about what is done or decided. It counts only if at least two of the three checks name it and both its quotes, one from the page and one from the source, are found in those texts. All conflicts with one source are one A finding that names the questions it touches, each with its own two quotes. The warm read gives no B or C findings. The line *Compared with:* in the panel names only the sources an answer rested on.

**Results.**

- **Panel:** click **Cold Read** under the page title to see the answers with quotes, the expected answers or the answers with the linked sources, and the findings. The title of the **Cold Read** item shows the latest finished run: `Cold Read · 1 critical` (A findings), `· 2 to fix` (B and C), `· 2 not on the page` (a run with nothing to compare with), `· page changed` or `· clear`.
- **Space page** (Space apps > Cold Read): pages with saved questions or finished runs, worst first, with a *Fix in Jira* column, and the sample (see Try the sample).
- **Jira:** from the panel, the A findings of a run go to the page owner as one issue: a Task where the project has one, with the label `cold-read` and a link to the page in the description, created as the person who clicks.
- **Status:** `get-cold-read-status` gives one line of advice on the latest finished run, such as "Do not act on this page yet: 2 class A finding(s), a newcomer would act wrongly. The fix is tracked in Jira issue `<KEY>`."

## Model

**Run cold read** calls a model through Forge LLMs, Atlassian's API for [Atlassian-hosted models](https://developer.atlassian.com/platform/forge/runtime-reference/forge-llms-api/). It takes the first of Claude Sonnet 5, Claude Sonnet 4.6 and Claude Haiku 4.5 that Forge LLMs lists as active for the site (the list is read once a UTC day), at temperature 0 where the model accepts one. The panel names the model under the result: "Read by Claude Sonnet 5 via Forge LLMs · fresh context · page version 3". The app's developer pays for these calls; they cost the site nothing. A run in the Rovo chat uses the site's Rovo instead.

**How many one-click runs.** Because the developer pays, each site has a spend limit, counted in money from the tokens of each call: $0.60 right after the app is installed, then $0.10 more each hour, at most $1.00 in a UTC day and $3.00 in any 30 days. A run starts only if an estimate of its highest cost fits into what is left; what its calls really cost is counted after each step. The estimate takes two characters of text for a token (one and a half tokens for a Chinese, Japanese or Korean character): a page or a linked source whose text takes more tokens than that can cost more than its estimate, and then a day can end above the limit by the difference. A warm read of the five default questions on the sample handoff costs about $0.05 to $0.06 and needs about $0.21 free before it starts (what its five calls could cost at most); a run with expected answers costs about $0.02. So right after install about 7 warm reads start one after another, then about 2 more each hour, about 15 in a UTC day and about 50 in 30 days. When the limit is reached, the panel says that the site has used its one-click budget for now and when runs are available again, and offers **Run in Rovo chat**, which does not count against the limit. The developer can also switch one-click runs off for one site or for all; then the panel says they are not available and offers the Rovo chat too. One-click runs stop on 20 February 2027.

## Install

Cold Read needs Confluence Cloud; the Rovo chat and *Suggest questions* need Rovo turned on. With Jira on the same site, the warm read reads the Jira issues a page links to, and A findings can go to Jira.

So far Cold Read runs as a development install on our own site. The install link for other sites will be added here. Until then, the way to try it on your site is your own copy: see Development.

1. A site admin installs Cold Read in Confluence, and in Jira if the site has it.
2. For MCP only: the site admin turns on "Expose tools to MCP-compatible apps" in Atlassian Administration > Apps > Sites > your site > Connected apps > cold-read > View app details > Tools.

To try it on a page of your own, open a handoff page that links to the Jira issues or pages it depends on, or add expected answers under Questions. Click **Cold Read** under the page title, then **Run cold read**.

## Try the sample

On **Space apps > Cold Read**, pick a Jira project and click **Load sample handoffs**. It puts into this space a parent page, "Cold Read sample: Payments on-call", with four handoffs of a made-up payments team under it, and into the project you picked two Jira issues with the label `cold-read-sample`, all created as you. It starts no runs. On **On-call handoff: Payments, week 47 (Mira to Jon)**, **Run cold read** takes about 30 seconds, and the item under the title shows `Cold Read · 1 critical`: the page says to restart a worker that a comment in a linked issue says not to restart during a billing run. **Remove sample** deletes the two issues; when Jira does not let you delete them, it adds a comment and moves them to a done status where the workflow has one. Cold Read has no permission to delete pages, so you delete the parent page with its children yourself. The full walkthrough, with the line that fixes the page, is in [docs/JUDGES.md](docs/JUDGES.md).

## For agents outside Atlassian: MCP and skill

The `rovo:mcp` module serves five tools: `get-cold-read-status` and the four steps of a run (`get-cold-read-packet`, `submit-cold-read-answers`, `get-warm-read-packet`, `submit-cold-read-findings`). Through MCP, your agent, or a fresh subagent it starts, can be the reader of a cold read; the Cold Read backend keeps the order and stores the findings. In Claude Code:

```
claude mcp add --transport http cold-read https://mcp.atlassian.com/forge/e881a251-e585-4efe-8680-72dc90fcb38f
claude mcp add --transport http atlassian https://mcp.atlassian.com/v2/mcp
```

The first address is Cold Read as published from this repository; for your own copy, put the app ID from your `manifest.yml` after `/forge/`. In `claude`, run `/mcp`, choose `cold-read` and select Authenticate. On the Atlassian consent screen, pick the site and select Accept. Claude Code then lists five tools. Repeat for `atlassian`. A site admin must first turn on "Expose tools to MCP-compatible apps" (see Install). Development tool names end with `_development`; use the names your client lists.

Why two servers: Cold Read says whether a page is safe to act on and runs the check, but it has no plain read tool, since `get-cold-read-packet` starts a run. Through Atlassian's official MCP server, your agent reads the page it is about to act on and does the work itself, in Confluence or Jira.

**Skill.** `skills/checking-cold-read-before-acting/SKILL.md` makes an agent call `get-cold-read-status` before it follows a Confluence runbook, handoff or how-to. If there are A findings, it stops and shows them with the Jira issue. If there is no cold read, or the page has changed since the last one, it suggests a run and waits for the user. If there are only B or C findings, it acts after naming the gaps. The skill also tells a fresh subagent how to run a cold read. To install the skill for one project:

```
mkdir -p .claude/skills
cp -r path/to/cold-read/skills/checking-cold-read-before-acting .claude/skills/
```

To install it for all projects, copy it to `~/.claude/skills/` instead.

## Permissions and data

| Scope | Used for |
|---|---|
| `read:page:confluence` | the page and the pages it links to; whether the user can edit the page; whether the space already has the sample |
| `write:page:confluence` | only **Load sample handoffs**: it creates the sample pages, as the person who clicks. The consent screen shows it as "Create and update pages". |
| `search:confluence` | a page that a link names by its title in another space (CQL) |
| `storage:app` | questions, runs and findings; the spend counters of Run cold read; what the sample created |
| `read:jira-work` | the Jira issues a page links to; Jira projects and issue types |
| `write:jira-work` | the Jira issue for A findings; the two sample issues and their comment, and deleting or closing them with Remove sample |

The manifest also declares the `llm` module, which lets **Run cold read** call Forge LLMs. Per the Forge LLMs documentation, site admins are told at installation that an app uses Forge LLMs.

Confluence and Jira calls run as the current user, so the Cold Reader sees only what that person can see, and the sample is created as that person. The latest finished run of a page is shown to everyone who can view the page; a person who cannot open one of the linked Jira issues or pages it was compared with sees it without the notes, quotes and answers that came with the linked sources. The app writes its own storage, so it checks rights itself: only people who can edit a page can change its questions. Everyone who can view the page can see its questions and expected answers in the panel; the Cold Reader gets the expected answers only after its answers are saved.

**What goes to the model.** When someone clicks **Run cold read**, the app sends Forge LLMs, in separate calls: the page title, the first 40,000 characters of the page text and the questions; then either the expected answers with the saved answers, or the page text again with the text of up to six linked Jira issues and pages (with their titles, keys and statuses), the saved answers and the answers given with those sources. The instructions tell the model that page and source text is data, not instructions. The app sends nothing to servers of its own: the manifest declares no external hosts. Forge LLMs calls Atlassian-hosted models, and its requests "undergo the same moderation checks as Atlassian first-party AI and Rovo features" ([Forge LLMs API](https://developer.atlassian.com/platform/forge/runtime-reference/forge-llms-api/)).

Storage is the Forge Key-Value Store of the installation: questions and expected answers (and when they were saved), the last Jira project used in each space, the latest one-click run of each page whose answers were saved (for Continue), which steps of a one-click run were started (so that each is taken once), what the sample created in a space (the keys of its issues and the IDs, titles and links of its pages, until Remove sample), the spend counters of Run cold read and the model list of the day, and runs. A run holds the page ID, title and version, the questions and expected answers as they were at the run, when it started, was answered and was checked, the answers with quotes from the page, findings with notes, and for a warm read the titles and IDs or keys of the linked sources, which ones an answer rested on, and the answers given with them, with quotes from the page and from the sources; a one-click run also holds the model, its tokens and cost, and an error line if it failed; for the Jira issue, its key, link, whether it was assigned, the number of A findings and when it was created. Cold Read stores no Atlassian account IDs and no profile data such as names or email addresses. To assign the Jira issue, it passes the page owner's account ID from Confluence to Jira and does not keep it. Titles, questions, expected answers, quotes and notes are free text, so they can contain whatever the page or the people who wrote them say, including names. The full page text is not stored. The app's logs hold page, run and space IDs, Jira issue keys, counts, the model, tokens and cost of each call with the site ID, and error messages, not page text; a development install also logs what the compare step wrote out, which can quote the page. The app does not delete old runs. More in [PRIVACY.md](PRIVACY.md).

Through MCP, the page text, the linked sources and the expected answers go to the client you connect and to its model provider. The Jira issue holds each A finding with its question and note, the page title and version, and a link to the page: choose a project whose members may see them.

## Limitations

- Pages only, read as plain text from the Confluence storage format: no images, no attachments, no content that macros pull in when the page is viewed. A one-click run reads the first 40,000 characters of a page; the panel says so when a page is longer.
- User mentions without link text reach the Cold Reader as `@user`, without the name: the storage format holds only an account ID. Table cells are joined with ` | `, one row per line unless a cell holds several paragraphs, a list, a line break or a multi-line code block; a `|` inside a cell reads as a cell boundary; merged cells and nested tables lose their layout. Link addresses are dropped: a link keeps its text, or else the title of the page or the name of the file it points to.
- The warm read sees only the Jira issues and pages the page links to. A rule that sits in an issue or page the handoff does not link, or only in a chat, is not seen. A page that links to nothing gets only the answers from the page alone.
- Being "cold" rests on what each step gets and on the instructions: the cold step gets only the page text and the questions, but nothing stops the model from using general knowledge. In the Rovo chat, expected answers and linked sources reach the Cold Reader only after its answers are saved, and it gives its own verdicts.
- Runs are not fully repeatable. In five runs of the main sample handoff the finding was the same each time; on other pages the questions a finding touches changed from run to run, and a borderline case can come out either way.
- When questions overlap, the compare with expected answers can mark as not covered a detail the reader gave under another question; its note then names that question.
- A run in the Rovo chat counts findings per question; the one-click run counts one finding per linked source. The two can show different numbers for the same page.
- No automatic re-run when a page changes: a changed page shows `page changed` until someone runs a new cold read.
- The space page covers at most 100 pages with Cold Read data per installation.
- A Jira project that rejects the assignee or the label still gets the issue, without the rejected field. An issue without the label is not left out of later warm reads.
- Where Cold Read is not added to Jira on the site, the one-click run and the warm read of linked pages work; the Jira issues a page links to are not read, and the sample and the Jira issue for A findings say that Cold Read is not connected to Jira.
- Not tested live: the read-only question list for people who cannot edit the page, the "Rovo is off on this site" message, the blog-post message, an issue filed by someone who may not create issues, and an unassigned issue.
- Tested on a development install only. External MCP access is a Preview platform feature. The MCP setup above is written for Claude Code; other MCP clients are untested.

## Development

You need a Confluence Cloud site where you are an admin, with Rovo turned on, and the Forge CLI logged in to your Atlassian account (`npm install -g @forge/cli`, then `forge login`). Forge CLI 15.1.0 needs Node ^22.23.4, ^24.22.1 or >=26.12.1. Your own copy calls Forge LLMs on your developer account, so you pay for its one-click runs.

```
npm install
npm test        # the tests, with fakes for the Forge calls
forge register  # your own copy: a new app ID in manifest.yml
forge deploy --non-interactive -e development
forge install --non-interactive --site <site>.atlassian.net --product confluence --environment development
forge install --non-interactive --site <site>.atlassian.net --product jira --environment development   # if the site has Jira
```

## Codegeist 2026

Built on Forge since 10 November 2026 for Codegeist 2026, in the category Apps for Software Teams, for the bonus prize Best app with Atlassian MCP.

## License

MIT, see [LICENSE](LICENSE).
