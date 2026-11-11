---
name: checking-cold-read-before-acting
description: Checks the Cold Read status of a Confluence page through the Cold Read MCP server before an agent acts on that page, and stops on class A findings. Use when the user asks you to follow, execute or continue a Confluence runbook, handoff, how-to, checklist or procedure page ("do the next step from this page", "follow the runbook", "pick up where Alex left off"), or asks whether a Confluence page is safe to rely on. Also covers running a cold read of a page yourself as a fresh reader.
---

# Checking Cold Read before acting on a Confluence page

Cold Read is a Forge app for Confluence. It tests what a newcomer would understand from one page: a fresh reader answers the page's questions from that page alone, and the answers are compared with the page owner's expected answers, or with a second "warm" read of related pages. Each difference is a finding:

- **A** - a reader who follows the page would act wrongly, stop, or repeat something that is already done.
- **B** - the page says something wrong or out of date, but the next action is still right.
- **C** - a case the page does not cover.

## Setup

1. A site admin turns on external tools: Atlassian Administration > Apps > Sites > your site > Connected apps > cold-read > Tools > Enable tools.
2. Add the server to your client. In Claude Code:
   ```
   claude mcp add --transport http cold-read https://mcp.atlassian.com/forge/<appId>
   ```
   Then run `/mcp`, connect, and approve access in the browser: choose the site where Cold Read is installed.
3. Tool names carry the app environment. In a development install they end with `_development`, for example `get-cold-read-status_development`. Use whatever names your client lists.

## Before acting on a page

Do this every time the user asks you to act on a Confluence runbook, handoff or how-to page:

1. Get the page ID: the number after `/pages/` in the page URL.
2. Call `get-cold-read-status` with `{"pageId": "<id>"}`.
3. Read `advice` and `lastRun.findings`, then:
   - **One or more A findings:** do not act on the page. Show the user each A finding (question and note) and ask them to have the page owner fix the page, or to confirm the real state first. An A finding often means a step was already done (an email sent, a release made) and must not be repeated.
   - **No cold read, an unfinished one, or the page changed after the last one** (`lastRun` is null, or the advice says so): tell the user the current version of the page is unchecked. Suggest running a cold read before acting: open the page, click "Cold Read" under the title, then "Run cold read". Proceed only if the user says so.
   - **Only B or C findings:** you may act. First tell the user what is wrong or missing, and double-check those points instead of trusting the page.
   - **No findings on the current version:** act as usual.
4. Quote the `advice` line in your answer, so the user sees why you stopped or went ahead.

## Running a cold read yourself (optional)

Only as a fresh reader with no other context about the page's subject, for example a new subagent. A reader who already knows the answers is not a cold reader.

1. `get-cold-read-packet` with `pageId`. It returns a `runId`, the page text and numbered questions.
2. Answer every question from the page text only. If the page does not state the answer, start the answer with `NOT STATED`. Add the shortest supporting quote (empty for `NOT STATED`).
3. `submit-cold-read-answers` with `pageId`, `runId` and `answers`: a JSON array of `{"q": number, "answer": string, "quote": string}`. Do not change answers after this call.
4. If the result contains `expected`, compare each saved answer with the owner's expected answer. Otherwise call `get-warm-read-packet` with `pageId` and `runId`, answer the same questions again from the page and the related pages, and compare the warm answer with the saved cold one.
5. `submit-cold-read-findings` with `pageId`, `runId` and `findings`: a JSON array of `{"q": number, "verdict": "match" | "A" | "B" | "C", "note": string}`.

The result appears on the page under its title ("Cold Read · 2 A") and in the space summary, and `get-cold-read-status` returns it from then on.
