# Cold Read

Cold Read is a Forge app for Confluence. It checks what a newcomer would understand from a page that people or AI agents act on, such as an on-call handoff, a deploy runbook or a how-to. A fresh Rovo agent, the Cold Reader, reads only the page and answers the questions the next reader would have. Where its answers differ from what the page owner expects, or from what related pages and Jira issues say, the page has a gap. Agents outside Atlassian get the same check through MCP.

## Why

A handoff page reads fine to the person who wrote it. They know the price quote already went out, so the page does not say so, and the next person sends it again.

## How it works

**Questions.** Up to 10 questions per page. A page without its own questions gets five default handoff questions: where the work stands, the next step and who does it, what is decided, what is done and must not be repeated, who is waiting on whom. Page editors can change the questions and add expected answers, or use *Suggest questions*, which proposes up to 7 for the kind of page.

**Cold read.** One cold read, or run, is done by the Cold Reader. It answers from the page text alone, each answer with the shortest supporting quote, or `NOT STATED`. It calls four tools in this order; the backend enforces the order, and only the person who started the run can complete it:

1. `get-cold-read-packet`: the page text and the questions, never the expected answers.
2. `submit-cold-read-answers`: the answers, saved once. Only then does the Cold Reader get the expected answers.
3. `get-warm-read-packet`: only when no question has an expected answer.
4. `submit-cold-read-findings`: up to one verdict per compared question, saved once.

In a test, the Cold Reader did not use a decoy page in the same space that held the missing facts; plain Rovo with search found it.

**Findings.** The Cold Reader compares its saved answers with the owner's expected answers, for the questions that have one. If no question has one, it compares them with its own warm-read answers (see Warm read). Each compared question gets one class:

- **A, would act wrongly:** a newcomer who follows the page would act differently, stop, or repeat something already done.
- **B, wrong or stale:** the page is wrong or out of date, but the next action would not change.
- **C, not covered:** the page leaves out something the owner expects or the related sources answer.
- **Match:** no gap.

**Warm read.** Without expected answers, the Cold Reader does a warm read: it answers again from the page plus related pages and Jira issues, so nobody has to write answers in advance. Related pages and issues contain two distinctive words of the page title (one word, if nothing contains two). The Cold Reader gets up to 5 pages and 5 issues, 4,000 characters each; Cold Read's own issues (label `cold-read`) are left out. With no sources found, the Cold Reader is told to record each `NOT STATED` answer as a C finding.

**Results.**

- **Panel:** click **Cold Read** under the page title to see the answers with quotes, the expected answers or warm-read sources, and the findings. The title of the **Cold Read** item shows the latest finished run: `Cold Read · 2 A`, `· 2 to fix` (B and C), `· page changed` or `· clear`.
- **Space page** (Space apps > Cold Read): pages with saved questions or finished runs, worst first, with a *Fix in Jira* column.
- **Jira:** from the panel, the A findings of a run go to the page owner as one issue: a Task where the project has one, with the label `cold-read` and a link to the page in the description, created as the person who clicks.
- **Status:** `get-cold-read-status` gives one line of advice on the latest finished run, such as "Do not act on this page yet: 2 class A finding(s), a newcomer would act wrongly. The fix is tracked in Jira issue `<KEY>`."

## Install

Cold Read needs Confluence Cloud with Rovo turned on. With Jira on the same site, the warm read also searches issues, and A findings can go to Jira.

So far Cold Read runs as a development install on our own site. The install link for other sites will be added here after the production deploy in December 2026. Until then, the way to try it on your site is your own copy: see Development.

1. A site admin installs Cold Read in Confluence, and in Jira if the site has it.
2. For MCP only: the site admin turns on "Expose tools to MCP-compatible apps" in Atlassian Administration > Apps > Sites > your site > Connected apps > cold-read > View app details > Tools.

To try it, open a handoff page in a space that has related pages or Jira issues, or add expected answers under Questions. Click **Cold Read** under the page title, then **Run cold read**. The Rovo chat opens with the Cold Reader. Confirm the two actions that save the answers and the findings (steps 2 and 4 above), then reopen the panel, or press **Refresh** in it. On a page with no expected answers and nothing related, the Cold Reader is told to record a C finding for every `NOT STATED` answer.

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
| `read:page:confluence` | the page and related pages; whether the user can edit the page |
| `search:confluence` | warm-read page search (CQL) |
| `storage:app` | questions, runs and findings |
| `read:jira-work` | warm-read issue search (JQL), Jira projects and issue types |
| `write:jira-work` | the Jira issue for A findings |

Confluence and Jira calls run as the current user, so the Cold Reader sees only what that person can see. The app writes its own storage, so it checks rights itself: only people who can edit a page can change its questions. Everyone who can view the page can see its questions and expected answers in the panel; the Cold Reader gets the expected answers only after its answers are saved.

Storage is the Forge Key-Value Store of the installation: questions and expected answers (with the Atlassian account ID of who saved them), the last Jira project used in each space, and runs (page ID, title and version, the questions and expected answers as they were at the run, the account ID of who ran it and when, answers with quotes from the page, findings with notes, the warm-read search words and the titles and IDs or keys of its sources, the Jira issue key and the account ID of who created it). The full page text is not stored. The app's logs hold page and run IDs, Jira issue keys, counts, the warm-read search words and Jira error messages, not page text. The manifest declares no external hosts, and the app calls no model of its own: the Cold Reader runs on the site's Rovo. The app does not delete old runs.

Through MCP, the page text, related sources and expected answers go to the client you connect and to its model provider. The Jira issue holds each A finding with its question and note, the page title and version, and a link to the page: choose a project whose members may see them.

## Limitations

- Pages only, read as plain text from the Confluence storage format: no images, no attachments, no content that macros pull in when the page is viewed.
- The plain text loses code blocks and user mentions, and table cells and macro titles run together with the text next to them. Commands in a runbook's code blocks are not read.
- The warm read searches only for words from the page title. It misses sources worded differently, and common title words can bring in unrelated ones.
- Being "cold" rests on the Cold Reader's instructions. Expected answers and related sources reach it only after its answers are saved, but nothing stops the model from using general knowledge, and it gives its own verdicts.
- No automatic re-run when a page changes: per the `rovo:action` documentation, agents started by Automation rules do not run `CREATE` actions, and those actions save the answers and findings. A changed page shows `page changed` until someone runs a new cold read.
- The space page covers at most 100 pages with Cold Read data per installation.
- A Jira project that rejects the assignee or the label still gets the issue, without the rejected field. An issue without the label is not left out of later warm reads.
- Not tested live: the read-only question list for people who cannot edit the page, the "Rovo is off on this site" message, the blog-post message, an issue filed by someone who may not create issues, an unassigned issue, and a site without Jira.
- Tested on a development install only. External MCP access is a Preview platform feature. The MCP setup above is written for Claude Code; other MCP clients are untested.

## Development

You need a Confluence Cloud site where you are an admin, with Rovo turned on, and the Forge CLI logged in to your Atlassian account (`npm install -g @forge/cli`, then `forge login`). Forge CLI 15.1.0 needs Node ^22.23.4, ^24.22.1 or >=26.12.1.

```
npm install
npm test        # 23 tests of the pure logic in src/logic.js
forge register  # your own copy: a new app ID in manifest.yml
forge deploy --non-interactive -e development
forge install --non-interactive --site <site>.atlassian.net --product confluence --environment development
forge install --non-interactive --site <site>.atlassian.net --product jira --environment development   # if the site has Jira
```

## Codegeist 2026

Built on Forge since 10 November 2026 for Codegeist 2026, in the category Apps for Software Teams, for the bonus prize Best app with Atlassian MCP.

## License

MIT, see [LICENSE](LICENSE).
