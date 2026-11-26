# Privacy

Last updated: 26 November 2026.

This page describes what the Cold Read app does with data, as the code in this repository does it. Cold Read runs on Atlassian's Forge platform; what Atlassian itself processes is covered by Atlassian's own privacy policy.

## What the app reads

Every Confluence and Jira request runs as the person using the app, so the app reads only what that person can see:

- the page being checked: its title, version, owner, space and body (converted to plain text), and whether the person can edit it;
- for a warm read: the Jira issues and Confluence pages the page links to (Jira macros, links and issue keys in its text): pages with their body, issues with their summary, status, description, comments and labels. A page that a link names by its title in another space is found by Confluence search. Cold Read's own issues (label `cold-read`) are left out;
- for a Jira issue about A findings: the Jira projects where the person can create issues, and their issue types;
- for the space page: the pages that have Cold Read data, read the same way, so pages the person cannot see are left out;
- for showing a run that was compared with linked Jira issues and pages: whether the person can open each of them (the issue summary or the page title is asked for and not kept);
- for **Load sample handoffs**: whether the space already has a page named "Cold Read sample: Payments on-call".

Each step of a cold read reads the page as the person who calls it, so only someone who can view the page can take the step.

## What the app creates

- **Load sample handoffs** (Space apps > Cold Read), as the person who clicks: a parent page "Cold Read sample: Payments on-call" with four handoff pages of a made-up team in that space, and in the Jira project the person picks two issues with the label `cold-read-sample`, one of them with a comment. The sample text names made-up people only. **Remove sample** deletes the two issues as that person, or, when Jira does not let them delete issues, adds the comment "Cold Read sample removed" and moves the issue to a done status where the workflow has one. The app has no permission to delete pages: the person deletes the parent page with its children.
- A Jira issue about the A findings of a run, when someone asks for it in the panel (see What leaves the site).

## What the app stores

The app keeps its data in the Forge Key-Value Store of the installation, hosted by Atlassian for the site where the app is installed:

- `questions:<page>`: the questions of a page and their expected answers, and when they were saved;
- `run:<page>:<run>`: one run: page ID, title and version; the questions and expected answers as they were at the run; the Cold Reader's answers with quotes from the page; findings with notes and, for a warm read, the quote from the page and the quote from the source and the questions each finding touches; for a warm read, the number of links on the page, the titles and IDs or keys of the linked pages and issues, which of them an answer rested on, and the answers given with them, with quotes from the page and the sources; when the run started, was answered and was checked. A one-click run also holds the model, the input and output tokens and the cost of each step, the UTC day its spend was counted on, whether the page was longer than the 40,000 characters read, and a short error line if it failed. For the Jira issue about the run: its key, link, whether it was assigned, the number of A findings and when it was created;
- `lastrun:<page>`: the ID of the latest finished run of the page;
- `pending:<page>`: the ID of the latest one-click run of the page whose answers were saved, so the panel can offer **Continue** if its second step did not run;
- `step:<page>:<run>:<step>`: when a step of a one-click run was started, so that each step is taken once;
- `jiraproject:<space>`: the Jira project last used for Cold Read issues in the space;
- `sample:<space>`: what **Load sample handoffs** created in the space: whether loading finished, the space and Jira project IDs, the keys of the two issues, the IDs, titles and links of the pages, when it was loaded and how long it took, and an error line if it failed. It holds no people. **Remove sample** clears it;
- the spend limit of **Run cold read**: `spend:install` (when the app was installed, and what was spent on each of the 29 UTC days before today), `spend:<day>` (what one-click runs spent and reserved that UTC day, in millionths of a dollar, and a count of runs started by page changes, which this version does not start) and `spend:lock` (held for a few seconds while a total is updated). None of these holds anything about a person;
- `llm:models`: the models Forge LLMs lists for the site and their prices, read once a UTC day.

An installation that ran an early test version may also hold `budget:<day>` run counts, which are no longer read.

The app does not store Atlassian account IDs or profile data such as names, email addresses or avatars, and it does not store the full page text. To assign a Jira issue to the page owner, the app passes the owner's account ID from Confluence to Jira in that request and does not keep it. The account ID inside a user mention on a page is dropped: the mention reaches the Cold Reader as its link text, or as `@user` if it has none. A mention in a Jira description or comment reaches it as the name Jira shows.

Titles, questions, expected answers, quotes and notes are free text. They can contain whatever the page, its linked issues and pages, or the people who wrote them say, including names.

What the latest finished run stores is shown in the Cold Read panel to everyone who can view the page, with one exception: a person who cannot open one of the linked Jira issues or pages the run was compared with sees the answers from the page alone and the classes of the findings, without the answers given with the linked sources, the notes and the quotes. `get-cold-read-status` and the Jira issue about A findings follow the same rule for the person who asks. `get-cold-read-status` returns its findings with their questions and notes, its Jira issue key and link, its status and when it finished.

The app writes to the Forge app logs page, run and space IDs, Jira issue keys, counts, the state of the one-click feature flag, the model, input and output tokens and cost of each model call with the site ID, and error messages from Jira, Confluence and Forge LLMs, not page text. In the development environment only, it also logs what the compare step wrote out for each question, which can quote the page and the expected answers; production never logs it. Forge shows app logs to the app developer in the Atlassian developer console, unless a site admin turns off log access for the app.

## What leaves the site

- Nothing goes to servers of the app's author: the manifest declares no external hosts.
- **Run cold read** calls Forge LLMs, which calls [Atlassian-hosted models](https://developer.atlassian.com/platform/forge/runtime-reference/forge-llms-api/). The Forge LLMs documentation does not name a region. Atlassian staff said on the Atlassian developer community in November 2026 that all Forge LLM inference is in the US. Each step is a separate call. The first gets the page title, the first 40,000 characters of the page text and the questions. The next get either the expected answers with the saved answers, or the page text, the text of up to six linked Jira issues and pages (3,000 characters each, with their titles, keys and statuses), the saved answers and the answers given with those sources. What the app keeps of the model's replies is listed under What the app stores. The app's developer pays for these calls.
- **Run in Rovo chat**: the Cold Reader is a Rovo agent and runs on the site's Rovo, Atlassian's AI. Rovo gets what the app's actions return to it: the page text and the questions, then the expected answers or, for a warm read, the text of the Jira issues and pages the page links to.
- MCP: once a site admin turns on "Expose tools to MCP-compatible apps", a person on the site can connect an MCP client with their own Atlassian sign-in. The five Cold Read tools then return to that client the page text, the questions, the expected answers (after the answers are saved), the linked pages and issues, and the findings and Jira issue key of the latest run. The client may pass them to its model provider.
- Jira: a Cold Read issue is created as the person who clicks, assigned to the page owner where the project allows it, and holds the A findings with their questions and notes, the page title and version, and a link to the page. Jira shows it to whoever can see the project. The two sample issues are ordinary issues of the project the person picked.

## How to remove the data

- A page editor removes the saved questions of a page with **Use the handoff set** in the Cold Read panel.
- **Remove sample** removes the sample record of the space and deletes the two sample issues (or comments on them and moves them to a done status where it can); the sample pages are deleted in Confluence.
- The app does not delete runs, step marks or spend counters. Uninstalling the app removes its storage for the site; Atlassian keeps a soft-deleted copy for its retention period, as described in Forge's "Data lifecycle for Forge-hosted storage".
- Cold Read issues are ordinary Jira issues and are deleted in Jira.

## Contact

Open an issue at https://github.com/works-on-my-box/cold-read/issues.
